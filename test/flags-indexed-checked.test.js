/**
 * @zakkster/lite-arena -- F2 indexed flags in CHECKED mode (PLAN-F2 A3 + the checked parts of A4; DECISIONS M-18,
 * M-36, M-41). Expected texts come from the SPEC (S7) and the M-18 text `lite-arena: <m>() <which> mask must be a
 * 32-bit integer, got <v>` (checkMask in the frozen build), never from the build under test.
 *
 * Run: `node --test test/flags-indexed-checked.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/flags-indexed-checked.test.js
 * (every test fails on the frozen fe8d7d5 build: no `indexed` option).
 *
 * MUTANT -> TEST MAP (reviewer applies these to Arena.js):
 *  A3 naive install (ixInstall overwrites the checked own setFlags / clearFlags with the unchecked ix bodies;
 *       the M-18 throw is lost)  -> 'A3: checked + indexed setFlags(e, 1.5) throws ...' (and its Hi twin, and the
 *       clearFlags rows of both).
 *  A3 checked wrapper delegating to the PROTOTYPE setFlags (installed ix body bypassed; the column never updates,
 *       count stays 0) -> 'A3: setFlags(e, F.a) -> flagCount 1' assertions (word 0 and Hi), the clear
 *       assertions (count back to 0) and 'A3: despawn / mixed bits ...'.
 *  A4 checked: query wrapper missing / not validating -> 'A4 checked: flagCount(1.5) ...',
 *       'A4 checked: nextFlagged E-BIT on flag, M-18 on flag and prev' (+ Hi twins).
 *
 * Unchanged-behaviour tests that PASS on the frozen build: none expected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

if (process.env.LITE_ARENA_PATH) {
    test('build under test (LITE_ARENA_PATH)', (t) => { t.diagnostic('LITE_ARENA_PATH=' + process.env.LITE_ARENA_PATH); });
}

// ---- shared helpers (duplicated across the three F2 test files on purpose) ----
const NAMES = Array.from({ length: 32 }, (_, i) => 'n' + i);
const SLOT = 0xFFFFF;
const slotOf = (h) => h & SLOT;
const optOf = (bits) => (bits.length === 0 ? undefined : { indexed: bits.map((b) => NAMES[b]) });
const CAP0 = 4096;
const CAP1 = 8192;
// Method names per word (M-37: the Hi twins carry a Hi suffix).
const NM = [
    { set: 'setFlags', clr: 'clearFlags', count: 'flagCount', first: 'firstFlagged', next: 'nextFlagged', clearAll: 'clearFlagAll', row: 'flags' },
    { set: 'setFlagsHi', clr: 'clearFlagsHi', count: 'flagCountHi', first: 'firstFlaggedHi', next: 'nextFlaggedHi', clearAll: 'clearFlagAllHi', row: 'flagsHi' },
];
// Spec S1 private storage names per word.
const PV = [
    { mask: '_ixMask', w: '_ixW', s1: '_ixS1', s2: '_ixS2', cnt: '_ixCnt' },
    { mask: '_ixMaskHi', w: '_ixWHi', s1: '_ixS1Hi', s2: '_ixS2Hi', cnt: '_ixCntHi' },
];

// w0Bits: array (maybe empty) of word-0 bit positions to index; hiBits: null (no Hi row) or array.
function mkArena(cap, w0Bits, hiBits, extra) {
    const a = new Arena(cap, extra);
    const F = a.registerFlags(NAMES, optOf(w0Bits));
    let H = null;
    if (hiBits !== null) H = a.registerFlagsHi(NAMES, optOf(hiBits));
    return { a, F, H };
}

// Expected column state per spec S1, derived from a list of ascending slots (never from the arena).
function checkColumns(label, a, word, b, slots) {
    const p = PV[word];
    const cap = a.capacity;
    const w = a[p.w][b], s1 = a[p.s1][b], s2 = a[p.s2][b];
    assert.equal(w.length, (cap + 31) >>> 5, label + ' W length');
    assert.ok(s1.length >= (((cap + 31) >>> 5) + 31) >>> 5, label + ' S1 length');
    const exp = new Int32Array(w.length);
    for (let i = 0; i < slots.length; i++) exp[slots[i] >>> 5] |= 1 << (slots[i] & 31);
    for (let k = 0; k < w.length; k++) if (w[k] !== exp[k]) assert.equal(w[k], exp[k], label + ' W[' + k + ']');
    const e1 = new Int32Array(s1.length);
    for (let k = 0; k < w.length; k++) if (exp[k] !== 0) e1[k >>> 5] |= 1 << (k & 31);
    for (let k = 0; k < s1.length; k++) if (s1[k] !== e1[k]) assert.equal(s1[k], e1[k], label + ' S1[' + k + ']');
    const e2 = new Int32Array(s2.length);
    for (let k = 0; k < s1.length; k++) if (e1[k] !== 0) e2[k >>> 5] |= 1 << (k & 31);
    for (let k = 0; k < s2.length; k++) if (s2[k] !== e2[k]) assert.equal(s2[k], e2[k], label + ' S2[' + k + ']');
    assert.equal(a[p.cnt][b], slots.length, label + ' count column');
}

// Ascending handle walk via the public surface; every handle must be alive.
function walk(a, word, flag) {
    const m = NM[word];
    const got = [];
    for (let h = a[m.first](flag); h !== -1; h = a[m.next](flag, h)) {
        assert.ok(a.isAlive(h), 'walk handle alive');
        got.push(h);
        if (got.length > a.capacity + 1) assert.fail('runaway walk');
    }
    return got;
}

const M18 = (m, which, got) => new RegExp('lite-arena: ' + m + '\\(\\) ' + which + ' mask must be a 32-bit integer, got ' + got.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' ');
const mkChecked = (w0, hi) => mkArena(64, w0, hi, { checked: true });

// ======================= A3 =======================
test('A3: checked + indexed setFlags(e, 1.5) throws the M-18 text, row and column unchanged; setFlags(e, F.a) -> flagCount 1', () => {
    const { a, F } = mkChecked([0, 5], null);
    const e = a.spawn();
    assert.throws(() => a.setFlags(e, 1.5), M18('setFlags', 'the', '1.5'));
    assert.throws(() => a.setFlags(e, 'x'), M18('setFlags', 'the', 'string'));
    assert.throws(() => a.setFlags(e), M18('setFlags', 'the', 'undefined'));
    assert.equal(a.flags[e & SLOT], 0);
    assert.equal(a.flagCount(F.n0), 0);
    a.setFlags(e, F.n0);
    assert.equal(a.flagCount(F.n0), 1, 'the installed ix body ran (column updated)');
    assert.equal(a.flagCount(F.n5), 0);
    assert.equal(a.firstFlagged(F.n0), e);
    assert.throws(() => a.clearFlags(e, 1.5), M18('clearFlags', 'the', '1.5'));
    assert.equal(a.flagCount(F.n0), 1, 'a throwing clearFlags is a no-op');
    assert.equal(a.flags[e & SLOT], F.n0);
    a.clearFlags(e, F.n0);
    assert.equal(a.flagCount(F.n0), 0);
    assert.equal(a.flags[e & SLOT], 0);
    // checked hasFlags still validates
    assert.throws(() => a.hasFlags(e, 1.5), M18('hasFlags', 'the required', '1.5'));
});

test('A3 (Hi): checked + indexed setFlagsHi(e, 1.5) throws the M-18 text; setFlagsHi(e, H.a) -> flagCountHi 1', () => {
    const { a, H } = mkChecked([0], [0, 31]);
    const e = a.spawn();
    assert.throws(() => a.setFlagsHi(e, 1.5), M18('setFlagsHi', 'the', '1.5'));
    assert.throws(() => a.setFlagsHi(e, null), M18('setFlagsHi', 'the', 'null'));
    assert.equal(a.flagsHi[e & SLOT], 0);
    assert.equal(a.flagCountHi(H.n31), 0);
    a.setFlagsHi(e, H.n31);
    assert.equal(a.flagCountHi(H.n31), 1);
    assert.equal(a.flagCountHi(H.n0), 0);
    assert.equal(a.firstFlaggedHi(H.n31), e);
    assert.throws(() => a.clearFlagsHi(e, 0.5), M18('clearFlagsHi', 'the', '0.5'));
    assert.equal(a.flagCountHi(H.n31), 1);
    a.clearFlagsHi(e, H.n31);
    assert.equal(a.flagCountHi(H.n31), 0);
    assert.throws(() => a.hasFlagsHi(e, 1.5), M18('hasFlagsHi', 'the required', '1.5'));
});

test('A3: despawn / mixed bits / uint32 masks / clearFlagAll in checked + indexed mode', () => {
    const { a, F, H } = mkChecked([0, 31], [31]);
    const e = a.spawn(), f = a.spawn();
    a.setFlags(e, 0x80000001);                      // uint32 form of bit 31 | bit 0 is accepted by M-18
    assert.equal(a.flagCount(F.n31), 1);
    assert.equal(a.flagCount(F.n0), 1);
    a.setFlags(f, F.n1 | F.n0);                     // n1 unindexed
    a.setFlagsHi(f, H.n31);
    assert.equal(a.flagCount(F.n0), 2);
    assert.equal(a.flagCountHi(H.n31), 1);
    assert.equal(a.despawn(f), true);
    assert.equal(a.flagCount(F.n0), 1, 'despawn updates the columns in checked mode');
    assert.equal(a.flagCountHi(H.n31), 0);
    a.clearFlagAll(F.n31);
    assert.equal(a.flagCount(F.n31), 0);
    assert.equal(a.flags[e & SLOT], 1);
    assert.deepEqual(walk(a, 0, F.n0), [e]);
});

// ======================= A4 checked =======================
test('A4 checked: flagCount / firstFlagged / clearFlagAll (+Hi) throw M-18 for non-int32 flags, E-BIT for int32 non-single-bit', () => {
    const { a, F, H } = mkChecked([0, 5], [31]);
    const bad = [[1.5, '1.5'], [NaN, 'NaN'], [2 ** 32, '4294967296'], [undefined, 'undefined'], ['1', 'string'], [null, 'null'], [{}, 'object']];
    for (const m of ['flagCount', 'firstFlagged', 'clearFlagAll']) {
        for (const [v, shown] of bad) {
            assert.throws(() => a[m](v), M18(m, 'the flag', shown), m + ' ' + String(v));
        }
        assert.throws(() => a[m](0), { message: `lite-arena: ${m}() needs exactly one indexed flag bit (indexed mask 0x00000021), got 0` });
        assert.throws(() => a[m](F.n0 | F.n5), { message: `lite-arena: ${m}() needs exactly one indexed flag bit (indexed mask 0x00000021), got 33` });
        assert.doesNotThrow(() => a[m](F.n5));
    }
    for (const m of ['flagCountHi', 'firstFlaggedHi', 'clearFlagAllHi']) {
        for (const [v, shown] of bad) {
            assert.throws(() => a[m](v), M18(m, 'the flag', shown), m + ' ' + String(v));
        }
        assert.throws(() => a[m](H.n0), { message: `lite-arena: ${m}() needs exactly one indexed flag bit (indexed mask 0x80000000), got 1` });
        assert.doesNotThrow(() => a[m](H.n31));
    }
    assert.equal(a.flagCount(1.0), 0, '1.0 is the integer 1');
});

test('A4 checked: flagCount(1.5) on a checked arena without indexed flags still throws M-18 first, then E-ROW for a valid flag', () => {
    const a = new Arena(8, { checked: true });
    a.registerFlags(['a']);
    assert.throws(() => a.flagCount(1.5), M18('flagCount', 'the flag', '1.5'));
    assert.throws(() => a.flagCount(1), { message: 'lite-arena: flagCount() needs registerFlags() with { indexed: [...] } first' });
});

test('A4 checked (M-41): nextFlagged E-BIT on flag, M-18 on flag and on prev', () => {
    const { a, F } = mkChecked([0, 5], null);
    const e = a.spawn();
    a.setFlags(e, F.n5);
    const ebit = (got) => ({ message: `lite-arena: nextFlagged() needs exactly one indexed flag bit (indexed mask 0x00000021), got ${got}` });
    assert.throws(() => a.nextFlagged(0, e), ebit('0'));
    assert.throws(() => a.nextFlagged(F.n0 | F.n5, e), ebit('33'));
    assert.throws(() => a.nextFlagged(F.n1, e), ebit('2'), 'unindexed bit');
    assert.throws(() => a.nextFlagged(1.5, e), M18('nextFlagged', 'the flag', '1.5'));
    assert.throws(() => a.nextFlagged(undefined, e), M18('nextFlagged', 'the flag', 'undefined'));
    for (const [v, shown] of [[1.5, '1.5'], [NaN, 'NaN'], [undefined, 'undefined'], ['x', 'string'], [null, 'null'], [2 ** 32, '4294967296']]) {
        assert.throws(() => a.nextFlagged(F.n5, v), M18('nextFlagged', 'the prev', shown), 'prev ' + String(v));
    }
    assert.throws(() => a.nextFlagged(F.n5), M18('nextFlagged', 'the prev', 'undefined'), 'prev omitted');
    // valid calls still walk
    assert.equal(a.firstFlagged(F.n5), e);
    assert.equal(a.nextFlagged(F.n5, e), -1);
    assert.equal(a.nextFlagged(F.n5, -1), -1);
});

test('A4 checked (M-41, Hi): nextFlaggedHi E-BIT on flag, M-18 on flag and on prev', () => {
    const { a, H } = mkChecked([0], [0, 31]);
    const e = a.spawn();
    a.setFlagsHi(e, H.n0);
    const ebit = (got) => ({ message: `lite-arena: nextFlaggedHi() needs exactly one indexed flag bit (indexed mask 0x80000001), got ${got}` });
    assert.throws(() => a.nextFlaggedHi(0, e), ebit('0'));
    assert.throws(() => a.nextFlaggedHi(H.n0 | H.n31, e), ebit(String(H.n0 | H.n31)));
    assert.throws(() => a.nextFlaggedHi(H.n1, e), ebit('2'));
    assert.throws(() => a.nextFlaggedHi(1.5, e), M18('nextFlaggedHi', 'the flag', '1.5'));
    for (const [v, shown] of [[1.5, '1.5'], [NaN, 'NaN'], [undefined, 'undefined'], ['x', 'string'], [null, 'null']]) {
        assert.throws(() => a.nextFlaggedHi(H.n0, v), M18('nextFlaggedHi', 'the prev', shown), 'prev ' + String(v));
    }
    assert.equal(a.firstFlaggedHi(H.n0), e);
    assert.equal(a.nextFlaggedHi(H.n0, e), -1);
});

test('A4 checked: a checked walk over indexed flags matches an unchecked twin', () => {
    const c = mkChecked([5], [0]);
    const u = mkArena(64, [5], [0]);
    const hs = [];
    for (let i = 0; i < 40; i++) {
        hs.push(c.a.spawn());
        assert.equal(u.a.spawn(), hs[i]);
        if (i % 3 === 0) { c.a.setFlags(hs[i], c.F.n5); u.a.setFlags(hs[i], u.F.n5); }
        if (i % 4 === 0) { c.a.setFlagsHi(hs[i], c.H.n0); u.a.setFlagsHi(hs[i], u.H.n0); }
    }
    assert.deepEqual(walk(c.a, 0, c.F.n5), walk(u.a, 0, u.F.n5));
    assert.deepEqual(walk(c.a, 1, c.H.n0), walk(u.a, 1, u.H.n0));
    assert.equal(walk(c.a, 0, c.F.n5).length, 14);   // i % 3 === 0 for i in 0..39 -> 14
    assert.equal(walk(c.a, 1, c.H.n0).length, 10);   // i % 4 === 0 for i in 0..39 -> 10
});
