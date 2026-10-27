/**
 * @zakkster/lite-arena -- checked-mode flag masks (M-16, widened by M-18 to
 * "every mask is a 32-bit integer") and plain-object registerFlags options (M-17). Expected values come from DECISIONS M-16/M-17
 * (and M-3, M-6, M-9), never from the build under test.
 *
 * Run: `node --test test/flags-checked.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/flags-checked.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

const row = (a, e) => a.flags[e & a.indexMask];
const BAD = [undefined, null, '1', {}, [], true, 1n, () => 1,
    NaN, 1.5, -0.5, Infinity, -Infinity, 2 ** 32];
const mk = (opts) => { const a = new Arena(8, opts); a.registerFlags(['a', 'b']); return a; };

test('M-16 checked: non-number mask throws in set/clear/has, row untouched', () => {
    const a = mk({ checked: true });
    const e = a.spawn();
    a.setFlags(e, 3);
    for (const m of BAD) {
        assert.throws(() => a.setFlags(e, m), /mask must be/, 'set ' + String(typeof m) + ' ' + String(m));
        assert.throws(() => a.clearFlags(e, m), /mask must be/, 'clear ' + String(typeof m) + ' ' + String(m));
        assert.throws(() => a.hasFlags(e, m), /mask must be/, 'has ' + String(typeof m) + ' ' + String(m));
        if (m !== undefined) assert.throws(() => a.hasFlags(e, 3, m), /the excluded mask/, 'exc ' + typeof m + ' ' + String(m));
    }
    assert.throws(() => a.setFlags(e, 'x'), /mask must be/);
    assert.equal(row(a, e), 3);
});

test('M-16 checked: omitted or undefined mask (not the optional third arg) throws', () => {
    const a = mk({ checked: true });
    const e = a.spawn();
    a.setFlags(e, 3);
    assert.throws(() => a.hasFlags(e, undefined), /mask must be/);
    assert.throws(() => a.setFlags(e), /mask must be/);
    assert.throws(() => a.clearFlags(e), /mask must be/);
    assert.equal(a.hasFlags(e, 3, undefined), true);
    assert.equal(a.hasFlags(e, 3), true);
});

test('M-18 checked: 32-bit integer edge masks are accepted', () => {
    const a = mk({ checked: true });
    const e = a.spawn();
    for (const m of [0x80000000, -1, 0xFFFFFFFF, -2147483648, 0]) {
        assert.doesNotThrow(() => a.setFlags(e, m), 'set ' + m);
        assert.doesNotThrow(() => a.clearFlags(e, m), 'clear ' + m);
        assert.doesNotThrow(() => a.hasFlags(e, m), 'has ' + m);
        assert.doesNotThrow(() => a.hasFlags(e, 0, m), 'exc ' + m);
    }
    assert.equal(a.clearFlags(e, -1), true);
    assert.equal(row(a, e), 0);
    assert.equal(a.setFlags(e, 0x80000000), true);
    assert.equal(a.hasFlags(e, -2147483648), true);
    assert.equal(row(a, e), -2147483648);
    assert.equal(a.hasFlags(e, 1), false);
    assert.equal(a.clearFlags(e, -1), true);
    assert.equal(row(a, e), 0);
});

test('M-16 checked: valid masks behave as production', () => {
    const a = mk({ checked: true });
    const e = a.spawn();
    assert.equal(a.setFlags(e, 1), true);
    assert.equal(a.setFlags(e, 2), true);
    assert.equal(row(a, e), 3);
    assert.equal(a.hasFlags(e, 3), true);
    assert.equal(a.hasFlags(e, 1), true);
    assert.equal(a.hasFlags(e, 4), false);
    assert.equal(a.clearFlags(e, 1), true);
    assert.equal(row(a, e), 2);
    assert.equal(a.hasFlags(e, 1), false);
});

test('M-16 checked: dead handle with a valid mask returns false', () => {
    const a = mk({ checked: true });
    const e = a.spawn();
    a.setFlags(e, 1);
    a.despawn(e);
    assert.equal(a.setFlags(e, 1), false);
    assert.equal(a.clearFlags(e, 1), false);
    assert.equal(a.hasFlags(e, 1), false);
});

test('M-6 checked: before registerFlags is still TypeError', () => {
    const a = new Arena(4, { checked: true });
    const e = a.spawn();
    assert.throws(() => a.setFlags(e, 1), TypeError);
    assert.throws(() => a.clearFlags(e, 1), TypeError);
    assert.throws(() => a.hasFlags(e, 1), TypeError);
});

// Production pins (documented fail-open behaviour); pass on the old build too.
test('M-16 production pin: hasFlags(e, undefined) is true on a live entity', () => {
    const a = mk();
    const e = a.spawn();
    assert.equal(a.hasFlags(e, undefined), true);
    assert.equal(a.hasFlags(e), true);
});

test('M-16 production pin: setFlags(e, undefined) is true, row unchanged', () => {
    const a = mk();
    const e = a.spawn();
    a.setFlags(e, 2);
    assert.equal(a.setFlags(e, undefined), true);
    assert.equal(row(a, e), 2);
});

test('M-16 production pin: no own setFlags/clearFlags/hasFlags/joinN keys', () => {
    const a = mk();
    for (const k of ['setFlags', 'clearFlags', 'hasFlags', 'joinN']) {
        assert.equal(Object.hasOwn(a, k), false, k);
        assert.equal(typeof a[k], 'function', k);
        assert.equal(a[k], Arena.prototype[k], k);
    }
});

test('M-17 registerFlags: non-plain options throw and leave flags null', () => {
    const cases = [
        ['prototype keys', Object.create({ x: 1 })],
        ['Map', new Map()],
        ['array', []],
    ];
    for (const [name, o] of cases) {
        const a = new Arena(4);
        // one matcher per input; [] is rejected by the own-key door
        const re = name === 'array' ? /takes no options/ : /plain object/;
        assert.throws(() => a.registerFlags(['a'], o), re, name);
        assert.equal(a.flags, null, name);
    }
});

test('M-17 registerFlags: plain options accepted', () => {
    for (const o of [undefined, null, {}, Object.create(null)]) {
        const a = new Arena(4);
        const F = a.registerFlags(['a'], o);
        assert.equal(F.a, 1);
        assert.ok(a.flags instanceof Int32Array);
    }
});

test('M-9 registerFlags: own keys of any kind still throw', () => {
    const ne = {}; Object.defineProperty(ne, 'h', { value: 1, enumerable: false });
    const cases = [{ str: 1 }, { [Symbol('s')]: 1 }, ne];
    for (const o of cases) {
        const a = new Arena(4);
        assert.throws(() => a.registerFlags(['a'], o), /takes no options/);
        assert.equal(a.flags, null);
    }
});

test('checked: subclass override of setFlags/clearFlags/hasFlags is honoured', () => {
    class Sub extends Arena {
        constructor(n, o) { super(n, o); this.hits = 0; }
        setFlags(e, m) { this.hits++; return super.setFlags(e, m); }
        clearFlags(e, m) { this.hits++; return super.clearFlags(e, m); }
        hasFlags(e, r, x) { this.hits++; return super.hasFlags(e, r, x); }
    }
    const a = new Sub(8, { checked: true });
    a.registerFlags(['a']);
    const e = a.spawn();
    assert.equal(a.setFlags(e, 1), true);
    assert.equal(a.hasFlags(e, 1), true);
    assert.equal(a.clearFlags(e, 1), true);
    assert.equal(a.hits, 3);
    assert.equal(row(a, e), 0);
    // the checked wrapper validates before delegating: a throwing call must not reach the override
    assert.throws(() => a.setFlags(e, NaN), /mask must be/);
    assert.throws(() => a.clearFlags(e, NaN), /mask must be/);
    assert.throws(() => a.hasFlags(e, NaN), /mask must be/);
    assert.equal(a.hits, 3);
});
