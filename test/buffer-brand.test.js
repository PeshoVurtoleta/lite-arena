/**
 * @zakkster/lite-arena -- caller-supplied buffer validation uses a brand check,
 * not instanceof (M-23). Oracle: PLAN-F assertions A6-A8, not the build.
 * Fake prototype-only look-alikes are rejected; cross-realm buffers accepted.
 *
 * Run: `node --test test/buffer-brand.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/buffer-brand.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

const CAP = 8;
const N = CAP * 4; // capacity * Float32Array.BYTES_PER_ELEMENT
const BRAND = /must be an ArrayBuffer or SharedArrayBuffer/;
const hasSAB = typeof SharedArrayBuffer === 'function';

const fresh = () => new Arena(CAP);
const fakeAB = () => Object.create(ArrayBuffer.prototype, { byteLength: { value: N } });
const fakeSAB = () => Object.create(SharedArrayBuffer.prototype, { byteLength: { value: N } });

function viaCtor(arena, buf) { return arena.registerComponent({ x: Float32Array }, { buffers: { x: buf } }); }
function viaRebind(arena, buf) {
    const set = arena.registerComponent({ x: Float32Array });
    set.rebind({ x: buf });
    return set;
}

test('A6 fake ArrayBuffer look-alike rejected by registerComponent buffers', () => {
    assert.throws(() => viaCtor(fresh(), fakeAB()), BRAND);
});
test('A6 fake ArrayBuffer look-alike rejected by rebind()', () => {
    assert.throws(() => viaRebind(fresh(), fakeAB()), BRAND);
});
test('A6 rebind() rejection of a fake leaves data.x unchanged', () => {
    const set = fresh().registerComponent({ x: Float32Array });
    const x0 = set.data.x;
    assert.throws(() => set.rebind({ x: fakeAB() }), BRAND);
    assert.equal(set.data.x, x0);
});
test('A6 fake SharedArrayBuffer look-alike rejected (ctor path + rebind)', { skip: !hasSAB }, () => {
    assert.throws(() => viaCtor(fresh(), fakeSAB()), BRAND);
    assert.throws(() => viaRebind(fresh(), fakeSAB()), BRAND);
});

test('A7 cross-realm ArrayBuffer accepted by buffers path; views read/write', () => {
    const buf = vm.runInNewContext('new ArrayBuffer(' + N + ')');
    const set = viaCtor(fresh(), buf);
    set.data.x[3] = 2.5;
    assert.equal(new Float32Array(buf)[3], 2.5);
    new Float32Array(buf)[5] = -7;
    assert.equal(set.data.x[5], -7);
    assert.equal(set.data.x.length, CAP);
});
test('A7 cross-realm ArrayBuffer accepted by rebind(); views read/write', () => {
    const buf = vm.runInNewContext('new ArrayBuffer(' + N + ')');
    const set = viaRebind(fresh(), buf);
    set.data.x[0] = 1.5;
    assert.equal(new Float32Array(buf)[0], 1.5);
    assert.equal(set.data.x.buffer, buf);
});
test('A7 cross-realm SharedArrayBuffer accepted (ctor path + rebind)', { skip: !hasSAB }, () => {
    const s1 = vm.runInNewContext('new SharedArrayBuffer(' + N + ')');
    const set1 = viaCtor(fresh(), s1);
    set1.data.x[2] = 4.25;
    assert.equal(new Float32Array(s1)[2], 4.25);
    const s2 = vm.runInNewContext('new SharedArrayBuffer(' + N + ')');
    const set2 = viaRebind(fresh(), s2);
    set2.data.x[1] = 8;
    assert.equal(new Float32Array(s2)[1], 8);
});

test('A8 real ArrayBuffer of wrong size still throws wrong-byteLength (pin)', () => {
    assert.throws(() => viaCtor(fresh(), new ArrayBuffer(N + 4)), /wrong byteLength/);
    assert.throws(() => viaRebind(fresh(), new ArrayBuffer(N - 4)), /wrong byteLength/);
});
test('A8 detached buffer throws (byteLength 0 != expected) (pin)', () => {
    const b1 = new ArrayBuffer(N);
    structuredClone(b1, { transfer: [b1] });
    assert.equal(b1.byteLength, 0);
    assert.throws(() => viaCtor(fresh(), b1), /wrong byteLength/);
    const b2 = new ArrayBuffer(N);
    structuredClone(b2, { transfer: [b2] });
    assert.throws(() => viaRebind(fresh(), b2), /wrong byteLength/);
});

// ---- Addendum A1 reviewer literals.
test('A6c shadowed own byteLength cannot hide a wrong real size (ctor + rebind)', () => {
    // real buffer is N+4 bytes; an own property lies that it is N
    const big = () => { const b = new ArrayBuffer(N + 4); Object.defineProperty(b, 'byteLength', { value: N }); return b; };
    assert.throws(() => viaCtor(fresh(), big()), /wrong byteLength/);
    assert.throws(() => viaRebind(fresh(), big()), /wrong byteLength/);
});

test('A6d Proxy around a real ArrayBuffer is rejected by the brand check (ctor + rebind)', () => {
    const px = () => new Proxy(new ArrayBuffer(N), {});
    assert.throws(() => viaRebind(fresh(), px()), BRAND);
    assert.throws(() => viaCtor(fresh(), px()), BRAND);
});
