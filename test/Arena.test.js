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
    // REGRESSION GUARD for AR-01 / AR-02. Do NOT trim this test back to
    // isAlive/despawn on a component-free arena: that shape passes green while
    // the entire SparseSet layer is silently broken (which is exactly how the
    // pre-1.4.1 version of this test hid the bug for three minor releases).
    //
    // AR-01: a handle is `(gen << 20) | index`, a SIGNED int that goes NEGATIVE
    // at generation 2048. `dense` must be an Int32Array so the stored form and
    // the compared form (`dense[i] === entity`) share signedness. When `dense`
    // was a Uint32Array, EVERY SparseSet op silently failed for gen >= 2048:
    // has() false for a live member, add() duplicated, remove()/despawn cascade
    // detached nothing. This test therefore MUST register components and drive
    // has/add/idx/remove and the despawn cascade over a sign-bit-set handle --
    // it fails against a Uint32Array `dense` and passes against Int32Array.
    const arena = new Arena(1);
    const pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
    const vel = arena.registerComponent({ vx: Float32Array });
    const frozen = arena.registerTag();

    let h = arena.spawn();
    arena.despawn(h);

    // Drive slot 0 to a generation where the sign bit is set (>= 2048).
    for (let i = 0; i < 2048; i++) {
        h = arena.spawn();
        arena.despawn(h);
    }
    const negHandle = arena.spawn();
    assert.equal(negHandle < 0, true);                 // sign bit set
    assert.equal(arena.isAlive(negHandle), true);

    // --- the SparseSet contract, over a NEGATIVE handle -------------------
    const di = pos.add(negHandle);
    assert.equal(di >= 0, true);                        // add attaches, not -1
    assert.equal(pos.has(negHandle), true);             // <-- the AR-01 assertion
    assert.equal(pos.idx(negHandle), di);               // fast-path index matches
    assert.equal(pos.add(negHandle), di);               // idempotent: same index
    assert.equal(pos.count, 1);                         // no duplicate appended

    // Write and read back through the dense index to prove the row is real.
    pos.data.x[di] = 3.5; pos.data.y[di] = -1.25;
    assert.equal(pos.data.x[di], 3.5);
    assert.equal(pos.data.y[di], -1.25);

    // Attach the other two components (a second data set + a tag).
    vel.add(negHandle); frozen.add(negHandle);
    assert.equal(vel.has(negHandle), true);
    assert.equal(frozen.has(negHandle), true);

    // remove() must be able to detach a negative handle.
    assert.equal(pos.remove(negHandle), true);
    assert.equal(pos.count, 0);
    assert.equal(pos.has(negHandle), false);

    // despawn() must cascade across EVERY registered component. Re-attach pos
    // first so the cascade has all three to clear.
    pos.add(negHandle);
    assert.equal(arena.despawn(negHandle), true);
    assert.equal(pos.count, 0);                         // cascade cleared pos
    assert.equal(vel.count, 0);                         // ...and vel
    assert.equal(frozen.count, 0);                      // ...and the tag
    assert.equal(arena.activeCount, 0);
    assert.equal(arena.isAlive(negHandle), false);
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
// Arena: schema validation & data hardening (1.5.0)
//   AR-03: a schema that lies about its field types is rejected.
//   AR-04: `data` is a null-prototype bag; __proto__ / symbol keys fail closed.
//   AR-10: a SparseSet whose capacity != its arena's is rejected.
// -----------------------------------------------------------------

test('Arena: schema validation > accepts all nine numeric TypedArray constructors', () => {
    const arena = new Arena(8);
    // Each of the nine, one at a time, must register without throwing.
    const nine = [
        Int8Array, Uint8Array, Uint8ClampedArray,
        Int16Array, Uint16Array,
        Int32Array, Uint32Array,
        Float32Array, Float64Array,
    ];
    for (const Ctor of nine) {
        const c = arena.registerComponent({ v: Ctor });
        assert.ok(c.data.v instanceof Ctor);
        assert.equal(c.data.v.length, arena.capacity);
    }
});

test('Arena: schema validation > rejects non-TypedArray field types with a library error naming the key', () => {
    const arena = new Arena(8);
    const bad = [
        ['arr', Array],
        ['obj', Object],
        ['fn', Function],
        ['sab', SharedArrayBuffer],
        ['str', 'Float32Array'],   // a string, not the constructor
        ['nul', null],
        ['undef', undefined],
        ['plain', { nested: Float32Array }],
        ['bigi', BigInt64Array],   // a TypedArray, but not numeric -> rejected
        ['bigu', BigUint64Array],
    ];
    for (const [key, value] of bad) {
        assert.throws(
            () => arena.registerComponent({ [key]: value }),
            (err) => err instanceof Error &&
                     /lite-arena:/.test(err.message) &&
                     err.message.includes(`"${key}"`),
            `expected a library error naming "${key}" for value ${String(value)}`,
        );
    }
});

test('Arena: schema validation > empty schema and registerTag() remain legal', () => {
    const arena = new Arena(8);
    assert.doesNotThrow(() => arena.registerComponent({}));
    assert.doesNotThrow(() => arena.registerTag());
    const tag = arena.registerTag();
    assert.equal(Object.keys(tag.data).length, 0);
});

test('Arena: schema validation > a __proto__ schema key throws instead of silently losing the field', () => {
    const arena = new Arena(8);
    // `{ __proto__: Float32Array }` sets the literal's PROTOTYPE (to a function),
    // leaving zero own keys -- the pre-1.5.0 silent field loss. It must now throw.
    assert.throws(
        () => arena.registerComponent({ __proto__: Float32Array }),
        /lite-arena:.*prototype/,
    );
});

test('Arena: schema validation > toString / constructor keys land in clean own slots (null-proto data)', () => {
    const arena = new Arena(8);
    // These names collide with Object.prototype members on a plain `{}` bag.
    // On a null-proto bag they are ordinary component fields.
    const c = arena.registerComponent({ toString: Float32Array, constructor: Int32Array });
    assert.ok(c.data.toString instanceof Float32Array);
    assert.ok(c.data.constructor instanceof Int32Array);
    assert.equal(Object.keys(c.data).length, 2);
    const e = arena.spawn();
    const i = c.add(e);
    c.data.toString[i] = 1.5;
    c.data.constructor[i] = 7;
    assert.equal(c.data.toString[i], 1.5);
    assert.equal(c.data.constructor[i], 7);
});

test('Arena: schema validation > a symbol schema key throws', () => {
    const arena = new Arena(8);
    assert.throws(
        () => arena.registerComponent({ [Symbol('x')]: Float32Array }),
        /lite-arena:.*symbol/,
    );
});

test('Arena: data hardening > registered component data has a null prototype', () => {
    const arena = new Arena(8);
    const c = arena.registerComponent({ x: Float32Array, y: Float32Array });
    assert.equal(Object.getPrototypeOf(c.data), null);
});

test('Arena: data hardening > SparseSet rejects a capacity that does not match its arena (AR-10)', () => {
    const arena = new Arena(4);
    // Mismatched capacity: the exact trap from the roadmap -- writes past
    // sparse.length would be silently discarded and despawn would never clean it.
    assert.throws(
        () => new SparseSet(2, { x: Float32Array }, arena),
        /lite-arena:.*capacity/,
    );
    // A missing / non-Arena owner is also rejected (fail closed).
    assert.throws(
        () => new SparseSet(4, { x: Float32Array }, null),
        /lite-arena:.*Arena/,
    );
    // A matching capacity with a real arena is fine.
    assert.doesNotThrow(() => new SparseSet(4, { x: Float32Array }, arena));
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
// Arena: registerTag -- zero-size membership components (1.3.0)
// -----------------------------------------------------------------

test('Arena: registerTag > data is an empty null-prototype object with no keys', () => {
    const arena = new Arena(8);
    const tag = arena.registerTag();
    assert.equal(Object.keys(tag.data).length, 0);
    // AR-04: `data` is an Object.create(null) bag, not a plain `{}`. A tag's
    // data has no own keys and, deliberately, no prototype -- so `data.toString`
    // etc. are undefined rather than inherited Object.prototype members.
    assert.equal(Object.getPrototypeOf(tag.data), null);
});

test('Arena: registerTag > add / has / remove / count / dense all work', () => {
    const arena = new Arena(8);
    const Frozen = arena.registerTag();
    const e = arena.spawn();

    assert.equal(Frozen.has(e), false);       // not tagged yet
    const i = Frozen.add(e);
    assert.equal(i, 0);                        // add returns the dense index
    assert.equal(Frozen.has(e), true);
    assert.equal(Frozen.count, 1);
    assert.equal(Frozen.dense[0], e);          // walkable via dense[0..count)

    assert.equal(Frozen.remove(e), true);
    assert.equal(Frozen.has(e), false);
    assert.equal(Frozen.count, 0);
});

test('Arena: registerTag > add is idempotent and rejects dead handles', () => {
    const arena = new Arena(8);
    const Tag = arena.registerTag();
    const e = arena.spawn();
    assert.equal(Tag.add(e), Tag.add(e));      // idempotent -> same index
    assert.equal(Tag.count, 1);

    const dead = arena.spawn();
    arena.despawn(dead);
    assert.equal(Tag.add(dead), -1);           // dead handle rejected
    assert.equal(Tag.count, 1);
});

test('Arena: registerTag > despawn auto-clears the tag', () => {
    const arena = new Arena(8);
    const Tag = arena.registerTag();
    const e = arena.spawn();
    Tag.add(e);
    assert.equal(Tag.has(e), true);
    arena.despawn(e);
    assert.equal(Tag.has(e), false);           // cascaded like any component
    assert.equal(Tag.count, 0);
});

test('Arena: registerTag > many tags iterate as a packed dense set under churn', () => {
    const arena = new Arena(64);
    const Tag = arena.registerTag();
    const alive = [];
    for (let i = 0; i < 40; i++) {
        const e = arena.spawn();
        alive.push(e);
        if (i % 2 === 0) Tag.add(e);           // tag the evens
    }
    // Untag a scattered subset to force swap-and-pop churn.
    Tag.remove(alive[0]);
    Tag.remove(alive[10]);
    Tag.remove(alive[20]);

    // dense[0..count) must be exactly the still-tagged evens, each once.
    const seen = new Set();
    for (let i = 0; i < Tag.count; i++) {
        const e = Tag.dense[i];
        assert.equal(Tag.has(e), true);
        assert.equal(seen.has(e), false);      // no duplicates
        seen.add(e);
    }
    assert.equal(seen.size, Tag.count);
    assert.equal(Tag.count, 20 - 3);
});

// -----------------------------------------------------------------
// Arena: join -- rarest-first two-component planner (1.3.0)
// -----------------------------------------------------------------

test('Arena: join > drives the component with the smaller count', () => {
    const arena = new Arena(32);
    const A = arena.registerComponent({ v: Float32Array });
    const B = arena.registerTag();

    const ents = [];
    for (let i = 0; i < 10; i++) ents.push(arena.spawn());
    for (let i = 0; i < 10; i++) A.add(ents[i]);   // A: 10
    for (let i = 0; i < 3; i++) B.add(ents[i]);    // B: 3  (rarer)

    let j = arena.join(A, B);
    assert.equal(j.driver, B);                 // smaller count wins as driver
    assert.equal(j.other, A);
    assert.equal(j.count, 3);

    // Order of arguments must not change which one drives.
    j = arena.join(B, A);
    assert.equal(j.driver, B);
    assert.equal(j.other, A);
    assert.equal(j.count, 3);
});

test('Arena: join > ties favour the first argument deterministically', () => {
    const arena = new Arena(16);
    const A = arena.registerComponent({ v: Uint8Array });
    const B = arena.registerComponent({ w: Uint8Array });
    const e = arena.spawn(), f = arena.spawn();
    A.add(e); A.add(f);                        // A: 2
    B.add(e); B.add(f);                        // B: 2  (tie)

    assert.equal(arena.join(A, B).driver, A);  // a.count <= b.count -> a
    assert.equal(arena.join(B, A).driver, B);
});

test('Arena: join > returned object is a reused scratch, not a fresh allocation', () => {
    const arena = new Arena(8);
    const A = arena.registerComponent({ v: Float32Array });
    const B = arena.registerTag();
    const r1 = arena.join(A, B);
    const r2 = arena.join(A, B);
    assert.equal(r1, r2);                      // same object identity every call
});

test('Arena: join > the intersection loop the caller writes yields exactly A-and-B', () => {
    const arena = new Arena(64);
    const Pos = arena.registerComponent({ x: Float32Array });
    const Poisoned = arena.registerTag();

    const ents = [];
    for (let i = 0; i < 30; i++) {
        const e = arena.spawn();
        ents.push(e);
        Pos.add(e);
        Pos.data.x[Pos.idx(e)] = i;
        if (i % 5 === 0) Poisoned.add(e);      // 0,5,10,15,20,25 -> 6 poisoned
    }

    // Oracle: entities in BOTH sets.
    const expected = new Set(ents.filter((e, i) => i % 5 === 0));

    const j = arena.join(Pos, Poisoned);
    assert.equal(j.driver, Poisoned);          // rarer set drives
    const drv = j.driver, oth = j.other, n = j.count;
    const got = new Set();
    for (let i = 0; i < n; i++) {
        const e = drv.dense[i];
        if (!oth.has(e)) continue;
        got.add(e);
    }
    assert.equal(got.size, expected.size);
    for (const e of expected) assert.equal(got.has(e), true);
});

test('Arena: join > handles empty and equal components without special-casing', () => {
    const arena = new Arena(8);
    const A = arena.registerComponent({ v: Float32Array });
    const B = arena.registerTag();
    // Both empty.
    let j = arena.join(A, B);
    assert.equal(j.count, 0);
    // Same component on both sides.
    const e = arena.spawn();
    A.add(e);
    j = arena.join(A, A);
    assert.equal(j.driver, A);
    assert.equal(j.other, A);
    assert.equal(j.count, 1);
});

// -----------------------------------------------------------------
// Arena: joinN -- k-way AND + exclusion planner (S7, 1.9.0)
// -----------------------------------------------------------------

// Runs the canonical joinN loop against a plan and returns the matched
// entities as a sorted array -- the exact loop shape the docs bless.
function runJoinN(p) {
    const drv = p.driver, n = p.count;
    const oth = p.others, no = p.othersCount;
    const ex = p.excl, nx = p.exclCount;
    const got = [];
    for (let i = 0; i < n; i++) {
        const e = drv.dense[i];
        let ok = true;
        for (let k = 0; k < no; k++) if (!oth[k].has(e)) { ok = false; break; }
        if (ok) for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
        if (ok) got.push(e);
    }
    return got.sort((x, y) => x - y);
}

test('Arena: joinN > k-way AND matches every required set (oracle)', () => {
    const arena = new Arena(64);
    const A = arena.registerTag();
    const B = arena.registerTag();
    const C = arena.registerComponent({ v: Float32Array });

    const ents = [];
    for (let i = 0; i < 30; i++) {
        const e = arena.spawn();
        ents.push(e);
        A.add(e);                    // A: all 30
        if (i % 2 === 0) B.add(e);   // B: 15
        if (i % 3 === 0) C.add(e);   // C: 10  (rarest required)
    }

    const oracle = ents.filter((e) => A.has(e) && B.has(e) && C.has(e))
        .sort((x, y) => x - y);
    const p = arena.joinN([A, B, C]);
    assert.equal(p.driver, C, 'the globally rarest required set must drive');
    assert.equal(p.count, C.count);
    assert.deepEqual(runJoinN(p), oracle);
});

test('Arena: joinN > exclusion removes entities in any excluded set (oracle)', () => {
    const arena = new Arena(64);
    const A = arena.registerTag();
    const B = arena.registerTag();
    const D = arena.registerTag();   // excluded

    const ents = [];
    for (let i = 0; i < 30; i++) {
        const e = arena.spawn();
        ents.push(e);
        A.add(e);
        if (i % 2 === 0) B.add(e);
        if (i % 5 === 0) D.add(e);   // 0,5,10,15,20,25 excluded
    }

    const oracle = ents.filter((e) => A.has(e) && B.has(e) && !D.has(e))
        .sort((x, y) => x - y);
    const p = arena.joinN([A, B], [D]);
    assert.deepEqual(runJoinN(p), oracle);
});

test('Arena: joinN > multiple exclusions: NONE of the excluded sets may contain e', () => {
    const arena = new Arena(64);
    const A = arena.registerTag();
    const D1 = arena.registerTag();
    const D2 = arena.registerTag();

    const ents = [];
    for (let i = 0; i < 24; i++) {
        const e = arena.spawn();
        ents.push(e);
        A.add(e);
        if (i % 3 === 0) D1.add(e);
        if (i % 4 === 0) D2.add(e);
    }

    const oracle = ents.filter((e) => A.has(e) && !D1.has(e) && !D2.has(e))
        .sort((x, y) => x - y);
    const p = arena.joinN([A], [D1, D2]);
    assert.deepEqual(runJoinN(p), oracle);
});

test('Arena: joinN > driver is the global min; ties favour the first required set', () => {
    const arena = new Arena(32);
    const A = arena.registerTag();
    const B = arena.registerTag();
    const C = arena.registerTag();
    const e = arena.spawn(), f = arena.spawn(), g = arena.spawn();
    // A: 3, B: 2, C: 2 (B and C tie for min; B appears first)
    A.add(e); A.add(f); A.add(g);
    B.add(e); B.add(f);
    C.add(e); C.add(f);
    assert.equal(arena.joinN([A, B, C]).driver, B, 'min-count, ties favour first');
    assert.equal(arena.joinN([A, C, B]).driver, C, 'reorder -> the earlier tied set drives');
    assert.equal(arena.joinN([A]).driver, A, 'single required set drives itself');
});

test('Arena: joinN > excluded omitted is the empty NOT list', () => {
    const arena = new Arena(16);
    const A = arena.registerTag();
    const e = arena.spawn(), f = arena.spawn();
    A.add(e); A.add(f);
    const p = arena.joinN([A]);
    assert.equal(p.exclCount, 0);
    assert.equal(p.othersCount, 0);
    assert.equal(p.count, 2);
    assert.deepEqual(runJoinN(p), [e, f].sort((x, y) => x - y));
});

test('Arena: joinN > fail-closed: empty or null required throws (null is not zero)', () => {
    const arena = new Arena(8);
    const A = arena.registerTag();
    assert.throws(() => arena.joinN([]), /at least one required set/);
    assert.throws(() => arena.joinN(null), /at least one required set/);
    assert.throws(() => arena.joinN(undefined), /at least one required set/);
    // A valid single-set join still works (guards do not over-fire).
    arena.joinN([A]);
});

test('Arena: joinN > contradiction (set both required and excluded) yields empty in production', () => {
    const arena = new Arena(32);
    const A = arena.registerTag();
    const B = arena.registerTag();
    for (let i = 0; i < 10; i++) { const e = arena.spawn(); A.add(e); B.add(e); }
    // B is required AND excluded -> every driver element is excluded -> empty.
    const p = arena.joinN([A, B], [B]);
    assert.deepEqual(runJoinN(p), []);
});

test('Arena: joinN > returned object is a reused scratch, not a fresh allocation', () => {
    const arena = new Arena(8);
    const A = arena.registerTag();
    const B = arena.registerTag();
    const r1 = arena.joinN([A, B]);
    const r2 = arena.joinN([A, B]);
    assert.equal(r1, r2, 'unchecked joinN() must hand back the one reused scratch');
});

test('Arena: joinN > scratch arrays carry a stale tail; only othersCount/exclCount is live', () => {
    const arena = new Arena(16);
    const A = arena.registerTag();
    const B = arena.registerTag();
    const C = arena.registerTag();
    const D = arena.registerTag();
    // A larger call grows the scratch high-water mark...
    const big = arena.joinN([A, B, C], [D]);
    assert.equal(big.othersCount, 2);
    assert.equal(big.exclCount, 1);
    // ...a smaller call reuses the SAME arrays with a shorter live prefix.
    const small = arena.joinN([A]);
    assert.equal(small.othersCount, 0);
    assert.equal(small.exclCount, 0);
    assert.equal(small.others, big.others, 'same reused backing array');
    assert.ok(small.others.length >= 2, 'stale tail is retained, not reallocated');
});

test('Arena: joinN > checked mode: plan read after a later join/joinN throws', () => {
    const arena = new Arena(16, { checked: true });
    const A = arena.registerTag();
    const B = arena.registerTag();
    const e = arena.spawn(); A.add(e); B.add(e);

    const p1 = arena.joinN([A, B]);
    arena.joinN([A]);                          // supersede via joinN
    assert.throws(() => p1.count, /stale joinN/);
    assert.throws(() => p1.driver, /stale joinN/);
    assert.throws(() => p1.others, /stale joinN/);

    const p2 = arena.joinN([A, B]);
    arena.join(A, B);                          // supersede via the 2-way join (shared epoch)
    assert.throws(() => p2.count, /stale joinN/);
});

test('Arena: joinN > checked mode: foreign set throws', () => {
    const arena = new Arena(16, { checked: true });
    const A = arena.registerTag();
    const other = new Arena(16, { checked: true });
    const foreign = other.registerTag();
    assert.throws(() => arena.joinN([A, foreign]), /foreign SparseSet/);
    assert.throws(() => arena.joinN([A], [foreign]), /foreign SparseSet/);
});

test('Arena: joinN > checked mode: set both required and excluded throws', () => {
    const arena = new Arena(16, { checked: true });
    const A = arena.registerTag();
    const B = arena.registerTag();
    assert.throws(() => arena.joinN([A, B], [B]), /both required and excluded/);
});

test('Arena: joinN > checked mode OFF by default hands back the reused scratch', () => {
    const arena = new Arena(16);   // no { checked: true }
    const A = arena.registerTag();
    const B = arena.registerTag();
    arena.spawn();
    const j1 = arena.joinN([A, B]);
    const j2 = arena.joinN([A, B]);
    assert.equal(j1, j2, 'unchecked joinN() must hand back the one reused scratch');
});

test('Arena: joinN > two-way join() is untouched: same shape and numbers as before', () => {
    const arena = new Arena(32);
    const A = arena.registerComponent({ v: Float32Array });
    const B = arena.registerTag();
    const ents = [];
    for (let i = 0; i < 10; i++) ents.push(arena.spawn());
    for (let i = 0; i < 10; i++) A.add(ents[i]);
    for (let i = 0; i < 3; i++) B.add(ents[i]);
    const j = arena.join(A, B);
    assert.equal(j.driver, B);
    assert.equal(j.other, A);
    assert.equal(j.count, 3);
    assert.equal(j.others, undefined, 'legacy join() plan has no joinN fields');
});

// -----------------------------------------------------------------
// Arena: NON-GOALS -- no query language, no callback iteration (1.3.0)
// -----------------------------------------------------------------

test('Arena: non-goals > no query() / forEach() / each() iteration API exists', () => {
    const arena = new Arena(4);
    const c = arena.registerComponent({ v: Float32Array });
    const tag = arena.registerTag();
    // The BRIEF forbids a query language and callback iteration. Assert absence
    // so a future accidental addition trips this test.
    assert.equal(typeof arena.query, 'undefined');
    assert.equal(typeof c.forEach, 'undefined');
    assert.equal(typeof c.each, 'undefined');
    assert.equal(typeof tag.forEach, 'undefined');
    assert.equal(typeof tag.each, 'undefined');
});

// -----------------------------------------------------------------
// Arena: reserve -- explicit, opt-in capacity growth (1.4.0)
// -----------------------------------------------------------------

test('Arena: reserve > no-op returning false when newCapacity <= capacity', () => {
    const arena = new Arena(8);
    assert.equal(arena.reserve(8), false);   // equal -> no-op
    assert.equal(arena.reserve(4), false);   // smaller -> no-op
    assert.equal(arena.reserve(0), false);
    assert.equal(arena.capacity, 8);         // untouched
});

test('Arena: reserve > grows and returns true when newCapacity > capacity', () => {
    const arena = new Arena(8);
    assert.equal(arena.reserve(16), true);
    assert.equal(arena.capacity, 16);
});

test('Arena: reserve > rejects non-integers and values above 1048575', () => {
    const arena = new Arena(8);
    assert.throws(() => arena.reserve(16.5), /reserve capacity/);
    assert.throws(() => arena.reserve(NaN), /reserve capacity/);
    assert.throws(() => arena.reserve(1048576), /reserve capacity/);
    assert.equal(arena.capacity, 8); // failed reserves leave capacity intact
});

test('Arena: reserve > preserves every live entity, membership, and data value (oracle)', () => {
    const arena = new Arena(8);
    const pos = arena.registerComponent({ x: Float32Array, y: Float64Array });
    const vel = arena.registerComponent({ vx: Int32Array });
    const tag = arena.registerTag();

    // Build a known population; despawn one to leave a hole in the free list.
    const handles = [];
    for (let i = 0; i < 8; i++) handles.push(arena.spawn());
    arena.despawn(handles[3]);           // create a gap
    const live = handles.filter((_, i) => i !== 3);

    // Oracle of expected state, captured BEFORE the grow.
    const oracle = new Map(); // handle -> {x,y,vx,hasVel,hasTag}
    for (let i = 0; i < live.length; i++) {
        const e = live[i];
        pos.add(e);
        pos.data.x[pos.idx(e)] = i * 1.5;
        pos.data.y[pos.idx(e)] = -i * 100;
        const hasVel = (i % 2) === 0;
        const hasTag = (i % 3) === 0;
        if (hasVel) { vel.add(e); vel.data.vx[vel.idx(e)] = 1000 + i; }
        if (hasTag) tag.add(e);
        oracle.set(e, { x: i * 1.5, y: -i * 100, vx: 1000 + i, hasVel, hasTag });
    }
    const activeBefore = arena.activeCount;
    const posCountBefore = pos.count;

    assert.equal(arena.reserve(64), true);

    // Nothing about the live population changed.
    assert.equal(arena.capacity, 64);
    assert.equal(arena.activeCount, activeBefore);
    assert.equal(pos.count, posCountBefore);
    for (const [e, exp] of oracle) {
        assert.equal(arena.isAlive(e), true, 'handle survives grow');
        assert.equal(pos.has(e), true);
        assert.equal(pos.data.x[pos.idx(e)], exp.x, 'x preserved');
        assert.equal(pos.data.y[pos.idx(e)], exp.y, 'y (Float64) preserved');
        assert.equal(vel.has(e), exp.hasVel);
        if (exp.hasVel) assert.equal(vel.data.vx[vel.idx(e)], exp.vx, 'vx preserved');
        assert.equal(tag.has(e), exp.hasTag);
    }
    // The despawned handle stays dead across the grow.
    assert.equal(arena.isAlive(handles[3]), false);
});

test('Arena: reserve > spawn() at full capacity throws and does NOT auto-grow', () => {
    const arena = new Arena(4);
    for (let i = 0; i < 4; i++) arena.spawn();
    assert.equal(arena.activeCount, 4);
    // The whole point: spawn never calls reserve() for you.
    assert.throws(() => arena.spawn(), /out of memory/);
    assert.equal(arena.capacity, 4, 'a failed spawn must not have grown the arena');
    assert.equal(arena.activeCount, 4);
});

test('Arena: reserve > enables spawning beyond the old capacity into fresh slots', () => {
    const arena = new Arena(4);
    const pos = arena.registerComponent({ x: Float32Array });
    const first = [];
    for (let i = 0; i < 4; i++) { const e = arena.spawn(); pos.add(e); first.push(e); }
    assert.throws(() => arena.spawn(), /out of memory/);

    assert.equal(arena.reserve(8), true);

    // Four more spawns now succeed and are distinct, live, and addressable.
    const seen = new Set(first);
    for (let i = 0; i < 4; i++) {
        const e = arena.spawn();
        assert.equal(seen.has(e), false, 'new handle is distinct from all prior');
        seen.add(e);
        assert.equal(arena.isAlive(e), true);
        assert.equal(pos.add(e) >= 0, true);
    }
    assert.equal(arena.activeCount, 8);
    assert.throws(() => arena.spawn(), /out of memory/); // full again at the new cap
});

test('Arena: reserve > free-list stays intact: despawn/respawn work after a grow', () => {
    const arena = new Arena(4);
    const a = arena.spawn(), b = arena.spawn();
    assert.equal(arena.reserve(16), true);
    // A pre-grow slot returned to the free list is still reusable post-grow.
    arena.despawn(a);
    const reused = arena.spawn();
    assert.equal(arena.isAlive(reused), true);
    assert.equal(arena.isAlive(a), false, 'the old (despawned) handle stays stale');
    assert.equal(arena.isAlive(b), true);
    assert.equal(arena.retiredCount, 0, 'reserve does not retire slots');
});

test('Arena: reserve > swaps in fresh backing buffers (hoisted refs are stale by design)', () => {
    const arena = new Arena(4);
    const pos = arena.registerComponent({ x: Float32Array });
    const e = arena.spawn();
    pos.add(e);
    pos.data.x[pos.idx(e)] = 42;

    const staleX = pos.data.x;       // the classic hoist
    const staleDense = pos.dense;
    assert.equal(arena.reserve(32), true);

    // Post-grow the arena points at NEW buffers; the old ones are discarded.
    assert.notEqual(pos.data.x, staleX, 'data.x buffer was replaced');
    assert.notEqual(pos.dense, staleDense, 'dense buffer was replaced');
    assert.equal(pos.data.x.length, 32, 'new buffer is the grown length');
    // The value was copied forward into the new buffer.
    assert.equal(pos.data.x[pos.idx(e)], 42);
    // The stale reference still holds the OLD (shorter) buffer -- reading it
    // would silently use pre-grow memory. This is the documented footgun.
    assert.equal(staleX.length, 4);
});

test('Arena: reserve > preserves packed dense order after prior swap-and-pop churn', () => {
    const arena = new Arena(8);
    const c = arena.registerComponent({ v: Uint32Array });
    const handles = [];
    for (let i = 0; i < 8; i++) { const e = arena.spawn(); c.add(e); c.data.v[c.idx(e)] = i; handles.push(e); }
    // Remove a couple from the middle to exercise swap-and-pop before growing.
    c.remove(handles[2]);
    c.remove(handles[5]);
    const expected = new Map();
    for (let i = 0; i < c.count; i++) expected.set(c.dense[i], c.data.v[i]);

    assert.equal(arena.reserve(64), true);

    assert.equal(c.count, expected.size);
    // dense[0..count) still lists exactly the surviving members with their data.
    for (let i = 0; i < c.count; i++) {
        assert.equal(expected.has(c.dense[i]), true);
        assert.equal(c.data.v[i], expected.get(c.dense[i]));
    }
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

// -----------------------------------------------------------------
// Arena: retirement observability, clear(), and checked mode (1.6.0)
// -----------------------------------------------------------------

const GEN_MASK = 0xFFF; // 4095 live generations per slot -- mirrors Arena.js.

// Drive whichever slot the free-list head points at through its entire live
// generation range and retire it. The free list is LIFO, so on a small arena a
// spawn/despawn churn keeps hammering that one slot -- advancing only its
// generation -- until the gen-GEN_MASK despawn withdraws it, leaving the other
// slots untouched. Returns nothing; asserts exactly one new retirement.
function retireOneSlot(arena) {
    const before = arena.retiredCount;
    let h = arena.spawn();                 // gen 1 on the head slot
    for (let g = 1; g < GEN_MASK; g++) {   // churn it up to gen GEN_MASK (4095)
        arena.despawn(h);
        h = arena.spawn();
    }
    arena.despawn(h);                      // gen === GEN_MASK -> retire
    assert.equal(arena.retiredCount, before + 1, 'retireOneSlot must retire exactly one slot');
}

test('Arena: remainingCapacity > equals capacity - activeCount - retiredCount across spawn/despawn', () => {
    const arena = new Arena(4);
    const check = () => assert.equal(
        arena.remainingCapacity(),
        arena.capacity - arena.activeCount - arena.retiredCount);

    assert.equal(arena.remainingCapacity(), 4);
    check();

    const a = arena.spawn(); check();
    const b = arena.spawn(); check();
    assert.equal(arena.remainingCapacity(), 2);

    arena.despawn(a); check();
    assert.equal(arena.remainingCapacity(), 3);

    arena.despawn(b); check();
    assert.equal(arena.remainingCapacity(), 4); // back to empty, nothing retired
    assert.equal(arena.retiredCount, 0);
});

test('Arena: remainingCapacity > falls below capacity - activeCount once a slot retires', () => {
    const arena = new Arena(2);
    retireOneSlot(arena);

    // The arena is EMPTY (activeCount 0) yet can hold only 1 more -- a retired
    // slot is gone, not free. This is the number a leak hunt would otherwise miss.
    assert.equal(arena.activeCount, 0);
    assert.equal(arena.retiredCount, 1);
    assert.equal(arena.remainingCapacity(), 1);
    assert.equal(arena.remainingCapacity(),
        arena.capacity - arena.activeCount - arena.retiredCount);

    // The one surviving slot is still spawnable.
    const e = arena.spawn();
    assert.equal(arena.isAlive(e), true);
    assert.equal(arena.remainingCapacity(), 0);
});

test('Arena: exhaustion message > a genuinely full arena names capacity, not retirement', () => {
    const arena = new Arena(2);
    arena.spawn();
    arena.spawn();
    let msg = '';
    try { arena.spawn(); } catch (err) { msg = err.message; }
    assert.match(msg, /out of memory/);          // back-compat: old callers match this
    assert.match(msg, /activeCount=2/);
    assert.match(msg, /retiredCount=0/);
    assert.doesNotMatch(msg, /retired by generation/); // must NOT blame retirement
});

test('Arena: exhaustion message > a retirement-exhausted arena names retirement and the counts', () => {
    const arena = new Arena(1);
    retireOneSlot(arena);
    assert.equal(arena.activeCount, 0);
    assert.equal(arena.retiredCount, 1);

    let msg = '';
    try { arena.spawn(); } catch (err) { msg = err.message; }
    assert.match(msg, /out of memory/);
    assert.match(msg, /retiredCount=1/);
    assert.match(msg, /activeCount=0/);
    assert.match(msg, /retired by generation/); // the reader is pointed at churn, not a leak
});

test('Arena: clear > empties the arena, resets counts, and invalidates every pre-clear handle', () => {
    const arena = new Arena(4);
    const pos = arena.registerComponent({ x: Float32Array });
    const tag = arena.registerTag();

    const handles = [];
    for (let i = 0; i < 3; i++) {
        const e = arena.spawn();
        pos.add(e);
        pos.data.x[pos.idx(e)] = i + 1;
        if (i === 0) tag.add(e);
        handles.push(e);
    }
    assert.equal(arena.activeCount, 3);
    assert.ok(pos.count > 0 && tag.count > 0);

    arena.clear();

    assert.equal(arena.activeCount, 0);
    assert.equal(arena.retiredCount, 0);
    assert.equal(arena.remainingCapacity(), 4);
    assert.equal(pos.count, 0);
    assert.equal(tag.count, 0);
    for (const e of handles) {
        assert.equal(arena.isAlive(e), false, 'pre-clear handle must be dead after clear()');
        assert.equal(pos.has(e), false);
    }

    // The arena is fully usable again, and the fresh handle is live.
    const e2 = arena.spawn();
    assert.equal(arena.isAlive(e2), true);
    assert.equal(pos.add(e2) >= 0, true);
});

test('Arena: clear > revives retired slots back to full capacity', () => {
    const arena = new Arena(2);
    retireOneSlot(arena);
    retireOneSlot(arena);
    assert.equal(arena.retiredCount, 2);
    assert.equal(arena.remainingCapacity(), 0);
    assert.throws(() => arena.spawn(), /out of memory/); // fully retired -> exhausted

    arena.clear();

    assert.equal(arena.retiredCount, 0, 'clear() must revive retired slots');
    assert.equal(arena.remainingCapacity(), 2);
    const a = arena.spawn();
    const b = arena.spawn();
    assert.equal(arena.isAlive(a), true);
    assert.equal(arena.isAlive(b), true);
    assert.equal(arena.remainingCapacity(), 0);
});

test('Arena: clear > reuses every backing buffer (allocates nothing)', () => {
    const arena = new Arena(4);
    const pos = arena.registerComponent({ x: Float32Array, y: Uint16Array });
    for (let i = 0; i < 4; i++) pos.add(arena.spawn());

    // Identity of every buffer clear() touches, captured before the reset.
    const gens = arena.generations;
    const free = arena.freeList;
    const dense = pos.dense;
    const sparse = pos.sparse;
    const dataX = pos.data.x;
    const dataY = pos.data.y;

    arena.clear();

    // Same objects afterward: clear() overwrites in place, never reallocates.
    assert.equal(arena.generations, gens);
    assert.equal(arena.freeList, free);
    assert.equal(pos.dense, dense);
    assert.equal(pos.sparse, sparse);
    assert.equal(pos.data.x, dataX);
    assert.equal(pos.data.y, dataY);
});

test('Arena: onRetire > a rejected onRetire option is never honored (non-goal, in writing)', () => {
    // Retirement deliberately does NOT call back into user code from the despawn
    // path (see decisions/0004). Passing an `onRetire` must be inert -- the counter
    // plus remainingCapacity() is the whole contract.
    let called = false;
    const arena = new Arena(1, { onRetire: () => { called = true; } });
    retireOneSlot(arena);
    assert.equal(called, false, 'onRetire must never fire -- it is a rejected shape');
    assert.equal(arena.retiredCount, 1);
});

test('Arena: checked mode > a join() plan read after a later join() throws', () => {
    const arena = new Arena(8, { checked: true });
    const a = arena.registerComponent({ x: Float32Array });
    const b = arena.registerTag();
    const e = arena.spawn(); a.add(e); b.add(e);
    const e2 = arena.spawn(); a.add(e2);   // a.count = 2, b.count = 1 -> b is rarer

    const p1 = arena.join(a, b);
    assert.equal(p1.count, 1);          // valid window: reads fine
    assert.equal(p1.driver, b);         // rarer set drives (tag has the smaller count)

    arena.join(a, b);                   // supersede p1

    assert.throws(() => p1.count, /stale join/);
    assert.throws(() => p1.driver, /stale join/);
    assert.throws(() => p1.other, /stale join/);
});

test('Arena: checked mode > idx() throws on a dead or non-member entity; valid idx() works', () => {
    const arena = new Arena(8, { checked: true });
    const a = arena.registerComponent({ x: Float32Array });

    const e = arena.spawn();
    const di = a.add(e);
    assert.equal(a.idx(e), di);                       // member: returns its dense index

    const outsider = arena.spawn();                    // alive, but never added to `a`
    assert.throws(() => a.idx(outsider), /checked mode/);

    arena.despawn(e);                                  // now dead
    assert.throws(() => a.idx(e), /checked mode/);
});

test('Arena: checked mode > OFF by default: join reuses the scratch, idx skips checks', () => {
    const arena = new Arena(4); // unchecked
    const a = arena.registerComponent({ x: Float32Array });
    const b = arena.registerTag();
    arena.spawn(); // populate so join has something to plan over

    const j1 = arena.join(a, b);
    const j2 = arena.join(a, b);
    assert.equal(j1, j2, 'unchecked join() must hand back the one reused scratch');

    // Unchecked idx() is the raw fast path: it must NOT throw on a non-member.
    const outsider = arena.spawn();
    assert.doesNotThrow(() => a.idx(outsider));
});

test('Arena: checked mode > production hot path untouched: prototype idx() vs own checked idx()', () => {
    const plain = new Arena(2);
    const plainSet = plain.registerComponent({ x: Float32Array });
    // An unchecked set uses the shared prototype method -- no own idx, so every
    // production set stays monomorphic on SparseSet.prototype.idx.
    assert.equal(plainSet.idx, SparseSet.prototype.idx);
    assert.equal(Object.prototype.hasOwnProperty.call(plainSet, 'idx'), false);

    const checked = new Arena(2, { checked: true });
    const checkedSet = checked.registerComponent({ x: Float32Array });
    // A checked set shadows it with an OWN property -- the prototype is untouched.
    assert.equal(Object.prototype.hasOwnProperty.call(checkedSet, 'idx'), true);
    assert.notEqual(checkedSet.idx, SparseSet.prototype.idx);
});

// -----------------------------------------------------------------
// Arena: caller-supplied component payload buffers (1.7.0 / S5)
//
// registerComponent(schema, { buffers }) lets each data.* field VIEW a buffer
// the caller owns (ArrayBuffer or SharedArrayBuffer) instead of one the arena
// allocates -- so a component's payload can live in memory shared with a Worker.
// The read path (count/dense) is NOT shared yet; the worker cannot iterate. See
// decisions/0006 and the cross-thread smoke test in test/cross-thread.test.js.
//
// Fail-before/pass-after note: on 1.6.1 the second argument was ignored, so the
// "independent view sees the write" test below would fail (data.x would be a
// private own buffer the independent view never sees). It passes only because
// registerComponent now views the supplied buffer.
// -----------------------------------------------------------------

// A correctly-sized ArrayBuffer for `capacity` elements of a typed-array ctor.
function bufFor(Ctor, capacity) {
    return new ArrayBuffer(capacity * Ctor.BYTES_PER_ELEMENT);
}

test('Arena: caller buffers > no options is byte-identical own-allocation (no _callerBacked own prop)', () => {
    const arena = new Arena(4);
    const c = arena.registerComponent({ x: Float32Array });
    // The production default keeps the exact 1.6.1 instance shape: no own flag.
    assert.equal(Object.prototype.hasOwnProperty.call(c, '_callerBacked'), false);
    assert.equal(c._callerBacked, undefined);
    // And an empty options object (no buffers key) is still own-allocation.
    const c2 = arena.registerComponent({ y: Float32Array }, {});
    assert.equal(Object.prototype.hasOwnProperty.call(c2, '_callerBacked'), false);
});

test('Arena: caller buffers > a supplied ArrayBuffer is genuinely the backing store (independent view)', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    const buf = bufFor(Float32Array, CAP);
    const pos = arena.registerComponent({ x: Float32Array }, { buffers: { x: buf } });

    assert.equal(Object.prototype.hasOwnProperty.call(pos, '_callerBacked'), true);
    assert.equal(pos._callerBacked, true);
    // The component's view must be over the SAME ArrayBuffer the caller passed.
    assert.equal(pos.data.x.buffer, buf);

    const e = arena.spawn();
    const i = pos.add(e);
    pos.data.x[i] = 42.5;

    // An INDEPENDENT view over the same buffer sees the write -- proof the arena
    // did not quietly own-allocate a private array.
    const independent = new Float32Array(buf);
    assert.equal(independent[i], 42.5);

    // And a write through the independent view is visible to the component.
    independent[i] = -7.25;
    assert.equal(pos.data.x[i], -7.25);
});

test('Arena: caller buffers > accepts a SharedArrayBuffer and round-trips a value (single thread)', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    const sab = new SharedArrayBuffer(CAP * Float32Array.BYTES_PER_ELEMENT);
    const pos = arena.registerComponent({ x: Float32Array }, { buffers: { x: sab } });
    assert.ok(pos.data.x.buffer instanceof SharedArrayBuffer);

    const e = arena.spawn();
    const i = pos.add(e);
    pos.data.x[i] = 3.5;
    assert.equal(new Float32Array(sab)[i], 3.5);
});

test('Arena: caller buffers > swap-and-pop on remove() writes through the shared buffer', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    const buf = bufFor(Float64Array, CAP);
    const c = arena.registerComponent({ v: Float64Array }, { buffers: { v: buf } });

    const e0 = arena.spawn(), e1 = arena.spawn(), e2 = arena.spawn();
    c.add(e0); c.add(e1); c.add(e2);
    c.data.v[c.idx(e0)] = 10;
    c.data.v[c.idx(e1)] = 20;
    c.data.v[c.idx(e2)] = 30;

    // Remove the middle: swap-and-pop moves e2's row (30) into e1's dense slot.
    assert.equal(c.remove(e1), true);
    assert.equal(c.count, 2);
    // The moved payload must be visible through an independent view of the buffer.
    const view = new Float64Array(buf);
    assert.equal(view[c.idx(e2)], 30);
    assert.equal(c.data.v[c.idx(e0)], 10);
});

test('Arena: caller buffers > despawn cascades across caller-backed components', () => {
    const CAP = 3;
    const arena = new Arena(CAP);
    const a = arena.registerComponent({ x: Float32Array }, { buffers: { x: bufFor(Float32Array, CAP) } });
    const b = arena.registerComponent({ y: Int32Array }, { buffers: { y: bufFor(Int32Array, CAP) } });
    const e = arena.spawn();
    a.add(e); b.add(e);
    assert.equal(a.count, 1);
    assert.equal(b.count, 1);
    assert.equal(arena.despawn(e), true);
    assert.equal(a.count, 0);
    assert.equal(b.count, 0);
});

test('Arena: caller buffers > multi-field component requires a buffer for EVERY field', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    // Two fields supplied: fine.
    assert.doesNotThrow(() => arena.registerComponent(
        { x: Float32Array, y: Float32Array },
        { buffers: { x: bufFor(Float32Array, CAP), y: bufFor(Float32Array, CAP) } }));
    // One field missing: a partial caller-backing is refused, naming the field.
    assert.throws(() => arena.registerComponent(
        { x: Float32Array, y: Float32Array },
        { buffers: { x: bufFor(Float32Array, CAP) } }), /"y"/);
});

test('Arena: caller buffers > a null or undefined buffer for a declared field throws (no silent own-alloc)', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    assert.throws(() => arena.registerComponent(
        { x: Float32Array }, { buffers: { x: null } }), /missing a buffer for component field "x"/);
    assert.throws(() => arena.registerComponent(
        { x: Float32Array }, { buffers: { x: undefined } }), /missing a buffer for component field "x"/);
});

test('Arena: caller buffers > an undersized or oversized buffer throws naming the byte lengths', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    const exact = CAP * Float32Array.BYTES_PER_ELEMENT; // 16
    assert.throws(() => arena.registerComponent(
        { x: Float32Array }, { buffers: { x: new ArrayBuffer(exact - 4) } }),
        /wrong byteLength.*expected 16.*got 12/s);
    assert.throws(() => arena.registerComponent(
        { x: Float32Array }, { buffers: { x: new ArrayBuffer(exact + 4) } }),
        /wrong byteLength.*expected 16.*got 20/s);
});

test('Arena: caller buffers > a wrong-type buffer (number, or a TypedArray not its buffer) throws', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    assert.throws(() => arena.registerComponent(
        { x: Float32Array }, { buffers: { x: 123 } }), /must be an ArrayBuffer or SharedArrayBuffer/);
    // A TypedArray is a common mistake -- pass `.buffer`, not the view itself.
    assert.throws(() => arena.registerComponent(
        { x: Float32Array }, { buffers: { x: new Float32Array(CAP) } }),
        /must be an ArrayBuffer or SharedArrayBuffer/);
});

test('Arena: caller buffers > a buffer with no matching schema field throws (reverse direction)', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    assert.throws(() => arena.registerComponent(
        { x: Float32Array },
        { buffers: { x: bufFor(Float32Array, CAP), z: bufFor(Float32Array, CAP) } }),
        /supplies a buffer for "z", which is not a field/);
    // Empty schema (what registerTag builds) + any buffer is the same reverse error.
    assert.throws(() => arena.registerComponent(
        {}, { buffers: { x: bufFor(Float32Array, CAP) } }),
        /is not a field in the component schema/);
});

test('Arena: caller buffers > a non-object buffers option throws', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    assert.throws(() => arena.registerComponent(
        { x: Float32Array }, { buffers: 42 }), /buffers option must be an object/);
    // A top-level null buffers (as opposed to a per-field null) is a provided-
    // but-empty map: fail closed with the object-type message, not silent own-alloc.
    assert.throws(() => arena.registerComponent(
        { x: Float32Array }, { buffers: null }), /buffers option must be an object/);
});

test('Arena: caller buffers > reserve() refuses to grow an arena with any caller-backed component', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    arena.registerComponent({ x: Float32Array }); // own-allocated
    arena.registerComponent({ y: Float32Array }, { buffers: { y: bufFor(Float32Array, CAP) } });
    assert.throws(() => arena.reserve(CAP * 2),
        /reserve\(\) cannot grow.*caller-supplied buffers.*decisions\/0006/s);
    // The refusal must name the offending component (#1) and its field.
    assert.throws(() => arena.reserve(CAP * 2), /component #1.*fields: y/s);
});

test('Arena: caller buffers > reserve() still grows an own-allocated arena (regression guard)', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    arena.registerComponent({ x: Float32Array });
    assert.equal(arena.reserve(CAP * 2), true);
    assert.equal(arena.capacity, CAP * 2);
});

// -----------------------------------------------------------------
// Arena: transferable-ArrayBuffer round-trip (1.8.0 / S6)
//
// detach() -> postMessage(buf, [buf]) -> Worker transforms -> transfer back ->
// rebind(). Transferring a buffer DETACHES the sender's view (byteLength 0);
// rebind() re-adopts the returned buffer, fail-closed. isDetached() is the
// truthful, once-per-frame guard. Works with a PLAIN ArrayBuffer -- no
// SharedArrayBuffer, no cross-origin isolation -- so it runs inside a Twitch
// extension iframe. See decisions/0007 and the Worker test in test/transfer.test.js.
//
// Fail-before/pass-after note: on 1.7.0 there was no rebind()/detach()/
// isDetached(), so the round-trip below could not close -- a transferred buffer
// left data.x permanently detached with no way back. It passes only because S6
// added the return half.
// -----------------------------------------------------------------

// Detach a component field's buffer in-thread, exactly as postMessage(transfer)
// would: returns a byte-copy the "worker" can transform, and leaves the original
// view detached (byteLength 0).
function transferOut(buffer) {
    return structuredClone(buffer, { transfer: [buffer] });
}

test('Arena: transfer > detach() returns the exact backing buffer, and transferring it detaches the view', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    const Pos = arena.registerComponent({ x: Float32Array });
    const bufs = Pos.detach(['x']);
    assert.equal(bufs.length, 1);
    assert.equal(bufs[0], Pos.data.x.buffer);   // the real backing store, not a copy
    assert.equal(Pos.isDetached('x'), false);
    transferOut(bufs[0]);                        // simulate the postMessage transfer
    assert.equal(Pos.isDetached('x'), true);
    assert.equal(Pos.data.x.byteLength, 0);
});

test('Arena: transfer > detach() with no argument returns every field buffer, in schema order', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    const Pos = arena.registerComponent({ x: Float32Array, y: Float64Array });
    const bufs = Pos.detach();
    assert.deepEqual(bufs, [Pos.data.x.buffer, Pos.data.y.buffer]);
});

test('Arena: transfer > a full round-trip on an own-allocated component (transfer out, transform, rebind)', () => {
    const CAP = 8;
    const arena = new Arena(CAP);
    const Pos = arena.registerComponent({ x: Float32Array });   // own-allocated
    const handles = [];
    for (let i = 0; i < CAP; i++) {
        const h = arena.spawn(); Pos.add(h);
        Pos.data.x[Pos.idx(h)] = (i + 1) * 1.5;
        handles.push(h);
    }
    const n = Pos.count;
    const [xbuf] = Pos.detach(['x']);
    const clone = transferOut(xbuf);            // Pos.data.x now detached
    assert.equal(Pos.isDetached('x'), true);
    // "Worker" transforms the transferred buffer in place.
    const w = new Float32Array(clone);
    for (let i = 0; i < n; i++) w[i] *= 2;
    // Return: re-adopt. An own-allocated component becomes caller-backed on rebind.
    Pos.rebind({ x: clone });
    assert.equal(Pos.isDetached('x'), false);
    for (let i = 0; i < n; i++) assert.equal(Pos.data.x[i], (i + 1) * 1.5 * 2);
    assert.equal(Pos._callerBacked, true);
});

test('Arena: transfer > partial rebind re-points only the named field; others untouched', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    const Pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
    for (let i = 0; i < CAP; i++) { const h = arena.spawn(); Pos.add(h); Pos.data.x[i] = i; Pos.data.y[i] = i * 10; }
    const yViewBefore = Pos.data.y;
    const [xbuf] = Pos.detach(['x']);
    const clone = transferOut(xbuf);
    assert.equal(Pos.isDetached('x'), true);
    assert.equal(Pos.isDetached('y'), false);   // y never left
    Pos.rebind({ x: clone });
    assert.equal(Pos.data.y, yViewBefore);       // same view object -- untouched
    for (let i = 0; i < CAP; i++) assert.equal(Pos.data.y[i], i * 10);
});

test('Arena: transfer > isDetached() throws on a field not in the schema', () => {
    const arena = new Arena(4);
    const Pos = arena.registerComponent({ x: Float32Array });
    assert.throws(() => Pos.isDetached('nope'), /not a field in this component schema/);
});

test('Arena: transfer > detach() throws on a non-array argument and on an unknown field', () => {
    const arena = new Arena(4);
    const Pos = arena.registerComponent({ x: Float32Array });
    assert.throws(() => Pos.detach('x'), /expects an array of field names/);
    assert.throws(() => Pos.detach(['zzz']), /field "zzz", which is not a field/);
});

test('Arena: transfer > rebind() fails closed on a non-object or empty map', () => {
    const arena = new Arena(4);
    const Pos = arena.registerComponent({ x: Float32Array });
    assert.throws(() => Pos.rebind(null), /rebind\(\) requires an object/);
    assert.throws(() => Pos.rebind(42), /rebind\(\) requires an object/);
    assert.throws(() => Pos.rebind({}), /empty buffers map/);
});

test('Arena: transfer > rebind() fails closed on an unknown key (reverse direction)', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    const Pos = arena.registerComponent({ x: Float32Array });
    assert.throws(() => Pos.rebind({ z: new ArrayBuffer(CAP * 4) }),
        /buffer for "z", which is not a field/);
});

test('Arena: transfer > rebind() fails closed on wrong type and wrong size, naming byte lengths', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    const Pos = arena.registerComponent({ x: Float32Array });
    assert.throws(() => Pos.rebind({ x: 123 }), /must be an ArrayBuffer or SharedArrayBuffer/);
    // A TypedArray is not its buffer -- reject it (a common caller mistake).
    assert.throws(() => Pos.rebind({ x: new Float32Array(CAP) }), /must be an ArrayBuffer or SharedArrayBuffer/);
    assert.throws(() => Pos.rebind({ x: new ArrayBuffer(CAP * 4 - 4) }),
        /wrong byteLength: expected 16 .* got 12/s);
    assert.throws(() => Pos.rebind({ x: new ArrayBuffer(CAP * 4 + 4) }),
        /wrong byteLength: expected 16 .* got 20/s);
});

test('Arena: transfer > rebind() is atomic: a bad buffer in a multi-field rebind re-points nothing', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    const Pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
    const xView = Pos.data.x, yView = Pos.data.y;
    // x is valid, y is the wrong size -- the whole call must throw and touch neither.
    assert.throws(() => Pos.rebind({ x: new ArrayBuffer(CAP * 4), y: new ArrayBuffer(4) }),
        /field "y" has the wrong byteLength/);
    assert.equal(Pos.data.x, xView);
    assert.equal(Pos.data.y, yView);
    assert.equal(Pos._callerBacked, undefined);  // no partial state, not marked
});

test('Arena: transfer > reserve() refuses an arena with a DETACHED field (own-allocated, transferred out)', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    arena.registerComponent({ x: Float32Array });                 // #0 own-allocated
    const Pos = arena.registerComponent({ y: Float32Array });     // #1 own-allocated
    const [ybuf] = Pos.detach(['y']);
    transferOut(ybuf);                                            // Pos.data.y detached
    assert.equal(Pos.isDetached('y'), true);
    assert.throws(() => arena.reserve(CAP * 2),
        /component #1 has a detached field "y".*decisions\/0007/s);
});

test('Arena: transfer > after rebind the set is caller-backed, so reserve() refuses it', () => {
    const CAP = 4;
    const arena = new Arena(CAP);
    const Pos = arena.registerComponent({ x: Float32Array });     // own-allocated
    const [xbuf] = Pos.detach(['x']);
    const clone = transferOut(xbuf);
    Pos.rebind({ x: clone });                                    // now caller-backed
    assert.throws(() => arena.reserve(CAP * 2),
        /caller-supplied buffers.*decisions\/0006/s);
});
