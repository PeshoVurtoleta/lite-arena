/**
 * @zakkster/lite-arena benchmark harness.
 *
 * Compares entity-management strategies on three workloads. All scratch
 * storage (handle buffers etc.) is allocated outside the timed region
 * so we measure the lifecycle/iteration cost itself, not setup.
 *
 *   A. lite-arena                 (Sparse-set ECS, SoA, generational handles)
 *   B. Map<id, object>            (the obvious JS approach)
 *   C. Array<Object>              (push/splice — what most start with)
 *   D. Manual SoA + free list     (typed arrays only — the floor)
 *
 * Workloads:
 *   1. Spawn / despawn churn      — lifecycle throughput
 *   2. Sequential iteration       — the systems hot path (apply velocity)
 *   3. Random-access removal      — the swap-and-pop sweet spot
 *
 * Requires `--expose-gc` for heap measurements.
 * Outputs both a formatted table and bench/bench-results.json.
 */

import { writeFileSync } from 'node:fs';
import { Arena } from '../Arena.js';

const N = 10_000;
const FRAMES = 200;
const GC = typeof globalThis.gc === 'function';

if (!GC) {
    console.warn('[bench] --expose-gc not present; heap deltas will be unreliable.\n');
}

function time(label, fn) {
    if (GC) globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    fn();
    const t1 = performance.now();
    if (GC) globalThis.gc();
    const after = process.memoryUsage().heapUsed;
    return { label, ms: t1 - t0, heap: after - before };
}

// ─────────────────────────────────────────────────────────────────
// Workload 1: spawn / despawn churn
// ─────────────────────────────────────────────────────────────────

function churnArena() {
    const a = new Arena(N);
    const c = a.registerComponent({ x: Float32Array, y: Float32Array });
    const handles = new Int32Array(N);
    return () => {
        for (let i = 0; i < N; i++) {
            const e = a.spawn();
            c.add(e);
            handles[i] = e;
        }
        for (let i = 0; i < N; i++) a.despawn(handles[i]);
    };
}

function churnMap() {
    const map = new Map();
    const ids = new Int32Array(N);
    let next = 0;
    return () => {
        for (let i = 0; i < N; i++) {
            const id = next++;
            map.set(id, { x: 0, y: 0 });
            ids[i] = id;
        }
        for (let i = 0; i < N; i++) map.delete(ids[i]);
    };
}

function churnAoO() {
    const arr = new Array(N);
    return () => {
        for (let i = 0; i < N; i++) arr[i] = { x: 0, y: 0 };
        for (let i = 0; i < N; i++) arr[i] = null;
    };
}

function churnSoAManual() {
    const x = new Float32Array(N), y = new Float32Array(N);
    const freeList = new Int32Array(N);
    for (let i = 0; i < N - 1; i++) freeList[i] = i + 1;
    freeList[N - 1] = -1;
    let freeHead = 0;
    const handles = new Int32Array(N);
    return () => {
        for (let i = 0; i < N; i++) {
            const idx = freeHead;
            freeHead = freeList[idx];
            x[idx] = 0; y[idx] = 0;
            handles[i] = idx;
        }
        for (let i = 0; i < N; i++) {
            const idx = handles[i];
            freeList[idx] = freeHead;
            freeHead = idx;
        }
    };
}

// ─────────────────────────────────────────────────────────────────
// Workload 2: sequential iteration (systems hot loop)
// ─────────────────────────────────────────────────────────────────

function iterArena() {
    const a = new Arena(N);
    const tr = a.registerComponent({ x: Float32Array, y: Float32Array });
    const vl = a.registerComponent({ vx: Float32Array, vy: Float32Array });
    for (let i = 0; i < N; i++) {
        const e = a.spawn();
        tr.add(e); vl.add(e);
        tr.data.x[tr.idx(e)] = i; vl.data.vx[vl.idx(e)] = 1.5;
    }
    return () => {
        const tx = tr.data.x, ty = tr.data.y;
        const vx = vl.data.vx, vy = vl.data.vy;
        const dt = 0.016;
        for (let f = 0; f < FRAMES; f++) {
            const n = tr.count;
            for (let i = 0; i < n; i++) {
                tx[i] += vx[i] * dt;
                ty[i] += vy[i] * dt;
            }
        }
    };
}

function iterMap() {
    const map = new Map();
    for (let i = 0; i < N; i++) map.set(i, { x: i, y: 0, vx: 1.5, vy: 0 });
    return () => {
        const dt = 0.016;
        for (let f = 0; f < FRAMES; f++) {
            for (const e of map.values()) {
                e.x += e.vx * dt;
                e.y += e.vy * dt;
            }
        }
    };
}

function iterAoO() {
    const arr = [];
    for (let i = 0; i < N; i++) arr.push({ x: i, y: 0, vx: 1.5, vy: 0 });
    return () => {
        const dt = 0.016;
        for (let f = 0; f < FRAMES; f++) {
            const n = arr.length;
            for (let i = 0; i < n; i++) {
                const e = arr[i];
                e.x += e.vx * dt;
                e.y += e.vy * dt;
            }
        }
    };
}

function iterSoAManual() {
    const x = new Float32Array(N), y = new Float32Array(N);
    const vx = new Float32Array(N), vy = new Float32Array(N);
    for (let i = 0; i < N; i++) { x[i] = i; vx[i] = 1.5; }
    return () => {
        const dt = 0.016;
        for (let f = 0; f < FRAMES; f++) {
            for (let i = 0; i < N; i++) {
                x[i] += vx[i] * dt;
                y[i] += vy[i] * dt;
            }
        }
    };
}

// ─────────────────────────────────────────────────────────────────
// Workload 3: random removal (swap-and-pop showcase)
// ─────────────────────────────────────────────────────────────────

function randomRemoveArena() {
    const a = new Arena(N);
    const c = a.registerComponent({ v: Float32Array });
    const handles = new Int32Array(N);
    return () => {
        for (let i = 0; i < N; i++) { const e = a.spawn(); c.add(e); handles[i] = e; }
        for (let i = 0; i < N; i += 3) c.remove(handles[i]);
        for (let i = 0; i < N; i++) a.despawn(handles[i]);
    };
}

function randomRemoveAoO() {
    return () => {
        const arr = [];
        for (let i = 0; i < N; i++) arr.push({ id: i, v: 0 });
        for (let i = arr.length - 1; i >= 0; i -= 3) arr.splice(i, 1);
        arr.length = 0;
    };
}

function randomRemoveMap() {
    const m = new Map();
    return () => {
        for (let i = 0; i < N; i++) m.set(i, { v: 0 });
        for (let i = 0; i < N; i += 3) m.delete(i);
        m.clear();
    };
}

// ─────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────

function bench(workload, name, factories, runs = 7) {
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`${workload}: ${name}`);
    console.log('─'.repeat(72));

    const results = [];
    for (const [label, factory] of factories) {
        const trials = [];
        for (let r = 0; r < runs; r++) {
            const fn = factory();
            fn(); fn(); // warmup
            trials.push(time(label, fn));
        }
        trials.sort((a, b) => a.ms - b.ms);
        const median = trials[Math.floor(trials.length / 2)];
        results.push({ label, ms: median.ms, heap: median.heap });
    }

    const fastest = Math.min(...results.map(r => r.ms));
    console.log(`${'Strategy'.padEnd(28)} ${'ms'.padStart(10)} ${'heap Δ'.padStart(12)} ${'vs best'.padStart(10)}`);
    for (const r of results) {
        const vs = (r.ms / fastest).toFixed(2) + '×';
        const heap = formatHeap(r.heap);
        console.log(`${r.label.padEnd(28)} ${r.ms.toFixed(3).padStart(10)} ${heap.padStart(12)} ${vs.padStart(10)}`);
    }
    return results;
}

function formatHeap(b) {
    const abs = Math.abs(b);
    const sign = b < 0 ? '-' : '';
    if (abs < 1024) return `${sign}${abs} B`;
    if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`;
    return `${sign}${(abs / 1024 / 1024).toFixed(2)} MB`;
}

console.log('@zakkster/lite-arena — benchmark harness');
console.log(`N=${N} entities, FRAMES=${FRAMES}, GC: ${GC ? 'enabled' : 'disabled (heap unreliable)'}`);

const all = {
    churn: bench('Workload 1', 'Spawn/Despawn churn (lifecycle throughput)', [
        ['lite-arena (sparse-set)', churnArena],
        ['Map<id, object>',          churnMap],
        ['Array<Object>',            churnAoO],
        ['Manual SoA + free list',   churnSoAManual],
    ]),

    iter: bench('Workload 2', `Sequential iteration (apply velocity, ${FRAMES} frames)`, [
        ['lite-arena (SoA)',         iterArena],
        ['Map<id, object>',          iterMap],
        ['Array<Object>',            iterAoO],
        ['Manual SoA (no ECS)',      iterSoAManual],
    ]),

    randomRemove: bench('Workload 3', 'Random component removal (every 3rd)', [
        ['lite-arena (swap-and-pop)', randomRemoveArena],
        ['Array<Object> + splice',    randomRemoveAoO],
        ['Map<id, object>',           randomRemoveMap],
    ]),
};

writeFileSync(new URL('./bench-results.json', import.meta.url),
    JSON.stringify({ n: N, frames: FRAMES, gc: GC, timestamp: new Date().toISOString(), results: all }, null, 2));

console.log('\nResults written to bench/bench-results.json');
