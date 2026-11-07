/**
 * @zakkster/lite-arena -- F2 L3 new-space probe (G3 T4; PLAN-F2 G3 A1 / A2, M-46, M-51).
 * DETERMINISTIC (GC counts + byte deltas), not timed. Spawned by
 * test/flags-indexed-alloc.test.js with:
 *   --expose-gc --trace-gc --min-semi-space-size=1 --max-semi-space-size=1
 * FAILS CLOSED (exit 2) unless both semi-space flags are in process.execArgv, gc() is
 * exposed and v8.GCProfiler exists; exit 2 too when the build has no indexed API
 * (e.g. fe8d7d5). Exit 1 = harness error (bad knob, a lane precondition broke, or a pair
 * lane does not reach the indexed write path).
 *
 * A1 count lanes: per lane 20,000 warm-up ops, a `LANE-START <name>` line, 500,000 ops
 *   (20,000 for walk), a `LANE-END <name>` line. The test counts the
 *   --trace-gc `Scavenge` and `Mark-Compact` lines between the markers. Lanes: noop,
 *   ixPair1, ixPair4 (f0 f1 f2 f31), hiPair (h0 h31), ixChurn (set + despawn + spawn),
 *   flagCount, firstFlagged, joinNHint (joinN + a driverFlag-driven walk), checkedPair,
 *   walk (first / nextFlagged), clearAll (clearFlagAll + refill; 500,000 ops), the Hi twins flagCountHi,
 *   firstFlaggedHi, walkHi (first / nextFlaggedHi), clearAllHi (clearFlagAllHi + refill; walkHi
 *   and clearAllHi run the full 500,000 ops), box (must-fail). Budget: <= noop + 1 Scavenge = ~2.1 B/op
 *   at 500,000 ops; only walk (20,000 ops, ~52 B/op) has the coarser resolution.
 *   The pair lanes (ixPair1, ixPair4, checkedPair) prove the indexed write is reached: after
 *   LANE-END, OUTSIDE every window, a reach check runs per bit b of the lane's mask on the
 *   first entity -- setFlags, firstFlagged(b) === it, flagCount(b) === 1, clearFlags,
 *   flagCount(b) === 0. A miss or a throw (E-BIT: b is not indexed, so the op drove the plain
 *   write path) exits 1.
 * M-51 byte lanes: new-space used bytes (v8.getHeapSpaceStatistics) across a window of
 *   400,000 ops with NO GC inside it (v8.GCProfiler; a window that saw a GC is re-armed,
 *   at most 8 tries, then NaN = fail closed). 4 windows per lane, window 0 discarded,
 *   steady state = the minimum of windows 1..3. Lanes: noop, ixSet1 (one ixSetFlags +
 *   one ixClearFlags per op), ctl1k (noop + one new Int32Array(1) per 1,000 ops: the
 *   harness's own must-fail, same rate as the once-per-1,000 mutant). Each window is
 *   bracketed by `BWIN-START` / `BWIN-END ... ok|rearm <bytes>` lines. After its 4 windows
 *   (OUTSIDE every window) ixSet1 runs the same check + reach check as the pair lanes, so a
 *   0 B read is from the indexed write path; a miss or a throw exits 1.
 * A2 retention: 64 cycles of Arena(4096), indexed a (word 0) and h (Hi), 100 entities
 *   flagged; the old _ixW / _ixS1 / _ixWHi / _ixS1Hi columns are tracked (256), then
 *   reserve(8192) and clear(). tracker.size() after a settled GC, arenas alive and dropped.
 * The last stdout line starting with `{` is a JSON object with the byte / retention results.
 *
 * Knobs (must-fail controls): F2NS_BOX=<lane>|1 adds one {a: i} per op to that count lane
 *   (1 = ixPair1); F2NS_LEAK=1 keeps the old columns reachable (retention reads 256).
 * Build under test: LITE_ARENA_PATH=/abs/path/Arena.js (default ../../Arena.js).
 *
 * MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 */
import { pathToFileURL } from 'node:url';
import { writeSync } from 'node:fs';
import v8 from 'node:v8';
import { createLeakTracker } from '@zakkster/lite-leak';
import { indexedApiMissing } from './lib.mjs';

const say = (s) => writeSync(1, s + '\n');
const fail = (code, s) => { process.stderr.write('newspace-probe: ' + s + '\n'); process.exit(code); };

const gc = globalThis.gc;
if (typeof gc !== 'function') fail(2, 'needs --expose-gc');
const ea = process.execArgv;
if (!ea.includes('--min-semi-space-size=1') || !ea.includes('--max-semi-space-size=1') || !ea.includes('--trace-gc')) {
    fail(2, 'needs --trace-gc --min-semi-space-size=1 --max-semi-space-size=1 (got ' + ea.join(' ') + ')');
}
if (typeof v8.GCProfiler !== 'function') fail(2, 'needs v8.GCProfiler (node >= 19.6)');

const COUNT_LANES = ['noop', 'ixPair1', 'ixPair4', 'hiPair', 'ixChurn', 'flagCount', 'firstFlagged', 'joinNHint',
    'checkedPair', 'walk', 'clearAll', 'flagCountHi', 'firstFlaggedHi', 'walkHi', 'clearAllHi', 'box'];
const BOX_ENV = process.env.F2NS_BOX;
const BOX = BOX_ENV === undefined || BOX_ENV === '' ? null : BOX_ENV === '1' ? 'ixPair1' : BOX_ENV;
if (BOX !== null && (BOX === 'noop' || BOX === 'box' || !COUNT_LANES.includes(BOX))) {
    fail(1, 'F2NS_BOX=' + BOX_ENV + ' is not an F2 lane (one of 1, ' + COUNT_LANES.slice(1, -1).join(', ') + ')');
}
const LEAK_ENV = process.env.F2NS_LEAK;
if (LEAK_ENV !== undefined && LEAK_ENV !== '' && LEAK_ENV !== '0' && LEAK_ENV !== '1') fail(1, 'F2NS_LEAK must be 0 or 1, got ' + LEAK_ENV);
const LEAK = LEAK_ENV === '1';

const BUILD = process.env.LITE_ARENA_PATH ? pathToFileURL(process.env.LITE_ARENA_PATH).href : '../../Arena.js';
let Arena;
try {
    Arena = (await import(BUILD)).Arena;
} catch (e) {
    fail(1, 'build failed to import: ' + (e && e.message));
}
const missing = indexedApiMissing(Arena);
if (missing !== null) fail(2, 'NO-VERDICT: ' + missing);
if (typeof Arena.prototype.flagCountHi !== 'function') fail(2, 'NO-VERDICT: build has no Arena.prototype.flagCountHi (no indexed Hi API)');

const N = 1024, MASK = N - 1;
const WARM = 20000, OPS = 500000, WOPS = 20000;
const NAMES = [], HNAMES = [];
for (let i = 0; i < 32; i++) { NAMES.push('f' + i); HNAMES.push('h' + i); }
const B31 = 1 << 31;
const S = new Int32Array(1);          // int sink: every lane folds its result here
const HOLD = [null];                  // object sink (box lanes)

function spawnAll(a, n) {
    const es = new Int32Array(n);
    for (let i = 0; i < n; i++) es[i] = a.spawn();
    return es;
}
function mkPair(opts, ix, m) {
    const a = new Arena(N, opts);
    a.registerFlags(NAMES, { indexed: ix });
    const es = spawnAll(a, N);
    const op = function (i) { const e = es[i & MASK]; a.setFlags(e, m); a.clearFlags(e, m); };
    op.check = () => (a.flagCount(1) === 0 ? null : 'pair left f0 set');
    // COLD reach check (run OUTSIDE every window): each bit of m goes through the index.
    op.reach = () => {
        const e = es[0];
        try {
            for (let r = m; r !== 0; r &= r - 1) {
                const b = r & -r, x = (b >>> 0).toString(16);
                a.setFlags(e, b);
                if (a.firstFlagged(b) !== e) return 'firstFlagged(0x' + x + ') != es[0] after setFlags';
                const c1 = a.flagCount(b);
                if (c1 !== 1) return 'flagCount(0x' + x + ') ' + c1 + ' != 1 after setFlags';
                a.clearFlags(e, b);
                const c0 = a.flagCount(b);
                if (c0 !== 0) return 'flagCount(0x' + x + ') ' + c0 + ' != 0 after clearFlags';
            }
        } catch (err) {
            return 'indexed write not reached: ' + (err && err.message);
        }
        return null;
    };
    return op;
}
function mkHiPair() {
    const a = new Arena(N);
    a.registerFlags(NAMES);
    const H = a.registerFlagsHi(HNAMES, { indexed: ['h0', 'h31'] });
    const m = H.h0 | H.h31;
    const es = spawnAll(a, N);
    const op = function (i) { const e = es[i & MASK]; a.setFlagsHi(e, m); a.clearFlagsHi(e, m); };
    op.check = () => (a.flagCountHi(H.h0) === 0 && a.flagCountHi(H.h31) === 0 ? null : 'hiPair left a bit set');
    return op;
}
function mkChurn() {
    const a = new Arena(N);
    a.registerFlags(NAMES, { indexed: ['f0'] });
    const es = spawnAll(a, N);
    const op = function (i) { const k = i & MASK; a.setFlags(es[k], 1); a.despawn(es[k]); es[k] = a.spawn(); };
    op.check = () => (a.flagCount(1) === 0 && a.activeCount === N ? null : 'churn: count ' + a.flagCount(1));
    return op;
}
/** An indexed arena with f0 on every `step`-th slot from `from`. */
function mkRead(cap, step, from) {
    const a = new Arena(cap);
    a.registerFlags(NAMES, { indexed: ['f0'] });
    const es = spawnAll(a, cap);
    let n = 0;
    for (let i = from; i < cap; i += step) { a.setFlags(es[i], 1); n++; }
    return { a, es, n };
}
function mkFlagCount() {
    const r = mkRead(N, 8, 0), a = r.a;
    const op = function () { S[0] = (S[0] + a.flagCount(1)) | 0; };
    op.check = () => (a.flagCount(1) === r.n ? null : 'flagCount drifted');
    return op;
}
function mkFirst() {
    const r = mkRead(N, 8, 100), a = r.a;
    const op = function () { S[0] ^= a.firstFlagged(1); };
    op.check = () => ((a.firstFlagged(1) & 0xFFFFF) === 100 ? null : 'firstFlagged != slot 100');
    return op;
}
function mkJoinN() {
    const a = new Arena(N);
    const P = a.registerComponent({ x: Float32Array });
    const V = a.registerComponent({ x: Float32Array });
    const F = a.registerFlags(NAMES, { indexed: ['f0', 'f1'] });
    const es = spawnAll(a, N);
    for (let i = 0; i < N; i++) {
        P.add(es[i]); V.add(es[i]);
        if ((i & 63) === 7) a.setFlags(es[i], F.f0);    // 16: the rare bit -> the driver flag
        if ((i & 1) === 0) a.setFlags(es[i], F.f1);     // 512
    }
    const req = [P, V], exc = [], rq = F.f0 | F.f1;
    const op = function () {
        const p = a.joinN(req, exc, rq, 0);
        const df = p.driverFlag;
        let s = p.driverFlagCount;
        if (df !== 0) {
            const row = p.flags;
            for (let e = a.firstFlagged(df); e !== -1; e = a.nextFlagged(df, e)) if ((row[e & 0xFFFFF] & rq) === rq) s = (s + e) | 0;
        }
        S[0] = (S[0] + s) | 0;
    };
    op.check = () => {
        const p = a.joinN(req, exc, rq, 0);
        return p.driverFlag === F.f0 && p.driverFlagCount === 16 ? null : 'joinN hint: driverFlag ' + p.driverFlag + ' count ' + p.driverFlagCount;
    };
    return op;
}
function mkWalk() {
    const r = mkRead(4096, 8, 3), a = r.a;
    const op = function () {
        let s = 0;
        for (let e = a.firstFlagged(1); e !== -1; e = a.nextFlagged(1, e)) s = (s + e) | 0;
        S[0] ^= s;
    };
    op.check = () => {
        let c = 0;
        for (let e = a.firstFlagged(1); e !== -1; e = a.nextFlagged(1, e)) c++;
        return c === r.n ? null : 'walk count ' + c + ' != ' + r.n;
    };
    return op;
}
function mkClearAll() {
    const r = mkRead(4096, 8, 5), a = r.a;
    const pick = new Int32Array(r.n);
    for (let i = 5, k = 0; i < 4096; i += 8) pick[k++] = r.es[i];
    const op = function () {
        a.clearFlagAll(1);
        for (let k = 0; k < pick.length; k++) a.setFlags(pick[k], 1);
    };
    op.check = () => (a.flagCount(1) === r.n ? null : 'clearAll refill count ' + a.flagCount(1));
    return op;
}
/** An indexed Hi arena with h0 on every `step`-th slot from `from` (M-65 / O-8: the Hi twins of mkRead). */
function mkReadHi(cap, step, from) {
    const a = new Arena(cap);
    a.registerFlags(NAMES);
    const H = a.registerFlagsHi(HNAMES, { indexed: ['h0'] });
    const es = spawnAll(a, cap);
    let n = 0;
    for (let i = from; i < cap; i += step) { a.setFlagsHi(es[i], H.h0); n++; }
    return { a, es, n, h: H.h0 };
}
function mkFlagCountHi() {
    const r = mkReadHi(N, 8, 0), a = r.a, h = r.h;
    const op = function () { S[0] = (S[0] + a.flagCountHi(h)) | 0; };
    op.check = () => (a.flagCountHi(h) === r.n ? null : 'flagCountHi drifted');
    return op;
}
function mkFirstHi() {
    const r = mkReadHi(N, 8, 100), a = r.a, h = r.h;
    const op = function () { S[0] ^= a.firstFlaggedHi(h); };
    op.check = () => ((a.firstFlaggedHi(h) & 0xFFFFF) === 100 ? null : 'firstFlaggedHi != slot 100');
    return op;
}
function mkWalkHi() {
    const r = mkReadHi(4096, 8, 3), a = r.a, h = r.h;
    const op = function () {
        let s = 0;
        for (let e = a.firstFlaggedHi(h); e !== -1; e = a.nextFlaggedHi(h, e)) s = (s + e) | 0;
        S[0] ^= s;
    };
    op.check = () => {
        let c = 0;
        for (let e = a.firstFlaggedHi(h); e !== -1; e = a.nextFlaggedHi(h, e)) c++;
        return c === r.n ? null : 'walkHi count ' + c + ' != ' + r.n;
    };
    return op;
}
function mkClearAllHi() {
    const r = mkReadHi(4096, 8, 5), a = r.a, h = r.h;
    const pick = new Int32Array(r.n);
    for (let i = 5, k = 0; i < 4096; i += 8) pick[k++] = r.es[i];
    const op = function () {
        a.clearFlagAllHi(h);
        for (let k = 0; k < pick.length; k++) a.setFlagsHi(pick[k], h);
    };
    op.check = () => (a.flagCountHi(h) === r.n ? null : 'clearAllHi refill count ' + a.flagCountHi(h));
    return op;
}
const noop = function (i) { S[0] = i; };
const box = function (i) { HOLD[0] = { a: i }; };
const boxed = (op) => function (i) { op(i); HOLD[0] = { a: i }; };

/** Shared driver (warm-up and windows): its op call site is megamorphic across lanes by design. */
function drive(op, n) { for (let i = 0; i < n; i++) op(i); }

/** COLD, after a lane (never inside a window): op.check then op.reach; a throw from check fails closed. */
function verdict(op) {
    let bad = null;
    try {
        bad = typeof op.check === 'function' ? op.check() : null;
    } catch (err) {
        bad = 'check threw: ' + (err && err.message);
    }
    const r = typeof op.reach === 'function' ? op.reach() : null;
    if (r !== null) bad = (bad === null ? '' : bad + '; ') + 'reach: ' + r;
    return bad;
}

function lane(name, op, ops) {
    const f = BOX === name ? boxed(op) : op;
    gc();                                    // a major GC OUTSIDE the window (Mark-Compact must not land inside)
    drive(f, WARM);
    say('LANE-START ' + name);
    drive(f, ops);
    say('LANE-END ' + name);
    const bad = verdict(op);
    if (bad !== null) fail(1, 'lane ' + name + ': ' + bad);
}

lane('noop', noop, OPS);
lane('ixPair1', mkPair(undefined, ['f0'], 1), OPS);
lane('ixPair4', mkPair(undefined, ['f0', 'f1', 'f2', 'f31'], 1 | 2 | 4 | B31), OPS);
lane('hiPair', mkHiPair(), OPS);
lane('ixChurn', mkChurn(), OPS);
lane('flagCount', mkFlagCount(), OPS);
lane('firstFlagged', mkFirst(), OPS);
lane('joinNHint', mkJoinN(), OPS);
lane('checkedPair', mkPair({ checked: true }, ['f0'], 1), OPS);
lane('walk', mkWalk(), WOPS);
lane('clearAll', mkClearAll(), OPS);
lane('flagCountHi', mkFlagCountHi(), OPS);
lane('firstFlaggedHi', mkFirstHi(), OPS);
lane('walkHi', mkWalkHi(), OPS);          // 500,000 ops (not WOPS): 1 Scavenge = 2.1 B/op
lane('clearAllHi', mkClearAllHi(), OPS);
lane('box', box, OPS);

// ---------------------------------------------------------------- M-51 byte-delta lanes
const BW = 400000, NWIN = 4, REARM = 8;
const UNUSED = -1;
function newUsed() {
    const s = v8.getHeapSpaceStatistics();
    for (let i = 0; i < s.length; i++) if (s[i].space_name === 'new_space') return s[i].space_used_size;
    return UNUSED;
}
if (newUsed() === UNUSED) fail(2, 'v8.getHeapSpaceStatistics() has no new_space');
const out = { bytesPerWindow: BW, bytes: {}, bytesMin: {}, rearms: 0 };
function byteLane(name, op) {
    drive(op, WARM);
    const w = new Float64Array(NWIN).fill(NaN);
    for (let k = 0; k < NWIN; k++) {
        for (let t = 0; t < REARM; t++) {
            gc({ type: 'minor', execution: 'sync' });   // an empty new space at the window start
            const p = new v8.GCProfiler();
            p.start();
            say('BWIN-START ' + name + ' ' + k + ' ' + t);
            const b = newUsed();
            drive(op, BW);
            const a = newUsed();
            const st = p.stop();
            const clean = st && Array.isArray(st.statistics) && st.statistics.length === 0;
            say('BWIN-END ' + name + ' ' + k + ' ' + t + ' ' + (clean ? 'ok' : 'rearm') + ' ' + (a - b));
            if (clean) { w[k] = a - b; break; }
            out.rearms++;
        }
    }
    const m = Math.min(w[1], w[2], w[3]);                     // window 0 discarded; a NaN window -> NaN (fail closed)
    out.bytes[name] = Array.from(w);
    out.bytesMin[name] = m;
    const bad = verdict(op);
    if (bad !== null) fail(1, 'byte lane ' + name + ': ' + bad);
}
const ctl1k = function (i) { S[0] = i; if ((i % 1000) === 999) HOLD[0] = new Int32Array(1); };
byteLane('noop', noop);
byteLane('ixSet1', mkPair(undefined, ['f0'], 1));
byteLane('ctl1k', ctl1k);

// ---------------------------------------------------------------- A2 retention
const NOOP = function () {};
const tracker = createLeakTracker({ name: 'f2ns-retention' });
const LEAKED = [];
const RARENAS = [];
let rBad = 0, rTracked = 0;
function rCycle(c) {
    const a = new Arena(4096);
    const F = a.registerFlags(['a', 'b'], { indexed: ['a'] });
    const H = a.registerFlagsHi(['h', 'g'], { indexed: ['h'] });
    const ba = 31 - Math.clz32(F.a), bh = 31 - Math.clz32(H.h);
    for (let i = 0; i < 100; i++) { const e = a.spawn(); a.setFlags(e, F.a); a.setFlagsHi(e, H.h); }
    const cols = [a._ixW[ba], a._ixS1[ba], a._ixWHi[bh], a._ixS1Hi[bh]];
    for (let k = 0; k < 4; k++) {
        if (!ArrayBuffer.isView(cols[k])) { rBad++; continue; }
        tracker.track(cols[k], NOOP, 'r' + c + 'k' + k);
        rTracked++;
        if (LEAK) LEAKED.push(cols[k]);
    }
    a.reserve(8192);
    if (a._ixW[ba] === cols[0] || a._ixS1[ba] === cols[1] || a._ixWHi[bh] === cols[2] || a._ixS1Hi[bh] === cols[3]) rBad++;
    let n = 0;
    for (let e = a.firstFlagged(F.a); e !== -1; e = a.nextFlagged(F.a, e)) n++;
    if (n !== 100 || a.flagCount(F.a) !== 100 || a.flagCountHi(H.h) !== 100) rBad++;
    a.clear();
    if (a.flagCount(F.a) !== 0 || a.flagCountHi(H.h) !== 0 || a.firstFlagged(F.a) !== -1 || a.firstFlaggedHi(H.h) !== -1) rBad++;
    RARENAS.push(a);
}
for (let c = 0; c < 64; c++) rCycle(c);

async function settle() {
    for (let t = 0; t < 40 && tracker.size() !== 0; t++) {
        gc();
        await new Promise((r) => setTimeout(r, 10));
    }
    return tracker.size();
}
out.rTracked = rTracked;
out.rBad = rBad;
out.rArenas = RARENAS.length;
out.rAlive = await settle();
RARENAS.length = 0;
out.rDropped = await settle();
out.leak = LEAK;
out.box = BOX;
out.sink = S[0] | 0;
say(JSON.stringify(out));
