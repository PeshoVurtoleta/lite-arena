/**
 * @zakkster/lite-arena -- M-33 (PLAN-QA B-A1..B-A7): flag methods convert the mask
 * FIRST; registerFlags / registerFlagsHi re-check after flagMap().
 * Expected values come from PLAN-QA ASSERTIONS, never from the build under test.
 * B-A1, B-A2, B-A3, B-A6 fail on the 1e6e2a9 build; B-A4, B-A5, B-A7 are
 * regression pins that pass on both.
 *
 * Run: `node --test test/flags-m33.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/flags-m33.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

// Both words: [label, set, clear, has, row accessor, other-row accessor]
const WORDS = [
    { w: 'word0', set: 'setFlags', clear: 'clearFlags', has: 'hasFlags', row: 'flags' },
    { w: 'Hi', set: 'setFlagsHi', clear: 'clearFlagsHi', has: 'hasFlagsHi', row: 'flagsHi' },
];
const mk = (opts) => {
    const a = new Arena(4, opts);
    a.registerFlags([]);
    a.registerFlagsHi([]);
    return a;
};
const slot = (a, e) => e & a.indexMask;

for (const W of WORDS) {
    test(`B-A1 ${W.w}: set/clear with a despawning valueOf mask returns false, writes nothing, valueOf once`, () => {
        for (const op of [W.set, W.clear]) {
            const a = mk();
            const e = a.spawn();
            let calls = 0;
            const m = { valueOf() { calls++; a.despawn(e); return 4; } };
            assert.equal(a[op](e, m), false, op);
            assert.equal(calls, 1, op + ' valueOf calls');
            assert.deepEqual(Array.from(a.flags), [0, 0, 0, 0], op + ' flags');
            assert.deepEqual(Array.from(a.flagsHi), [0, 0, 0, 0], op + ' flagsHi');
            const e2 = a.spawn();
            assert.equal(slot(a, e2), slot(a, e), 'same slot reused');
            assert.equal(a[W.has](e2, 4), false, op + ' next occupant clean');
            const e3 = a.spawn(); let c3 = 0;
            assert.equal(a[op](e3, { valueOf() { c3++; return 4; } }), true, op + ' live');
            assert.equal(c3, 1, op + ' live valueOf once');
        }
    });

    test(`B-A2 ${W.w}: has with a despawning required/excluded valueOf returns false; live: valueOf once each`, () => {
        for (const which of ['required', 'excluded']) {
            const a = mk();
            const e = a.spawn();
            let calls = 0;
            const m = { valueOf() { calls++; a.despawn(e); return 0; } };
            const r = which === 'required' ? a[W.has](e, m) : a[W.has](e, 0, m);
            assert.equal(r, false, which);
            assert.equal(calls, 1, which + ' calls');
        }
        const a = mk();
        const e = a.spawn();
        let rc = 0, xc = 0;
        const req = { valueOf() { rc++; return 0; } };
        const exc = { valueOf() { xc++; return 0; } };
        assert.equal(a[W.has](e, req, exc), true);
        assert.equal(rc, 1, 'required valueOf exactly once');
        assert.equal(xc, 1, 'excluded valueOf exactly once');
    });

    test(`B-A3 ${W.w}: dead handle -- BigInt/Symbol mask throws TypeError, object mask false (valueOf once), number/undefined false`, () => {
        const a = mk();
        const e = a.spawn();
        a[W.set](e, 6);
        a.despawn(e);
        const before0 = Array.from(a.flags), beforeHi = Array.from(a.flagsHi);
        for (const op of [W.set, W.clear, W.has]) {
            assert.throws(() => a[op](e, 1n), TypeError, op + ' 1n');
            assert.throws(() => a[op](e, Symbol()), TypeError, op + ' Symbol');
            let calls = 0;
            assert.equal(a[op](e, { valueOf() { calls++; return 1; } }), false, op + ' object');
            assert.equal(calls, 1, op + ' object valueOf once');
            assert.equal(a[op](e, 5), false, op + ' number');
            assert.equal(a[op](e, undefined), false, op + ' undefined');
        }
        assert.throws(() => a[W.has](e, 0, 1n), TypeError, 'has excluded 1n');
        assert.throws(() => a[W.has](e, 0, Symbol()), TypeError, 'has excluded Symbol');
        assert.deepEqual(Array.from(a.flags), before0);
        assert.deepEqual(Array.from(a.flagsHi), beforeHi);
    });

    test(`B-A4 ${W.w}: live-handle semantics unchanged (regression pin)`, () => {
        const a = mk();
        const e = a.spawn();
        const r = () => a[W.row][slot(a, e)];
        assert.equal(a[W.set](e, 0x80000000), true);
        assert.equal(r(), -2147483648);
        assert.equal(a[W.has](e, 0x80000000), true);
        assert.equal(a[W.has](e, -2147483648), true);
        assert.equal(a[W.clear](e, 0x80000000), true);
        assert.equal(r(), 0);
        assert.equal(a[W.set](e, -1), true);
        assert.equal(r(), -1);
        assert.equal(a[W.has](e, -1), true);
        assert.equal(a[W.has](e, 5, 2), false, 'excluded bit present');
        assert.equal(a[W.clear](e, -1), true);
        assert.equal(r(), 0);
        // typo fail-open: undefined mask is a no-op that still returns true
        a[W.set](e, 8);
        assert.equal(a[W.set](e, undefined), true);
        assert.equal(a[W.clear](e, undefined), true);
        assert.equal(r(), 8);
        assert.equal(a[W.has](e, undefined), true);
        // NaN -> 0, 1.5 -> 1 (ToInt32 truncation)
        assert.equal(a[W.set](e, NaN), true);
        assert.equal(r(), 8);
        assert.equal(a[W.set](e, 1.5), true);
        assert.equal(r(), 9);
        assert.equal(a[W.clear](e, 1.5), true);
        assert.equal(r(), 8);
        assert.equal(a[W.has](e, NaN), true);
        assert.equal(a[W.has](e, 8, 1.5), true, 'excluded 1.5 -> 1, bit 1 not set');
        assert.equal(a[W.has](e, 8, 8.9), false, 'excluded 8.9 -> 8, set');
    });

    test(`B-A4 ${W.w}: before registration a live handle throws TypeError, a dead one is false (regression pin)`, () => {
        const a = new Arena(4);
        if (W.row === 'flagsHi') a.registerFlags([]);
        const live = a.spawn();
        const dead = a.spawn();
        a.despawn(dead);
        for (const op of [W.set, W.clear, W.has]) {
            assert.throws(() => a[op](live, 1), TypeError, op + ' live');
            assert.equal(a[op](dead, 1), false, op + ' dead');
        }
    });

    test(`B-A5 ${W.w}: checked mode rejects object/BigInt/Symbol before any valueOf, live or dead (regression pin)`, () => {
        const a = mk({ checked: true });
        const live = a.spawn();
        const dead = a.spawn();
        a.despawn(dead);
        for (const h of [live, dead]) {
            for (const op of [W.set, W.clear, W.has]) {
                let calls = 0;
                const obj = { valueOf() { calls++; return 1; } };
                assert.throws(() => a[op](h, obj), /must be a 32-bit integer/);
                assert.throws(() => a[op](h, 1n), /must be a 32-bit integer/);
                assert.throws(() => a[op](h, Symbol()), /must be a 32-bit integer/);
                assert.equal(calls, 0, op + ' valueOf never ran');
            }
            let xc = 0;
            assert.throws(() => a[W.has](h, 0, { valueOf() { xc++; return 0; } }), /must be a 32-bit integer/);
            assert.throws(() => a[W.has](h, 0, 1n), /must be a 32-bit integer/);
            assert.equal(xc, 0);
        }
        // int masks: results identical to the production semantics
        assert.equal(a[W.set](live, 6), true);
        assert.equal(a[W.has](live, 6), true);
        assert.equal(a[W.has](live, 2, 1), true);
        assert.equal(a[W.has](live, 2, 4), false);
        assert.equal(a[W.clear](live, 2), true);
        assert.equal(a[W.has](live, 6), false);
        assert.equal(a[W.set](dead, 1), false);
        assert.equal(a[W.clear](dead, 1), false);
        assert.equal(a[W.has](dead, 1), false);
    });
}

test('B-A6 registerFlags re-entrance via a names getter: inner wins, outer throws, flags identity kept', () => {
    const a = new Arena(4);
    let inner = null, innerRow = null;
    const list = ['p'];
    Object.defineProperty(list, 0, {
        get() { if (inner === null) { inner = a.registerFlags(['q']); innerRow = a.flags; } return 'p'; },
    });
    assert.throws(() => a.registerFlags(list), (e) => e.message ===
        'lite-arena: registerFlags() was already called on this arena');
    assert.deepEqual(Object.keys(inner), ['q']);
    assert.equal(inner.q, 1);
    assert.ok(innerRow !== null);
    assert.equal(a.flags, innerRow, 'arena.flags is still the inner row');
});

test('B-A6 registerFlags re-entrance via an options getter (Proxy ownKeys trap): inner wins, outer throws', () => {
    const a = new Arena(4);
    let inner = null, innerRow = null;
    const opts = new Proxy({}, {
        ownKeys() {
            if (inner === null) { inner = a.registerFlags(['q']); innerRow = a.flags; }
            return [];
        },
    });
    assert.throws(() => a.registerFlags(['p'], opts), (e) => e.message ===
        'lite-arena: registerFlags() was already called on this arena');
    assert.deepEqual(Object.keys(inner), ['q']);
    assert.equal(a.flags, innerRow);
});

test('B-A6 registerFlagsHi re-entrance via a names getter: inner wins, outer throws, flagsHi identity kept', () => {
    const a = new Arena(4);
    a.registerFlags([]);
    let inner = null, innerRow = null;
    const list = ['p'];
    Object.defineProperty(list, 0, {
        get() { if (inner === null) { inner = a.registerFlagsHi(['q']); innerRow = a.flagsHi; } return 'p'; },
    });
    assert.throws(() => a.registerFlagsHi(list), (e) => e.message ===
        'lite-arena: registerFlagsHi() was already called on this arena');
    assert.deepEqual(Object.keys(inner), ['q']);
    assert.equal(inner.q, 1);
    assert.ok(innerRow !== null);
    assert.equal(a.flagsHi, innerRow, 'arena.flagsHi is still the inner row');
});

test('B-A6 registerFlagsHi re-entrance via an options getter (Proxy ownKeys trap): inner wins, outer throws', () => {
    const a = new Arena(4);
    a.registerFlags([]);
    let inner = null, innerRow = null;
    const opts = new Proxy({}, {
        ownKeys() {
            if (inner === null) { inner = a.registerFlagsHi(['q']); innerRow = a.flagsHi; }
            return [];
        },
    });
    assert.throws(() => a.registerFlagsHi(['p'], opts), (e) => e.message ===
        'lite-arena: registerFlagsHi() was already called on this arena');
    assert.deepEqual(Object.keys(inner), ['q']);
    assert.equal(a.flagsHi, innerRow);
});

test('B-A7 twin equality: Hi method sources equal the word-0 twins modulo the Hi renames (regression pin)', (t) => {
    const P = Arena.prototype;
    if (typeof P.setFlagsHi !== 'function') return t.skip('build has no Hi');
    for (const base of ['setFlags', 'clearFlags', 'hasFlags']) {
        const hi = P[base + 'Hi'].toString().split('flagsHi').join('flags').split(base + 'Hi(').join(base + '(');
        assert.equal(hi, P[base].toString(), base);
    }
});
