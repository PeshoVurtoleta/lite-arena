/**
 * @zakkster/lite-arena — Unit test suite.
 *
 * Run: `npm test`
 *      or: `node --expose-gc node_modules/.bin/vitest run`
 *
 * The zero-allocation tests at the bottom require `--expose-gc`. They are
 * automatically skipped when global.gc is unavailable so the suite remains
 * green on stock Node.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Arena, SparseSet } from './Arena.js';

// ─────────────────────────────────────────────────────────────────
// Construction & validation
// ─────────────────────────────────────────────────────────────────

describe('Arena: construction', () => {
    it('accepts a positive integer up to 1048575', () => {
        expect(() => new Arena(1)).not.toThrow();
        expect(() => new Arena(1000)).not.toThrow();
        expect(() => new Arena(1048575)).not.toThrow();
    });

    it('rejects 0', () => {
        expect(() => new Arena(0)).toThrow(/maxEntities/);
    });

    it('rejects negative values', () => {
        expect(() => new Arena(-1)).toThrow(/maxEntities/);
        expect(() => new Arena(-1000)).toThrow(/maxEntities/);
    });

    it('rejects values above 1048575', () => {
        expect(() => new Arena(1048576)).toThrow(/maxEntities/);
        expect(() => new Arena(2 ** 30)).toThrow(/maxEntities/);
    });

    it('rejects non-integers', () => {
        expect(() => new Arena(1.5)).toThrow(/maxEntities/);
        expect(() => new Arena(NaN)).toThrow(/maxEntities/);
        expect(() => new Arena(Infinity)).toThrow(/maxEntities/);
    });

    it('rejects non-numbers', () => {
        // @ts-expect-error testing runtime validation
        expect(() => new Arena('100')).toThrow();
        // @ts-expect-error testing runtime validation
        expect(() => new Arena(null)).toThrow();
        // @ts-expect-error testing runtime validation
        expect(() => new Arena(undefined)).toThrow();
    });

    it('exposes capacity and activeCount', () => {
        const a = new Arena(64);
        expect(a.capacity).toBe(64);
        expect(a.activeCount).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────
// Spawn / despawn / liveness
// ─────────────────────────────────────────────────────────────────

describe('Arena: lifecycle', () => {
    let arena;
    beforeEach(() => { arena = new Arena(8); });

    it('spawn returns alive handles', () => {
        const e = arena.spawn();
        expect(arena.isAlive(e)).toBe(true);
    });

    it('different spawns return different handles', () => {
        const a = arena.spawn();
        const b = arena.spawn();
        expect(a).not.toBe(b);
    });

    it('activeCount reflects spawns and despawns', () => {
        expect(arena.activeCount).toBe(0);
        const a = arena.spawn();
        const b = arena.spawn();
        expect(arena.activeCount).toBe(2);
        arena.despawn(a);
        expect(arena.activeCount).toBe(1);
        arena.despawn(b);
        expect(arena.activeCount).toBe(0);
    });

    it('throws when arena is full', () => {
        const small = new Arena(3);
        small.spawn();
        small.spawn();
        small.spawn();
        expect(() => small.spawn()).toThrow(/out of memory/);
    });

    it('reuses slots after despawn', () => {
        const small = new Arena(2);
        const a = small.spawn();
        const b = small.spawn();
        expect(() => small.spawn()).toThrow();
        small.despawn(a);
        expect(() => small.spawn()).not.toThrow();
    });

    it('despawn returns false for already-dead handles', () => {
        const e = arena.spawn();
        expect(arena.despawn(e)).toBe(true);
        expect(arena.despawn(e)).toBe(false);
    });

    it('despawn returns false for synthesized junk handles', () => {
        expect(arena.despawn(0xDEADBEEF | 0)).toBe(false);
        expect(arena.despawn(-1)).toBe(false);
        expect(arena.despawn(0)).toBe(false); // slot 0 might exist but gen 0 hasn't been spawned yet
    });

    it('isAlive is false for despawned handles', () => {
        const e = arena.spawn();
        arena.despawn(e);
        expect(arena.isAlive(e)).toBe(false);
    });

    it('isAlive never throws on arbitrary input', () => {
        expect(() => arena.isAlive(-1)).not.toThrow();
        expect(() => arena.isAlive(0xFFFFFFFF | 0)).not.toThrow();
        expect(() => arena.isAlive(0)).not.toThrow();
    });
});

// ─────────────────────────────────────────────────────────────────
// Generational handles — the ABA defence
// ─────────────────────────────────────────────────────────────────

describe('Arena: generational handles', () => {
    it('invalidates stale handles after slot reuse', () => {
        const arena = new Arena(1);
        const old = arena.spawn();
        arena.despawn(old);

        const fresh = arena.spawn();
        expect(arena.isAlive(old)).toBe(false);
        expect(arena.isAlive(fresh)).toBe(true);
        // Even though the slot index is identical:
        expect(old & 0xFFFFF).toBe(fresh & 0xFFFFF);
        expect(old).not.toBe(fresh);
    });

    it('generation wraps after 4096 cycles (ABA limit)', () => {
        const arena = new Arena(1);
        let h = arena.spawn();
        arena.despawn(h);

        // With generations init'd to 1, the first spawn has gen=1 and the
        // first despawn bumps to gen=2. 4095 more spawn/despawn cycles
        // brings the stored gen back around to 1 → collision.
        for (let i = 0; i < 4095; i++) {
            const nh = arena.spawn();
            arena.despawn(nh);
        }
        const after = arena.spawn();
        // The wrap means `after` collides with `h`'s bit pattern.
        expect(after).toBe(h);
    });

    it('high-generation handles work correctly even when their bit pattern is negative', () => {
        const arena = new Arena(1);
        let h = arena.spawn();
        arena.despawn(h);

        // Get to a generation where the sign bit is set.
        for (let i = 0; i < 2048; i++) {
            h = arena.spawn();
            arena.despawn(h);
        }
        const negHandle = arena.spawn();
        expect(negHandle < 0).toBe(true); // sign bit set
        expect(arena.isAlive(negHandle)).toBe(true);
        expect(arena.despawn(negHandle)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────
// Component registration & SoA layout
// ─────────────────────────────────────────────────────────────────

describe('Arena: component registration', () => {
    it('creates parallel typed arrays sized to capacity', () => {
        const arena = new Arena(100);
        const pos = arena.registerComponent({
            x: Float32Array,
            y: Float32Array,
        });
        expect(pos.data.x).toBeInstanceOf(Float32Array);
        expect(pos.data.y).toBeInstanceOf(Float32Array);
        expect(pos.data.x.length).toBe(100);
        expect(pos.data.y.length).toBe(100);
    });

    it('supports all typed-array constructors', () => {
        const arena = new Arena(8);
        const c = arena.registerComponent({
            f32: Float32Array,
            f64: Float64Array,
            i32: Int32Array,
            u32: Uint32Array,
            i16: Int16Array,
            u16: Uint16Array,
            i8: Int8Array,
            u8: Uint8Array,
            uc: Uint8ClampedArray,
        });
        expect(c.data.f32).toBeInstanceOf(Float32Array);
        expect(c.data.f64).toBeInstanceOf(Float64Array);
        expect(c.data.uc).toBeInstanceOf(Uint8ClampedArray);
    });

    it('starts with count=0', () => {
        const arena = new Arena(16);
        const pos = arena.registerComponent({ x: Float32Array });
        expect(pos.count).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────
// SparseSet operations
// ─────────────────────────────────────────────────────────────────

describe('SparseSet: add / has / remove', () => {
    let arena, pos;
    beforeEach(() => {
        arena = new Arena(8);
        pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
    });

    it('add returns a valid dense index', () => {
        const e = arena.spawn();
        const idx = pos.add(e);
        expect(idx).toBe(0);
        expect(pos.count).toBe(1);
        expect(pos.has(e)).toBe(true);
    });

    it('add returns -1 for dead handles', () => {
        const e = arena.spawn();
        arena.despawn(e);
        expect(pos.add(e)).toBe(-1);
        expect(pos.count).toBe(0);
    });

    it('add is idempotent: re-adding returns the same index', () => {
        const e = arena.spawn();
        const first = pos.add(e);
        const second = pos.add(e);
        expect(first).toBe(second);
        expect(pos.count).toBe(1);
    });

    it('has returns false for dead handles', () => {
        const e = arena.spawn();
        pos.add(e);
        arena.despawn(e);
        expect(pos.has(e)).toBe(false);
    });

    it('has returns false for never-added entities', () => {
        const e = arena.spawn();
        expect(pos.has(e)).toBe(false);
    });

    it('has rejects synthesized junk handles', () => {
        expect(pos.has(0xDEADBEEF | 0)).toBe(false);
        expect(pos.has(-1)).toBe(false);
        expect(pos.has(0)).toBe(false);
    });

    it('remove returns true on first call, false thereafter', () => {
        const e = arena.spawn();
        pos.add(e);
        expect(pos.remove(e)).toBe(true);
        expect(pos.remove(e)).toBe(false);
    });

    it('remove decrements count', () => {
        const a = arena.spawn();
        const b = arena.spawn();
        pos.add(a);
        pos.add(b);
        expect(pos.count).toBe(2);
        pos.remove(a);
        expect(pos.count).toBe(1);
    });

    it('despawn detaches from all components automatically', () => {
        const vel = arena.registerComponent({ vx: Float32Array });
        const e = arena.spawn();
        pos.add(e);
        vel.add(e);
        expect(pos.has(e)).toBe(true);
        expect(vel.has(e)).toBe(true);
        arena.despawn(e);
        expect(pos.has(e)).toBe(false);
        expect(vel.has(e)).toBe(false);
        expect(pos.count).toBe(0);
        expect(vel.count).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────
// Swap-and-pop correctness — the subtle one
// ─────────────────────────────────────────────────────────────────

describe('SparseSet: swap-and-pop correctness', () => {
    it('keeps dense array contiguous after middle-element removal', () => {
        const arena = new Arena(4);
        const c = arena.registerComponent({ v: Float32Array });

        const a = arena.spawn(), b = arena.spawn(), x = arena.spawn();
        c.add(a); c.data.v[c.idx(a)] = 10;
        c.add(b); c.data.v[c.idx(b)] = 20;
        c.add(x); c.data.v[c.idx(x)] = 30;
        expect(c.count).toBe(3);

        c.remove(b); // middle removal
        expect(c.count).toBe(2);
        // a stays at index 0, x moved into index 1 (was last)
        expect(c.dense[0]).toBe(a);
        expect(c.dense[1]).toBe(x);
        expect(c.data.v[c.idx(a)]).toBe(10);
        expect(c.data.v[c.idx(x)]).toBe(30);
    });

    it('handles last-element removal without swapping', () => {
        const arena = new Arena(4);
        const c = arena.registerComponent({ v: Float32Array });
        const a = arena.spawn(), b = arena.spawn();
        c.add(a); c.add(b);
        c.remove(b);
        expect(c.count).toBe(1);
        expect(c.dense[0]).toBe(a);
    });

    it('handles single-element removal', () => {
        const arena = new Arena(4);
        const c = arena.registerComponent({ v: Float32Array });
        const a = arena.spawn();
        c.add(a);
        c.remove(a);
        expect(c.count).toBe(0);
    });

    it('preserves SoA data integrity through many random ops', () => {
        const N = 64;
        const arena = new Arena(N);
        const c = arena.registerComponent({ tag: Uint32Array });

        // Snapshot model: entity -> tag value.
        const model = new Map();
        let next = 1;

        // Mixed sequence of spawns, adds, removes.
        const entities = [];
        for (let i = 0; i < N; i++) {
            const e = arena.spawn();
            entities.push(e);
            const v = next++;
            c.add(e);
            c.data.tag[c.idx(e)] = v;
            model.set(e, v);
        }

        // Remove every third entity from the component (not the arena).
        for (let i = 0; i < entities.length; i += 3) {
            c.remove(entities[i]);
            model.delete(entities[i]);
        }

        // Verify all surviving entities still see the correct tag.
        for (const [e, expected] of model.entries()) {
            expect(c.has(e)).toBe(true);
            expect(c.data.tag[c.idx(e)]).toBe(expected);
        }
        expect(c.count).toBe(model.size);
    });

    it('re-add after remove restores the entity correctly', () => {
        const arena = new Arena(4);
        const c = arena.registerComponent({ v: Float32Array });
        const a = arena.spawn(), b = arena.spawn();
        c.add(a); c.data.v[c.idx(a)] = 100;
        c.add(b); c.data.v[c.idx(b)] = 200;
        c.remove(a); // b swaps into slot 0
        c.add(a);    // a should land at slot 1
        c.data.v[c.idx(a)] = 999;
        expect(c.has(a)).toBe(true);
        expect(c.has(b)).toBe(true);
        expect(c.data.v[c.idx(a)]).toBe(999);
        expect(c.data.v[c.idx(b)]).toBe(200);
    });
});

// ─────────────────────────────────────────────────────────────────
// Iteration patterns — the hot path that ECS users actually run
// ─────────────────────────────────────────────────────────────────

describe('SparseSet: iteration', () => {
    it('iterating dense[0..count) visits every member exactly once', () => {
        const arena = new Arena(32);
        const c = arena.registerComponent({ v: Uint32Array });
        const seen = new Set();
        for (let i = 0; i < 20; i++) {
            const e = arena.spawn();
            c.add(e);
            c.data.v[c.idx(e)] = i;
        }
        for (let i = 0; i < c.count; i++) {
            const e = c.dense[i];
            seen.add(c.data.v[i]);
        }
        expect(seen.size).toBe(20);
        for (let i = 0; i < 20; i++) expect(seen.has(i)).toBe(true);
    });

    it('idx() matches has() for valid entities', () => {
        const arena = new Arena(16);
        const c = arena.registerComponent({ v: Float32Array });
        const e = arena.spawn();
        c.add(e);
        const i = c.idx(e);
        expect(c.dense[i]).toBe(e);
    });
});

// ─────────────────────────────────────────────────────────────────
// Stress / soak — pure correctness under randomized churn
// ─────────────────────────────────────────────────────────────────

describe('Arena: randomized churn (1000 ops)', () => {
    it('matches a Set/Map oracle through random spawn/despawn/add/remove', () => {
        const arena = new Arena(64);
        const c = arena.registerComponent({ t: Uint32Array });
        const alive = new Set();      // entity handles considered alive
        const hasC = new Map();        // entity -> tag

        let tagCounter = 1;
        // Deterministic LCG.
        let s = 0x12345678;
        const rand = () => (s = (s * 1664525 + 1013904223) | 0, (s >>> 0) / 0xFFFFFFFF);

        for (let step = 0; step < 1000; step++) {
            const r = rand();
            if (r < 0.30 && alive.size < 60) {
                const e = arena.spawn();
                alive.add(e);
            } else if (r < 0.55 && alive.size > 0) {
                const idx = Math.floor(rand() * alive.size);
                const e = [...alive][idx];
                arena.despawn(e);
                alive.delete(e);
                hasC.delete(e);
            } else if (r < 0.80 && alive.size > 0) {
                const idx = Math.floor(rand() * alive.size);
                const e = [...alive][idx];
                const t = tagCounter++;
                c.add(e);
                c.data.t[c.idx(e)] = t;
                hasC.set(e, t);
            } else if (alive.size > 0) {
                const idx = Math.floor(rand() * alive.size);
                const e = [...alive][idx];
                if (c.has(e)) {
                    c.remove(e);
                    hasC.delete(e);
                }
            }
        }

        // Invariants:
        expect(arena.activeCount).toBe(alive.size);
        expect(c.count).toBe(hasC.size);
        for (const e of alive) expect(arena.isAlive(e)).toBe(true);
        for (const [e, t] of hasC.entries()) {
            expect(c.has(e)).toBe(true);
            expect(c.data.t[c.idx(e)]).toBe(t);
        }
    });
});

// ─────────────────────────────────────────────────────────────────
// Zero-GC guarantee — requires --expose-gc
// ─────────────────────────────────────────────────────────────────

const gcAvailable = typeof globalThis.gc === 'function';
const describeGC = gcAvailable ? describe : describe.skip;

describeGC('Arena: zero-allocation guarantee (--expose-gc required)', () => {
    it('100k spawn/despawn cycles allocate <1MB', () => {
        const arena = new Arena(1024);
        const c = arena.registerComponent({
            x: Float32Array, y: Float32Array, vx: Float32Array, vy: Float32Array,
        });

        // Warm-up + baseline.
        for (let i = 0; i < 1000; i++) {
            const e = arena.spawn();
            c.add(e);
            arena.despawn(e);
        }
        globalThis.gc();
        const baseline = process.memoryUsage().heapUsed;

        // Hot loop.
        for (let i = 0; i < 100_000; i++) {
            const e = arena.spawn();
            c.add(e);
            c.data.x[c.idx(e)] = i;
            arena.despawn(e);
        }
        globalThis.gc();
        const after = process.memoryUsage().heapUsed;
        const delta = after - baseline;
        expect(delta).toBeLessThan(1024 * 1024); // < 1 MB
    });

    it('500k component iterations allocate <1MB', () => {
        const arena = new Arena(1024);
        const c = arena.registerComponent({ x: Float32Array });
        for (let i = 0; i < 1024; i++) {
            const e = arena.spawn();
            c.add(e);
            c.data.x[c.idx(e)] = i;
        }
        globalThis.gc();
        const baseline = process.memoryUsage().heapUsed;

        const data = c.data.x;
        let acc = 0;
        for (let pass = 0; pass < 500; pass++) {
            for (let i = 0; i < c.count; i++) acc += data[i];
        }
        expect(acc).toBeGreaterThan(0);

        globalThis.gc();
        const delta = process.memoryUsage().heapUsed - baseline;
        expect(delta).toBeLessThan(1024 * 1024);
    });
});
