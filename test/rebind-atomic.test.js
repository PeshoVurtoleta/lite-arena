/**
 * @zakkster/lite-arena -- SparseSet.rebind() is atomic and reads each buffer
 * exactly once (Group E review). Oracle: the reviewer's fix spec, not the build.
 * A buffers map whose `y` getter returns a valid buffer on the first read and a
 * wrong-size buffer on the second must either succeed having read each getter
 * once, or throw leaving data.x / data.y IDENTICAL to before (and a swapping
 * remove must still move the payload through them). A getter returning 123 on the
 * second read must never produce a 123-length data.y.
 *
 * Run: `node --test test/rebind-atomic.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/rebind-atomic.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

function setup() {
    const arena = new Arena(8);
    const set = arena.registerComponent({ x: Float32Array, y: Float32Array });
    const ents = [];
    for (let i = 0; i < 3; i++) {
        const e = arena.spawn();
        const d = set.add(e);
        set.data.x[d] = 5 + i;   // 5, 6, 7
        set.data.y[d] = 50 + i;
        ents.push(e);
    }
    return { arena, set, ents };
}

test('rebind: second-read-bad getter -> succeeds with one read each, or throws atomically', () => {
    const { arena, set, ents } = setup();
    const x0 = set.data.x, y0 = set.data.y;
    const goodX = new ArrayBuffer(arena.capacity * 4);
    new Float32Array(goodX).set([5, 6, 7]);
    let reads = 0, xReads = 0;
    const buffers = {
        get x() { xReads++; return goodX; },
        get y() { reads++; return reads === 1 ? new ArrayBuffer(arena.capacity * 4) : new ArrayBuffer(4); },
    };
    let threw = false;
    try { set.rebind(buffers); } catch (_) { threw = true; }
    if (!threw) {
        assert.equal(reads, 1, 'y getter read ' + reads + ' times');
        assert.equal(xReads, 1, 'x getter read ' + xReads + ' times');
        assert.equal(set.data.y.length, arena.capacity);
    } else {
        assert.equal(set.data.x, x0, 'data.x replaced despite throw');
        assert.equal(set.data.y, y0, 'data.y replaced despite throw');
    }
    // swapping remove: entity 2 (payload 7) moves into slot 0 in the CURRENT data
    set.remove(ents[0]);
    assert.equal(set.data.x[0], 7);
});

test('rebind: getter returning 123 on the second read never yields a 123-length view', () => {
    const { arena, set } = setup();
    const goodY = new ArrayBuffer(arena.capacity * 4);
    let n = 0;
    const buffers = { get y() { n++; return n === 1 ? goodY : 123; } };
    try { set.rebind(buffers); } catch (_) { /* a throw is acceptable */ }
    assert.notEqual(set.data.y.length, 123);
    assert.equal(set.data.y.length, arena.capacity);
});
