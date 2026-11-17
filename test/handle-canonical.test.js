/**
 * @zakkster/lite-arena -- 1.12.1-B canonical entity handles (M-57 / M-60 / M-68).
 * Gates: (A2) production despawn(e >>> 0) of a live negative handle frees the slot AND
 * leaves every set / tag / flag row; (A3) checked arenas throw on any non-int32 handle
 * (own isAlive) and on a SUPPLIED undefined excluded mask in hasFlags / hasFlagsHi;
 * (A5) G1 / G2 golden replay of canonical-handle workloads (PARITY rows: they pass on
 * the 83f754df build by design). Expected values come from PLAN-1.12.1-B ASSERTIONS and
 * LEDGER law 3, never from the build under test; the golden is cut from 83f754df.
 *
 * A2 / A3 rows FAIL on the 1.12.0 (180d1268) and 83f754df builds.
 *
 * Run: `node --test test/handle-canonical.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/handle-canonical.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './golden/handle-canonical-workload.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

const INT32 = /entity handle must be the int32/;
const EXC = /the excluded mask must be a 32-bit integer, got undefined/;

// Churn one slot until its handle is negative (generation >= 2048: bit 31 of gen<<20 set).
function negHandle(a) {
    let e = a.spawn();
    while (e >= 0) { a.despawn(e); e = a.spawn(); }
    return e;
}

function mk(opts, indexed) {
    const a = new Arena(4, opts);
    const C = a.registerComponent({ x: Float32Array });
    const T = a.registerTag();
    const F = indexed ? a.registerFlags(['a', 'b'], { indexed: ['a'] }) : a.registerFlags(['a', 'b']);
    return { a, C, T, F };
}

for (const indexed of [false, true]) {
    const tag = indexed ? 'indexed' : 'plain';

    test('A2 production (' + tag + '): despawn(e >>> 0) of a live negative handle cleans every row', () => {
        const { a, C, T, F } = mk(undefined, indexed);
        const e = negHandle(a);
        assert.ok(e < 0);
        C.add(e); T.add(e); a.setFlags(e, F.a | F.b);
        assert.equal(C.count, 1);
        assert.equal(T.count, 1);
        if (indexed) assert.equal(a.flagCount(F.a), 1);
        assert.equal(a.despawn(e >>> 0), true);
        assert.equal(C.count, 0);
        assert.equal(T.count, 0);
        assert.equal(a.flags[e & a.indexMask], 0);
        assert.equal(a.isAlive(e), false);
        if (indexed) assert.equal(a.flagCount(F.a), 0);
        assert.equal(a.despawn(e >>> 0), false);
        assert.equal(a.despawn(e), false);
        // a re-spawned slot is clean
        const r = a.spawn();
        assert.equal(r & a.indexMask, e & a.indexMask);
        assert.equal(C.has(r), false);
        assert.equal(T.has(r), false);
        assert.equal(a.hasFlags(r, F.a), false);
        assert.equal(a.flags[r & a.indexMask], 0);
        if (indexed) assert.equal(a.flagCount(F.a), 0);
    });

    test('A3 checked (' + tag + '): unsigned copy of a live negative handle throws, state unchanged', () => {
        const { a, C, T, F } = mk({ checked: true }, indexed);
        const e = negHandle(a);
        const u = e >>> 0;
        C.add(e); T.add(e); a.setFlags(e, F.a);
        assert.throws(() => a.isAlive(u), INT32);
        assert.throws(() => a.despawn(u), INT32);
        assert.throws(() => C.add(u), INT32);
        assert.throws(() => C.has(u), INT32);
        assert.throws(() => C.remove(u), INT32);
        assert.equal(C.count, 1);
        assert.equal(T.count, 1);
        assert.equal(a.flags[e & a.indexMask], F.a);
        if (indexed) assert.equal(a.flagCount(F.a), 1);
        // canonical negative never throws
        assert.equal(a.isAlive(e), true);
        assert.equal(C.has(e), true);
        assert.doesNotThrow(() => C.add(e));
        assert.equal(C.count, 1);
        assert.equal(a.hasFlags(e, F.a), true);
        assert.equal(a.despawn(e), true);
        assert.equal(C.count, 0);
        assert.equal(a.isAlive(e), false);
    });
}

test('A3 checked: other non-int32 handles throw on isAlive; message names the value', () => {
    const { a } = mk({ checked: true }, false);
    for (const v of [1.5, NaN, undefined, '3', null, 2 ** 32, -0.5, Infinity]) {
        assert.throws(() => a.isAlive(v), INT32, String(v));
    }
    assert.throws(() => a.isAlive(1.5), /got 1\.5/);
    assert.throws(() => a.isAlive(2 ** 31), /got 2147483648/);
});

test('A3 checked: subclass isAlive override honoured; a non-int32 handle never reaches it', () => {
    class Sub extends Arena {
        constructor(n, o) { super(n, o); this.hits = 0; }
        isAlive(e) { this.hits++; return super.isAlive(e); }
    }
    const a = new Sub(4, { checked: true });
    const e = a.spawn();
    assert.equal(a.isAlive(e), true);
    assert.equal(a.hits, 1);
    assert.throws(() => a.isAlive(1.5), /entity handle must be the int32/);
    assert.equal(a.hits, 1);
});

test('A3 checked: a SUPPLIED undefined excluded mask throws in hasFlags / hasFlagsHi, omitted is fine', () => {
    const a = new Arena(4, { checked: true });
    a.registerFlags(['a']);
    a.registerFlagsHi(['p']);
    const e = a.spawn();
    a.setFlags(e, 1);
    a.setFlagsHi(e, 1);
    assert.throws(() => a.hasFlags(e, 1, undefined), EXC);
    assert.throws(() => a.hasFlagsHi(e, 0, undefined), EXC);
    assert.equal(a.hasFlags(e, 1), true);
    assert.equal(a.hasFlagsHi(e, 1), true);
});

test('A3 production: non-int32 isAlive calls do not throw (zero-cost production)', () => {
    const { a } = mk(undefined, false);
    assert.equal(Object.hasOwn(a, 'isAlive'), false);
    for (const v of [1.5, NaN, undefined, '3', null, 2 ** 32]) {
        assert.doesNotThrow(() => a.isAlive(v), String(v));
    }
});

// ---------------------------------------------------------------- A5 golden replay
// PARITY rows: canonical-handle workloads must be byte-identical across B (green on 83f754df too).
const golden = JSON.parse(readFileSync(join(ROOT, 'test/golden/handle-canonical-83f754df.json'), 'utf8'));
const got = run(mod);

test('A5 PARITY G1 production: plain arena replay equals the golden', () => {
    assert.deepEqual(got.G1.plain, golden.G1.plain);
});
test('A5 PARITY G1 production: indexed arena replay equals the golden', () => {
    assert.deepEqual(got.G1.indexed, golden.G1.indexed);
});
test('A5 PARITY G2 checked: plain arena replay equals the golden', () => {
    assert.deepEqual(got.G2.plain, golden.G2.plain);
});
test('A5 PARITY G2 checked: indexed arena replay equals the golden', () => {
    assert.deepEqual(got.G2.indexed, golden.G2.indexed);
});
test('A5 PARITY G2 checked: invalid-call messages and valid canonical results equal the golden', () => {
    assert.deepEqual(got.G2.invalid, golden.G2.invalid);
});
test('A5 PARITY meta equals the golden', () => {
    assert.deepEqual(got.meta, golden.meta);
});
