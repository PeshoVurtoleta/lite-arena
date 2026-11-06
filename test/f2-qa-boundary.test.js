/**
 * @zakkster/lite-arena -- F2 indexed flags, U8 qa boundary matrix (PLAN-F2 A1 / A2 / A4 / A9 gaps).
 * Oracle: a harness scan of the rows (the A1 row oracle: live handles whose row carries the bit, ascending
 * slot) plus independent counts / handle lists the test derives itself (spawn handles, spec S1-S7, M-25,
 * M-36, M-39, M-41). Deterministic, no timing, no .handoff reads.
 *
 * Run: `node --test test/f2-qa-boundary.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/f2-qa-boundary.test.js
 *
 * Rows the existing F2 suites do not reach (they run at capacity <= 8192, so the S2 summary has one
 * word; generations stay far below 1024):
 *  - capacity edges 1 / 31 / 32 / 33 / 1023-1025 / 32767-32769 / 65537 / 1048575 (S1 and S2 word edges)
 *  - reserve() across the S2 word edge (ixGrow rebuilds S2 words > 0)
 *  - generation wrap: handles past 2^30 (gen 1024), the sign bit (gen 2048) and retirement (gen 4095)
 *  - stale / duplicate despawn after slot reuse; dispose-during-iteration; re-entrant writes
 *  - the integer matrix for masks and flags (-1, -0, NaN, null, undefined, 2^30 .. 2^53)
 *  - registration options: [] / null / undefined / a hole / 32 of 32 names / Object.prototype names
 *  - joinN hint with an empty driver (count 0) and a count-0 flag
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

const NAMES = [];
for (let i = 0; i < 32; i++) NAMES.push('f' + i);
const B0 = 1, B30 = 1 << 30, B31 = 1 << 31; // B31 === -2147483648
const E_BIT = /needs exactly one indexed flag bit/;
const E_ROW = /needs registerFlags(Hi)?\(\) with \{ indexed: \[\.\.\.\] \} first/;
const M18 = /mask must be a 32-bit integer/;

function walk(a, flag) {
    const out = [];
    for (let e = a.firstFlagged(flag); e !== -1; e = a.nextFlagged(flag, e)) {
        out.push(e);
        if (out.length > a.capacity) throw new Error('walk did not terminate');
    }
    return out;
}

function walkHi(a, flag) {
    const out = [];
    for (let e = a.firstFlaggedHi(flag); e !== -1; e = a.nextFlaggedHi(flag, e)) {
        out.push(e);
        if (out.length > a.capacity) throw new Error('walkHi did not terminate');
    }
    return out;
}

// Harness scan: handles of live rows carrying bit `flag`, ascending slot (true definition).
function scan(a, hs, flag) {
    const out = [];
    for (let i = 0; i < hs.length; i++) {
        const e = hs[i];
        if (e !== -1 && a.isAlive(e) && (a.flags[e & 0xFFFFF] & flag) !== 0) out.push(e);
    }
    return out.sort((x, y) => (x & 0xFFFFF) - (y & 0xFFFFF));
}

function fullArena(cap) {
    const a = new Arena(cap);
    const F = a.registerFlags(NAMES, { indexed: ['f0', 'f31'] });
    const hs = new Array(cap);
    for (let i = 0; i < cap; i++) hs[i] = a.spawn();
    let bad = -1;
    for (let i = 0; i < cap && bad === -1; i++) if ((hs[i] & 0xFFFFF) !== i) bad = i;
    assert.equal(bad, -1, 'spawn order is slot order');
    return { a, F, hs };
}

test('QA caps 1 / 31 / 32 / 33 / 1023-1025 / 32767-32769 / 65537: empty, word / S1 / S2 edges and full == scan', () => {
    for (const cap of [1, 31, 32, 33, 1023, 1024, 1025, 32767, 32768, 32769, 65537]) {
        const { a, hs } = fullArena(cap);
        for (const flag of [B0, B31]) {
            const tag = ' cap ' + cap + ' flag ' + (flag >>> 0).toString(16);
            assert.equal(a.firstFlagged(flag), -1, 'empty first' + tag);
            assert.equal(a.flagCount(flag), 0, 'empty count' + tag);
            const edge = [0, 31, 32, 1023, 1024, 32767, 32768, 65536, cap - 2, cap - 1].filter((s) => s >= 0 && s < cap);
            for (const s of edge) a.setFlags(hs[s], flag);
            assert.deepEqual(walk(a, flag), scan(a, hs, flag), 'edges walk' + tag);
            assert.equal(a.flagCount(flag), new Set(edge).size, 'edges count' + tag);
            assert.equal(a.nextFlagged(flag, hs[cap - 1]), -1, 'next after slot N-1' + tag);
            // only slot 0 and slot N-1: the walk must cross every empty word / S1 / S2 word between
            a.clearFlagAll(flag);
            a.setFlags(hs[0], flag);
            a.setFlags(hs[cap - 1], flag);
            assert.deepEqual(walk(a, flag), cap === 1 ? [hs[0]] : [hs[0], hs[cap - 1]], 'first + last' + tag);
            a.clearFlagAll(flag);
            for (let i = 0; i < cap; i++) a.setFlags(hs[i], flag);
            const w = walk(a, flag);
            assert.equal(w.length, cap, 'full walk length' + tag);
            assert.deepEqual(w, hs, 'full walk' + tag);
            assert.equal(a.flagCount(flag), cap, 'full count' + tag);
            a.clearFlagAll(flag);
            assert.equal(a.firstFlagged(flag), -1, 'cleared' + tag);
            assert.equal(a.flagCount(flag), 0, 'cleared count' + tag);
        }
    }
});

test('QA reserve across the S2 word edge (40000 -> 80000, 32768 -> 32769) and capacity 1048575 (max)', () => {
    // 40,000 slots = 1,250 words = 40 S1 words -> S2 word 1 exists BEFORE the grow (ixGrow must rebuild it).
    const a = new Arena(40000);
    const F = a.registerFlags(NAMES, { indexed: ['f0', 'f31'] });
    const hs = [];
    for (let i = 0; i < 40000; i++) hs.push(a.spawn());
    for (const s of [0, 32768, 39999]) { a.setFlags(hs[s], B0); a.setFlags(hs[s], B31); }
    a.reserve(80000);
    assert.deepEqual(walk(a, B0), [hs[0], hs[32768], hs[39999]]);
    assert.deepEqual(walk(a, B31), [hs[0], hs[32768], hs[39999]]);
    assert.equal(a.flagCount(B0), 3);
    for (let i = 40000; i < 80000; i++) hs.push(a.spawn());
    a.setFlags(hs[79999], B31);
    assert.deepEqual(walk(a, B31), scan(a, hs, B31));
    assert.equal(walk(a, B31).length, 4);
    assert.equal(F.f31, B31);

    // N -> N+1 at the S2 edge: slot 32768 is the first slot of S2 word 1.
    const b = new Arena(32768);
    b.registerFlags(NAMES, { indexed: ['f0'] });
    const e0 = b.spawn();
    for (let i = 1; i < 32768; i++) b.spawn();
    b.setFlags(e0, B0);
    b.reserve(32769);
    const eN = b.spawn();
    assert.equal(eN & 0xFFFFF, 32768);
    b.setFlags(eN, B0);
    assert.deepEqual(walk(b, B0), [e0, eN]);
    assert.throws(() => b.reserve(1048576), /reserve capacity must be an integer <= 1048575/);

    // Maximum capacity: first, middle and last slot (S2 word 31).
    const { a: c, hs: hc } = fullArena(1048575);
    for (const s of [0, 524288, 1048574]) c.setFlags(hc[s], B31);
    assert.deepEqual(walk(c, B31), [hc[0], hc[524288], hc[1048574]]);
    c.despawn(hc[1048574]);
    assert.deepEqual(walk(c, B31), [hc[0], hc[524288]]);
    assert.equal(c.flagCount(B31), 2);
});

test('QA generation wrap: handles at gen 1023 / 1024 (2^30) / 2047 / 2048 (sign bit) / 4094 / 4095 (retire) round-trip', () => {
    const a = new Arena(2);
    const F = a.registerFlags(NAMES, { indexed: ['f0', 'f31'] });
    const H = a.registerFlagsHi(['h0', 'h1'], { indexed: ['h0'] });
    const e0 = a.spawn();
    a.setFlags(e0, F.f0 | F.f31);
    a.setFlagsHi(e0, H.h0);
    const checkpoints = new Set([1, 1023, 1024, 1025, 2047, 2048, 2049, 4094, 4095]);
    let seen = 0;
    for (let g = 1; g <= 4095; g++) {
        const e = a.spawn();
        assert.equal(e & 0xFFFFF, 1);
        assert.equal((e >>> 20) & 0xFFF, g);
        if (checkpoints.has(g)) {
            seen++;
            if (g >= 2048) assert.ok(e < 0, 'gen ' + g + ' handle is negative (signed int32)');
            else if (g >= 1024) assert.ok(e >= 2 ** 30, 'gen ' + g + ' handle is >= 2^30');
            a.setFlags(e, B31 | B0);
            a.setFlagsHi(e, H.h0);
            assert.equal(a.flagCount(B31), 2);
            assert.equal(a.nextFlagged(B31, e0), e, 'nextFlagged === spawn handle, gen ' + g);
            assert.equal(a.nextFlagged(B0, e0), e, 'nextFlagged bit 0, gen ' + g);
            assert.equal(a.nextFlaggedHi(H.h0, e0), e, 'nextFlaggedHi, gen ' + g);
            assert.deepEqual(walk(a, B31), [e0, e]);
            assert.deepEqual(walkHi(a, H.h0), [e0, e]);
            assert.equal(a.nextFlagged(B31, e), -1);
            assert.ok(a.isAlive(a.nextFlagged(B31, e0)));
            a.clearFlags(e0, B31); assert.equal(a.firstFlagged(B31), e, 'firstFlagged, gen ' + g); a.setFlags(e0, B31);
            a.clearFlagsHi(e0, H.h0); assert.equal(a.firstFlaggedHi(H.h0), e, 'firstFlaggedHi, gen ' + g); a.setFlagsHi(e0, H.h0);
        }
        assert.equal(a.despawn(e), true);
        assert.equal(a.flagCount(B31), 1, 'despawn drops the column, gen ' + g);
        assert.equal(a.flagCountHi(H.h0), 1);
        assert.equal(a.nextFlagged(B31, e0), -1);
    }
    assert.equal(seen, checkpoints.size);
    assert.equal(a.retiredCount, 1, 'slot 1 retired at gen 4095');
    assert.deepEqual(walk(a, B31), [e0]);
    assert.deepEqual(walkHi(a, H.h0), [e0]);
    assert.throws(() => a.spawn(), /out of memory -- no free slot\. capacity=2, activeCount=1, retiredCount=1\. 1 slot\(s\) were permanently retired/);
});

test('QA dispose: duplicate despawn and a stale handle after slot reuse never touch the new owner\'s column', () => {
    const a = new Arena(4);
    const F = a.registerFlags(NAMES, { indexed: ['f0', 'f1'] });
    const H = a.registerFlagsHi(['h0'], { indexed: ['h0'] });
    const e1 = a.spawn();
    a.setFlags(e1, F.f0);
    a.setFlagsHi(e1, H.h0);
    assert.equal(a.despawn(e1), true);
    assert.equal(a.despawn(e1), false, 'duplicate despawn');
    assert.equal(a.flagCount(F.f0), 0);
    assert.equal(a.flagCountHi(H.h0), 0);
    const e2 = a.spawn();
    assert.equal(e2 & 0xFFFFF, e1 & 0xFFFFF, 'slot reused');
    assert.notEqual(e2, e1);
    a.setFlags(e2, F.f0);
    a.setFlagsHi(e2, H.h0);
    assert.equal(a.despawn(e1), false, 'stale despawn');
    assert.equal(a.setFlags(e1, F.f1), false, 'stale setFlags');
    assert.equal(a.clearFlags(e1, F.f0), false, 'stale clearFlags');
    assert.equal(a.clearFlagsHi(e1, H.h0), false, 'stale clearFlagsHi');
    assert.equal(a.flagCount(F.f0), 1);
    assert.equal(a.flagCount(F.f1), 0);
    assert.equal(a.flagCountHi(H.h0), 1);
    assert.deepEqual(walk(a, F.f0), [e2]);
    assert.deepEqual(walkHi(a, H.h0), [e2]);
    assert.equal(a.flags[e2 & 0xFFFFF], F.f0);
    assert.equal(a.despawn(e2), true);
    assert.equal(a.flagCount(F.f0), 0);
    assert.equal(a.flagCountHi(H.h0), 0);
});

test('QA dispose-during-iteration and re-entrant writes (respawn into the current slot, clearFlagAll, reserve, clear)', () => {
    const SLOTS = [3, 40, 41, 1000];
    function mk() {
        const a = new Arena(2048);
        const F = a.registerFlags(NAMES, { indexed: ['f0', 'f1'] });
        const hs = [];
        for (let i = 0; i < 2048; i++) hs.push(a.spawn());
        for (const s of SLOTS) a.setFlags(hs[s], F.f0);
        return { a, F, hs };
    }
    // (a) despawn the current entity, spawn (reuses that slot, new generation) and flag the newcomer
    {
        const { a, F } = mk();
        const slots = [];
        for (let e = a.firstFlagged(F.f0); e !== -1; e = a.nextFlagged(F.f0, e)) {
            slots.push(e & 0xFFFFF);
            assert.equal(a.despawn(e), true);
            const n = a.spawn();
            assert.equal(n & 0xFFFFF, e & 0xFFFFF);
            a.setFlags(n, F.f0);
            assert.ok(slots.length <= SLOTS.length, 'no revisit');
        }
        assert.deepEqual(slots, SLOTS);
        assert.equal(a.flagCount(F.f0), 4);
    }
    // (b) clearFlagAll at the 2nd visit ends the walk
    {
        const { a, F, hs } = mk();
        let visits = 0;
        for (let e = a.firstFlagged(F.f0); e !== -1; e = a.nextFlagged(F.f0, e)) {
            if (++visits === 2) a.clearFlagAll(F.f0);
        }
        assert.equal(visits, 2);
        assert.equal(a.flagCount(F.f0), 0);
        for (const s of SLOTS) assert.equal(a.flags[hs[s] & 0xFFFFF] & F.f0, 0);
    }
    // (c) reserve() at the 1st visit: the walk continues on the grown column, a new high slot is visited
    {
        const { a, F } = mk();
        const seen = [];
        let hi = -1;
        for (let e = a.firstFlagged(F.f0); e !== -1; e = a.nextFlagged(F.f0, e)) {
            seen.push(e & 0xFFFFF);
            if (seen.length === 1) {
                a.reserve(4096);
                for (let i = 2048; i < 3001; i++) hi = a.spawn();
                assert.equal(hi & 0xFFFFF, 3000);
                a.setFlags(hi, F.f0);
            }
        }
        assert.deepEqual(seen, SLOTS.concat([3000]));
        assert.equal(a.flagCount(F.f0), 5);
    }
    // (d) clear() at the 1st visit ends the walk
    {
        const { a, F } = mk();
        let visits = 0;
        for (let e = a.firstFlagged(F.f0); e !== -1; e = a.nextFlagged(F.f0, e)) visits++, a.clear();
        assert.equal(visits, 1);
        assert.equal(a.flagCount(F.f0), 0);
        assert.equal(a.firstFlagged(F.f0), -1);
    }
    // (e) re-entrant writes on the current entity: re-set the walked bit, set / clear another indexed bit
    {
        const { a, F } = mk();
        let visits = 0;
        for (let e = a.firstFlagged(F.f0); e !== -1; e = a.nextFlagged(F.f0, e)) {
            visits++;
            assert.equal(a.setFlags(e, F.f0), true);
            assert.equal(a.flagCount(F.f0), 4, 'double set counts once');
            a.setFlags(e, F.f1 | F.f2);
            a.setFlags(e, F.f1);
        }
        assert.equal(visits, 4);
        assert.equal(a.flagCount(F.f1), 4);
        for (let e = a.firstFlagged(F.f1); e !== -1; e = a.nextFlagged(F.f1, e)) a.clearFlags(e, F.f1 | F.f0);
        assert.equal(a.flagCount(F.f1), 0);
        assert.equal(a.flagCount(F.f0), 0);
    }
});

const MASKS = [-1, 0, -0, NaN, null, undefined, 1, 2 ** 30, 2 ** 31 - 1, 2 ** 31, -(2 ** 31), 2 ** 32 - 1, 2 ** 32,
    2 ** 32 + 1, 2 ** 53 - 1, 2 ** 53, 1.5, '1', 0x80000001];

test('QA integer matrix: setFlags / clearFlags masks keep row == plain twin and column == row; flag arguments map by |0', () => {
    const IX = ['f0', 'f30', 'f31'];
    const a = new Arena(8), p = new Arena(8);
    const F = a.registerFlags(NAMES, { indexed: IX });
    p.registerFlags(NAMES);
    const ea = a.spawn(), ep = p.spawn();
    for (const m of MASKS) {
        for (const op of ['setFlags', 'clearFlags']) {
            if (op === 'clearFlags') { a.setFlags(ea, -1); p.setFlags(ep, -1); }
            assert.equal(a[op](ea, m), p[op](ep, m), op + ' return ' + String(m));
            const row = a.flags[ea & 0xFFFFF];
            assert.equal(row, p.flags[ep & 0xFFFFF], op + ' row ' + String(m));
            for (const nm of IX) {
                const on = (row & F[nm]) !== 0 ? 1 : 0;
                assert.equal(a.flagCount(F[nm]), on, op + ' column ' + nm + ' ' + String(m));
                assert.deepEqual(walk(a, F[nm]), on ? [ea] : [], op + ' walk ' + nm + ' ' + String(m));
            }
            a.clearFlags(ea, -1); p.clearFlags(ep, -1);
        }
    }
    a.setFlags(ea, B31 | B30 | B0);
    // production flag argument: flag | 0 (M-25), then exactly one INDEXED bit
    assert.equal(a.flagCount(2 ** 31), 1, 'uint32 bit 31');
    assert.equal(a.flagCount(-(2 ** 31)), 1, 'int32 bit 31');
    assert.equal(a.flagCount(2 ** 30), 1, 'bit 30 (indexed)');
    assert.equal(a.flagCount(2 ** 32 + 1), 1, '2^32 + 1 | 0 === 1 (production trusts |0)');
    assert.equal(a.firstFlagged(2 ** 31), ea);
    for (const bad of [0, -0, NaN, null, undefined, -1, 2 ** 31 - 1, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1, 2 ** 53, 2, 0x80000001]) {
        assert.throws(() => a.flagCount(bad), E_BIT, 'flagCount ' + String(bad));
        assert.throws(() => a.firstFlagged(bad), E_BIT, 'firstFlagged ' + String(bad));
        assert.throws(() => a.clearFlagAll(bad), E_BIT, 'clearFlagAll ' + String(bad));
    }
    assert.equal(a.flagCount(B31), 1, 'a throwing clearFlagAll changed nothing');
    // prev sentinels: -1 (the loop's end value) and 2^32 - 1 map to slot 0xFFFFF -> -1, never a restart
    assert.equal(a.nextFlagged(B31, -1), -1);
    assert.equal(a.nextFlagged(B31, 2 ** 32 - 1), -1);
    // checked: M-18 on non-int32 / non-uint32 flag and prev; uint32 forms accepted
    const c = new Arena(8, { checked: true });
    c.registerFlags(NAMES, { indexed: IX });
    const ec = c.spawn();
    c.setFlags(ec, 2 ** 31);
    assert.equal(c.flagCount(2 ** 31), 1);
    assert.equal(c.flagCount(-(2 ** 31)), 1);
    for (const bad of [2 ** 32 + 1, 2 ** 32, 2 ** 53, 1.5, NaN, null, undefined, '1']) {
        assert.throws(() => c.flagCount(bad), M18, 'checked flagCount ' + String(bad));
        assert.throws(() => c.setFlags(ec, bad), M18, 'checked setFlags ' + String(bad));
        assert.throws(() => c.nextFlagged(B31, bad), M18, 'checked nextFlagged prev ' + String(bad));
    }
    assert.throws(() => c.flagCount(-0), E_BIT, 'checked -0 passes M-18, fails E-BIT');
    assert.equal(c.nextFlagged(B31, -1), -1);
    assert.equal(c.nextFlagged(B31, 2 ** 32 - 1), -1);
    assert.equal(c.flagCount(B31), 1);
});

test('QA registration options: [] / null / undefined / a hole / 32 of 32 indexed / Object.prototype names / "__proto__"', () => {
    {
        const a = new Arena(8);
        a.registerFlags(NAMES, { indexed: [] });
        assert.equal(Object.hasOwn(a, 'setFlags'), false, 'indexed [] installs nothing');
        assert.throws(() => a.flagCount(1), E_ROW);
    }
    for (const v of [null, undefined, 'f0', 1, {}]) {
        const a = new Arena(8);
        assert.throws(() => a.registerFlags(NAMES, { indexed: v }), /options\.indexed must be an array of flag names/,
            'R2 ' + String(v));
        assert.equal(a.flags, null);
    }
    {
        const a = new Arena(8);
        // eslint-disable-next-line no-sparse-arrays
        assert.throws(() => a.registerFlags(NAMES, { indexed: [, 'f0'] }), /options\.indexed #0 \(undefined\)/);
        assert.equal(a.flags, null);
    }
    for (const nm of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
        const a = new Arena(8);
        assert.throws(() => a.registerFlags(['a', 'b'], { indexed: [nm] }), /is not one of the names, or a duplicate/,
            'inherited name ' + nm);
        assert.equal(a.flags, null);
        assert.equal(Object.hasOwn(a, 'setFlags'), false);
    }
    {
        const a = new Arena(8);
        const F = a.registerFlags(['__proto__', 'toString'], { indexed: ['__proto__', 'toString'] });
        assert.equal(F['__proto__'], 1);
        assert.equal(F.toString, 2);
        const e = a.spawn();
        a.setFlags(e, 3);
        assert.equal(a.flagCount(1), 1);
        assert.equal(a.flagCount(2), 1);
    }
    {
        const a = new Arena(64);
        a.registerFlags(NAMES, { indexed: NAMES });
        const es = [];
        for (let i = 0; i < 64; i++) es.push(a.spawn());
        for (let i = 0; i < 64; i += 2) a.setFlags(es[i], -1);
        for (let b = 0; b < 32; b++) {
            assert.equal(a.flagCount(1 << b), 32, 'bit ' + b);
            assert.deepEqual(walk(a, 1 << b), es.filter((_, i) => (i & 1) === 0));
        }
        a.despawn(es[0]);
        for (let b = 0; b < 32; b++) assert.equal(a.flagCount(1 << b), 31);
        assert.throws(() => new Arena(8).registerFlags(NAMES.concat(['f32']), { indexed: ['f0'] }), /<= 32 strings/);
    }
});

test('QA joinN hint: empty driver (count 0) -> 0 / -1; driver 1 with a count-0 indexed flag -> that flag / 0', () => {
    for (const checked of [false, true]) {
        const a = checked ? new Arena(8, { checked: true }) : new Arena(8);
        const F = a.registerFlags(NAMES, { indexed: ['f0', 'f31'] });
        const S = a.registerTag();
        let p = a.joinN([S], null, F.f0 | F.f31);
        assert.equal(p.count, 0);
        assert.equal(p.driverFlag, 0, 'empty driver: no flag is < 0');
        assert.equal(p.driverFlagCount, -1);
        const e = a.spawn();
        S.add(e);
        p = a.joinN([S], null, F.f0 | F.f31);
        assert.equal(p.count, 1);
        assert.equal(p.driverFlag, F.f0, 'count 0 < 1, lowest bit wins the tie');
        assert.equal(p.driverFlagCount, 0);
        a.setFlags(e, F.f0 | F.f31);
        p = a.joinN([S], null, F.f0 | F.f31);
        assert.equal(p.driverFlag, 0, 'count 1 ties the driver: no hint');
        assert.equal(p.driverFlagCount, -1);
    }
});
