/**
 * @zakkster/lite-arena -- SparseSet.remove() parity trace (Group E, PLAN-E A3).
 *
 * runTrace(mod) drives a seeded, long op stream through an Arena build and
 * returns ONE sha256 digest of every observable (return values, counts, dense
 * handles, raw payload bytes). The digest must be identical across HEAD,
 * before-E and E: the swap branch of remove() may change HOW it copies columns,
 * never WHAT ends up in them.
 *
 * Independent oracle: a plain-JS model (Map handle -> payload) is kept next to
 * the arena and checked at checkpoints; a build that disagrees with the model
 * throws here, before any digest is compared.
 *
 * PRNG: xorshift32, seed 0x5EED, two independent streams (op kind / key+value).
 * Phases: Arena(64) with C4 {F32,F64,I32,U8} + C1 {F32} + tag, 6,000 ops;
 * reserve(128) at op 2000; at op 3000 C4.x is structuredClone-transferred,
 * 200 removes run while detached, reserve() must throw; rebind at op 4000,
 * 2,000 more ops; then 1,000 ops on a caller-backed (S5) arena.
 */

import { createHash } from 'node:crypto';

const SEED = 0x5EED;

function xs(s) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
}

const BPE = { F32: 4, F64: 8, I32: 4, U8: 1 };

function makeCtx(mod, arena, comps, h, seedA, seedB) {
    return {
        mod, arena, comps, h, live: [], grave: [],
        opS: seedA, keyS: seedB, swaps: 0, ops: 0,
    };
}

// next value for a field; model value is computed independently of the build.
function nextVal(ctx, type) {
    ctx.keyS = xs(ctx.keyS);
    const r = ctx.keyS;
    switch (type) {
        case 'F32': return Math.fround((r % 100000) / 64 + 0.0625);
        case 'F64': return (r % 100000) / 64 + 0.015625;
        case 'I32': return r | 0;
        default: return r & 255;
    }
}

function pickKey(ctx, n) {
    ctx.keyS = xs(ctx.keyS);
    return ctx.keyS % n;
}

// add + write payload; model records the value, or undefined for a detached view.
function addTo(ctx, comp, e) {
    const idx = comp.set.add(e);
    if (idx < 0) return idx;
    let rec = comp.model.get(e);
    if (rec === undefined) {
        rec = new Array(comp.keys.length);
        for (let k = 0; k < comp.keys.length; k++) {
            const v = nextVal(ctx, comp.types[k]);
            const arr = comp.set.data[comp.keys[k]];
            if (arr.byteLength === 0) rec[k] = undefined;
            else { arr[idx] = v; rec[k] = v; }
        }
        comp.model.set(e, rec);
    }
    return idx;
}

function removeFrom(ctx, comp, e) {
    const wasMember = comp.model.has(e);
    let swap = false;
    if (wasMember) swap = comp.set.idx(e) !== comp.set.count - 1;
    const ok = comp.set.remove(e);
    ctx.h.update('r' + (ok ? 1 : 0) + ',');
    if (ok !== wasMember) throw new Error('trace: remove() disagrees with model');
    if (ok) { comp.model.delete(e); if (swap) { ctx.swaps++; comp.swaps++; } }
    return ok;
}

function hashComp(ctx, comp) {
    const set = comp.set;
    ctx.h.update('c' + set.count + ':');
    ctx.h.update(new Uint8Array(set.dense.buffer, set.dense.byteOffset, set.count * 4));
    for (let k = 0; k < comp.keys.length; k++) {
        const v = set.data[comp.keys[k]];
        const n = v.byteLength === 0 ? 0 : set.count * BPE[comp.types[k]];
        ctx.h.update('k' + n + ':');
        if (n > 0) ctx.h.update(new Uint8Array(v.buffer, v.byteOffset, n));
    }
}

function check(ctx) {
    for (const comp of ctx.comps) {
        const set = comp.set;
        if (set.count !== comp.model.size) throw new Error('trace: count != model size');
        for (const [e, rec] of comp.model) {
            if (!set.has(e)) throw new Error('trace: member missing');
            const i = set.idx(e);
            for (let k = 0; k < comp.keys.length; k++) {
                if (rec[k] === undefined || set.data[comp.keys[k]].byteLength === 0) continue;
                if (set.data[comp.keys[k]][i] !== rec[k]) {
                    throw new Error('trace: payload != model (' + comp.keys[k] + ')');
                }
            }
        }
    }
}

function step(ctx) {
    ctx.opS = xs(ctx.opS);
    const kind = ctx.opS % 8;
    const { arena, comps, h, live } = ctx;
    ctx.ops++;
    if (kind <= 1) {
        if (arena.activeCount < arena.capacity) {
            const e = arena.spawn();
            live.push(e);
            h.update('s' + e + ',');
            for (let c = 0; c < comps.length; c++) {
                if ((ctx.opS >>> (4 + c)) & 1 || c === 0) addTo(ctx, comps[c], e);
            }
        }
    } else if (kind === 2) {
        if (live.length > 0) {
            const j = pickKey(ctx, live.length);
            const e = live[j];
            live[j] = live[live.length - 1]; live.pop();
            // despawn cascades into every set's remove(): count swaps first.
            for (const comp of comps) {
                if (comp.model.has(e) && comp.set.idx(e) !== comp.set.count - 1) { ctx.swaps++; comp.swaps++; }
                comp.model.delete(e);
            }
            h.update('d' + (arena.despawn(e) ? 1 : 0) + ',');
            ctx.grave.push(e);
            if (ctx.grave.length > 16) ctx.grave.shift();
        }
    } else if (kind <= 4) {
        if (live.length > 0) {
            const e = live[pickKey(ctx, live.length)];
            removeFrom(ctx, comps[pickKey(ctx, comps.length)], e);
        }
    } else if (kind === 5) {
        if (live.length > 0) {
            const e = live[pickKey(ctx, live.length)];
            const comp = comps[pickKey(ctx, comps.length)];
            removeFrom(ctx, comp, e);
            h.update('a' + addTo(ctx, comp, e) + ',');
        }
    } else if (kind === 6) {
        if (live.length > 0) {
            const e = live[pickKey(ctx, live.length)];
            h.update('a' + addTo(ctx, comps[pickKey(ctx, comps.length)], e) + ',');
        }
    } else if (ctx.grave.length > 0) {
        const e = ctx.grave[pickKey(ctx, ctx.grave.length)];
        const comp = comps[pickKey(ctx, comps.length)];
        if (removeFrom(ctx, comp, e)) throw new Error('trace: stale handle removed');
    }
    if ((ctx.ops & 63) === 0) for (const comp of comps) hashComp(ctx, comp);
    if ((ctx.ops & 255) === 0) check(ctx);
}

function mkComp(set, keys, types) {
    return { set, keys, types, model: new Map(), swaps: 0 };
}

export function runTrace(mod, info) {
    const { Arena } = mod;
    const h = createHash('sha256');
    const cov = { swaps: 0, swapsDetached: 0, swapsAfterRebind: 0, swapsCallerBacked: 0, swapsAfterReserve: 0, reserveThrew: false };

    // ---- phase 1: Arena(64), 6,000 ops ----
    const arena = new Arena(64);
    const c4 = arena.registerComponent({ x: Float32Array, y: Float64Array, i: Int32Array, u: Uint8Array });
    const c1 = arena.registerComponent({ v: Float32Array });
    const tg = arena.registerTag();
    const comps = [
        mkComp(c4, ['x', 'y', 'i', 'u'], ['F32', 'F64', 'I32', 'U8']),
        mkComp(c1, ['v'], ['F32']),
        mkComp(tg, [], []),
    ];
    const ctx = makeCtx(mod, arena, comps, h, SEED, xs(SEED ^ 0x9E3779B9));
    let mark = 0;
    for (let op = 0; op < 6000; op++) {
        if (op === 2000) {
            h.update('R' + arena.reserve(128) + ',' + arena.capacity + ',');
            cov.swapsBefore = ctx.swaps; mark = ctx.swaps;
        }
        if (op === 3000) {
            cov.swapsAfterReserve = ctx.swaps - mark;
            // transfer C4.x: detaches c4.data.x
            const x = c4.data.x;
            const moved = structuredClone(x.buffer, { transfer: [x.buffer] });
            if (c4.isDetached('x') !== true) throw new Error('trace: transfer did not detach');
            const before = ctx.swaps;
            const m4 = comps[0];
            for (let i = 0; i < 200; i++) {
                if ((i & 1) === 0 && m4.model.size > 0) {
                    const keys = Array.from(m4.model.keys());
                    removeFrom(ctx, m4, keys[pickKey(ctx, keys.length)]);
                } else if (live(ctx).length > 0) {
                    const L = live(ctx);
                    addTo(ctx, m4, L[pickKey(ctx, L.length)]);
                } else if (arena.activeCount < arena.capacity) {
                    const e = arena.spawn(); ctx.live.push(e); addTo(ctx, m4, e);
                }
            }
            cov.swapsDetached = ctx.swaps - before;
            let threw = false;
            try { arena.reserve(256); } catch (err) { threw = true; }
            cov.reserveThrew = threw;
            if (!threw) throw new Error('trace: reserve() must throw while a field is detached');
            h.update('T' + threw + ',');
            ctx.moved = moved;
        }
        if (op === 4000) {
            c4.rebind({ x: ctx.moved });
            // dropped swap writes left stale x values: re-write x from the model.
            const m4 = comps[0];
            for (const [e, rec] of m4.model) {
                if (rec[0] === undefined) rec[0] = nextVal(ctx, 'F32');
                c4.data.x[c4.idx(e)] = rec[0];
            }
            h.update('B' + c4.isDetached('x') + ',');
            mark = ctx.swaps;
        }
        step(ctx);
    }
    cov.swapsAfterRebind = ctx.swaps - mark;
    for (const comp of comps) hashComp(ctx, comp);
    check(ctx);
    h.update('end1:' + arena.activeCount + ',' + ctx.swaps + ',');
    cov.swaps = ctx.swaps;

    // ---- phase 2: caller-backed (S5) arena, 1,000 ops ----
    const a2 = new Arena(32);
    const bx = new ArrayBuffer(32 * 4);
    const by = new ArrayBuffer(32 * 4);
    const cb = a2.registerComponent({ x: Float32Array, y: Float32Array }, { buffers: { x: bx, y: by } });
    const t2 = a2.registerTag();
    const comps2 = [mkComp(cb, ['x', 'y'], ['F32', 'F32']), mkComp(t2, [], [])];
    const ctx2 = makeCtx(mod, a2, comps2, h, xs(SEED ^ 0x1234567), xs(SEED ^ 0x7654321));
    for (let op = 0; op < 1000; op++) step(ctx2);
    for (const comp of comps2) hashComp(ctx2, comp);
    check(ctx2);
    h.update('end2:' + a2.activeCount + ',' + ctx2.swaps);
    cov.swapsCallerBacked = ctx2.swaps;

    if (info) Object.assign(info, cov);
    return h.digest('hex');
}

function live(ctx) { return ctx.live; }
