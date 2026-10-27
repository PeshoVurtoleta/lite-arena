/**
 * @zakkster/lite-arena -- joinN flag masks (Group D2) tests.
 *
 * Expected values come from the D2 SPEC / ASSERTIONS 6-7 and DECISIONS
 * M-4, M-10..M-13, never from the build under test. Hand oracle for the
 * masked match set: slot even (in U), slot%4===0 (flag a), slot%3!==0 (not b)
 * over 0..63 -> 4,8,16,20,28,32,40,44,52,56.
 *
 * Run: `node --test test/joinN-masks.test.js`
 * Control run: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/joinN-masks.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

const REQUIRED_ERR = /joinN\(\) needs at least one required set; got an empty array\. There is no driver and no honest result for zero required sets\./;

// 64 entities in spawn order; T on all, U on even slots; a: slot%4===0, b: slot%3===0.
function build(opts) {
    const arena = new Arena(64, opts);
    const F = arena.registerFlags(['a', 'b']);
    const T = arena.registerTag();
    const U = arena.registerTag();
    const ents = [];
    for (let i = 0; i < 64; i++) {
        const e = arena.spawn();
        assert.equal(e & arena.indexMask, i, 'slot == spawn index');
        ents.push(e);
        T.add(e);
        if (i % 2 === 0) U.add(e);
        if (i % 4 === 0) arena.setFlags(e, F.a);
        if (i % 3 === 0) arena.setFlags(e, F.b);
    }
    return { arena, F, T, U, ents };
}

function runMasked(arena, p) {
    const row = p.flags, m = arena.indexMask;
    const drv = p.driver, n = p.count, oth = p.others, no = p.othersCount;
    const ex = p.excl, nx = p.exclCount, rm = p.reqMask, xm = p.excMask;
    const got = [];
    for (let i = 0; i < n; i++) {
        const e = drv.dense[i];
        let ok = true;
        for (let k = 0; k < no; k++) if (!oth[k].has(e)) { ok = false; break; }
        if (ok) for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
        if (!ok) continue;
        const w = row[e & m];
        if ((w & rm) !== rm || (w & xm) !== 0) continue;
        got.push(e & m);
    }
    return got.sort((x, y) => x - y);
}

test('A6 masked joinN: driver, count, masks, flags ref, exact match set', () => {
    const { arena, F, T, U } = build();
    const p = arena.joinN([T, U], null, F.a, F.b);
    assert.equal(p.driver, U);
    assert.equal(p.count, 32);
    assert.equal(p.reqMask, 1);
    assert.equal(p.excMask, 2);
    assert.equal(p.flags, arena.flags);
    assert.deepEqual(runMasked(arena, p), [4, 8, 16, 20, 28, 32, 40, 44, 52, 56]);
});

test('A6 sign-bit mask normalised | 0', () => {
    const { arena, T } = build();
    assert.equal(arena.joinN([T], null, 0x80000000).reqMask, -2147483648);
    const c = build({ checked: true });
    assert.equal(c.arena.joinN([c.T], null, 0, 0x80000000).excMask, -2147483648);
});

test('A6 no masks: reqMask 0, excMask 0, rest of plan as unmasked', () => {
    const { arena, T, U } = build();
    const p = arena.joinN([T, U]);
    assert.equal(p.reqMask, 0);
    assert.equal(p.excMask, 0);
    assert.equal(p.driver, U);
    assert.equal(p.count, 32);
    assert.equal(p.others[0], T);
    assert.equal(p.othersCount, 1);
    assert.equal(p.exclCount, 0);
    assert.equal(p.flags, arena.flags);
    // excluded set variant: exclude U, drive by T
    const q = arena.joinN([T], [U]);
    assert.equal(q.driver, T);
    assert.equal(q.othersCount, 0);
    assert.equal(q.excl[0], U);
    assert.equal(q.exclCount, 1);
    assert.equal(q.reqMask, 0);
    assert.equal(q.excMask, 0);
});

test('A6 production: overlapping req/exc masks return a plan matching nothing', () => {
    const { arena, F, T } = build();
    const p = arena.joinN([T], null, F.a, F.a);
    assert.ok(p);
    assert.deepEqual(runMasked(arena, p), []);
});

test('A7 no-flags arena: non-zero mask throws naming registerFlags', () => {
    const arena = new Arena(8);
    const T = arena.registerTag();
    assert.throws(() => arena.joinN([T], null, 1), /registerFlags/);
    assert.throws(() => arena.joinN([T], null, 0, 1), /registerFlags/);
});

test('A7 no-flags arena: zero masks ok, p.flags === null', () => {
    const arena = new Arena(8);
    const T = arena.registerTag();
    const p = arena.joinN([T], null, 0, 0);
    assert.equal(p.flags, null);
    assert.equal(p.reqMask, 0);
    assert.equal(p.excMask, 0);
});

test('A7 empty required with masks throws the 1.9.0 required-set error', () => {
    const { arena, F } = build();
    assert.throws(() => arena.joinN([], null, F.a), REQUIRED_ERR);
    const bare = new Arena(8);
    assert.throws(() => bare.joinN([], null, 1), REQUIRED_ERR);
});

test('A7 a plan taken before an M-10 throw stays readable', () => {
    const arena = new Arena(8);
    const T = arena.registerTag();
    arena.spawn(); // keep T empty is fine; just need a plan
    const p = arena.joinN([T]);
    assert.throws(() => arena.joinN([T], null, 1), /registerFlags/);
    assert.equal(p.driver, T);
    assert.equal(p.count, 0);
    assert.equal(p.reqMask, 0);
    assert.equal(p.excMask, 0);
    assert.equal(p.flags, null);
});

test('A7 checked mode: overlapping masks throw', () => {
    const { arena, F, T } = build({ checked: true });
    assert.throws(() => arena.joinN([T], null, F.a, F.a), /share bit/);
    assert.throws(() => arena.joinN([T], null, F.a | F.b, F.b), /share bit/);
});

test('A7 checked mode: an M-10 throw leaves an earlier plan live', () => {
    const arena = new Arena(8, { checked: true });
    const T = arena.registerTag();
    const p = arena.joinN([T]);
    assert.throws(() => arena.joinN([T], null, 1), /registerFlags/);
    assert.equal(p.count, 0);
    assert.equal(p.flags, null);
});

test('A7 checked mode: reqMask / excMask / flags throw after a later join()', () => {
    const { arena, F, T, U } = build({ checked: true });
    const p = arena.joinN([T, U], null, F.a, F.b);
    assert.equal(p.reqMask, 1); // fresh read ok
    arena.join(T, U);
    assert.throws(() => p.reqMask, /stale/);
    assert.throws(() => p.excMask, /stale/);
    assert.throws(() => p.flags, /stale/);
});

test('A7 checked mode: fields throw after a later joinN()', () => {
    const { arena, F, T } = build({ checked: true });
    const p = arena.joinN([T], null, F.a);
    arena.joinN([T]);
    assert.throws(() => p.reqMask);
    assert.throws(() => p.excMask);
    assert.throws(() => p.flags);
});

test('reserve(): a NEW plan re-reads the grown arena.flags (valid only until reserve())', () => {
    const { arena, F, T } = build();
    const before = arena.flags;
    const p0 = arena.joinN([T], null, F.a);
    arena.reserve(128);
    assert.notEqual(arena.flags, before, 'reserve reallocates the row');
    assert.notEqual(p0.flags, before, 'reserve() must drop the pre-reserve row from the scratch');
    const p = arena.joinN([T], null, F.a);
    assert.equal(p.flags, arena.flags);
    assert.equal(p.reqMask, 1);
});
