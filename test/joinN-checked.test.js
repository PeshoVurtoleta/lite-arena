/**
 * @zakkster/lite-arena -- joinN checked-mode mask guard (decision M-20) tests.
 *
 * Expected values come from the M-20 decision text, never from the build under
 * test: with { checked: true }, each SUPPLIED mask must satisfy
 * typeof m === 'number' && ((m | 0) === m || (m >>> 0) === m); a supplied undefined throws
 * (M-25), an omitted mask means 0.
 * Production (no checked option) keeps a plain `| 0` and never throws for these.
 *
 * Run: `node --test test/joinN-checked.test.js`
 * Control run: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/joinN-checked.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

const BAD = [undefined, NaN, 1.5, -0.5, Infinity, -Infinity, 2 ** 32, -2147483649, '1', null, {}, true, 1n];
const GOOD = [0, -0, 1, -1, 0x80000000, -2147483648, 0xFFFFFFFF, 2147483647];
const lbl = (m) => (typeof m === 'bigint' ? m + 'n' : typeof m === 'string' ? JSON.stringify(m)
    : m && typeof m === 'object' ? '{}' : Object.is(m, -0) ? '-0' : String(m));

function make(opts) {
    const a = new Arena(8, opts);
    a.registerFlags(['a', 'b']); // so the "no flags" throw is never what we observe
    const T = a.registerTag();
    return { a, T };
}

for (const m of BAD) {
    test(`checked: bad required mask ${lbl(m)} throws`, () => {
        const { a, T } = make({ checked: true });
        assert.throws(() => a.joinN([T], null, m), (e) =>
            /32-bit integer/.test(e.message) && /required/.test(e.message));
    });
    test(`checked: bad excluded mask ${lbl(m)} throws`, () => {
        const { a, T } = make({ checked: true });
        assert.throws(() => a.joinN([T], null, 0, m), (e) =>
            /32-bit integer/.test(e.message) && /excluded/.test(e.message));
    });
}

for (const m of GOOD) {
    test(`checked: accepts ${lbl(m)} as required and as excluded`, () => {
        const { a, T } = make({ checked: true });
        assert.doesNotThrow(() => a.joinN([T], null, m, 0));
        assert.doesNotThrow(() => a.joinN([T], null, 0, m));
        assert.doesNotThrow(() => a.joinN([T], null, m));
    });
}

test('checked: 0x80000000 as required -> reqMask -2147483648', () => {
    const { a, T } = make({ checked: true });
    assert.equal(a.joinN([T], null, 0x80000000).reqMask, -2147483648);
});

test('checked: earlier plan stays live after a guard throw', () => {
    const { a, T } = make({ checked: true });
    const p = a.joinN([T]);
    assert.throws(() => a.joinN([T], null, NaN), /32-bit integer/);
    assert.equal(p.count, 0);
    assert.equal(p.reqMask, 0);
});

// Production: 1n is excluded (`1n | 0` is a native TypeError in JS); Symbol likewise.
for (const m of BAD.filter((x) => typeof x !== 'bigint')) {
    test(`production: ${lbl(m)} as required/excluded does not throw`, () => {
        const { a, T } = make();
        assert.doesNotThrow(() => a.joinN([T], null, m));
        assert.doesNotThrow(() => a.joinN([T], null, 0, m));
    });
}

test('production: NaN -> reqMask 0, 1.5 -> 1, 2**32 -> 0', () => {
    const { a, T } = make();
    assert.equal(a.joinN([T], null, NaN).reqMask, 0);
    assert.equal(a.joinN([T], null, 1.5).reqMask, 1);
    assert.equal(a.joinN([T], null, 2 ** 32).reqMask, 0);
});

test('checked: null/empty required + bad mask -> required-set error first (M-11)', () => {
    const a = new Arena(8, { checked: true });
    a.registerFlags(['a']);
    for (const r of [null, undefined, []]) {
        assert.throws(() => a.joinN(r, null, NaN), /at least one required set/);
        assert.throws(() => a.joinN(r, null, 0, 1.5), /at least one required set/);
    }
});
test('checked: subclass joinN override honoured; a bad mask never reaches it', () => {
    class Sub extends Arena {
        constructor(n, o) { super(n, o); this.hits = 0; }
        joinN(r, x, rm, xm) { this.hits++; return super.joinN(r, x, rm, xm); }
    }
    const a = new Sub(8, { checked: true });
    a.registerFlags(['a']);
    const T = a.registerTag();
    a.joinN([T], null, 1);
    assert.equal(a.hits, 1);
    assert.throws(() => a.joinN([T], null, NaN), /32-bit integer/);
    assert.equal(a.hits, 1);
});
