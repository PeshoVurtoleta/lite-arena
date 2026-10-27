/**
 * @zakkster/lite-arena -- checked joinN validates BEFORE the epoch bump (M-22).
 * Oracle: PLAN-F assertions A1-A5, not the build. A throwing checked joinN
 * (set in both lists, foreign set, M-13 shared flag bits) must leave an earlier
 * plan live; a SUCCESSFUL join/joinN still supersedes it (AR-09, unchanged).
 *
 * Run: `node --test test/checked-epoch.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/checked-epoch.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

const STALE = /stale|superseded/;

function make() {
    const a = new Arena(8, { checked: true });
    const F = a.registerFlags(['a', 'b']);
    const A = a.registerTag();
    const B = a.registerTag();
    return { a, F, A, B };
}

test('A1 both-lists joinN throws; earlier joinN plan stays readable', () => {
    const { a, A, B } = make();
    const p1 = a.joinN([A], [B]);
    assert.throws(() => a.joinN([A], [A]));
    assert.doesNotThrow(() => p1.count);
    assert.equal(p1.count, 0);
});

test('A2 foreign set in required: earlier plan stays live', () => {
    const { a, A, B } = make();
    const other = new Arena(8, { checked: true });
    const X = other.registerTag();
    const p1 = a.joinN([A], [B]);
    assert.throws(() => a.joinN([X]));
    assert.equal(p1.count, 0);
});

test('A2 foreign set in excluded: earlier plan stays live', () => {
    const { a, A, B } = make();
    const other = new Arena(8, { checked: true });
    const X = other.registerTag();
    const p1 = a.joinN([A], [B]);
    assert.throws(() => a.joinN([A], [X]));
    assert.equal(p1.count, 0);
});

test('A3 M-13 shared flag bits throw; earlier plan stays live', () => {
    const { a, F, A } = make();
    const p1 = a.joinN([A]);
    assert.throws(() => a.joinN([A], [], F.a, F.a));
    assert.equal(p1.count, 0);
});

test('A4 successful joinN supersedes an earlier joinN plan (AR-09 pin)', () => {
    const { a, A, B } = make();
    const p1 = a.joinN([A]);
    a.joinN([B]);
    assert.throws(() => p1.count, STALE);
});

test('A4 successful join supersedes an earlier join plan (AR-09 pin)', () => {
    const { a, A, B } = make();
    const p1 = a.join(A, B);
    a.join(A, B);
    assert.throws(() => p1.count, STALE);
});

test('A5 checked join plan stays live after a throwing checked joinN (shared epoch)', () => {
    const { a, A, B } = make();
    const jp = a.join(A, B);
    assert.throws(() => a.joinN([A], [A]));
    assert.doesNotThrow(() => jp.count);
    // and a successful joinN afterwards does supersede it
    a.joinN([A]);
    assert.throws(() => jp.count, STALE);
});

// ---- Addendum A1 (reviewer literals): a throwing checked joinN must not touch the
// shared others/excl scratch that an earlier surviving plan aliases.
function tags(a, n) { const r = []; for (let i = 0; i < n; i++) r.push(a.registerTag()); return r; }

test('A1b throwing joinN (both lists) leaves earlier plan others/excl intact', () => {
    const a = new Arena(8, { checked: true });
    const [A, B, C, D] = tags(a, 4);
    const p1 = a.joinN([A, B], [C]); // all counts 0 -> driver A, others [B], excl [C]
    assert.equal(p1.others[0], B);
    assert.equal(p1.excl[0], C);
    const oc = p1.othersCount, ec = p1.exclCount;
    assert.equal(oc, 1);
    assert.equal(ec, 1);
    assert.throws(() => a.joinN([D, C], [D]));
    assert.equal(p1.others[0], B);
    assert.equal(p1.excl[0], C);
    assert.equal(p1.othersCount, oc);
    assert.equal(p1.exclCount, ec);
});

test('A2b throwing joinN (foreign set) leaves earlier plan others/excl intact', () => {
    const a = new Arena(8, { checked: true });
    const [A, B, C, D] = tags(a, 4);
    const X = new Arena(8, { checked: true }).registerTag();
    const p1 = a.joinN([A, B], [C]);
    assert.throws(() => a.joinN([D, X], [C]));
    assert.equal(p1.others[0], B);
    assert.equal(p1.excl[0], C);
    assert.equal(p1.othersCount, 1);
    assert.equal(p1.exclCount, 1);
});

test('A3b throwing joinN (M-13 shared flag bits) leaves earlier plan others/excl intact', () => {
    const a = new Arena(8, { checked: true });
    const F = a.registerFlags(['a', 'b']);
    const [A, B, C, D] = tags(a, 4);
    const p1 = a.joinN([A, B], [C]);
    assert.throws(() => a.joinN([D, C], [B], F.a, F.a));
    assert.equal(p1.others[0], B);
    assert.equal(p1.excl[0], C);
    assert.equal(p1.othersCount, 1);
    assert.equal(p1.exclCount, 1);
});

// ---- A10 (M-25): supplied-but-undefined mask throws in checked mode only.
test('A10 checked: supplied undefined mask throws; omitted masks do not', () => {
    const { a, A } = make();
    assert.throws(() => a.joinN([A], [], undefined), /32-bit integer/);
    assert.throws(() => a.joinN([A], [], 0, undefined), /32-bit integer/);
    assert.doesNotThrow(() => a.joinN([A], []));
    assert.doesNotThrow(() => a.joinN([A]));
});

test('A10 production: supplied undefined mask does not throw', () => {
    const a = new Arena(8);
    const A = a.registerTag();
    assert.doesNotThrow(() => a.joinN([A], [], undefined));
});

// ---- A11 (M-25 / A1 order): M-11, mask, M-10 (no flags), foreign / both-lists / M-13.
test('A11 empty required beats mask error', () => {
    const { a } = make();
    assert.throws(() => a.joinN([], [], 'x'), /at least one required set/);
});

test('A11 nonzero mask on arena without registerFlags throws the no-flags error', () => {
    const a = new Arena(8, { checked: true });
    const A = a.registerTag();
    assert.throws(() => a.joinN([A], [], 1), /registerFlags/);
});

test('A11 both-lists error fires before M-13', () => {
    const a = new Arena(8, { checked: true });
    a.registerFlags(['a']);
    const A = a.registerTag();
    assert.throws(() => a.joinN([A], [A], 1, 1), (e) => !/flag bit|shared|mask/i.test(e.message) || /both|required|excluded/i.test(e.message));
});

test('A12 direct prototype joinN on a checked arena fails closed: throws, earlier plan stale', () => {
    const a = new Arena(8, { checked: true });
    const [A, B] = tags(a, 2);
    const X = new Arena(8, { checked: true }).registerTag();
    const p1 = a.joinN([A, B]);
    assert.throws(() => Arena.prototype.joinN.call(a, [A, X]), /not registered/);
    assert.throws(() => p1.others, STALE);
});

test('A13 M-10: the no-flags error beats foreign / both-lists / M-13', () => {
    const a = new Arena(8, { checked: true });
    const A = a.registerTag();
    const X = new Arena(8, { checked: true }).registerTag();
    assert.throws(() => a.joinN([X], null, 1), /registerFlags/);
    assert.throws(() => a.joinN([A], [A], 1), /registerFlags/);
    assert.throws(() => a.joinN([A], [], 1, 1), /registerFlags/);
});
