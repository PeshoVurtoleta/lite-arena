/**
 * @zakkster/lite-arena -- F1 qa boundary matrix for the second flag word (PLAN-F1 A1-A3).
 *
 * Written by qa from the ASSERTIONS, independent of the coder's tests. Expected
 * values come from PLAN-F1 / DECISIONS M-26 / M-27 and from the word-0 twin
 * (setFlags / clearFlags / hasFlags) as the parity oracle: every Hi method must
 * decide exactly what its twin decides for the same handle and mask, so a twin
 * oracle is never the design's own Hi code. Every test fails on the 1.10.0 build
 * (no Hi API).
 *
 * Run: `node --test test/flags-hi-qa.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/flags-hi-qa.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

const B31 = -2147483648;
const names = (n) => Array.from({ length: n }, (_, i) => 'n' + i);
const two = (n = 8, opts) => {
    const a = new Arena(n, opts);
    a.registerFlags(names(32));
    const H = a.registerFlagsHi(names(32));
    return { a, H };
};
const sorted = (xs) => xs.slice().sort((x, y) => x - y);
// True-definition oracle: walk every live slot, read both rows directly.
function oracle(a, inT, rm, xm, rh, xh) {
    const out = [];
    for (let i = 0; i < a.capacity; i++) {
        if (!inT(i)) continue;
        const w = a.flags[i], v = a.flagsHi[i];
        if ((w & rm) === rm && (w & xm) === 0 && (v & rh) === rh && (v & xh) === 0) out.push(i);
    }
    return out;
}
function run(a, p) {
    const out = [];
    const m = a.indexMask;
    for (let i = 0; i < p.count; i++) {
        const e = p.driver.dense[i];
        const w = p.flags[e & m], v = p.flagsHi[e & m];
        if ((w & p.reqMask) !== p.reqMask || (w & p.excMask) !== 0) continue;
        if ((v & p.reqMaskHi) !== p.reqMaskHi || (v & p.excMaskHi) !== 0) continue;
        out.push(e & m);
    }
    return sorted(out);
}

test('QA bit 31 (-2147483648) through set / has / clear, both modes, both spellings', () => {
    for (const opts of [undefined, { checked: true }]) {
        const { a, H } = two(4, opts);
        assert.equal(H.n31, B31);
        const e = a.spawn();
        for (const m of [H.n31, 0x80000000]) {
            assert.equal(a.setFlagsHi(e, m), true);
            assert.equal(a.flagsHi[e & a.indexMask], B31);
            assert.equal(a.flags[e & a.indexMask], 0, 'word 0 untouched');
            assert.equal(a.hasFlagsHi(e, B31), true);
            assert.equal(a.hasFlagsHi(e, 0x80000000), true);
            assert.equal(a.hasFlagsHi(e, 0, 0x80000000), false);
            assert.equal(a.hasFlagsHi(e, 1 << 30), false, 'bit 30 is not bit 31');
            assert.equal(a.clearFlagsHi(e, m), true);
            assert.equal(a.flagsHi[e & a.indexMask], 0);
        }
        // bits 30 and 31 together (2^30 boundary of the Smi range on 31-bit-Smi engines)
        a.setFlagsHi(e, (1 << 30) | B31);
        assert.equal(a.flagsHi[e & a.indexMask], -1073741824);
        assert.equal(a.hasFlagsHi(e, 0xC0000000), true);
        a.clearFlagsHi(e, 1 << 30);
        assert.equal(a.flagsHi[e & a.indexMask], B31);
    }
});

test('QA joinN bit 31 in all four masks, both modes: plan normalised, match == true-definition oracle', () => {
    for (const opts of [undefined, { checked: true }]) {
        const a = new Arena(16, opts);
        a.registerFlags(names(32));
        a.registerFlagsHi(names(32));
        const T = a.registerTag();
        for (let i = 0; i < 16; i++) {
            const e = a.spawn();
            T.add(e);
            if (i & 1) a.setFlags(e, B31);
            if (i & 2) a.setFlagsHi(e, B31);
            if (i & 4) a.setFlagsHi(e, 1 << 30);
            if (i & 8) a.setFlags(e, 1 << 30);
        }
        const all = () => true;
        const cases = [
            [B31, 0, 0x80000000, 0], [0, 0x80000000, 0, B31], [0x80000000, 0, 0, 0x80000000],
            [0, 0, 0x80000000, 1 << 30], [0, 0, 1 << 30, 0x80000000], [0, B31, B31, 0],
        ];
        for (const [rm, xm, rh, xh] of cases) {
            const tag = JSON.stringify([opts, rm, xm, rh, xh]);
            const p = a.joinN([T], null, rm, xm, rh, xh);
            assert.equal(p.reqMask, rm | 0, tag);
            assert.equal(p.excMask, xm | 0, tag);
            assert.equal(p.reqMaskHi, rh | 0, tag);
            assert.equal(p.excMaskHi, xh | 0, tag);
            const got = run(a, p);
            assert.deepEqual(got, oracle(a, all, rm | 0, xm | 0, rh | 0, xh | 0), tag);
            assert.equal(got.length, 4, tag + ' 16 slots / 4 = 4 per two-bit cell');
        }
    }
});

test('QA checked integer matrix: Hi methods and joinN Hi args decide exactly as the word-0 twins', () => {
    const ACCEPT = [-1, 0, -0, 1, 2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, -(2 ** 31)];
    const REJECT = [2 ** 32, 2 ** 53 - 1, 2 ** 53, -(2 ** 31) - 1, NaN, Infinity, -Infinity, null,
        undefined, 0.5, '0', 1n, [1], { valueOf: () => 1 }];
    const { a } = two(4, { checked: true });
    const R = a.registerTag();
    const e = a.spawn();
    R.add(e);
    const ok = (f) => { try { f(); return true; } catch { return false; } };
    for (const m of ACCEPT) {
        const tag = 'accept ' + String(m);
        assert.equal(ok(() => a.setFlagsHi(e, m)), true, tag);
        assert.equal(ok(() => a.clearFlagsHi(e, m)), true, tag);
        assert.equal(ok(() => a.hasFlagsHi(e, m, 0)), true, tag);
        assert.equal(ok(() => a.joinN([R], null, 0, 0, m, 0)), true, tag);
        assert.equal(ok(() => a.joinN([R], null, 0, 0, 0, m)), true, tag);
    }
    a.setFlagsHi(e, 0x55555555);
    for (const m of REJECT) {
        const tag = 'reject ' + typeof m + ' ' + (typeof m === 'bigint' ? m + 'n' : String(m));
        // twin parity first: the word-0 twin must reject it too
        assert.equal(ok(() => a.setFlags(e, m)), false, 'twin ' + tag);
        assert.equal(ok(() => a.setFlagsHi(e, m)), false, tag);
        assert.equal(ok(() => a.clearFlagsHi(e, m)), false, tag);
        assert.equal(ok(() => a.hasFlagsHi(e, m)), false, tag);
        if (m !== undefined) assert.equal(ok(() => a.hasFlagsHi(e, 0, m)), false, tag);
        assert.equal(ok(() => a.joinN([R], null, 0, 0, m)), false, tag);
        assert.equal(ok(() => a.joinN([R], null, 0, 0, 0, m)), false, tag);
    }
    assert.equal(a.flagsHi[e & a.indexMask], 0x55555555, 'no rejected mask changed the row');
    a.clearFlagsHi(e, -1);
    // -0 is an int32 0 in the row and the plan
    a.setFlagsHi(e, -0);
    assert.ok(Object.is(a.flagsHi[e & a.indexMask], 0));
    assert.ok(Object.is(a.joinN([R], null, 0, 0, -0, -0).reqMaskHi, 0));
});

test('QA handle matrix (production): every Hi method returns and writes what its word-0 twin does', () => {
    const { a } = two(4);
    const live = [a.spawn(), a.spawn(), a.spawn()];
    a.despawn(live[1]);
    const HANDLES = [-1, 0, 1, 3, 4, 2 ** 20, 2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32,
        2 ** 53 - 1, 2 ** 53, NaN, -0, undefined, null, Infinity, '1', live[0], live[1], live[2],
        live[0] + 2 ** 32, live[2] - 2 ** 32, live[0] >>> 0];
    for (const h of HANDLES) {
        const tag = 'handle ' + String(h);
        for (const m of [1, B31, -1]) {
            assert.equal(a.setFlagsHi(h, m), a.setFlags(h, m), tag);
            assert.equal(a.hasFlagsHi(h, m), a.hasFlags(h, m), tag);
            assert.equal(a.hasFlagsHi(h, 0, m), a.hasFlags(h, 0, m), tag);
            assert.deepEqual(Array.from(a.flagsHi), Array.from(a.flags), tag + ' rows after set');
            assert.equal(a.clearFlagsHi(h, m), a.clearFlags(h, m), tag);
            assert.deepEqual(Array.from(a.flagsHi), Array.from(a.flags), tag + ' rows after clear');
        }
    }
    // the despawned slot's row stayed 0 through every write attempt
    assert.equal(a.flagsHi[live[1] & a.indexMask], 0);
});

test('QA generation crosses the sign bit (2047 -> 2048 -> 2049): Hi API and despawn zero on negative handles', () => {
    const { a, H } = two(1);
    const T = a.registerTag();
    // gen 1 .. 2045 spawned and despawned; the next spawn is gen 2046
    for (let i = 0; i < 2045; i++) a.despawn(a.spawn());
    const seen = [];
    for (let g = 2046; g <= 2050; g++) {
        const e = a.spawn();
        assert.equal((e >>> 20) & 0xFFF, g, 'gen ' + g);
        assert.equal(e < 0, g >= 2048, 'sign bit at gen ' + g);
        assert.equal(a.flagsHi[0], 0, 'fresh row at gen ' + g);
        assert.equal(a.setFlagsHi(e, H.n31 | H.n0), true);
        assert.equal(a.hasFlagsHi(e, B31), true);
        T.add(e);
        const p = a.joinN([T], null, 0, 0, B31, 2);
        assert.deepEqual(run(a, p), [0], 'joinN finds gen ' + g);
        seen.push(e);
        assert.equal(a.despawn(e), true);
        assert.equal(a.flagsHi[0], 0, 'despawn zeroed at gen ' + g);
        // the previous generation's handle is dead for every Hi method
        assert.equal(a.setFlagsHi(e, 1), false);
        assert.equal(a.hasFlagsHi(e, 0), false);
        assert.equal(a.flagsHi[0], 0);
    }
    assert.equal(new Set(seen).size, 5);
});

test('QA registerFlagsHi name counts 0 / 1 / 31 / 32 / 33, undefined and null', () => {
    const fresh = () => { const a = new Arena(8); a.registerFlags([]); return a; };
    for (const n of [0, 1, 31, 32]) {
        const a = fresh();
        const H = a.registerFlagsHi(names(n));
        assert.equal(Object.keys(H).length, n, 'n=' + n);
        assert.ok(Object.isFrozen(H));
        assert.ok(a.flagsHi instanceof Int32Array, 'row allocated for n=' + n);
        assert.equal(a.flagsHi.length, 8);
        if (n === 31) assert.equal(H.n30, 2 ** 30);
        if (n === 32) assert.equal(H.n31, B31);
        assert.throws(() => a.registerFlagsHi([]), /registerFlagsHi\(\) was already called/);
    }
    const u = fresh();
    assert.deepEqual(Object.keys(u.registerFlagsHi()), []);
    assert.equal(u.flagsHi.length, 8);
    for (const bad of [names(33), null, 0, {}, new Set(['p'])]) {
        const a = fresh();
        assert.throws(() => a.registerFlagsHi(bad), /registerFlagsHi names must be an array of <= 32 strings/);
        assert.equal(a.flagsHi, null);
    }
    // registerFlags([]) + Hi-only: word-0 row exists, all zero, unaffected by Hi writes
    const a = fresh();
    const H = a.registerFlagsHi(['p']);
    const e = a.spawn();
    a.setFlagsHi(e, -1);
    assert.equal(a.flags[e & a.indexMask], 0);
    assert.equal(a.hasFlags(e, 0), true);
    assert.equal(a.hasFlagsHi(e, H.p), true);
});

test('QA reserve(): flagsHi null stays null; registered later gets the grown capacity', () => {
    const a = new Arena(4);
    a.registerFlags(['a']);
    const T = a.registerTag();
    T.add(a.spawn());
    a.joinN([T]);
    assert.equal(a.reserve(16), true);
    assert.equal(a.flagsHi, null);
    assert.equal(a._joinNResult.flagsHi, null);
    assert.equal(a.joinN([T]).flagsHi, null);
    const H = a.registerFlagsHi(['p']);
    assert.equal(a.flagsHi.length, 16);
    const e = a.spawn();
    assert.equal(a.setFlagsHi(e, H.p), true);
    assert.equal(a.joinN([T], null, 0, 0, H.p).flagsHi, a.flagsHi);
    // no flag rows at all: reserve leaves both null
    const b = new Arena(2);
    b.reserve(8);
    assert.equal(b.flags, null);
    assert.equal(b.flagsHi, null);
    // checked: a plan made after reserve carries the new row
    const { a: c, H: CH } = two(4, { checked: true });
    const R = c.registerTag();
    const ce = c.spawn();
    R.add(ce);
    c.setFlagsHi(ce, CH.n31);
    const old = c.flagsHi;
    c.reserve(32);
    const p = c.joinN([R], null, 0, 0, CH.n31);
    assert.notEqual(p.flagsHi, old);
    assert.equal(p.flagsHi, c.flagsHi);
    assert.equal(p.flagsHi.length, 32);
    assert.deepEqual(run(c, p), [ce & c.indexMask]);
});

test('QA clear(): Hi-only arena zeroed, flagsHi-null arena stays null, handles cross clear dead', () => {
    const a = new Arena(4);
    a.registerFlags([]);
    a.registerFlagsHi(['p']);
    const es = [a.spawn(), a.spawn(), a.spawn(), a.spawn()];
    for (const e of es) a.setFlagsHi(e, -1);
    a.clear();
    assert.deepEqual(Array.from(a.flagsHi), [0, 0, 0, 0]);
    for (const e of es) {
        assert.equal(a.setFlagsHi(e, 1), false, 'pre-clear handle dead');
        assert.equal(a.hasFlagsHi(e, 0), false);
    }
    assert.deepEqual(Array.from(a.flagsHi), [0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) assert.equal(a.hasFlagsHi(a.spawn(), 1), false, 'respawn clean');
    const b = new Arena(4);
    b.registerFlags(['a']);
    b.setFlags(b.spawn(), 1);
    b.clear();
    assert.equal(b.flagsHi, null);
    b.clear(); // duplicate clear
    assert.equal(b.flagsHi, null);
});

test('QA duplicate despawn of a stale handle never zeroes the respawned entity Hi row', () => {
    const { a } = two(1);
    const e = a.spawn();
    a.setFlagsHi(e, -1);
    assert.equal(a.despawn(e), true);
    const e2 = a.spawn();
    a.setFlagsHi(e2, B31 | 5);
    a.setFlags(e2, 7);
    assert.equal(a.despawn(e), false, 'duplicate despawn');
    assert.equal(a.despawn(e), false, 'third despawn');
    assert.equal(a.flagsHi[0], B31 | 5);
    assert.equal(a.flags[0], 7);
    assert.equal(a.hasFlagsHi(e2, B31), true);
});

test('QA retire at generation 4095 then reserve: retired row stays 0 and is never reissued', () => {
    const { a } = two(1);
    for (let i = 0; i < 4094; i++) { const e = a.spawn(); a.setFlagsHi(e, -1); a.despawn(e); }
    const last = a.spawn();
    assert.equal((last >>> 20) & 0xFFF, 4095);
    a.setFlagsHi(last, -1);
    a.despawn(last);
    assert.equal(a.retiredCount, 1);
    assert.equal(a.flagsHi[0], 0);
    assert.equal(a.setFlagsHi(last, 1), false);
    a.reserve(2);
    assert.equal(a.flagsHi[0], 0);
    const n = a.spawn();
    assert.equal(n & a.indexMask, 1, 'retired slot 0 not reissued');
    assert.equal(a.hasFlagsHi(n, 1), false);
});

test('QA despawn during iteration of a Hi-masked plan: survivors keep their Hi word, victims read 0', () => {
    const a = new Arena(32);
    a.registerFlags([]);
    const H = a.registerFlagsHi(['p', 'q']);
    const T = a.registerTag();
    for (let i = 0; i < 32; i++) {
        const e = a.spawn();
        T.add(e);
        a.setFlagsHi(e, i % 2 ? H.p : H.q);
    }
    const p = a.joinN([T], null, 0, 0, H.p);
    const killed = [];
    // reverse walk: swap-and-pop only moves already-visited tail entries
    for (let i = p.count - 1; i >= 0; i--) {
        const e = p.driver.dense[i];
        if ((p.flagsHi[e & a.indexMask] & p.reqMaskHi) !== p.reqMaskHi) continue;
        killed.push(e & a.indexMask);
        assert.equal(a.despawn(e), true);
    }
    assert.equal(killed.length, 16);
    for (const s of killed) assert.equal(a.flagsHi[s], 0, 'victim ' + s);
    for (let s = 0; s < 32; s += 2) assert.equal(a.flagsHi[s], H.q, 'survivor ' + s);
    assert.deepEqual(run(a, a.joinN([T], null, 0, 0, H.p)), []);
    assert.equal(T.count, 16);
});

test('QA checked epoch wrap through the Hi stamp (start 2^30 - 2 and 2^31 - 2): stale guard holds', () => {
    for (const start of [2 ** 30 - 2, 2 ** 31 - 2]) {
        const { a, H } = two(4, { checked: true });
        const R = a.registerTag();
        R.add(a.spawn());
        a._joinEpoch = start | 0;
        const plans = [];
        for (let i = 0; i < 4; i++) {
            const p = a.joinN([R], null, 0, 0, H.n31, H.n0);
            assert.equal(p.reqMaskHi, B31, 'fresh read at epoch ' + a._joinEpoch);
            assert.equal(p.excMaskHi, 1);
            assert.equal(p.flagsHi, a.flagsHi);
            for (const old of plans) assert.throws(() => old.flagsHi, /stale/);
            plans.push(p);
        }
        // 2^31 - 2 + 4 crosses int32 max: the counter wrapped to a negative int32
        if (start === 2 ** 31 - 2) assert.equal(a._joinEpoch, -(2 ** 31) + 2);
        else assert.equal(a._joinEpoch, 2 ** 30 + 2);
    }
});

test('QA cross-word overlap with every bit: checked allows rm & xh / xm & rh, production matches the oracle', () => {
    for (const opts of [undefined, { checked: true }]) {
        const a = new Arena(8, opts);
        a.registerFlags(names(32));
        a.registerFlagsHi(names(32));
        const T = a.registerTag();
        for (let i = 0; i < 8; i++) {
            const e = a.spawn();
            T.add(e);
            if (i & 1) a.setFlags(e, -1);
            if (i & 2) a.setFlagsHi(e, -1);
        }
        const p = a.joinN([T], null, -1, 0, 0, -1);
        assert.deepEqual(run(a, p), [1, 5]);
        const q = a.joinN([T], null, 0, 0xffffffff, 0xffffffff, 0);
        assert.deepEqual(run(a, q), [2, 6]);
        if (opts) {
            assert.throws(() => a.joinN([T], null, 0, 0, -1, B31), /reqMaskHi and excMaskHi share bit\(s\) -2147483648 /);
            assert.throws(() => a.joinN([T], null, B31, 0x80000000), /reqMask and excMask share bit\(s\) -2147483648 /);
        }
    }
});

test('QA own keys: production arena has no own *Hi key except the flagsHi row; checked adds exactly 7 (3 flag methods + 4 F2 query wrappers); _ix private fields excluded', () => {
    const hiKeys = (a) => Reflect.ownKeys(a).filter((k) => typeof k === 'string' && /Hi$/.test(k) && !k.startsWith('_ix')).sort();
    const p = new Arena(4);
    assert.deepEqual(hiKeys(p), ['flagsHi']);
    p.registerFlags([]);
    p.registerFlagsHi(['p']);
    const T = p.registerTag();
    T.add(p.spawn());
    p.joinN([T], null, 0, 0, 1);
    p.reserve(8);
    p.clear();
    assert.deepEqual(hiKeys(p), ['flagsHi']);
    const c = new Arena(4, { checked: true });
    assert.deepEqual(hiKeys(c), ['clearFlagAllHi', 'clearFlagsHi', 'firstFlaggedHi', 'flagCountHi', 'flagsHi', 'hasFlagsHi', 'nextFlaggedHi', 'setFlagsHi']);
});

// Adversarial cases the plan did not list. Both inherited defects are FIXED by M-33
// (convert-first in set/clear/has; re-check after flagMap in register*). These tests
// stay as twin-parity guards: a fix landed in only one twin fails them
// (set / register*; clear / has twin parity: flags-m33 B-A7).
test('QA adversarial: re-entrant registerFlagsHi from a names getter behaves like registerFlags', () => {
    const probe = (method, rowKey) => {
        const a = new Arena(4);
        if (method === 'registerFlagsHi') a.registerFlags([]);
        let innerRow = null, inner = null, threw = null;
        const list = ['p'];
        Object.defineProperty(list, 0, {
            get() { if (inner === null) { inner = a[method](['q']); innerRow = a[rowKey]; } return 'p'; },
        });
        let outer = null;
        try { outer = a[method](list); } catch (e) { threw = e.message.replace(method, 'M'); }
        return { threw, outerKeys: outer && Object.keys(outer), replaced: innerRow !== a[rowKey] };
    };
    assert.deepEqual(probe('registerFlagsHi', 'flagsHi'), probe('registerFlags', 'flags'));
});

test('QA adversarial: a valueOf mask that despawns mid-call writes exactly what the word-0 twin writes', () => {
    const rows = [];
    for (const hi of [false, true]) {
        const a = new Arena(2);
        a.registerFlags([]);
        a.registerFlagsHi([]);
        const e = a.spawn();
        const m = { valueOf() { a.despawn(e); return 4; } };
        const r = hi ? a.setFlagsHi(e, m) : a.setFlags(e, m);
        const e2 = a.spawn();
        rows.push([r, e2 & a.indexMask, hi ? a.hasFlagsHi(e2, 4) : a.hasFlags(e2, 4),
            Array.from(hi ? a.flagsHi : a.flags), Array.from(hi ? a.flags : a.flagsHi)]);
    }
    assert.deepEqual(rows[1], rows[0]);
    // checked mode rejects the object mask before any despawn
    const c = new Arena(2, { checked: true });
    c.registerFlags([]);
    c.registerFlagsHi([]);
    const ce = c.spawn();
    let fired = false;
    assert.throws(() => c.setFlagsHi(ce, { valueOf() { fired = true; return 1; } }), /must be a 32-bit integer/);
    assert.equal(fired, false);
    assert.equal(c.isAlive(ce), true);
});
