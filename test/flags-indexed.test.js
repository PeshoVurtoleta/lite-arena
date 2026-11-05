/**
 * @zakkster/lite-arena -- F2 indexed flags, word 0 (PLAN-F2 A1, A2, A4 production validation,
 * A5 word-0 GC parts; spec S1-S5 + S7, DECISIONS M-35..M-42). Expected values come from the
 * PLAN-F2 SPEC / ASSERTIONS and a harness-owned mirror, never from the build under test.
 *
 * Run: `node --test test/flags-indexed.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/flags-indexed.test.js
 * (every test touching F2 surface fails on the frozen fe8d7d5 build, which has no `indexed` option).
 *
 * A5 here is RETENTION only (M-50): the allocation gate is torture Phase N maxMinor 0 (U5) + test/flags-indexed-alloc.test.js scavenge counts (U7, M-46).
 *
 * MUTANT -> TEST MAP (reviewer applies these to Arena.js):
 *  A1 S1 zeroed mid-walk (clearFlagAll zeroes a summary before the walk ends) ->
 *       'A1 pin: clearFlagAll over 4,000 rows (2,667 flagged) ...' (rows must all clear) and the oracle's clearFlagAll ops.
 *  A1 no ixGrow (reserve() keeps old columns)  -> 'A1 pin: reserve() grows the columns ...' and the oracle (op 25,000).
 *  A1 no ixReset (clear() keeps columns)       -> 'A1 pin: clear() resets ...' and the oracle (op 40,000).
 *  A1 despawn not installed                    -> 'A1 pin: despawn removes ...' and the oracle.
 *  A2 nextFlagged requiring isAlive(prev)      -> 'A2: despawning the current entity ...' (visits only 1 of 4).
 *  A4 (production validation) -> the 'A4 ...' tests; a mutant that skips the E-BIT / E-ROW throw is caught by
 *       the verbatim message asserts; Object.prototype.indexed leaking is caught by 'A4 Object.prototype.indexed'.
 *  A5 -> 'A5 ...' tests (arrayBuffers retention delta, drain retention). The Phase N major / minor GC windows and the lite-leak
 *       tracker.size() part belong to test/torture.mjs (later unit) and are NOT here.
 *
 * Unchanged-behaviour tests that PASS on the frozen build: 'A4 Object.prototype.indexed is ignored'
 * (no-option registration installs nothing there too).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

if (process.env.LITE_ARENA_PATH) {
    test('build under test (LITE_ARENA_PATH)', (t) => { t.diagnostic('LITE_ARENA_PATH=' + process.env.LITE_ARENA_PATH); });
}

// ---- shared helpers (duplicated across the three F2 test files on purpose) ----
// mulberry32: 32-bit-exact seeded PRNG (Math.imul / >>> 0 only).
function mulberry32(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (t ^ (t >>> 14)) >>> 0;
    };
}
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

// ---- A1 oracle: indexed arena vs plain twin vs a harness-owned mirror ----
// cfg: { seed, ops, w0Bits, hiBits (null | []), reserveAt, clearAt, checkEvery }
function runOracle(cfg) {
    const { a, F, H } = mkArena(CAP0, cfg.w0Bits, cfg.hiBits);
    const t = mkArena(CAP0, [], cfg.hiBits === null ? null : []).a;
    const hasHi = H !== null;
    const rOp = mulberry32(cfg.seed);                 // op kind stream
    const rKey = mulberry32(cfg.seed ^ 0x9E3779B9);   // key / target stream
    const rMask = mulberry32(cfg.seed ^ 0x85EBCA6B);  // mask stream
    const mrow = [new Int32Array(CAP1), new Int32Array(CAP1)];
    const liveSlot = new Uint8Array(CAP1);
    const hAt = new Int32Array(CAP1);
    let live = [];
    let stale = 0;
    let reserved = false;
    const targets = [];
    for (const b of cfg.w0Bits) targets.push({ word: 0, bit: b });
    if (hasHi) for (const b of cfg.hiBits) targets.push({ word: 1, bit: b });
    const cov = { spawn: 0, despawn: 0, stale: 0, set: 0, clr: 0, clearAll: 0, query: 0, checks: 0, maxCount: 0, walked: 0, maxSlotAfterReserve: -1 };

    const nextMask = () => {
        const r = rMask();
        switch (r % 8) {
            case 0: return -1;
            case 1: return 1 << ((r >>> 8) & 31);
            case 2: return rMask() | 0;
            case 3: return 0;
            case 4: return (rMask() & rMask()) | 0;
            case 5: return 1 << cfg.w0Bits[(r >>> 8) % cfg.w0Bits.length];
            case 6: return (rMask() & rMask() & rMask()) | 0;
            default: return (rMask() | rMask()) | 0;
        }
    };
    const slotsOf = (word, bit) => {
        const out = [];
        const cap = a.capacity;
        for (let s = 0; s < cap; s++) if (liveSlot[s] === 1 && (mrow[word][s] & (1 << bit)) !== 0) out.push(s);
        return out;
    };
    const check = (label) => {
        cov.checks++;
        const cap = a.capacity;
        for (let s = 0; s < cap; s++) {
            if (a.flags[s] !== mrow[0][s]) assert.equal(a.flags[s], mrow[0][s], label + ' row0 slot ' + s);
            if (t.flags[s] !== mrow[0][s]) assert.equal(t.flags[s], mrow[0][s], label + ' twin row0 slot ' + s);
            if (hasHi) {
                if (a.flagsHi[s] !== mrow[1][s]) assert.equal(a.flagsHi[s], mrow[1][s], label + ' row1 slot ' + s);
                if (t.flagsHi[s] !== mrow[1][s]) assert.equal(t.flagsHi[s], mrow[1][s], label + ' twin row1 slot ' + s);
            }
        }
        for (const tg of targets) {
            const flag = 1 << tg.bit;
            const m = NM[tg.word];
            const slots = slotsOf(tg.word, tg.bit);
            const lbl = label + ' w' + tg.word + 'b' + tg.bit;
            assert.equal(a[m.count](flag), slots.length, lbl + ' flagCount');
            const want = slots.map((s) => hAt[s]);
            assert.deepEqual(walk(a, tg.word, flag), want, lbl + ' walk');
            checkColumns(lbl, a, tg.word, tg.bit, slots);
            cov.walked += want.length;
            if (slots.length > cov.maxCount) cov.maxCount = slots.length;
        }
    };

    for (let op = 0; op < cfg.ops; op++) {
        if (op === cfg.reserveAt) {
            assert.equal(a.reserve(CAP1), true);
            assert.equal(t.reserve(CAP1), true);
            reserved = true;
            check('after reserve @' + op);
        }
        if (op === cfg.clearAt) {
            a.clear(); t.clear();
            mrow[0].fill(0); mrow[1].fill(0); liveSlot.fill(0); live = [];
            check('after clear @' + op);
        }
        let k = rOp() % 100;
        if (!hasHi && k >= 72 && k < 90) k = k < 82 ? 27 : 52;
        if (k < 15 && live.length >= a.capacity) k = 15;
        if (k < 15) {
            const h = a.spawn();
            assert.equal(t.spawn(), h, 'twin spawn handle');
            const s = slotOf(h);
            assert.equal(liveSlot[s], 0, 'spawned a live slot');
            liveSlot[s] = 1; hAt[s] = h; live.push(h);
            if (reserved && s > cov.maxSlotAfterReserve) cov.maxSlotAfterReserve = s;
            mrow[0][s] = 0; mrow[1][s] = 0;
            cov.spawn++;
        } else if (k < 25 || k < 27) {
            if (k < 25) {
                if (live.length === 0) continue;
                const i = rKey() % live.length;
                const h = live[i];
                live[i] = live[live.length - 1]; live.pop();
                assert.equal(a.despawn(h), true);
                assert.equal(t.despawn(h), true);
                const s = slotOf(h);
                liveSlot[s] = 0; mrow[0][s] = 0; mrow[1][s] = 0;
                stale = h;
                cov.despawn++;
            } else if (stale !== 0) {
                assert.equal(a.despawn(stale), false, 'stale despawn');
                assert.equal(t.despawn(stale), false, 'twin stale despawn');
                cov.stale++;
            }
        } else if (k < 72 || (k >= 72 && k < 90)) {
            if (live.length === 0) continue;
            const h = live[rKey() % live.length];
            const s = slotOf(h);
            const m = nextMask();
            const isSet = (k >= 27 && k < 52) || (k >= 72 && k < 82);
            const word = k >= 72 ? 1 : 0;
            const nm = NM[word];
            const ra = a[isSet ? nm.set : nm.clr](h, m);
            const rt = t[isSet ? nm.set : nm.clr](h, m);
            assert.equal(ra, rt, 'twin return value');
            if (isSet) { mrow[word][s] |= m; cov.set++; } else { mrow[word][s] &= ~m; cov.clr++; }
        } else if (k === 90) {
            if (targets.length === 0) continue;
            const tg = targets[rKey() % targets.length];
            const flag = 1 << tg.bit;
            const nm = NM[tg.word];
            a[nm.clearAll](flag);
            for (let i = 0; i < live.length; i++) t[nm.clr](live[i], flag);
            for (let s = 0; s < a.capacity; s++) mrow[tg.word][s] &= ~flag;
            cov.clearAll++;
        } else {
            if (targets.length === 0) continue;
            const tg = targets[rKey() % targets.length];
            const flag = 1 << tg.bit;
            assert.equal(a[NM[tg.word].count](flag), slotsOf(tg.word, tg.bit).length, 'sampled flagCount');
            cov.query++;
        }
        if ((op + 1) % cfg.checkEvery === 0) check('op ' + op);
    }
    check('final');
    cov.reserved = cfg.reserveAt >= 0;
    return { a, t, cov, targets, live: () => live.length };
}

function oracleFloor(cov, nTargets) {
    assert.ok(cov.spawn >= 3000, 'spawn ' + cov.spawn);
    assert.ok(cov.despawn >= 2000, 'despawn ' + cov.despawn);
    assert.ok(cov.stale >= 100, 'stale ' + cov.stale);
    assert.ok(cov.set >= 6000, 'set ' + cov.set);
    assert.ok(cov.clr >= 6000, 'clr ' + cov.clr);
    assert.ok(cov.clearAll >= 300, 'clearAll ' + cov.clearAll);
    assert.ok(cov.query >= 300, 'query ' + cov.query);
    assert.ok(cov.checks >= 100, 'checks ' + cov.checks);
    assert.ok(cov.maxCount >= 100, 'maxCount ' + cov.maxCount);
    if (cov.reserved) assert.ok(cov.maxSlotAfterReserve >= CAP0, 'run never used the grown region: ' + cov.maxSlotAfterReserve);
    assert.ok(cov.walked >= 1000 * nTargets, 'walked ' + cov.walked);
}
const W0 = [0, 5, 31];

// ======================= A1 =======================

test('A1 oracle: word-0 indexed {0,5,31}, 50,000 seeded ops vs plain twin + mirror', () => {
    const r = runOracle({ seed: 0xA1F2, ops: 50000, w0Bits: W0, hiBits: null, reserveAt: 25000, clearAt: 40000, checkEvery: 500 });
    oracleFloor(r.cov, W0.length);
    assert.equal(r.a._ixMask, (1 | (1 << 5) | (1 << 31)), 'word-0 indexed mask (int32, bit 31 negative)');
    assert.equal(r.t._ixMask, 0, 'plain twin has no indexed mask');
    assert.equal(r.a.capacity, CAP1);
});

test('A1 oracle: second seed, no reserve / clear, dense rows', () => {
    const r = runOracle({ seed: 0x51DE, ops: 20000, w0Bits: [31], hiBits: null, reserveAt: -1, clearAt: -1, checkEvery: 400 });
    assert.ok(r.cov.set >= 2000 && r.cov.clearAll >= 100, JSON.stringify(r.cov));
});

test('A1 pin: set / clear are transitions (double set counts once, clear of unset is a no-op)', () => {
    const { a, F } = mkArena(64, [0, 5, 31], null);
    const e = a.spawn();
    const f = a.spawn();
    a.setFlags(e, F.n0); a.setFlags(e, F.n0);
    assert.equal(a.flagCount(F.n0), 1);
    a.setFlags(e, F.n1 | F.n5);            // n1 is not indexed
    assert.equal(a.flagCount(F.n5), 1);
    a.clearFlags(f, F.n0 | F.n5);          // f has neither
    assert.equal(a.flagCount(F.n0), 1);
    assert.equal(a.flagCount(F.n5), 1);
    a.setFlags(f, -1);
    assert.equal(a.flagCount(F.n0), 2);
    assert.equal(a.flagCount(F.n31), 1);   // bit 31 = -2147483648
    a.setFlags(e, -1);
    assert.equal(a.flagCount(F.n31), 2);
    a.clearFlags(e, -1);
    assert.equal(a.flagCount(F.n0), 1);
    assert.equal(a.flagCount(F.n31), 1);
    assert.equal(a.flags[e & SLOT], 0);
    assert.equal(a.hasFlags(f, F.n0 | F.n31), true);
});

test('A1 pin: clearFlagAll over 4,000 rows (2,667 flagged) clears every flagged row bit, keeps other bits, zeroes summaries and count (S1 not zeroed mid-walk)', () => {
    const { a, F } = mkArena(CAP0, W0, null);
    const hs = [];
    for (let i = 0; i < 4000; i++) hs.push(a.spawn());
    const orig = new Int32Array(CAP0);
    for (let i = 0; i < 4000; i++) {
        const s = slotOf(hs[i]);
        let m = F.n1 | F.n5;                       // n1 unindexed, n5 indexed on every row
        if (i % 3 !== 1) m |= F.n0;                // ~2667 rows carry n0 (spans every W word and S1 word)
        a.setFlags(hs[i], m);
        orig[s] = m;
    }
    assert.equal(a.flagCount(F.n5), 4000);
    const n0Rows = 4000 - Math.floor((4000 + 1) / 3);
    assert.equal(a.flagCount(F.n0), n0Rows);
    a.clearFlagAll(F.n0);
    for (let i = 0; i < 4000; i++) {
        const s = slotOf(hs[i]);
        assert.equal(a.flags[s], orig[s] & ~F.n0, 'row ' + s);
    }
    assert.equal(a.flagCount(F.n0), 0);
    assert.equal(a.firstFlagged(F.n0), -1);
    checkColumns('after clearAll n0', a, 0, 0, []);
    // the other indexed bit is untouched, column included
    assert.equal(a.flagCount(F.n5), 4000);
    checkColumns('n5 intact', a, 0, 5, Array.from(hs, slotOf).sort((x, y) => x - y));
    // reuse after clearAll: counts / summaries are consistent
    a.setFlags(hs[3999], F.n0); a.setFlags(hs[2], F.n0);
    assert.equal(a.flagCount(F.n0), 2);
    assert.deepEqual(walk(a, 0, F.n0), [hs[2], hs[3999]].sort((x, y) => slotOf(x) - slotOf(y)));
});

test('A1 pin: reserve() grows the columns and keeps the flagged set (no ixGrow)', () => {
    const { a, F } = mkArena(64, W0, null);
    const early = [];
    for (let i = 0; i < 64; i++) early.push(a.spawn());
    a.setFlags(early[5], F.n0); a.setFlags(early[63], F.n0);
    assert.equal(a.reserve(5000), true);
    assert.equal(a._ixW[0].length, (5000 + 31) >>> 5, 'W regrown to the new capacity');
    assert.equal(a.flagCount(F.n0), 2, 'count survives reserve');
    const more = [];
    for (let i = 0; i < 10; i++) more.push(a.spawn());   // new slots are handed out first
    for (const h of more) a.setFlags(h, F.n0);
    assert.ok(more.some((h) => slotOf(h) >= 64), 'grown slots in use');
    const want = [early[5], early[63], ...more].sort((x, y) => slotOf(x) - slotOf(y));
    assert.equal(a.flagCount(F.n0), want.length);
    assert.deepEqual(walk(a, 0, F.n0), want);
    checkColumns('grown', a, 0, 0, want.map(slotOf));
});

test('A1 pin: clear() resets columns, summaries and counts to 0 (no ixReset)', () => {
    const { a, F } = mkArena(CAP0, W0, null);
    for (let i = 0; i < 3000; i++) a.setFlags(a.spawn(), i % 2 === 0 ? -1 : F.n5);
    assert.ok(a.flagCount(F.n5) === 3000 && a.flagCount(F.n0) === 1500);
    a.clear();
    for (const b of W0) {
        assert.equal(a.flagCount(1 << b), 0, 'count b' + b);
        assert.equal(a.firstFlagged(1 << b), -1, 'first b' + b);
        checkColumns('cleared b' + b, a, 0, b, []);
    }
    const e = a.spawn();
    a.setFlags(e, F.n0);
    assert.equal(a.flagCount(F.n0), 1);
    assert.deepEqual(walk(a, 0, F.n0), [e]);
});

test('A1 pin: despawn removes the entity from every indexed column (despawn installed)', () => {
    const { a, F } = mkArena(128, W0, null);
    const hs = [];
    for (let i = 0; i < 100; i++) hs.push(a.spawn());
    for (let i = 0; i < 100; i += 2) a.setFlags(hs[i], F.n0 | F.n5 | F.n31);
    assert.equal(a.flagCount(F.n5), 50);
    assert.equal(a.despawn(hs[10]), true);
    assert.equal(a.despawn(hs[10]), false);
    assert.equal(a.flagCount(F.n0), 49);
    assert.equal(a.flagCount(F.n5), 49);
    assert.equal(a.flagCount(F.n31), 49);
    assert.ok(!walk(a, 0, F.n0).includes(hs[10]));
    const e2 = a.spawn();                          // reuses slot 10 (LIFO free list) with a fresh generation
    assert.equal(slotOf(e2), slotOf(hs[10]));
    assert.equal(a.flagCount(F.n0), 49, 'a reused slot starts unflagged');
    a.setFlags(e2, F.n0);
    const w = walk(a, 0, F.n0);
    assert.equal(w.length, 50);
    assert.ok(w.includes(e2) && !w.includes(hs[10]), 'walk yields the CURRENT-generation handle');
});

// ======================= A2 (M-39) =======================
function a2Arena(word) {
    const { a, F, H } = mkArena(2100, [0, 5], word === 1 ? [0, 31] : null);
    const hs = [];
    for (let i = 0; i < 2001; i++) {
        hs.push(a.spawn());
        assert.equal(slotOf(hs[i]), i, 'fresh arena hands out slots in order');
    }
    const flag = word === 0 ? F.n5 : H.n31;
    for (const s of [3, 40, 41, 1000]) a[NM[word].set](hs[s], flag);
    return { a, hs, flag, m: NM[word] };
}

test('A2: despawning the current entity mid-walk still visits all 4 (nextFlagged continues from the slot)', () => {
    const { a, hs, flag, m } = a2Arena(0);
    const seen = [];
    for (let h = a[m.first](flag); h !== -1; h = a[m.next](flag, h)) { seen.push(slotOf(h)); a.despawn(h); }
    assert.deepEqual(seen, [3, 40, 41, 1000]);
    assert.equal(a[m.count](flag), 0);
    assert.equal(a[m.first](flag), -1);
    assert.equal(a.isAlive(hs[3]), false);
});

test('A2: clearing the flag on the current entity mid-walk still visits all 4, count ends 0', () => {
    const { a, flag, m } = a2Arena(0);
    const seen = [];
    for (let h = a[m.first](flag); h !== -1; h = a[m.next](flag, h)) { seen.push(slotOf(h)); a[m.clr](h, flag); }
    assert.deepEqual(seen, [3, 40, 41, 1000]);
    assert.equal(a[m.count](flag), 0);
});

test('A2: a flag set mid-walk on a HIGHER slot is visited, on a LOWER slot is not', () => {
    const { a, hs, flag, m } = a2Arena(0);
    const seen = [];
    for (let h = a[m.first](flag); h !== -1; h = a[m.next](flag, h)) {
        const s = slotOf(h);
        seen.push(s);
        if (s === 3) a[m.set](hs[2000], flag);
        if (s === 40) a[m.set](hs[1], flag);
    }
    assert.deepEqual(seen, [3, 40, 41, 1000, 2000]);
    assert.equal(a[m.count](flag), 6, 'slot 1 stays flagged');
    assert.equal(a[m.first](flag), hs[1]);
});

test('A2: end of walk and generation handling', () => {
    const { a, F } = mkArena(100, [5], null);
    const hs = [];
    for (let i = 0; i < 100; i++) hs.push(a.spawn());
    a.setFlags(hs[99], F.n5);
    assert.equal(a.firstFlagged(F.n5), hs[99]);
    assert.equal(a.nextFlagged(F.n5, hs[99]), -1, 'prev at the last slot -> -1');
    assert.equal(a.nextFlagged(F.n5, -1), -1, 'prev = -1 (slot 0xFFFFF >= capacity) -> -1');
    // a stale prev (older generation of its slot) still continues from the SLOT
    a.despawn(hs[7]);
    assert.equal(a.nextFlagged(F.n5, hs[7]), hs[99]);
    // handles carry the slot's CURRENT generation
    const h2 = a.spawn();                                   // slot 7, generation + 1
    assert.equal(slotOf(h2), 7);
    assert.notEqual(h2, hs[7]);
    a.setFlags(h2, F.n5);
    assert.equal(a.firstFlagged(F.n5), h2);
    assert.equal(a.nextFlagged(F.n5, h2), hs[99]);
});

// ======================= A4 production validation =======================

// After a registration throw every S1 field keeps its constructor value (PLAN-F2 S1 + A4) and nothing is installed.
function assertPristine(a, word, label) {
    const p = PV[word];
    assert.equal(a[p.mask], 0, label + ' ' + p.mask);
    for (const k of [p.w, p.s1, p.s2, p.cnt]) assert.equal(a[k], null, label + ' ' + k);
    for (const m of ['setFlags', 'clearFlags', 'despawn', 'setFlagsHi', 'clearFlagsHi'])
        assert.equal(Object.hasOwn(a, m), false, label + ' no own ' + m);
}
const msgBit = (m, mask, got) => `lite-arena: ${m}() needs exactly one indexed flag bit (indexed mask 0x${mask}), got ${got}`;

test('A4: E-BIT verbatim for 0, 2 bits, an unindexed bit, undefined, a string, NaN (flagCount / firstFlagged / clearFlagAll)', () => {
    const a = new Arena(8);
    const F = a.registerFlags(['a', 'b', 'c'], { indexed: ['a', 'c'] });   // a = 1, b = 2 (unindexed), c = 4
    const cases = [[0, '0'], [3, '3'], [F.b, '2'], [5, '5'], [undefined, 'undefined'], ['a', 'string'], [NaN, 'NaN']];
    for (const method of ['flagCount', 'firstFlagged', 'clearFlagAll']) {
        for (const [bad, shown] of cases) {
            assert.throws(() => a[method](bad), { message: msgBit(method, '00000005', shown) }, method + ' ' + String(bad));
        }
        assert.doesNotThrow(() => a[method](F.a));
        assert.doesNotThrow(() => a[method](F.c));
    }
    assert.equal(a.flagCount(F.a), 0);
});

test('A4: E-ROW verbatim before registerFlags and with no indexed flag', () => {
    const row = (m) => `lite-arena: ${m}() needs registerFlags() with { indexed: [...] } first`;
    const a = new Arena(8);
    for (const m of ['flagCount', 'firstFlagged', 'clearFlagAll']) {
        assert.throws(() => a[m](1), { message: row(m) }, m + ' before register');
    }
    // production nextFlagged trusts its flag (M-39): no E-ROW / E-BIT contract on it.
    const b = new Arena(8);
    b.registerFlags(['a']);
    for (const m of ['flagCount', 'firstFlagged', 'clearFlagAll']) {
        assert.throws(() => b[m](1), { message: row(m) }, m + ' registered, none indexed');
    }
    const c = new Arena(8);
    c.registerFlags(['a'], { indexed: [] });
    assert.throws(() => c.flagCount(1), { message: row('flagCount') }, '{ indexed: [] } indexes nothing');
});

test('A4: R1 unknown options key', () => {
    const a = new Arena(4);
    assert.throws(() => a.registerFlags(['a'], { k: 1 }), { message: 'lite-arena: registerFlags options accept only "indexed"; got k' });
    assert.equal(a.flags, null);
    assertPristine(a, 0, 'R1');
    const s = Symbol('s');
    assert.throws(() => a.registerFlags(['a'], { [s]: 1 }), { message: 'lite-arena: registerFlags options accept only "indexed"; got Symbol(s)' });
    assert.equal(a.flags, null);
    assertPristine(a, 0, 'R1 symbol');
});

test('A4: R2 options.indexed must be an array of names', () => {
    for (const [bad, shown] of [['a', 'string'], [5, 'number'], [null, 'null'], [{}, 'object'], [undefined, 'undefined']]) {
        const a = new Arena(4);
        assert.throws(() => a.registerFlags(['a'], { indexed: bad }),
            { message: `lite-arena: registerFlags options.indexed must be an array of flag names, got ${shown}` }, shown);
        assert.equal(a.flags, null, 'no row after R2 ' + shown);
        assertPristine(a, 0, 'R2 ' + shown);
    }
});

test('A4: R3 unknown or duplicate indexed name; a throw leaves flags null and no columns', () => {
    const a = new Arena(4);
    assert.throws(() => a.registerFlags(['a', 'b'], { indexed: ['zz'] }),
        { message: 'lite-arena: registerFlags options.indexed #0 ("zz") is not one of the names, or a duplicate' });
    assert.equal(a.flags, null);
    assertPristine(a, 0, 'R3 zz');
    assert.throws(() => a.registerFlags(['a', 'b'], { indexed: ['a', 'a'] }),
        { message: 'lite-arena: registerFlags options.indexed #1 ("a") is not one of the names, or a duplicate' });
    assert.equal(a.flags, null);
    assertPristine(a, 0, 'R3 dup');
    assert.throws(() => a.registerFlags(['a'], { indexed: ['a', 5] }),
        { message: 'lite-arena: registerFlags options.indexed #1 (number) is not one of the names, or a duplicate' });
    assert.equal(a.flags, null);
    assertPristine(a, 0, 'R3 non-string');
    // the arena is still registrable after the throws
    const F = a.registerFlags(['a', 'b'], { indexed: ['b'] });
    assert.equal(F.b, 2);
    assert.equal(a.flagCount(F.b), 0);
});

test('A4: registration installs nothing without a non-empty indexed list (S2)', () => {
    for (const o of [undefined, null, {}, { indexed: [] }, Object.create(null)]) {
        const a = new Arena(4);
        a.registerFlags(['a'], o);
        for (const m of ['setFlags', 'clearFlags', 'despawn']) assert.equal(Object.hasOwn(a, m), false, m);
        assert.equal(a._ixMask | 0, 0);
    }
    const b = new Arena(4);
    b.registerFlags(['a'], { indexed: ['a'] });
    for (const m of ['setFlags', 'clearFlags', 'despawn']) assert.equal(Object.hasOwn(b, m), true, 'indexed installs own ' + m);
});

test('A4 Object.prototype.indexed is ignored (only an OWN key counts)', () => {
    Object.prototype.indexed = ['a'];
    try {
        const a = new Arena(4);
        const F = a.registerFlags(['a'], {});
        assert.equal(F.a, 1);
        assert.equal(Object.hasOwn(a, 'setFlags'), false);
        assert.equal(a._ixMask | 0, 0);
        const b = new Arena(4);
        b.registerFlags(['a'], Object.create(null));
        assert.equal(Object.hasOwn(b, 'setFlags'), false);
    } finally {
        delete Object.prototype.indexed;
    }
});

// gc without a CLI flag (same effect as --expose-gc): deterministic arrayBuffers reads.
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
// Full GC repeated until arrayBuffers stops moving (backing stores are released by background sweepers).
async function settledArrayBuffers() {
    let prev = -1;
    for (let i = 0; i < 100; i++) {
        gc();
        await new Promise((r) => setImmediate(r));
        const cur = process.memoryUsage().arrayBuffers;
        if (cur === prev) return cur;
        prev = cur;
    }
    return prev;
}

// ======================= A5 word-0 (GC) =======================
// arrayBuffers RETENTION delta 0 over 100,000 indexed ops (columns never reallocate on the op loop; gc-settled reads,
// so this does not see transient allocation: M-50) and retention
// after 3 cycles. Phase N windows (maxMajor / maxMinor 0) and tracker.size() live in test/torture.mjs.
function a5Ops(a, F, H, n, seed) {
    const r = mulberry32(seed);
    const flags0 = [F.n0, F.n5, F.n31];
    const hs = new Int32Array(a.capacity);
    let nLive = 0, sink = 0;
    for (let i = 0; i < n; i++) {
        const x = r();
        const k = x % 8;
        if (k === 0 && nLive < hs.length) { hs[nLive++] = a.spawn(); }
        else if (k === 1 && nLive > 0) { const j = (x >>> 4) % nLive; a.despawn(hs[j]); hs[j] = hs[--nLive]; }
        else if (k === 2 && nLive > 0) { a.setFlags(hs[(x >>> 4) % nLive], r() | 0); }
        else if (k === 3 && nLive > 0) { a.clearFlags(hs[(x >>> 4) % nLive], r() | 0); }
        else if (k === 4 && H !== null && nLive > 0) { a.setFlagsHi(hs[(x >>> 4) % nLive], r() | 0); }
        else if (k === 5) { sink += a.flagCount(flags0[(x >>> 4) % 3]); if (H !== null) sink += a.flagCountHi(H.n31); }
        else if (k === 6) {
            const f = flags0[(x >>> 4) % 3];
            for (let h = a.firstFlagged(f), c = 0; h !== -1 && c < 8; h = a.nextFlagged(f, h), c++) sink += h & 1;
            if (H !== null) for (let h = a.firstFlaggedHi(H.n0), c = 0; h !== -1 && c < 8; h = a.nextFlaggedHi(H.n0, h), c++) sink += h & 1;
        }
        else if (k === 7 && nLive > 0) { a.clearFlags(hs[(x >>> 4) % nLive], -1); if (H !== null) a.clearFlagsHi(hs[(x >>> 4) % nLive], -1); }
    }
    return sink;
}

test('A5 (word 0): 100,000 indexed ops retain 0 B of arrayBuffers after warm-up', async () => {
    const { a, F } = mkArena(CAP0, W0, null);
    a5Ops(a, F, null, 30000, 0xA5A5);        // warm-up (JIT + any lazy one-time state)
    const before = await settledArrayBuffers();   // earlier tests' buffers are gone, nothing frees in the window
    const sink = a5Ops(a, F, null, 100000, 0x5A5A);
    const after = await settledArrayBuffers();
    assert.equal(after - before, 0, 'arrayBuffers delta (sink ' + sink + ')');
});

function drainRetention(word0Only) {
    const { a, F, H } = mkArena(CAP0, W0, word0Only ? null : [0, 31]);
    const r = mulberry32(0xCAFE);
    for (let cycle = 0; cycle < 3; cycle++) {
        const hs = [];
        for (let i = 0; i < CAP0; i++) {
            const h = a.spawn();
            hs.push(h);
            a.setFlags(h, (r() | 0) | F.n0);
            if (!word0Only) a.setFlagsHi(h, (r() | 0) | H.n0);
        }
        assert.equal(a.flagCount(F.n0), CAP0, 'full before drain, cycle ' + cycle);
        if (cycle === 0) for (let i = hs.length - 1; i > 0; i--) { const j = r() % (i + 1); const t = hs[i]; hs[i] = hs[j]; hs[j] = t; }
        if (cycle === 1) { for (const b of W0) a.clearFlagAll(1 << b); if (!word0Only) { a.clearFlagAllHi(H.n0); a.clearFlagAllHi(H.n31); } }
        if (cycle === 2) a.clear();
        else for (const h of hs) a.despawn(h);
        let orRow = 0, orHi = 0;
        for (let s = 0; s < CAP0; s++) { orRow |= a.flags[s]; if (!word0Only) orHi |= a.flagsHi[s]; }
        assert.equal(a.activeCount, 0, 'activeCount, cycle ' + cycle);
        for (const b of W0) { assert.equal(a.flagCount(1 << b), 0); assert.equal(a.firstFlagged(1 << b), -1); }
        if (!word0Only) for (const f of [H.n0, H.n31]) { assert.equal(a.flagCountHi(f), 0); assert.equal(a.firstFlaggedHi(f), -1); }
        assert.equal(orRow | orHi, 0, 'row OR, cycle ' + cycle);
        for (const b of W0) checkColumns('retained b' + b + ' c' + cycle, a, 0, b, []);
    }
}

test('A5 (word 0): retention after 3 drain cycles (despawn / clearFlagAll+despawn / clear) -> counts 0, row OR 0', () => {
    drainRetention(true);
});
