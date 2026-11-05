/**
 * @zakkster/lite-arena -- second flag word (M-26 / M-27, PLAN-F1 A1).
 * Expected values come from PLAN-F1 ASSERTIONS A1 and DECISIONS M-26 / M-27
 * (H[name_i] = 1 << i, #32 = -2147483648; registerFlagsHi needs registerFlags first;
 * error texts = the registerFlags texts with the method name swapped), never from
 * the build under test. Every test fails on the 1.10.0 build (no Hi API).
 *
 * Run: `node --test test/flags-hi.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/flags-hi.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

const names32 = () => Array.from({ length: 32 }, (_, i) => 'n' + i);
const lo = (a, e) => a.flags[e & a.indexMask];
const hi = (a, e) => a.flagsHi[e & a.indexMask];
const mk = (n = 8) => { const a = new Arena(n); a.registerFlags(['a']); return a; };

test('A1 fresh arena: flagsHi is null and the Hi methods exist', () => {
    const a = new Arena(8);
    assert.equal(a.flagsHi, null);
    assert.equal(typeof a.registerFlagsHi, 'function');
    assert.equal(typeof a.setFlagsHi, 'function');
    assert.equal(typeof a.clearFlagsHi, 'function');
    assert.equal(typeof a.hasFlagsHi, 'function');
});

test('A1 registerFlagsHi before registerFlags throws (M-27 Q1); flagsHi stays null', () => {
    const a = new Arena(8);
    assert.throws(() => a.registerFlagsHi(['p']), (e) => e.message ===
        'lite-arena: registerFlagsHi() needs registerFlags() first (call registerFlags([]) for a Hi-only arena)');
    assert.equal(a.flagsHi, null);
    assert.equal(a.flags, null);
});

test('A1 registerFlags([]) enables a Hi-only arena', () => {
    const a = new Arena(8);
    a.registerFlags([]);
    const H = a.registerFlagsHi(['p']);
    assert.equal(H.p, 1);
    assert.equal(a.flagsHi.length, 8);
});

test('A1 33 names throws with the registerFlags text, method swapped', () => {
    const a = mk();
    const names = Array.from({ length: 33 }, (_, i) => 'n' + i);
    assert.throws(() => a.registerFlagsHi(names), (e) => e.message ===
        'lite-arena: registerFlagsHi names must be an array of <= 32 strings, got 33 names');
    assert.equal(a.flagsHi, null);
});

test('A1 32 names: frozen map, H[n0] === 1, H[n31] === -2147483648, row length = capacity', () => {
    const a = mk();
    const H = a.registerFlagsHi(names32());
    assert.equal(Object.isFrozen(H), true);
    assert.equal(Object.getPrototypeOf(H), null);
    for (let i = 0; i < 32; i++) assert.equal(H['n' + i], (1 << i) | 0, 'n' + i);
    assert.equal(H.n0, 1);
    assert.equal(H.n31, -2147483648);
    assert.ok(a.flagsHi instanceof Int32Array);
    assert.equal(a.flagsHi.length, 8);
    assert.ok(a.flagsHi.every((w) => w === 0));
    assert.notEqual(a.flagsHi, a.flags);
});

test('A1 the same name may live in both maps (M-27 Q4)', () => {
    const a = mk();
    const H = a.registerFlagsHi(['a']);
    assert.equal(H.a, 1);
});

test('A1 bad inputs throw, flagsHi stays null', () => {
    const cases = [
        [() => ['x', 'x'], undefined,
            'lite-arena: registerFlagsHi name #1 ("x") is empty, not a string, or a duplicate'],
        [() => [''], undefined,
            'lite-arena: registerFlagsHi name #0 ("") is empty, not a string, or a duplicate'],
        [() => ['ok', 5], undefined,
            'lite-arena: registerFlagsHi name #1 (number) is empty, not a string, or a duplicate'],
        [() => ['p'], { k: 1 }, 'lite-arena: registerFlagsHi options accept only "indexed"; got k'], // M-40
        [() => 'abc', undefined,
            'lite-arena: registerFlagsHi names must be an array of <= 32 strings, got string'],
    ];
    for (const [names, opts, msg] of cases) {
        const a = mk();
        assert.throws(() => a.registerFlagsHi(names(), opts), (e) => e.message === msg, msg);
        assert.equal(a.flagsHi, null, msg);
    }
    const a = mk();
    assert.throws(() => a.registerFlagsHi(['p'], Object.create({})), /registerFlagsHi options must be a plain object/);
    assert.equal(a.flagsHi, null);
    assert.throws(() => a.registerFlagsHi(['p'], Object.create(null, { z: { value: 1, enumerable: false } })),
        /registerFlagsHi options accept only "indexed"; got z/); // M-40
    assert.equal(a.flagsHi, null);
    // a failed attempt does not burn the one allowed call
    assert.equal(a.registerFlagsHi(['p']).p, 1);
});

test('A1 a second call throws; the first row survives', () => {
    const a = mk();
    a.registerFlagsHi(['p']);
    const row = a.flagsHi;
    assert.throws(() => a.registerFlagsHi(['q']), (e) => e.message ===
        'lite-arena: registerFlagsHi() was already called on this arena');
    assert.equal(a.flagsHi, row);
});

test('A1 registerFlags rejects nothing new: registerFlags after Hi still throws "already called"', () => {
    const a = mk();
    a.registerFlagsHi(['p']);
    assert.throws(() => a.registerFlags(['b']), /registerFlags\(\) was already called/);
});

test('A1 setFlagsHi touches only the Hi row, and vice versa', () => {
    const a = mk();
    const H = a.registerFlagsHi(names32());
    const e = a.spawn();
    assert.equal(a.setFlagsHi(e, H.n31), true);
    assert.equal(lo(a, e), 0);
    assert.equal(hi(a, e), -2147483648);
    assert.equal(a.setFlags(e, 1), true);
    assert.equal(lo(a, e), 1);
    assert.equal(hi(a, e), -2147483648);
    assert.equal(a.clearFlagsHi(e, H.n31), true);
    assert.equal(hi(a, e), 0);
    assert.equal(lo(a, e), 1);
    assert.equal(a.setFlagsHi(e, 0x80000000), true); // unsigned literal normalises | 0
    assert.equal(hi(a, e), -2147483648);
});

test('A1 hasFlagsHi mirrors hasFlags on the Hi row', () => {
    const a = mk();
    const H = a.registerFlagsHi(names32());
    const e = a.spawn();
    a.setFlagsHi(e, H.n0 | H.n31);
    assert.equal(a.hasFlagsHi(e, H.n0), true);
    assert.equal(a.hasFlagsHi(e, H.n0 | H.n31), true);
    assert.equal(a.hasFlagsHi(e, H.n1), false);
    assert.equal(a.hasFlagsHi(e, H.n0, H.n1), true);
    assert.equal(a.hasFlagsHi(e, H.n0, H.n31), false);
    assert.equal(a.hasFlagsHi(e, 0), true);
    assert.equal(a.hasFlagsHi(e, 0x80000000), true);
    // word 0 is a different word: nothing there
    assert.equal(a.hasFlags(e, 1), false);
    assert.equal(a.hasFlags(e, 0), true);
});

test('A1 dead handle: set/clear false with no write; has false', () => {
    const a = mk();
    a.registerFlagsHi(names32());
    const e = a.spawn();
    a.setFlagsHi(e, -1);
    a.despawn(e);
    assert.equal(a.setFlagsHi(e, 3), false);
    assert.equal(a.clearFlagsHi(e, 3), false);
    assert.equal(a.hasFlagsHi(e, 0), false);
    assert.equal(a.hasFlagsHi(e, 1), false);
    assert.equal(hi(a, e), 0);
    assert.equal(a.setFlagsHi(3, 1), false); // never-spawned handle
    assert.equal(a.flagsHi[3], 0);
});

test('A1 before registerFlagsHi a live handle gets a TypeError', () => {
    const a = mk();
    const e = a.spawn();
    assert.equal(typeof a.setFlagsHi, 'function');
    assert.throws(() => a.setFlagsHi(e, 1), TypeError);
    assert.throws(() => a.clearFlagsHi(e, 1), TypeError);
    assert.throws(() => a.hasFlagsHi(e, 1), TypeError);
    assert.equal(a.flagsHi, null);
});

test('A1 despawn zeroes the Hi word (relink exit) and a respawn is clean', () => {
    const a = mk(2);
    a.registerFlagsHi(names32());
    const e = a.spawn();
    a.setFlags(e, -1);
    a.setFlagsHi(e, -1);
    assert.equal(a.despawn(e), true);
    assert.equal(hi(a, e), 0);
    assert.equal(lo(a, e), 0);
    const e2 = a.spawn();
    assert.equal(e2 & a.indexMask, e & a.indexMask);
    assert.equal(a.hasFlagsHi(e2, 0x80000000), false);
    assert.equal(hi(a, e2), 0);
});

test('A1 despawn zeroes the Hi word on the retire exit (generation 4095)', () => {
    const a = new Arena(1);
    a.registerFlags(['a']);
    a.registerFlagsHi(['p']);
    for (let i = 0; i < 4094; i++) a.despawn(a.spawn());
    const e = a.spawn();
    assert.equal(a.setFlagsHi(e, -1), true);
    assert.equal(a.setFlags(e, -1), true);
    assert.equal(a.despawn(e), true);
    assert.equal(a.retiredCount, 1);
    assert.equal(a.flagsHi[0], 0);
    assert.equal(a.flags[0], 0);
});

test('A1 despawn clears only its own Hi row', () => {
    const a = mk(4);
    a.registerFlagsHi(['p']);
    const e0 = a.spawn(), e1 = a.spawn();
    a.setFlagsHi(e0, 1);
    a.setFlagsHi(e1, 1);
    a.despawn(e0);
    assert.equal(hi(a, e1), 1);
    assert.equal(a.hasFlagsHi(e1, 1), true);
});

test('A1 despawn on an arena with word 0 only keeps flagsHi null (no throw)', () => {
    const a = mk();
    const e = a.spawn();
    a.setFlags(e, 1);
    assert.equal(a.despawn(e), true);
    assert.equal(a.flagsHi, null);
    assert.equal(a.flags[e & a.indexMask], 0);
});

test('A1 clear() zeroes both rows', () => {
    const a = mk(8);
    a.registerFlagsHi(names32());
    for (let i = 0; i < 5; i++) { const e = a.spawn(); a.setFlagsHi(e, -1); a.setFlags(e, -1); }
    a.clear();
    assert.ok(a.flagsHi.every((w) => w === 0));
    assert.ok(a.flags.every((w) => w === 0));
    assert.equal(a.flagsHi.length, 8);
});

test('A1 reserve(16) copies the Hi row, grows it, and refreshes the plan scratch', () => {
    const a = mk(8);
    const H = a.registerFlagsHi(names32());
    const es = [];
    for (let i = 0; i < 8; i++) { const e = a.spawn(); es.push(e); a.setFlagsHi(e, 1 << i); }
    const oldRow = a.flagsHi;
    assert.equal(a.reserve(16), true);
    assert.notEqual(a.flagsHi, oldRow);
    assert.equal(a.flagsHi.length, 16);
    for (let i = 0; i < 8; i++) assert.equal(a.flagsHi[i], (1 << i) | 0, 'head ' + i);
    for (let i = 8; i < 16; i++) assert.equal(a.flagsHi[i], 0, 'tail ' + i);
    assert.equal(a._joinNResult.flagsHi, a.flagsHi);
    assert.equal(a._joinNResult.flags, a.flags);
    for (let i = 0; i < 8; i++) assert.equal(a.hasFlagsHi(es[i], 1 << i), true);
    assert.equal(typeof H, 'object');
});

test('A1 reserve no-op keeps the same Hi array', () => {
    const a = mk(8);
    a.registerFlagsHi(['p']);
    const T = a.registerTag();
    const row = a.flagsHi;
    a.joinN([T]); // joinN publishes the row into the scratch
    assert.equal(a.reserve(8), false);
    assert.equal(a.flagsHi, row);
    assert.equal(a._joinNResult.flagsHi, row);
});

test('A1 registerFlagsHi after a joinN publishes the row into the scratch', () => {
    const a = mk(8);
    const T = a.registerTag();
    a.spawn();
    const H = a.registerFlagsHi(['p']);
    const p = a.joinN([T], null, 0, 0, H.p);
    assert.equal(p.flagsHi, a.flagsHi);
});
