/**
 * @zakkster/lite-arena -- SparseSet.remove() allocation (scavenge count) +
 * retention probe (Group E, PLAN-E A1 + A4). Spawned by test/remove-alloc.test.js
 * with: --expose-gc --trace-gc --min-semi-space-size=1 --max-semi-space-size=1.
 * FAILS CLOSED (exit 2) unless both semi-space flags are in process.execArgv.
 *
 * A1: per lane, 1024 members (fractional payloads); op = remove(dense[0]) then
 *     add the same entity, so every remove takes the swap branch. 20,000 warm-up
 *     ops, then a start marker line, 500,000 ops, an end marker line. The test
 *     counts `Scavenge` lines of the --trace-gc output between a lane's markers.
 *     With a 1 MB semi-space, ~310 B/op x 500k ops = many scavenges; 0 B/op = 0.
 *     Lanes: noop (control), oneCol, fourCol, tag, box (must-fail: allocates per
 *     op), sixKind (6 TypedArray kinds, REPORTED only).
 * A4: 64 cycles on LIVE 4-column sets: track the 4 columns, reserve(512),
 *     transfer-rebind x, track the detached view; after a macrotask + gc()
 *     tracker.size() must be 0 with all sets alive. A4r: reserve-only cycles
 *     (no rebind): the pre-growth columns must be released and a swapping
 *     remove after growth must move the payload in the NEW columns.
 * The last stdout line starting with `{` is a JSON object with the A4 results.
 *
 * Build under test: LITE_ARENA_PATH=/abs/path/Arena.js (default ../Arena.js).
 */

import { pathToFileURL } from 'node:url';
import { writeSync } from 'node:fs';
import { createLeakTracker } from '@zakkster/lite-leak';

const gc = globalThis.gc;
if (typeof gc !== 'function') { process.stderr.write('probe: needs --expose-gc\n'); process.exit(2); }
const ea = process.execArgv;
if (!ea.includes('--min-semi-space-size=1') || !ea.includes('--max-semi-space-size=1')) {
    process.stderr.write('probe: needs --min-semi-space-size=1 and --max-semi-space-size=1 (got ' + ea.join(' ') + ')\n');
    process.exit(2);
}

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

const N = 1024;
const WARM = 20000;
const OPS = 500000;
const sink = [null];
const say = (s) => writeSync(1, s + '\n');

function build(schema) {
    const arena = new Arena(N);
    const set = schema === null ? arena.registerTag() : arena.registerComponent(schema);
    const keys = schema === null ? [] : Object.keys(schema);
    for (let i = 0; i < N; i++) {
        const e = arena.spawn();
        const d = set.add(e);
        for (let k = 0; k < keys.length; k++) set.data[keys[k]][d] = i + 0.5; // fractional payloads
    }
    if (arena.activeCount !== N) throw new Error('probe: build drifted');
    return set;
}
function swapOp(set) {
    const dense = set.dense;
    return function () {
        const e = dense[0];
        set.remove(e);
        set.add(e);
    };
}
function lane(name, op) {
    for (let i = 0; i < WARM; i++) op(i);
    say('LANE-START ' + name);
    for (let i = 0; i < OPS; i++) op(i);
    say('LANE-END ' + name);
}

lane('noop', function (i) { sink[0] = i; });
lane('oneCol', swapOp(build({ x: Float32Array })));
lane('fourCol', swapOp(build({ x: Float32Array, y: Float64Array, i: Int32Array, u: Uint8Array })));
lane('tag', swapOp(build(null)));
lane('box', function (i) { sink[0] = { a: i }; });
lane('sixKind', swapOp(build({ a: Float32Array, b: Float64Array, c: Int32Array, d: Uint8Array, e: Int16Array, f: Uint32Array })));

const out = {};
// ---- A4 retention ----
const NOOP = function () {};
const tracker = createLeakTracker({ name: 'remove-alloc-a4' });
const arenas = [];
const sets = [];
function cycle(c) {
    const arena = new Arena(16);
    const set = arena.registerComponent({ x: Float32Array, y: Float64Array, i: Int32Array, u: Uint8Array });
    for (let i = 0; i < 8; i++) set.add(arena.spawn());
    const keys = ['x', 'y', 'i', 'u'];
    for (let k = 0; k < 4; k++) tracker.track(set.data[keys[k]], NOOP, 'c' + c + keys[k]);
    arena.reserve(512);
    const xv = set.data.x;                       // post-reserve view
    const moved = structuredClone(xv.buffer, { transfer: [xv.buffer] });
    tracker.track(xv, NOOP, 'c' + c + 'det');    // detached view
    set.rebind({ x: moved });
    // swap through every column after growth + rebind
    const e0 = set.dense[0];
    set.remove(e0);
    arenas.push(arena); sets.push(set);
}
for (let c = 0; c < 64; c++) cycle(c);

async function settle() {
    for (let t = 0; t < 40 && tracker.size() !== 0; t++) {
        gc();
        await new Promise((r) => setTimeout(r, 10));
    }
    return tracker.size();
}
out.a4Alive = await settle();
out.a4AliveSets = sets.length;
arenas.length = 0; sets.length = 0;
out.a4Dropped = await settle();


// ---- A4r: reserve-only cycles (no rebind) ----
const trk2 = createLeakTracker({ name: 'remove-alloc-a4r' });
const arenas2 = [];
let a4rBad = 0;
for (let c = 0; c < 64; c++) {
    const arena = new Arena(16);
    const set = arena.registerComponent({ x: Float32Array, y: Float64Array, i: Int32Array, u: Uint8Array });
    for (let i = 0; i < 8; i++) { const d = set.add(arena.spawn()); set.data.x[d] = i + 0.5; set.data.y[d] = i + 0.25; }
    const keys = ['x', 'y', 'i', 'u'];
    for (let k = 0; k < 4; k++) trk2.track(set.data[keys[k]], NOOP, 'r' + c + keys[k]);
    arena.reserve(512);
    set.remove(set.dense[0]);                    // swaps the last member (payload 7) into slot 0
    if (set.data.x[0] !== 7.5 || set.data.y[0] !== 7.25) a4rBad++;
    arenas2.push(arena);
}
async function settle2() {
    for (let t = 0; t < 40 && trk2.size() !== 0; t++) { gc(); await new Promise((r) => setTimeout(r, 10)); }
    return trk2.size();
}
out.a4rAlive = await settle2();
out.a4rBad = a4rBad;
out.a4rSets = arenas2.length;

say(JSON.stringify(out));
