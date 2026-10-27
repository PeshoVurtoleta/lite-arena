/**
 * @zakkster/lite-arena -- per-entity flags row (Group D1) tests.
 *
 * Expected values come from PLAN-D ASSERTIONS 1-3 and DECISIONS M-3, M-5..M-9,
 * never from the build under test. Every behavioural test fails on the
 * pre-feature build (registerFlags does not exist there).
 *
 * Run: `node --test test/flags.test.js`
 * Control run against another build:
 *   LITE_ARENA_PATH=/abs/path/Arena.js node --test test/flags.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

const SIGN = -2147483648; // 1 << 31 as Int32
const names32 = () => Array.from({ length: 32 }, (_, i) => 'n' + i);
const row = (a, e) => a.flags[e & a.indexMask];

test('A1 fresh arena: flags null, indexMask 1048575', () => {
    const a = new Arena(8);
    assert.equal(a.flags, null);
    assert.equal(a.indexMask, 1048575);
});

test('A1 registerFlags: 32 names -> frozen null-proto map, bit 31 = -2147483648, row zeroed', () => {
    const a = new Arena(8);
    const F = a.registerFlags(names32());
    assert.equal(Object.getPrototypeOf(F), null);
    assert.equal(Object.isFrozen(F), true);
    for (let i = 0; i < 31; i++) assert.equal(F['n' + i], 1 << i);
    assert.equal(F.n0, 1);
    assert.equal(F.n31, SIGN);
    assert.ok(a.flags instanceof Int32Array);
    assert.equal(a.flags.length, 8);
    for (let i = 0; i < 8; i++) assert.equal(a.flags[i], 0);
});

test('A1 registerFlags([]) allocates and returns a frozen {}', () => {
    const a = new Arena(4);
    const F = a.registerFlags([]);
    assert.equal(Object.isFrozen(F), true);
    assert.deepEqual(Object.keys(F), []);
    assert.equal(Object.getPrototypeOf(F), null);
    assert.ok(a.flags instanceof Int32Array);
    assert.equal(a.flags.length, 4);
});

test('A1 registerFlags() with no args: frozen null-proto {} and allocated row', () => {
    const a = new Arena(4);
    const F = a.registerFlags();
    assert.equal(Object.isFrozen(F), true);
    assert.equal(Object.getPrototypeOf(F), null);
    assert.deepEqual(Object.keys(F), []);
    assert.equal(a.flags.length, 4);
});

test('A1 registerFlags: bad input throws and leaves flags null', () => {
    const bad = [
        [['a', 'a']],
        [['']],
        [[1]],
        [[null]],
        [null],
        [['a'], { [Symbol('x')]: 1 }],
        [['a'], Object.defineProperty({}, 'x', { value: 1 })],
        [Array.from({ length: 33 }, (_, i) => 'n' + i)],
        [['a'], { x: 1 }],
        ['abc'],
        [{ length: 1, 0: 'a' }],
        [42],
    ];
    for (const args of bad) {
        const a = new Arena(8);
        assert.throws(() => a.registerFlags(...args), undefined, JSON.stringify(args));
        assert.equal(a.flags, null);
    }
});

test('A1 registerFlags: undefined / null options are allowed; "__proto__" is a name', () => {
    const a = new Arena(4);
    const F = a.registerFlags(['a'], undefined);
    assert.equal(F.a, 1);
    const b = new Arena(4);
    assert.equal(b.registerFlags(['a'], null).a, 1);
    const c = new Arena(4);
    const G = c.registerFlags(['__proto__', 'b']);
    assert.equal(Object.getPrototypeOf(G), null);
    assert.equal(Object.keys(G).length, 2);
    assert.equal(G.b, 2);
    assert.equal(G['__proto__'], 1);
});

test('A1 second registerFlags call throws; first result survives', () => {
    const a = new Arena(8);
    const F = a.registerFlags(['a']);
    const arr = a.flags;
    assert.throws(() => a.registerFlags(['b']));
    assert.throws(() => a.registerFlags([]));
    assert.equal(a.flags, arr);
    assert.equal(F.a, 1);
});

test('A2 live entity: set / has / clear with sign bit', () => {
    const a = new Arena(8);
    const F = a.registerFlags(names32());
    const e = a.spawn();
    assert.equal(a.setFlags(e, F.n0 | 0x80000000), true);
    assert.ok(row(a, e) < 0);
    assert.equal(row(a, e), SIGN | 1);
    assert.equal(a.hasFlags(e, F.n0), true);
    assert.equal(a.hasFlags(e, 0x80000000), true);
    assert.equal(a.hasFlags(e, F.n0, 0x80000000), false);
    assert.equal(a.hasFlags(e, F.n0, F.n1), true);
    assert.equal(a.hasFlags(e, F.n0 | F.n1), false);
    assert.equal(a.clearFlags(e, F.n0), true);
    assert.equal(a.hasFlags(e, F.n0), false);
    assert.equal(row(a, e), SIGN);
    assert.equal(a.clearFlags(e, 0x80000000), true);
    assert.equal(row(a, e), 0);
});

test('A2 masks are normalised with |0 (unsigned, fractional-free, large)', () => {
    const a = new Arena(4);
    a.registerFlags(['a']);
    const e = a.spawn();
    assert.equal(a.setFlags(e, 0x80000001), true);
    assert.equal(row(a, e), SIGN | 1);
    assert.equal(a.hasFlags(e, 0xFFFFFFFF & 0x80000001), true);
    assert.equal(a.hasFlags(e, 0x80000001), true);
    assert.equal(a.hasFlags(e, 1, 0x80000000), false);
    assert.equal(a.clearFlags(e, 0x80000000), true);
    assert.equal(row(a, e), 1);
});

test('M-9 zero masks: hasFlags(e,0) true, setFlags(e,0) true no-op', () => {
    const a = new Arena(4);
    a.registerFlags(['a']);
    const e = a.spawn();
    assert.equal(a.hasFlags(e, 0), true);
    assert.equal(a.setFlags(e, 0), true);
    assert.equal(row(a, e), 0);
    a.setFlags(e, 1);
    assert.equal(a.clearFlags(e, 0), true);
    assert.equal(row(a, e), 1);
    assert.equal(a.hasFlags(e, 0), true);
});

test('A2 dead handle: despawn zeroes row; set/clear false and write nothing; has false', () => {
    const a = new Arena(4);
    a.registerFlags(['a', 'b']);
    const e = a.spawn();
    a.setFlags(e, -1);
    a.despawn(e);
    assert.equal(a.flags[e & a.indexMask], 0);
    assert.equal(a.setFlags(e, 3), false);
    assert.equal(a.clearFlags(e, 3), false);
    assert.equal(a.hasFlags(e, 0), false);
    assert.equal(a.hasFlags(e, 1), false);
    assert.equal(a.flags[e & a.indexMask], 0);
    // never-spawned / garbage handle writes nothing either
    assert.equal(a.setFlags(3, 1), false);
    assert.equal(a.flags[3], 0);
});

test('A2 respawn of the same slot starts with a clean row', () => {
    const a = new Arena(2);
    a.registerFlags(names32());
    const e = a.spawn();
    a.setFlags(e, -1);
    a.despawn(e);
    const e2 = a.spawn();
    assert.equal(e2 & a.indexMask, e & a.indexMask);
    assert.notEqual(e2, e);
    assert.equal(a.hasFlags(e2, 0x80000000), false);
    assert.equal(row(a, e2), 0);
    assert.equal(a.hasFlags(e, 0), false); // stale handle stays dead
});

test('A2 despawn of a slot that retires still zeroes its row', () => {
    const a = new Arena(1);
    a.registerFlags(['a']);
    for (let i = 0; i < 4094; i++) a.despawn(a.spawn());
    const e = a.spawn();
    assert.equal(a.setFlags(e, -1), true);
    assert.equal(a.despawn(e), true);
    assert.equal(a.retiredCount, 1);
    assert.equal(a.flags[0], 0);
});

test('A2 despawn clears only its own row', () => {
    const a = new Arena(4);
    a.registerFlags(['a']);
    const e0 = a.spawn(), e1 = a.spawn();
    a.setFlags(e0, 1); a.setFlags(e1, 1);
    a.despawn(e0);
    assert.equal(row(a, e1), 1);
    assert.equal(a.hasFlags(e1, 1), true);
});

test('M-6 flag methods before registerFlags throw TypeError', () => {
    const a = new Arena(4);
    const e = a.spawn();
    assert.throws(() => a.setFlags(e, 1), TypeError);
    assert.throws(() => a.clearFlags(e, 1), TypeError);
    assert.throws(() => a.hasFlags(e, 1), TypeError);
    assert.equal(a.flags, null);
});

test('A3 despawn on a never-registered arena keeps flags null', () => {
    const a = new Arena(4);
    const e = a.spawn();
    a.despawn(e);
    a.clear();
    a.reserve(8);
    assert.equal(a.flags, null);
    assert.equal(a.indexMask, 1048575);
});

test('A3 clear(): same array, every capacity slot zeroed', () => {
    const a = new Arena(8);
    a.registerFlags(['a']);
    const arr = a.flags;
    for (let i = 0; i < 8; i++) a.setFlags(a.spawn(), -1);
    for (let i = 0; i < 8; i++) assert.equal(arr[i], -1);
    a.clear();
    assert.equal(a.flags, arr);
    for (let i = 0; i < 8; i++) assert.equal(arr[i], 0);
});

test('A3 reserve(16) on Arena(8): new len-16 array, head copied, tail zero', () => {
    const a = new Arena(8);
    a.registerFlags(['a']);
    const old = a.flags;
    const es = [];
    for (let i = 0; i < 8; i++) { const e = a.spawn(); es.push(e); a.setFlags(e, i + 1); }
    assert.equal(a.reserve(16), true);
    assert.notEqual(a.flags, old);
    assert.ok(a.flags instanceof Int32Array);
    assert.equal(a.flags.length, 16);
    for (let i = 0; i < 8; i++) assert.equal(a.flags[i], i + 1);
    for (let i = 8; i < 16; i++) assert.equal(a.flags[i], 0);
    assert.equal(a.hasFlags(es[3], 4), true);
});

test('A3 reserve no-op keeps the same array', () => {
    const a = new Arena(8);
    a.registerFlags(['a']);
    const arr = a.flags;
    assert.equal(a.reserve(8), false);
    assert.equal(a.reserve(4), false);
    assert.equal(a.flags, arr);
});

test('A3 throwing reserve (caller-backed component / bad capacity) keeps the same array', () => {
    const a = new Arena(4);
    a.registerFlags(['a']);
    a.registerComponent({ x: Float32Array }, { buffers: { x: new ArrayBuffer(4 * 4) } });
    const arr = a.flags;
    const e = a.spawn();
    a.setFlags(e, 1);
    assert.throws(() => a.reserve(8));
    assert.equal(a.flags, arr);
    assert.equal(a.flags.length, 4);
    assert.equal(row(a, e), 1);
    assert.equal(a.capacity, 4);

    const b = new Arena(4);
    b.registerFlags(['a']);
    const arrB = b.flags;
    assert.throws(() => b.reserve(16.5));
    assert.throws(() => b.reserve(NaN));
    assert.equal(b.flags, arrB);
});
