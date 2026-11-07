/**
 * @zakkster/lite-arena -- 1.12.1-A engine cold paths (PLAN-1.12.1-A: M-56, M-59, M-61, M-62).
 * Expected values come from the PLAN's ASSERTIONS A1 / A3 / A4 / A5 and error wording,
 * never from the build under test. The golden (A3) is cut from the frozen 3eb87a7 build
 * by test/golden/cold-1121a-workload.mjs.
 *
 * Rows prefixed "FIX" are the six A1 fix rows: they FAIL on the frozen build. Every other
 * row (PARITY / A4 / A5) passes on both builds, except where noted.
 *
 * Run: `node --test test/cold-paths-1121a.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/cold-paths-1121a.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './golden/cold-1121a-workload.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena, SparseSet } = mod;

const CAP = 8;
const F32 = { x: Float32Array, y: Float32Array };
const buf = () => new ArrayBuffer(CAP * 4);
const pair = () => ({ x: buf(), y: buf() });

// ---------------------------------------------------------------- A1 fix rows

test('FIX M-56: registerComponent options bag is validated like flagMap', () => {
    const a = () => new Arena(CAP);
    assert.throws(() => a().registerComponent(F32, { buffer: pair() }), /lite-arena: registerComponent options accept only "buffers"; got buffer/);
    assert.throws(() => a().registerComponent(F32, { buffers: pair(), shared: true }), /registerComponent options accept only "buffers"; got shared/);
    assert.throws(() => a().registerComponent(F32, { [Symbol('s')]: 1 }), /registerComponent options accept only "buffers"; got Symbol\(s\)/);
    // M-40 form: the `got` part is typeof for a non-object / array, as registerFlags prints (golden).
    assert.throws(() => a().registerComponent(F32, 5), /lite-arena: registerComponent options accept only "buffers"; got number/);
    assert.throws(() => a().registerComponent(F32, []), /lite-arena: registerComponent options accept only "buffers"; got object/);
    class Opts { constructor() { this.buffers = pair(); } }
    assert.throws(() => a().registerComponent(F32, new Opts()), /registerComponent options must be a plain object/);
    // Object.create(null) is a plain object: accepted.
    const nb = Object.create(null); nb.buffers = pair();
    assert.doesNotThrow(() => a().registerComponent(F32, nb));
    // Fail-open guard: options are read by OWN key. A buffers map planted on Object.prototype
    // must not turn an empty bag caller-backed.
    const planted = buf();
    Object.prototype.buffers = { x: planted };
    try {
        const P = a().registerComponent({ x: Float32Array }, {});
        assert.equal(P._callerBacked, undefined);
        assert.notEqual(P.data.x.buffer, planted);
    } finally {
        delete Object.prototype.buffers;
    }
    // A rejected bag leaves nothing registered.
    const ar = a();
    assert.throws(() => ar.registerComponent(F32, { buffer: pair() }));
    assert.equal(ar.components.length, 0);
});

test('FIX O-3: a buffers getter is read exactly once; the view is the validated buffer', () => {
    const a = new Arena(CAP);
    const ab = buf();
    let reads = 0;
    const bufs = { get x() { reads++; return reads === 1 ? ab : [1, 2, 3]; } };
    const C = a.registerComponent({ x: Float32Array }, { buffers: bufs });
    assert.equal(reads, 1);
    assert.equal(C.data.x.buffer, ab);
    assert.equal(C.data.x.length, 8);
    // M-70: validateBuffers reads OWN keys of the buffers map only.
    Object.prototype.y = buf();
    try {
        assert.throws(() => new Arena(CAP).registerComponent(F32, { buffers: { x: buf() } }),
            /missing a buffer for component field "y"/);
    } finally {
        delete Object.prototype.y;
    }
    assert.throws(() => new Arena(CAP).registerComponent({ x: Float32Array }, { buffers: Object.create({ x: buf() }) }),
        /missing a buffer for component field "x"/);
});

test('FIX F-4 registration: two fields sharing one buffer throw', () => {
    const a = new Arena(CAP);
    const b = buf();
    assert.throws(() => a.registerComponent(F32, { buffers: { x: b, y: b } }),
        /buffer for component field "y" is already used by field "x" -- each field needs its own buffer\. See decisions\/0006-caller-supplied-buffers\.md/);
    assert.equal(a.components.length, 0);
    // Direct construction has the same door.
    assert.throws(() => new SparseSet(CAP, F32, new Arena(CAP), { x: b, y: b }), /already used by field "x"/);
    // Distinct buffers are fine.
    assert.doesNotThrow(() => a.registerComponent(F32, { buffers: pair() }));
});

test('FIX F-4 rebind: aliased supplied buffers, and a buffer owned by an untouched field, throw atomically', () => {
    const a = new Arena(CAP);
    const S = a.registerComponent(F32);
    const x0 = S.data.x, y0 = S.data.y;
    const s = buf();
    assert.throws(() => S.rebind({ x: s, y: s }),
        /rebind\(\) was given a buffer for "y" that is already used by field "x" -- each field needs its own buffer\. See decisions\/0007-transferable-roundtrip\.md/);
    assert.equal(S.data.x, x0);
    assert.equal(S.data.y, y0);

    const xb = buf(), yb = buf();
    const C = new Arena(CAP).registerComponent(F32, { buffers: { x: xb, y: yb } });
    const cx = C.data.x, cy = C.data.y;
    assert.throws(() => C.rebind({ x: yb }), /rebind\(\) was given a buffer for "x" that is already used by field "y"/);
    assert.equal(C.data.x, cx);
    assert.equal(C.data.y, cy);
    assert.equal(C.data.x.buffer, xb);
});

test('FIX M-62: a direct SparseSet is registered; registerComponent adds exactly one', () => {
    const a = new Arena(CAP);
    const D = new SparseSet(CAP, { x: Float32Array }, a);
    assert.equal(a.components.length, 1);
    a.registerComponent({ y: Float32Array });
    assert.equal(a.components.length, 2);
    // O-4 sequence: reserve, then re-add a high-slot entity three times.
    const b = new Arena(4);
    const S = new SparseSet(4, { x: Float32Array }, b);
    b.reserve(8);
    assert.equal(b.components.length, 1);
    const hs = [];
    for (let i = 0; i < 8; i++) hs.push(b.spawn());
    const e = hs.find((h) => (h & 0xFFFFF) >= 4);
    assert.notEqual(e, undefined);
    S.add(e); S.add(e); S.add(e);
    assert.equal(S.count, 1);
    assert.equal(S.has(e), true);
    assert.equal(b.components.length, 1);
    // despawn clears it
    b.despawn(e);
    assert.equal(S.has(e), false);
    assert.equal(S.count, 0);
    // clear() clears it
    const e2 = b.spawn();
    S.add(e2);
    assert.equal(S.count, 1);
    b.clear();
    assert.equal(S.count, 0);
    assert.equal(D.count, 0);
});

test('FIX M-59: reserve() at or below capacity is false on caller-backed, rebound and detached arenas', () => {
    const cb = new Arena(CAP);
    cb.registerComponent({ x: Float32Array }, { buffers: { x: buf() } });
    const rb = new Arena(CAP);
    rb.registerComponent({ x: Float32Array }).rebind({ x: buf() });
    const dt = new Arena(CAP);
    const [b] = dt.registerComponent({ x: Float32Array }).detach(['x']);
    structuredClone(b, { transfer: [b] });
    for (const a of [cb, rb, dt]) {
        assert.equal(a.reserve(CAP), false);
        assert.equal(a.reserve(CAP - 1), false);
        assert.equal(a.reserve(0), false);
        assert.equal(a.capacity, CAP);
    }
    // Ordering: the integer check runs before the no-op check, on every arena kind.
    for (const a of [new Arena(CAP), cb, rb, dt]) for (const v of [1.5, -0.5]) assert.throws(() => a.reserve(v), /reserve capacity must be an integer/);
    // Growth is still refused (same wording as the golden).
    assert.throws(() => cb.reserve(CAP * 2), /reserve\(\) cannot grow this arena/);
    assert.throws(() => dt.reserve(CAP * 2), /reserve\(\) cannot grow this arena/);
});

// ---------------------------------------------------------------- A3 parity

test('PARITY golden replay is byte-identical to the 3eb87a7 cut', () => {
    const golden = JSON.parse(readFileSync(join(ROOT, 'test/golden/cold-1121a-3eb87a7.json'), 'utf8'));
    const live = JSON.parse(JSON.stringify(run(mod)));
    assert.deepEqual(live, golden);
    assert.equal(JSON.stringify(live), JSON.stringify(golden));
});

test('PARITY still accepted: options undefined / null / {} / {buffers: undefined} / valid buffers', () => {
    for (const o of [undefined, null, {}, { buffers: undefined }]) {
        const a = new Arena(CAP);
        const S = a.registerComponent(F32, o);
        assert.equal(S.data.x.length, CAP);
        assert.equal(a.components.length, 1);
    }
    const bs = pair();
    const S = new Arena(CAP).registerComponent(F32, { buffers: bs });
    assert.equal(S.data.x.buffer, bs.x);
    assert.equal(S.data.y.buffer, bs.y);
});

test('PARITY still accepted: rebind swap, same-buffer self rebind, single-field rebind', () => {
    const xb = buf(), yb = buf();
    new Float32Array(xb)[0] = 11; new Float32Array(yb)[0] = 22;
    const S = new Arena(CAP).registerComponent(F32, { buffers: { x: xb, y: yb } });
    S.rebind({ x: yb, y: xb });
    assert.equal(S.data.x.buffer, yb);
    assert.equal(S.data.y.buffer, xb);
    assert.equal(S.data.x[0], 22);
    assert.equal(S.data.y[0], 11);

    const T = new Arena(CAP).registerComponent(F32);
    const own = T.data.x.buffer;
    T.rebind({ x: T.data.x.buffer });
    assert.equal(T.data.x.buffer, own);

    const U = new Arena(CAP).registerComponent(F32);
    const nb = buf();
    U.rebind({ y: nb });
    assert.equal(U.data.y.buffer, nb);
    assert.equal(U.data.y.length, CAP);
});

// ---------------------------------------------------------------- A4 / A5 probe

const PROBE = join(ROOT, 'test/cold-1121a-probe.mjs');
const FLAGS = ['--expose-gc', '--trace-gc', '--min-semi-space-size=1', '--max-semi-space-size=1'];
const probe = spawnSync(process.execPath, [...FLAGS, PROBE], {
    cwd: ROOT, env: { ...process.env }, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024,
});
const ctlRun = spawnSync(process.execPath, [...FLAGS, PROBE], {
    cwd: ROOT, env: { ...process.env, COLD_LEAK: '1', COLD_ALLOC: '1' }, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024,
});
let ctl = null;
if (ctlRun.status === 0) for (const ln of ctlRun.stdout.split('\n')) if (ln.startsWith('{')) ctl = JSON.parse(ln);
let report = null, scav = -1, mark = -1;
if (probe.status === 0) {
    scav = 0; mark = 0;
    let inWin = false;
    for (const ln of probe.stdout.split('\n')) {
        if (ln === 'WIN-START') inWin = true;
        else if (ln === 'WIN-END') inWin = false;
        else if (inWin && /Scavenge/.test(ln)) scav++;
        else if (inWin && /Mark-Compact|Mark-sweep/.test(ln)) mark++;
        else if (ln.startsWith('{')) report = JSON.parse(ln);
    }
}

test('A4 probe ran', () => {
    assert.equal(probe.status, 0, 'probe exit ' + probe.status + ': ' + String(probe.stderr).slice(0, 400));
    assert.notEqual(report, null);
});

test('A4 GC: direct set after reserve(2x), 100,000 spawn / add / has / despawn cycles: 0 GC, < 0.01 B/op', () => {
    assert.equal(report.ops, 100000);
    // (set membership / registration is the M-62 FIX row's job; this row is GC only and holds on both builds)
    assert.equal(report.activeCount, 0);
    assert.equal(mark, 0, 'Mark-Compact lines in window');
    assert.equal(scav, 0, 'Scavenge lines in window (1 MiB semi-space: >= ~10 B/op would show)');
    assert.ok(report.heapRetained < 0.01 * report.ops, 'new-space growth ' + report.heapRetained + ' B over ' + report.ops + ' ops');
});

test('A5 retention: 1,000 cycles of (arena, direct set, caller-backed, rebind, drop) retain nothing', () => {
    assert.equal(report.tracked, 4000);
    assert.equal(report.retained, 0);
});

test('A5 throwing constructions leave components.length 0', () => {
    assert.equal(report.throws, 1000);
    assert.equal(report.componentsAfterThrows, 0);
});

test('CONTROL must fail: leaking + allocating probe is seen by both lanes', () => {
    assert.equal(ctlRun.status, 0, 'control probe exit ' + ctlRun.status + ': ' + String(ctlRun.stderr).slice(0, 400));
    assert.equal(ctl.retained, 4000);
    assert.ok(ctl.heapRetained >= 0.01 * ctl.ops, 'control new-space growth ' + ctl.heapRetained + ' B');
});
