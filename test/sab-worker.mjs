/**
 * @zakkster/lite-arena -- cross-thread smoke-test worker (S5 / 1.7.0).
 *
 * NOT a test file (no `.test.js` suffix, so `node --test` never runs it). It is
 * the second thread for test/cross-thread.test.js. It receives a
 * SharedArrayBuffer that the main thread registered as a component's payload,
 * builds its OWN arena + component VIEWING the same SAB, and proves the shared
 * payload is reachable both ways.
 *
 * The worker deliberately does NOT iterate the set: in S5 `count` and `dense`
 * are not shared, so it reads exactly `data.x[0..n)` with `n` handed to it in
 * the message -- the documented S5 worker pattern. Access is fenced by
 * postMessage (the main thread is not touching the buffer while we are), so
 * there are no atomics and no locking here by design.
 *
 * @license MIT
 */

import { parentPort } from 'node:worker_threads';
import { Arena } from '../Arena.js';

parentPort.on('message', (msg) => {
    const { sab, cap, count } = msg;

    // The worker accepts the SAB through the same public API the main thread
    // used -- registerComponent(schema, { buffers }) -- proving the arena takes a
    // caller-supplied SharedArrayBuffer on this thread too.
    const arena = new Arena(cap);
    const pos = arena.registerComponent({ x: Float32Array }, { buffers: { x: sab } });

    // Read what the main thread wrote, over the range it told us is live.
    const read = [];
    for (let i = 0; i < count; i++) read.push(pos.data.x[i]);

    // Write back through the shared payload: double every value in place.
    for (let i = 0; i < count; i++) pos.data.x[i] = pos.data.x[i] * 2;

    parentPort.postMessage({ read });
});
