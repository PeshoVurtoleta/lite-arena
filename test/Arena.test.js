/**
 * @zakkster/lite-arena — Unit test suite.
 *
 * Run: `npm test`            (node --test)
 *      or: `node --expose-gc --test`  to include the zero-allocation tests.
 *
 * The zero-allocation tests at the bottom require `--expose-gc`. They are
 * automatically skipped when globalThis.gc is unavailable so the suite remains
 * green on stock Node.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Arena, SparseSet } from '../Arena.js';

// -----------------------------------------------------------------
// Arena: construction
// -----------------------------------------------------------------

test('Arena: construction > accepts a positive integer up to 1048575', () => {
    assert.doesNotThrow(() => new Arena(1));
    assert.doesNotThrow(() => new Arena(1000));
    assert.doesNotThrow(() => new Arena(1048575));
});

test('Arena: construction > rejects 0', () => {
    assert.throws(() => new Arena(0), /maxEntities/);
});

test('Arena: construction > rejects negative values', () => {
    assert.throws(() => new Arena(-1), /maxEntities/);
    assert.throws(() => new Arena(-1000), /maxEntities/);
});

test('Arena: construction > rejects values above 1048575', () => {
    assert.throws(() => new Arena(1048576), /maxEntities/);
    assert.throws(() => new Arena(2 ** 30), /maxEntities/);
});

test('Arena: construction > rejects non-integers', () => {
    assert.throws(() => new Arena(1.5), /maxEntities/);
    assert.throws(() => new Arena(NaN), /maxEntities/);
    assert.throws(() => new Arena(Infinity), /maxEntities/);
});

test('Arena: construction > rejects non-numbers', () => {
    assert.throws(() => new Arena('100'));
    assert.throws(() => new Arena(null));
    assert.throws(() => new Arena(undefined));
});

test('Arena: construction > exposes capacity and activeCount', () => {
    const a = new Arena(64);
    assert.equal(a.capacity, 64);
    assert.equal(a.activeCount, 0);
});

// -----------------------------------------------------------------
// Arena: lifecycle
// -----------------------------------------------------------------

test('Arena: lifecycle > spawn returns alive handles', () => {
    const arena = new Arena(8);
    const e = arena.spawn();
    assert.equal(arena.isAlive(e), true);
});

test('Arena: lifecycle > different spawns return different handles', () => {
    const arena = new Arena(8);
    const a = arena.spawn();
    const b = arena.spawn();
    assert.notEqual(a, b);
});

test('Arena: lifecycle > activeCount reflects spawns and despawns', () => {
    const arena = new Arena(8);
    assert.equal(arena.activeCount, 0);
    const a = arena.spawn();
    const b = arena.spawn();
    assert.equal(arena.activeCount, 2);
    arena.despawn(a);
    assert.equal(arena.activeCount, 1);
    arena.despawn(b);
    assert.equal(arena.activeCount, 0);
});

test('Arena: lifecycle > throws when arena is full', () => {
    const small = new Arena(3);
    small.spawn();
    small.spawn();
    small.spawn();
    assert.throws(() => small.spawn(), /out of memory/);
});

test('Arena: lifecycle > reuses slots after despawn', () => {
    const small = new Arena(2);
    const a = small.spawn();
    small.spawn();
    assert.throws(() => small.spawn());
    small.despawn(a);
    assert.doesNotThrow(() => small.spawn());
});

test('Arena: lifecycle > despawn returns false for already-dead handles', () => {
    const arena = new Arena(8);
    const e = arena.spawn();
    assert.equal(arena.despawn(e), true);
    assert.equal(arena.despawn(e), false);
});

test('Arena: lifecycle > despawn returns false for synthesized junk handles', () => {
    const arena = new Arena(8);
    assert.equal(arena.despawn(0xDEADBEEF | 0), false);
    assert.equal(arena.despawn(-1), false);
    assert.equal(arena.despawn(0), false); // slot 0 might exist but gen 0 hasn't been spawned yet
});

test('Arena: lifecycle > isAlive is false for despawned handles', () => {
    const arena = new Arena(8);
    const e = arena.spawn();
    arena.despawn(e);
    assert.equal(arena.isAlive(e), false);
});

test('Arena: lifecycle > isAlive never throws on arbitrary input', () => {
    const arena = new Arena(8);
    assert.doesNotThrow(() => arena.isAlive(-1));
    assert.doesNotThrow(() => arena.isAlive(0xFFFFFFFF | 0));
    assert.doesNotThrow(() => arena.isAlive(0));
    // Synthesized handle 0 (generation bits 0) is rejected on a fresh arena:
    // slots initialise to generation 1, so 0 never matches. This invariant
    // survives the 1.2.0 rollover change (retired slots poison to GEN_MASK+1).
    assert.equal(arena.isAlive(0), false);
});

// -----------------------------------------------------------------
// Arena: generational handles — the ABA defence
// -----------------------------------------------------------------

test('Arena: generational handles > invalidates stale handles after slot reuse', () => {
    const arena = new Arena(1);
    const old = arena.spawn();
    arena.despawn(old);

    const fresh = arena.spawn();
    assert.equal(arena.isAlive(old), false);
    assert.equal(arena.isAlive(fresh), true);
    // Even though the slot index is identical:
    assert.equal(old & 0xFFFFF, fresh & 0xFFFFF);
    assert.notEqual(old, fresh);
});

test('Arena: generational handles > retires a slot at generation exhaustion (no ABA alias)', () => {
    // DECISION 0001 (see decisions/0001-generational-rollover.md): the 12-bit
    // generation counter issues 4095 live generations per slot. Rather than let
    // the counter wrap and re-issue a previously-handed-out generation -- which
    // would alias a stale handle as valid on the SAFE path -- the slot is
    // RETIRED on the despawn that returns its last generation. This test pins
    // the exact documented boundary behaviour; it is intended, not accidental.
    const arena = new Arena(1);

    // The very first handle. If the counter ever wrapped, a later spawn on this
    // single slot would re-mint exactly this bit pattern.
    const first = arena.spawn();      // gen 1
    assert.equal(arena.isAlive(first), true);
    arena.despawn(first);             // slot gen 1 -> 2  (despawn #1)

    // Drive the slot to its last live generation (gen 4095). despawn #k sees
    // gen k and advances to k+1; we need the slot sitting at gen 4095 so the
    // next despawn is the one that would wrap.
    for (let i = 0; i < 4093; i++) {  // despawns #2..#4094: gen 2 -> 4095
        const h = arena.spawn();
        arena.despawn(h);
    }

    const nearLast = arena.spawn();   // gen 4095 -- the last live generation
    assert.equal(arena.isAlive(nearLast), true);
    assert.equal(arena.retiredCount, 0);

    arena.despawn(nearLast);          // despawn #4095: gen == GEN_MASK -> RETIRE

    // Fail-closed outcome, asserted exactly:
    assert.equal(arena.retiredCount, 1);          // the slot was withdrawn
    assert.equal(arena.activeCount, 0);           // and it is not alive
    assert.equal(arena.isAlive(first), false);    // no alias: the first handle stays dead
    assert.equal(arena.isAlive(nearLast), false); // the retired handle is dead
    assert.equal(arena.isAlive(0), false);        // synthesized gen-0 rejected on a retired slot
    // The slot is gone for good -- capacity is now effectively 0, so spawn
    // surfaces the withdrawal as the library's normal exhaustion throw.
    assert.throws(() => arena.spawn(), /out of memory/);
});

test('Arena: generational handles > high-generation handles work correctly even when their bit pattern is negative', () => {
    const arena = new Arena(1);
    let h = arena.spawn();
    arena.despawn(h);

    // Get to a generation where the sign bit is set.
    for (let i = 0; i < 2048; i++) {
        h = arena.spawn();
        arena.despawn(h);
    }
    const negHandle = arena.spawn();
    assert.equal(negHandle < 0, true); // sign bit set
    assert.equal(arena.isAlive(negHandle), true);
    assert.equal(arena.despawn(negHandle), true);
});

// -----------------------------------------------------------------
// Arena: component registration & SoA layout
// -----------------------------------------------------------------

test('Arena: component registration > creates parallel typed arrays sized to capacity', () => {
    const arena = new Arena(100);
    const pos = arena.registerComponent({
        x: Float32Array,
        y: Float32Array,
    });
    assert.ok(pos.data.x instanceof Float32Array);
    assert.ok(pos.data.y instanceof Float32Array);
    assert.equal(pos.data.x.length, 100);
    assert.equal(pos.data.y.length, 100);
});

test('Arena: component registration > supports all typed-array constructors', () => {
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
    assert.ok(c.data.f32 instanceof Float32Array);
    assert.ok(c.data.f64 instanceof Float64Array);
    assert.ok(c.data.uc instanceof Uint8ClampedArray);
});

test('Arena: component registration > starts with count=0', () => {
    const arena = new Arena(16);
    const pos = arena.registerComponent({ x: Float32Array });
    assert.equal(pos.count, 0);
});

// -----------------------------------------------------------------
// SparseSet: add / has / remove
// -----------------------------------------------------------------

test('SparseSet: add / has / remove > add returns a valid dense index', () => {
    const arena = new Arena(8);
    const pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
    const e = arena.spawn();
    const idx = pos.add(e);
    assert.equal(idx, 0);
    assert.equal(pos.count, 1);
    assert.equal(pos.has(e), true);
});

test('SparseSet: add / has / remove > add returns -1 for dead handles', () => {
    const arena = new Arena(8);
    const pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
    const e = arena.spawn();
    arena.despawn(e);
    assert.equal(pos.add(e), -1);
    assert.equal(pos.count, 0);
});

test('SparseSet: add / has / remove > add is idempotent: re-adding returns the same index', () => {
    const arena = new Arena(8);
    const pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
    const e = arena.spawn();
    const first = pos.add(e);
    const second = pos.add(e);
    assert.equal(first, second);
    assert.equal(pos.count, 1);
});

test('SparseSet: add / has / remove > has returns false for dead handles', () => {
    const arena = new Arena(8);
    const pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
    const e = arena.spawn();
    pos.add(e);
    arena.despawn(e);
    assert.equal(pos.has(e), false);
});

test('SparseSet: add / has / remove > has returns false for never-added entities', () => {
    const arena = new Arena(8);
    const pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
    const e = arena.spawn();
    assert.equal(pos.has(e), false);
});

test('SparseSet: add / has / remove > has rejects synthesized junk handles', () => {
    const arena = new Arena(8);
    const pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
    assert.equal(pos.has(0xDEADBEEF | 0), false);
    assert.equal(pos.has(-1), false);
    assert.equal(pos.has(0), false);
});

test('SparseSet: add / has / remove > remove returns true on first call, false thereafter', () => {
    const arena = new Arena(8);
    const pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
    const e = arena.spawn();
    pos.add(e);
    assert.equal(pos.remove(e), true);
    assert.equal(pos.remove(e), false);
});

test('SparseSet: add / has / remove > remove decrements count', () => {
    const arena = new Arena(8);
    const pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
    const a = arena.spawn();
    const b = arena.spawn();
    pos.add(a);
    pos.add(b);
    assert.equal(pos.count, 2);
    pos.remove(a);
    assert.equal(pos.count, 1);
});

test('SparseSet: add / has / remove > despawn detaches from all components automatically', () => {
    const arena = new Arena(8);
    const pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
    const vel = arena.registerComponent({ vx: Float32Array });
    const e = arena.spawn();
    pos.add(e);
    vel.add(e);
    assert.equal(pos.has(e), true);
    assert.equal(vel.has(e), true);
    arena.despawn(e);
    assert.equal(pos.has(e), false);
    assert.equal(vel.has(e), false);
    assert.equal(pos.count, 0);
    assert.equal(vel.count, 0);
});

// -----------------------------------------------------------------
// SparseSet: swap-and-pop correctness — the subtle one
// -----------------------------------------------------------------

test('SparseSet: swap-and-pop correctness > keeps dense array contiguous after middle-element removal', () => {
    const arena = new Arena(4);
    const c = arena.registerComponent({ v: Float32Array });

    const a = arena.spawn(), b = arena.spawn(), x = arena.spawn();
    c.add(a); c.data.v[c.idx(a)] = 10;
    c.add(b); c.data.v[c.idx(b)] = 20;
    c.add(x); c.data.v[c.idx(x)] = 30;
    assert.equal(c.count, 3);

    c.remove(b); // middle removal
    assert.equal(c.count, 2);
    // a stays at index 0, x moved into index 1 (was last)
    assert.equal(c.dense[0], a);
    assert.equal(c.dense[1], x);
    assert.equal(c.data.v[c.idx(a)], 10);
    assert.equal(c.data.v[c.idx(x)], 30);
});

test('SparseSet: swap-and-pop correctness > handles last-element removal without swapping', () => {
    const arena = new Arena(4);
    const c = arena.registerComponent({ v: Float32Array });
    const a = arena.spawn(), b = arena.spawn();
    c.add(a); c.add(b);
    c.remove(b);
    assert.equal(c.count, 1);
    assert.equal(c.dense[0], a);
});

test('SparseSet: swap-and-pop correctness > handles single-element removal', () => {
    const arena = new Arena(4);
    const c = arena.registerComponent({ v: Float32Array });
    const a = arena.spawn();
    c.add(a);
    c.remove(a);
    assert.equal(c.count, 0);
});

test('SparseSet: swap-and-pop correctness > preserves SoA data integrity through many random ops', () => {
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
        assert.equal(c.has(e), true);
        assert.equal(c.data.tag[c.idx(e)], expected);
    }
    assert.equal(c.count, model.size);
});

test('SparseSet: swap-and-pop correctness > re-add after remove restores the entity correctly', () => {
    const arena = new Arena(4);
    const c = arena.registerComponent({ v: Float32Array });
    const a = arena.spawn(), b = arena.spawn();
    c.add(a); c.data.v[c.idx(a)] = 100;
    c.add(b); c.data.v[c.idx(b)] = 200;
    c.remove(a); // b swaps into slot 0
    c.add(a);    // a should land at slot 1
    c.data.v[c.idx(a)] = 999;
    assert.equal(c.has(a), true);
    assert.equal(c.has(b), true);
    assert.equal(c.data.v[c.idx(a)], 999);
    assert.equal(c.data.v[c.idx(b)], 200);
});

// -----------------------------------------------------------------
// SparseSet: iteration — the hot path that ECS users actually run
// -----------------------------------------------------------------

test('SparseSet: iteration > iterating dense[0..count) visits every member exactly once', () => {
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
    assert.equal(seen.size, 20);
    for (let i = 0; i < 20; i++) assert.equal(seen.has(i), true);
});

test('SparseSet: iteration > idx() matches has() for valid entities', () => {
    const arena = new Arena(16);
    const c = arena.registerComponent({ v: Float32Array });
    const e = arena.spawn();
    c.add(e);
    const i = c.idx(e);
    assert.equal(c.dense[i], e);
});

// -----------------------------------------------------------------
// Arena: randomized churn (1000 ops) — pure correctness under churn
// -----------------------------------------------------------------

test('Arena: randomized churn (1000 ops) > matches a Set/Map oracle through random spawn/despawn/add/remove', () => {
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
    assert.equal(arena.activeCount, alive.size);
    assert.equal(c.count, hasC.size);
    for (const e of alive) assert.equal(arena.isAlive(e), true);
    for (const [e, t] of hasC.entries()) {
        assert.equal(c.has(e), true);
        assert.equal(c.data.t[c.idx(e)], t);
    }
});

// -----------------------------------------------------------------
// Arena: zero-allocation guarantee — requires --expose-gc
// -----------------------------------------------------------------

const hasGc = typeof globalThis.gc === 'function';

test('Arena: zero-allocation guarantee (--expose-gc required) > 100k spawn/despawn cycles allocate <1MB', { skip: !hasGc }, () => {
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
    assert.ok(delta < 1024 * 1024); // < 1 MB
});

test('Arena: zero-allocation guarantee (--expose-gc required) > 500k component iterations allocate <1MB', { skip: !hasGc }, () => {
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
    assert.ok(acc > 0);

    globalThis.gc();
    const delta = process.memoryUsage().heapUsed - baseline;
    assert.ok(delta < 1024 * 1024);
});
