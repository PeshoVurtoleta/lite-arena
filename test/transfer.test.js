/**
 * @zakkster/lite-arena -- S6 (1.8.0) cross-thread round-trip test.
 *
 * Proves the transferable-ArrayBuffer contract across a real thread boundary:
 * main fills a component's payload, detach()es it, transfers it to a Worker
 * (transfer list), the Worker doubles it in place and transfers it back, main
 * rebind()s and reads the doubled values -- then does it AGAIN to prove the same
 * buffer can ping-pong repeatedly. Plain ArrayBuffer, no SharedArrayBuffer, no
 * cross-origin isolation: the exact path a Twitch extension iframe can run.
 *
 * Fenced by postMessage transfer: the buffer is owned by exactly one thread at a
 * time (detached on the other), so there is no concurrent access and no atomics.
 *
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { Arena } from '../Arena.js';

// One send/receive leg: transfer xbuf to the worker, resolve with the buffer it
// transfers back. `once` avoids leaking a listener across legs.
function roundtrip(worker, xbuf, n) {
    return new Promise((resolve) => {
        worker.once('message', (buf) => resolve(buf));
        worker.postMessage({ xbuf, n }, [xbuf]);
    });
}

test('cross-thread: a transferable ArrayBuffer round-trips through a Worker, twice (S6)', async () => {
    const CAP = 16;
    const arena = new Arena(CAP);
    const Pos = arena.registerComponent({ x: Float32Array });
    for (let i = 0; i < CAP; i++) {
        const h = arena.spawn();
        Pos.add(h);
        Pos.data.x[Pos.idx(h)] = (i + 1) * 1.5;
    }
    const n = Pos.count;

    const worker = new Worker(new URL('./transfer-worker.mjs', import.meta.url));
    try {
        // Round-trip #1: values should double. detach() only collects the buffer;
        // the postMessage transfer inside roundtrip() is what detaches the view.
        let [xbuf] = Pos.detach(['x']);
        let reply = await roundtrip(worker, xbuf, n);
        assert.equal(Pos.isDetached('x'), true);          // the transfer detached it
        Pos.rebind({ x: reply });
        assert.equal(Pos.isDetached('x'), false);
        for (let i = 0; i < n; i++) {
            assert.equal(Pos.data.x[i], (i + 1) * 1.5 * 2, `round 1 index ${i}`);
        }

        // Round-trip #2: the SAME buffer ping-pongs again -> quadrupled.
        [xbuf] = Pos.detach(['x']);
        reply = await roundtrip(worker, xbuf, n);
        Pos.rebind({ x: reply });
        for (let i = 0; i < n; i++) {
            assert.equal(Pos.data.x[i], (i + 1) * 1.5 * 4, `round 2 index ${i}`);
        }
    } finally {
        await worker.terminate();
    }
});
