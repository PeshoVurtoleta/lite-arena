/**
 * @zakkster/lite-arena -- Worker for the S6 transferable round-trip test.
 *
 * Not named `*.test.js`, so the node:test runner ignores it. It receives a
 * transferred ArrayBuffer (a plain buffer -- NOT a SharedArrayBuffer, so no
 * cross-origin isolation is needed, exactly like a Twitch extension iframe),
 * doubles each of the first `n` Float32 values in place, and transfers the
 * SAME buffer back. The transfer list on both legs is the fence: the buffer is
 * owned by exactly one thread at a time.
 *
 * @license MIT
 */
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ xbuf, n }) => {
    const x = new Float32Array(xbuf);
    for (let i = 0; i < n; i++) x[i] *= 2;
    parentPort.postMessage(xbuf, [xbuf]);   // transfer back -- detaches the worker's view
});
