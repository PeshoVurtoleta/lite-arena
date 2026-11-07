/**
 * @zakkster/lite-arena -- 1.12.1-A probe (PLAN-1.12.1-A A4 / A5). Spawned by
 * test/cold-paths-1121a.test.js as: node --expose-gc --trace-gc --min-semi-space-size=1
 * --max-semi-space-size=1 test/cold-1121a-probe.mjs. Loads the build from LITE_ARENA_PATH
 * (default ../Arena.js). Prints WIN-START / WIN-END around the A4 loop (the test counts the
 * --trace-gc lines between them) and one final JSON line.
 *
 * A4: a direct SparseSet on an arena grown with reserve(2x); 100,000 spawn / add / has /
 *   despawn cycles. Reports new-space growth over the loop (gc() before and after).
 * A5: 1,000 cycles of (arena, direct set, caller-backed register, rebind, drop), every
 *   arena / set / column tracked by lite-leak; tracker.size() after settled gc. Then 1,000
 *   throwing direct constructions; reports arena.components.length afterwards.
 * Knob COLD_LEAK=1 retains every tracked object (control: retention must read > 0).
 */
import { pathToFileURL } from 'node:url';
import { getHeapSpaceStatistics } from 'node:v8';
import { createLeakTracker } from '@zakkster/lite-leak';

if (typeof globalThis.gc !== 'function') { console.error('run with --expose-gc'); process.exit(2); }
const gc = globalThis.gc;
const BUILD = process.env.LITE_ARENA_PATH ? pathToFileURL(process.env.LITE_ARENA_PATH).href : '../Arena.js';
const { Arena, SparseSet } = await import(BUILD);
const LEAK = process.env.COLD_LEAK === '1';
const ALLOC = process.env.COLD_ALLOC === '1';   // must-fail control: one Int32Array(1) per 128 ops
let junk;
const out = {};
function newSpaceUsed() {
    const s = getHeapSpaceStatistics();
    for (let i = 0; i < s.length; i++) if (s[i].space_name === 'new_space') return s[i].space_used_size;
    throw new Error('cold-1121a-probe: no new_space entry in v8.getHeapSpaceStatistics()');
}

// ---- A4
{
    const a = new Arena(512);
    const S = new SparseSet(512, { x: Float32Array, y: Int32Array }, a);
    a.reserve(1024);                               // the set is built at 512, then really grown (M-62 path)
    const N = 100000;
    let sink = 0;
    function cycle(i) {
        const e = a.spawn();
        const d = S.add(e);
        S.data.x[d] = i;
        if (S.has(e)) sink++;
        a.despawn(e);
        if (ALLOC && (i & 127) === 0) junk = new Int32Array(1);
    }
    for (let i = 0; i < 40000; i++) cycle(i);      // warm-up: tier up before the window
    // Five consecutive 100,000-op windows, GC-free inside. Per window: new-space bytes used
    // before / after the loop, minus the same two reads taken back to back with nothing between
    // them (the read's own allocation cancels). Measured: clean steady state = 0..16 B per
    // window; a Int32Array(1) per 100 ops = ~226,000 B. The first windows carry one-time JIT /
    // feedback cost, so the verdict is the MINIMUM (steady state), as the F2 probe does.
    const W = 5;
    const wins = new Float64Array(W);
    for (let w = 0; w < W; w++) {
        gc(); gc();
        newSpaceUsed();
        const A = newSpaceUsed();
        console.log('WIN-START');
        for (let i = 0; i < N; i++) cycle(i);
        console.log('WIN-END');
        const B = newSpaceUsed();
        gc(); gc();
        newSpaceUsed();
        const C = newSpaceUsed();
        console.log('CAL-START');      // same two prints as the loop window: their allocation cancels too
        console.log('CAL-END');
        const D = newSpaceUsed();
        wins[w] = (B - A) - (D - C);
    }
    out.win = Array.from(wins);
    out.ops = N;
    out.sink = sink;
    out.heapRetained = Math.min(...out.win);
    out.activeCount = a.activeCount;
    out.setCount = S.count;
    out.registered = a.components.length;
}

// ---- A5
const NOOP = function () {};
const tracker = createLeakTracker({ name: 'cold-1121a' });
const HOLD = [];
let tracked = 0;
function track(o, id) { tracker.track(o, NOOP, id); tracked++; if (LEAK) HOLD.push(o); }
function rcycle(c) {
    const a = new Arena(16);
    const direct = new SparseSet(16, { x: Float32Array }, a);
    const bufs = { x: new ArrayBuffer(16 * 4), y: new ArrayBuffer(16 * 4) };
    const cb = a.registerComponent({ x: Float32Array, y: Float32Array }, { buffers: bufs });
    const e = a.spawn();
    direct.add(e); cb.add(e);
    cb.rebind({ x: new ArrayBuffer(16 * 4) });
    cb.rebind({ x: cb.data.y.buffer, y: cb.data.x.buffer });   // swap: allowed
    track(a, 'a' + c); track(direct, 'd' + c); track(cb, 'c' + c); track(cb.data.x, 'x' + c);
}
for (let c = 0; c < 1000; c++) rcycle(c);
async function settle() {
    for (let t = 0; t < 40 && tracker.size() !== 0; t++) { gc(); await new Promise((r) => setTimeout(r, 10)); }
    return tracker.size();
}
out.tracked = tracked;
out.retained = await settle();

{
    const a = new Arena(8);
    let threw = 0;
    for (let i = 0; i < 1000; i++) {
        try { new SparseSet(8, { x: Float32Array }, a, { x: new ArrayBuffer(4) }); } catch (_) { threw++; }
    }
    out.throws = threw;
    out.componentsAfterThrows = a.components.length;
}
out.leak = LEAK;
out.alloc = ALLOC;
out.junk = junk === undefined ? 0 : 1;
console.log(JSON.stringify(out));
