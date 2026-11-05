/**
 * @zakkster/lite-arena -- checked-mode Hi-word masks (M-26 / M-27, PLAN-F1 A3).
 * Expected values come from PLAN-F1 A3 and the pinned error texts (M-27 Q2 / Q3;
 * M-25 and M-22 analogs for args 5-6), never from the build under test. Every
 * test fails on the 1.10.0 build (no Hi API).
 *
 * Run: `node --test test/flags-hi-checked.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/flags-hi-checked.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

const BAD = [undefined, NaN, 1.5, 2 ** 32, '1', null, {}, true, Infinity, -0.5];
const GOOD = [0, 1, -1, 0x80000000, -2147483648, 0x7fffffff, 0xffffffff];
const NO_HI = (rh, xh) => `lite-arena: joinN() got reqMaskHi=${rh}, excMaskHi=${xh}, but this arena has no Hi flag row ` +
    '(arena.flagsHi is null). Call registerFlagsHi() before passing a non-zero reqMaskHi or excMaskHi, ' +
    'or pass 0 / omit both Hi masks.';

function mk(opts = { checked: true }) {
    const arena = new Arena(8, opts);
    arena.registerFlags(['a', 'b']);
    const H = arena.registerFlagsHi(['p', 'q']);
    const R = arena.registerTag();
    const X = arena.registerTag();
    const e = arena.spawn();
    R.add(e);
    return { arena, H, R, X, e };
}

test('A3 checked Hi setters throw "must be a 32-bit integer" on bad masks; row untouched', () => {
    const { arena, e } = mk();
    arena.setFlagsHi(e, 3);
    for (const m of BAD) {
        const tag = typeof m + ' ' + String(m);
        assert.throws(() => arena.setFlagsHi(e, m),
            /lite-arena: setFlagsHi\(\) the mask must be a 32-bit integer, got /, 'set ' + tag);
        assert.throws(() => arena.clearFlagsHi(e, m),
            /lite-arena: clearFlagsHi\(\) the mask must be a 32-bit integer, got /, 'clear ' + tag);
        assert.throws(() => arena.hasFlagsHi(e, m),
            /lite-arena: hasFlagsHi\(\) the required mask must be a 32-bit integer, got /, 'has req ' + tag);
        // a supplied undefined excluded is treated as omitted (word-0 rule, flags-checked.test.js:45)
        if (m !== undefined) assert.throws(() => arena.hasFlagsHi(e, 0, m),
            /lite-arena: hasFlagsHi\(\) the excluded mask must be a 32-bit integer, got /, 'has exc ' + tag);
    }
    assert.equal(arena.flagsHi[e & arena.indexMask], 3);
});

test('A3 the specific texts name the offending value', () => {
    const { arena, e } = mk();
    assert.throws(() => arena.setFlagsHi(e, 1.5), /must be a 32-bit integer, got 1\.5 /);
    assert.throws(() => arena.setFlagsHi(e, 2 ** 32), /must be a 32-bit integer, got 4294967296 /);
    assert.throws(() => arena.setFlagsHi(e, NaN), /must be a 32-bit integer, got NaN /);
    assert.throws(() => arena.setFlagsHi(e, '1'), /must be a 32-bit integer, got /);
    assert.throws(() => arena.setFlagsHi(e, undefined), /must be a 32-bit integer, got /);
});

test('A3 checked Hi methods accept 0x80000000 and every int32 / uint32 mask', () => {
    const { arena, e } = mk();
    for (const m of GOOD) {
        assert.equal(arena.setFlagsHi(e, m), true, 'set ' + m);
        assert.equal(arena.hasFlagsHi(e, m), true, 'has ' + m);
        assert.equal(arena.clearFlagsHi(e, m), true, 'clear ' + m);
    }
    assert.equal(arena.setFlagsHi(e, 0x80000000), true);
    assert.equal(arena.flagsHi[e & arena.indexMask], -2147483648);
    assert.equal(arena.hasFlagsHi(e, 0x80000000), true);
    // an omitted excluded mask is fine
    assert.equal(arena.hasFlagsHi(e, 0x80000000, undefined), true);
});

test('A3 checked Hi methods validate first, then behave like production (dead handle, no Hi row)', () => {
    const { arena, e } = mk();
    arena.despawn(e);
    assert.equal(arena.setFlagsHi(e, 1), false);
    assert.equal(arena.clearFlagsHi(e, 1), false);
    assert.equal(arena.hasFlagsHi(e, 1), false);
    const b = new Arena(4, { checked: true });
    b.registerFlags(['a']);
    const live = b.spawn();
    assert.throws(() => b.setFlagsHi(live, 1), TypeError);
    assert.throws(() => b.setFlagsHi(live, 1.5), /must be a 32-bit integer/); // validation first
});

test('A3 checked joinN: a SUPPLIED undefined Hi mask throws (M-25 analog), omitted does not', () => {
    const { arena, R, X } = mk();
    assert.throws(() => arena.joinN([R], [X], 0, 0, undefined),
        /lite-arena: joinN\(\) the required Hi mask must be a 32-bit integer, got /);
    assert.throws(() => arena.joinN([R], [X], 0, 0, 0, undefined),
        /lite-arena: joinN\(\) the excluded Hi mask must be a 32-bit integer, got /);
    for (const m of BAD) {
        assert.throws(() => arena.joinN([R], [X], 0, 0, m), /the required Hi mask must be a 32-bit integer/, String(m));
        assert.throws(() => arena.joinN([R], [X], 0, 0, 0, m), /the excluded Hi mask must be a 32-bit integer/, String(m));
    }
    assert.doesNotThrow(() => arena.joinN([R], [X], 0, 0));
    assert.doesNotThrow(() => arena.joinN([R], [X]));
    assert.doesNotThrow(() => arena.joinN([R], [X], 0, 0, 0x80000000));
    assert.doesNotThrow(() => arena.joinN([R], [X], 0, 0, 0, 0x80000000));
});

test('A3 checked joinN: reqMaskHi and excMaskHi share bit(s) throws the pinned text', () => {
    const { arena, R, X } = mk();
    assert.throws(() => arena.joinN([R], [X], 0, 0, 1, 1), (err) => err.message ===
        'lite-arena: joinN() reqMaskHi and excMaskHi share bit(s) 1 -- the match is always empty. ' +
        'Remove them from one mask. (checked mode.)');
    assert.throws(() => arena.joinN([R], [X], 0, 0, 3, 2), /reqMaskHi and excMaskHi share bit\(s\) 2 /);
    assert.throws(() => arena.joinN([R], [X], 0, 0, 0x80000000, 0x80000000),
        /reqMaskHi and excMaskHi share bit\(s\) -2147483648 /);
});

test('A3 checked joinN: word-0 overlap still throws; a cross-word overlap is allowed', () => {
    const { arena, R, X } = mk();
    assert.throws(() => arena.joinN([R], [X], 1, 1), /reqMask and excMask share bit\(s\) 1 /);
    assert.doesNotThrow(() => arena.joinN([R], [X], 1, 0, 0, 1));
    assert.doesNotThrow(() => arena.joinN([R], [X], 0, 1, 1, 0));
    assert.doesNotThrow(() => arena.joinN([R], [X], 1, 0, 1, 0));
    const p = arena.joinN([R], [X], 1, 0, 0, 1);
    assert.equal(p.reqMask, 1);
    assert.equal(p.excMask, 0);
    assert.equal(p.reqMaskHi, 0);
    assert.equal(p.excMaskHi, 1);
});

test('A3 checked joinN: Hi mask with no Hi row -> the pinned no-Hi-row error', () => {
    const arena = new Arena(8, { checked: true });
    arena.registerFlags(['a']);
    const R = arena.registerTag();
    arena.spawn();
    assert.throws(() => arena.joinN([R], null, 0, 0, 4, 0), (err) => err.message === NO_HI(4, 0));
    assert.throws(() => arena.joinN([R], null, 0, 0, 0, 2), (err) => err.message === NO_HI(0, 2));
    assert.doesNotThrow(() => arena.joinN([R], null, 0, 0, 0, 0));
});

test('A3 every checked joinN throw keeps the previous plan readable (M-22)', () => {
    const { arena, H, R, X } = mk();
    const foreign = new Arena(4).registerTag();
    const p = arena.joinN([R], [X], 1, 2, H.p, H.q);
    const snap = () => [p.driver, p.count, p.others, p.othersCount, p.excl, p.exclCount,
        p.reqMask, p.excMask, p.reqMaskHi, p.excMaskHi, p.flags, p.flagsHi];
    const want = snap();
    assert.equal(want[0], R);
    assert.equal(want[8], 1);
    assert.equal(want[9], 2);
    assert.equal(want[11], arena.flagsHi);
    const bad = [
        () => arena.joinN([R], [X], 0, 0, undefined),
        () => arena.joinN([R], [X], 0, 0, 1.5),
        () => arena.joinN([R], [X], 0, 0, 0, NaN),
        () => arena.joinN([R], [X], 0, 0, 0, 2 ** 32),
        () => arena.joinN([R], [X], 0, 0, 1, 1),
        () => arena.joinN([R], [X], 1, 1),
        () => arena.joinN([R], [X], undefined),
        () => arena.joinN([foreign], [X], 0, 0, H.p),
        () => arena.joinN([R], [R], 0, 0, H.p),
        () => arena.joinN([], [X], 0, 0, H.p),
    ];
    for (let i = 0; i < bad.length; i++) {
        assert.throws(bad[i], Error, 'bad #' + i);
        assert.deepEqual(snap(), want, 'plan intact after bad #' + i);
    }
    // the no-Hi-row throw, on its own arena
    const b = new Arena(4, { checked: true });
    b.registerFlags(['a']);
    const T = b.registerTag();
    T.add(b.spawn());
    const q = b.joinN([T]);
    assert.throws(() => b.joinN([T], null, 0, 0, 1), /no Hi flag row/);
    assert.equal(q.count, 1);
    assert.equal(q.reqMaskHi, 0);
    assert.equal(q.excMaskHi, 0);
    assert.equal(q.flagsHi, null);
});

test('A3 a stale plan throws on flagsHi, reqMaskHi and excMaskHi', () => {
    const { arena, H, R, X } = mk();
    const p = arena.joinN([R], [X], 0, 0, H.p, H.q);
    assert.equal(p.reqMaskHi, 1); // fresh reads fine
    assert.equal(p.excMaskHi, 2);
    assert.equal(p.flagsHi, arena.flagsHi);
    arena.joinN([R]);
    assert.throws(() => p.flagsHi, /stale/);
    assert.throws(() => p.reqMaskHi, /stale/);
    assert.throws(() => p.excMaskHi, /stale/);
    const q = arena.joinN([R], null, 0, 0, H.p);
    arena.join(R, X);
    assert.throws(() => q.flagsHi, /stale/);
});

const HI_CHK = ['clearFlagAllHi', 'clearFlagsHi', 'firstFlaggedHi', 'flagCountHi', 'hasFlagsHi', 'nextFlaggedHi', 'setFlagsHi'];
test('A3 own *Hi function keys: production arena 0, checked arena exactly the three Hi flag methods + the four F2 Hi query wrappers', () => {
    const own = (a) => Object.getOwnPropertyNames(a)
        .filter((k) => k.endsWith('Hi') && typeof a[k] === 'function').sort();
    const prod = new Arena(8);
    assert.deepEqual(own(prod), []);
    assert.equal(prod.flagsHi, null); // data field, not a function
    prod.registerFlags(['a']);
    prod.registerFlagsHi(['p']);
    assert.deepEqual(own(prod), []);
    assert.equal(Object.prototype.hasOwnProperty.call(prod, 'setFlagsHi'), false);
    const chk = new Arena(8, { checked: true });
    assert.deepEqual(own(chk), HI_CHK);
    chk.registerFlags(['a']);
    chk.registerFlagsHi(['p']);
    assert.deepEqual(own(chk), HI_CHK);
    // the checked wrappers are not the prototype methods
    assert.notEqual(chk.setFlagsHi, Arena.prototype.setFlagsHi);
    assert.equal(prod.setFlagsHi, Arena.prototype.setFlagsHi);
});

test('A3 production (unchecked) Hi methods do not validate: bad masks normalise | 0', () => {
    const { arena, e } = mk({});
    assert.doesNotThrow(() => arena.setFlagsHi(e, undefined));
    assert.equal(arena.setFlagsHi(e, 2 ** 32 + 5), true); // | 0 -> 5
    assert.equal(arena.flagsHi[e & arena.indexMask], 5);
    assert.doesNotThrow(() => arena.joinN([arena.components[0]], null, 0, 0, undefined));
});

// B2: Hi analog of checked-epoch A13 -- the no-Hi-row error beats foreign / both-lists / M-13-Hi.
test('B2 checked: no-Hi-row error beats foreign set, set in both lists, and the M-13-Hi share-bits error', () => {
    const arena = new Arena(4, { checked: true });
    arena.registerFlags(['a']);
    const R = arena.registerTag();
    const X = arena.registerTag();
    R.add(arena.spawn());
    const foreign = new Arena(4).registerTag();
    assert.throws(() => arena.joinN([foreign], null, 0, 0, 1), (e) => e.message === NO_HI(1, 0));
    assert.throws(() => arena.joinN([R], [R], 0, 0, 1), (e) => e.message === NO_HI(1, 0));
    assert.throws(() => arena.joinN([R], [X], 0, 0, 1, 1), (e) => e.message === NO_HI(1, 1));
});

// B3: bypass guard -- a direct prototype call (skipping the cached-result path) still validates and stales.
test('B3 checked: Arena.prototype.joinN.call bypass rejects Hi share-bits, stales the prior result, allows cross-word overlap', () => {
    const { arena, R, X } = mk();
    const p = arena.joinN([R], [X]);
    assert.throws(() => Arena.prototype.joinN.call(arena, [R], [X], 0, 0, 1, 1),
        /reqMaskHi and excMaskHi share bit\(s\) 1 /);
    assert.throws(() => p.count, /stale/);
    assert.doesNotThrow(() => Arena.prototype.joinN.call(arena, [R], [X], 1, 0, 0, 1));
});
