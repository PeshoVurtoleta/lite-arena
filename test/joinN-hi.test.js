/**
 * @zakkster/lite-arena -- joinN() Hi-word masks (M-26 / M-27, PLAN-F1 A2).
 *
 * Expected values come from PLAN-F1 A2 and DECISIONS M-26 / M-27, never from the
 * build under test. Hand oracle over slots 0..63 (T = all, U = even slots,
 * a = slot%4===0, p = slot%3===0, q = slot%5===0):
 *   joinN([T,U], null, a, 0, p, q): even && %4==0 && %3==0 && %5!=0
 *     -> multiples of 12 in 0..63 = 0,12,24,36,48,60; drop multiples of 5 (0, 60)
 *     -> 12, 24, 36, 48.
 *   joinN([T,U], null, 0, 0, p): even && %3==0 -> multiples of 6: 0..60 = 11 slots.
 * Every test fails on the 1.10.0 build (no Hi API).
 *
 * Run: `node --test test/joinN-hi.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/joinN-hi.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

const NO_HI = (rh, xh) => `lite-arena: joinN() got reqMaskHi=${rh}, excMaskHi=${xh}, but this arena has no Hi flag row ` +
    '(arena.flagsHi is null). Call registerFlagsHi() before passing a non-zero reqMaskHi or excMaskHi, ' +
    'or pass 0 / omit both Hi masks.';
const REQUIRED_ERR = /joinN\(\) needs at least one required set; got an empty array\. There is no driver and no honest result for zero required sets\./;

function build(opts) {
    const arena = new Arena(64, opts);
    const F = arena.registerFlags(['a', 'b']);
    const H = arena.registerFlagsHi(['p', 'q']);
    const T = arena.registerTag();
    const U = arena.registerTag();
    for (let i = 0; i < 64; i++) {
        const e = arena.spawn();
        assert.equal(e & arena.indexMask, i, 'slot == spawn index');
        T.add(e);
        if (i % 2 === 0) U.add(e);
        if (i % 4 === 0) arena.setFlags(e, F.a);
        if (i % 3 === 0) arena.setFlagsHi(e, H.p);
        if (i % 5 === 0) arena.setFlagsHi(e, H.q);
    }
    return { arena, F, H, T, U };
}

// Two-row loop documented for joinN (word 0 and Hi word, then the set checks).
function loop(arena, p) {
    const row = p.flags, rowHi = p.flagsHi, m = arena.indexMask;
    const rm = p.reqMask, xm = p.excMask, rh = p.reqMaskHi, xh = p.excMaskHi;
    const drv = p.driver, n = p.count, oth = p.others, no = p.othersCount, ex = p.excl, nx = p.exclCount;
    const got = [];
    for (let i = 0; i < n; i++) {
        const e = drv.dense[i];
        let ok = true;
        for (let k = 0; k < no; k++) if (!oth[k].has(e)) { ok = false; break; }
        if (ok) for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
        if (!ok) continue;
        const w = row === null ? 0 : row[e & m];
        const v = rowHi === null ? 0 : rowHi[e & m];
        if ((w & rm) !== rm || (w & xm) !== 0) continue;
        if ((v & rh) !== rh || (v & xh) !== 0) continue;
        got.push(e & m);
    }
    return got.sort((x, y) => x - y);
}

test('A2 joinN([T,U], null, F.a, 0, H.p, H.q): driver U, count 32, plan Hi fields, slots 12/24/36/48', () => {
    const { arena, F, H, T, U } = build();
    const p = arena.joinN([T, U], null, F.a, 0, H.p, H.q);
    assert.equal(p.driver, U);
    assert.equal(p.count, 32);
    assert.equal(p.reqMask, 1);
    assert.equal(p.excMask, 0);
    assert.equal(p.reqMaskHi, 1);
    assert.equal(p.excMaskHi, 2);
    assert.equal(p.flags, arena.flags);
    assert.equal(p.flagsHi, arena.flagsHi);
    assert.deepEqual(loop(arena, p), [12, 24, 36, 48]);
});

test('A2 joinN([T,U], null, 0, 0, H.p): 11 slots (multiples of 6)', () => {
    const { arena, H, T, U } = build();
    const p = arena.joinN([T, U], null, 0, 0, H.p);
    assert.equal(p.reqMaskHi, 1);
    assert.equal(p.excMaskHi, 0);
    assert.deepEqual(loop(arena, p), [0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60]);
});

test('A2 excluded Hi only: even && %5 != 0 -> 32 - 7 = 25 slots', () => {
    const { arena, H, T, U } = build();
    const p = arena.joinN([T, U], null, 0, 0, 0, H.q);
    // even multiples of 5 in 0..63: 0,10,20,30,40,50,60 = 7
    assert.equal(p.excMaskHi, 2);
    assert.equal(loop(arena, p).length, 25);
});

test('A2 Hi masks normalise | 0: unsigned 0x80000000 -> -2147483648; bit 31 matches', () => {
    const arena = new Arena(8);
    arena.registerFlags([]);
    arena.registerFlagsHi(Array.from({ length: 32 }, (_, i) => 'n' + i));
    const T = arena.registerTag();
    const e0 = arena.spawn(), e1 = arena.spawn();
    T.add(e0); T.add(e1);
    arena.setFlagsHi(e1, 0x80000000);
    const p = arena.joinN([T], null, 0, 0, 0x80000000, 0);
    assert.equal(p.reqMaskHi, -2147483648);
    assert.deepEqual(loop(arena, p), [1]);
    const q = arena.joinN([T], null, 0, 0, 0, 0x80000000);
    assert.equal(q.excMaskHi, -2147483648);
    assert.deepEqual(loop(arena, q), [0]);
});

test('A2 omitted Hi masks reset the scratch to 0 (no stale Hi mask from the previous call)', () => {
    const { arena, F, H, T } = build();
    arena.joinN([T], null, 0, 0, H.p, H.q);
    const p = arena.joinN([T], null, F.a);
    assert.equal(p.reqMaskHi, 0);
    assert.equal(p.excMaskHi, 0);
    assert.equal(p.flagsHi, arena.flagsHi);
});

test('A2 plan flagsHi is null on a word-0-only arena and tracks reserve()', () => {
    const a = new Arena(4);
    a.registerFlags(['a']);
    const T = a.registerTag();
    a.spawn();
    const p = a.joinN([T]);
    assert.equal(p.flagsHi, null);
    assert.equal(p.reqMaskHi, 0);
    assert.equal(p.excMaskHi, 0);
    const b = new Arena(4);
    b.registerFlags([]);
    const H = b.registerFlagsHi(['p']);
    const T2 = b.registerTag();
    b.spawn();
    assert.equal(b.joinN([T2], null, 0, 0, H.p).flagsHi, b.flagsHi);
    b.reserve(16);
    assert.equal(b.joinN([T2], null, 0, 0, H.p).flagsHi, b.flagsHi);
    assert.equal(b.flagsHi.length, 16);
});

test('A2 word-0-only arena: a Hi mask throws the pinned error before any write', () => {
    const arena = new Arena(8);
    arena.registerFlags(['a']);
    const T = arena.registerTag();
    const U = arena.registerTag();
    const e = arena.spawn(); T.add(e); U.add(e);
    const p = arena.joinN([T]);
    const before = [p.driver, p.count, p.othersCount, p.exclCount, p.reqMask, p.excMask];
    assert.throws(() => arena.joinN([U], null, 0, 0, 5), (err) => err.message === NO_HI(5, 0));
    assert.throws(() => arena.joinN([U], null, 0, 0, 0, 3), (err) => err.message === NO_HI(0, 3));
    assert.throws(() => arena.joinN([U], null, 0, 0, 4, 2), (err) => err.message === NO_HI(4, 2));
    assert.throws(() => arena.joinN([U], null, 1, 0, -2147483648), (err) => err.message === NO_HI(-2147483648, 0));
    // scratch untouched: still the plan for T
    assert.deepEqual([p.driver, p.count, p.othersCount, p.exclCount, p.reqMask, p.excMask], before);
    assert.equal(p.driver, T);
    assert.equal(p.reqMaskHi, 0);
    assert.equal(p.excMaskHi, 0);
});

test('A2 arena with no flag rows at all: a Hi mask throws the Hi error; 0 / omitted do not', () => {
    const arena = new Arena(8);
    const T = arena.registerTag();
    arena.spawn();
    assert.throws(() => arena.joinN([T], null, 0, 0, 1), (err) => err.message === NO_HI(1, 0));
    assert.doesNotThrow(() => arena.joinN([T], null, 0, 0, 0, 0));
    assert.doesNotThrow(() => arena.joinN([T], null, 0, 0));
    assert.doesNotThrow(() => arena.joinN([T]));
});

test('A2 empty required with a Hi mask throws the required-set error (M-11 first)', () => {
    const a = new Arena(8);
    a.registerFlags(['a']);
    assert.throws(() => a.joinN([], null, 0, 0, 1), REQUIRED_ERR);
    assert.throws(() => a.joinN(null, null, 0, 0, 1), /needs at least one required set/);
    const { arena } = build();
    assert.throws(() => arena.joinN([], null, 0, 0, 1), REQUIRED_ERR);
});

test('A2 production joinN(..., 0, 0, H.p, H.p) matches 0', () => {
    const { arena, H, T, U } = build();
    const p = arena.joinN([T, U], null, 0, 0, H.p, H.p);
    assert.equal(p.reqMaskHi, 1);
    assert.equal(p.excMaskHi, 1);
    assert.deepEqual(loop(arena, p), []);
});

test('A2 word-0 and Hi are independent: a word-0 mask never reads the Hi row', () => {
    const { arena, F, H, T } = build();
    // F.a = 1 and H.p = 1 are the same numeric bit in different words
    const lo0 = loop(arena, arena.joinN([T], null, F.a));
    const hi0 = loop(arena, arena.joinN([T], null, 0, 0, H.p));
    assert.equal(lo0.length, 16); // slot%4==0 in 0..63
    assert.equal(hi0.length, 22); // slot%3==0 in 0..63: 0,3,...,63
    // cross-word "overlap" is allowed in production and in the plan
    const both = loop(arena, arena.joinN([T], null, F.a, 0, 0, H.p));
    // a && !p: slot%4==0 && slot%3!=0 -> 16 - multiples of 12 (0,12,24,36,48,60 = 6) = 10
    assert.equal(both.length, 10);
});

// B1: the word-0 no-flags error has precedence when both word-0 and Hi masks apply.
test('B1 word-0 no-flags error beats the Hi check on an arena with no flag rows', () => {
    for (const opts of [undefined, { checked: true }]) {
        const a = new Arena(8, opts);
        const T = a.registerTag();
        T.add(a.spawn());
        assert.throws(() => a.joinN([T], null, 1, 0, 1),
            (e) => e.message.startsWith('lite-arena: joinN() got reqMask=1, excMask=0, but this arena has no flag'),
            'opts ' + JSON.stringify(opts));
    }
});
