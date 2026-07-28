/**
 * @zakkster/lite-arena -- cross-thread smoke test (S5 / 1.7.0).
 *
 * Proves the point of caller-supplied buffers: a component's payload placed in a
 * SharedArrayBuffer is genuinely reachable from another thread, both ways.
 *
 *   main thread                         worker thread (test/sab-worker.mjs)
 *   -----------                         -----------------------------------
 *   register comp over SAB
 *   write data.x[0..n)  --------------> read the same SAB, verify values
 *                                       write doubled values back
 *   read data.x[0..n)   <-------------- (values now doubled)
 *
 * Access is fenced by postMessage -- the two threads never touch the buffer
 * concurrently -- so there are no atomics and no locking. In S5 the worker
 * cannot ITERATE the set (count/dense are not shared); it reads exactly the
 * range `n` the message hands it. That is the whole contract of this release.
 *
 * @license MIT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { Arena } from '../Arena.js';

test('cross-thread > a worker reads and writes a SAB-backed component payload (postMessage-fenced)', async () => {
    const CAP = 8;
    const COUNT = 5;

    const sab = new SharedArrayBuffer(CAP * Float32Array.BYTES_PER_ELEMENT);
    const arena = new Arena(CAP);
    const pos = arena.registerComponent({ x: Float32Array }, { buffers: { x: sab } });

    // Main thread writes a known pattern over the live range.
    const expect = [];
    for (let i = 0; i < COUNT; i++) {
        const e = arena.spawn();
        const di = pos.add(e);
        pos.data.x[di] = (i + 1) * 1.5; // 1.5, 3.0, 4.5, 6.0, 7.5
        expect.push(pos.data.x[di]);
    }

    const worker = new Worker(new URL('./sab-worker.mjs', import.meta.url));
    try {
        const reply = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.postMessage({ sab, cap: CAP, count: COUNT });
        });

        // Direction 1: the worker saw exactly what the main thread wrote.
        assert.deepEqual(reply.read, expect,
            'worker did not read the values the main thread wrote into the shared buffer');

        // Direction 2: the worker's writes (doubled) are visible on the main thread
        // through the very same component view -- no message carried the payload.
        for (let i = 0; i < COUNT; i++) {
            assert.equal(pos.data.x[i], expect[i] * 2,
                `main thread did not observe the worker's write at index ${i}`);
        }
    } finally {
        await worker.terminate();
    }
});
