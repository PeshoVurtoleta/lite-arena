# 0002 - The dense container must be Int32Array (signed handle corruption)

Status: accepted
Date: 2026-07-28
Finding: AR-01 (roadmap: lite-aabb + lite-bvh + lite-arena)
Ships in: v1.4.1

## Context

An entity handle is `(gen << 20) | index`: 20 bits of slot index, 12 bits of
generation. `<<` and `|` operate on SIGNED 32-bit integers, so the moment a
slot reaches generation 2048 the generation's top bit lands in bit 31 and the
handle is a NEGATIVE number. `spawn()` has always returned that signed value,
and this is correct and intentional -- the handle stays a 32-bit SMI, so it
never boxes and spawning never allocates.

The bug was in the container, not the handle. `SparseSet.dense` was a
`Uint32Array`. Storing a negative handle into a `Uint32Array` writes its
unsigned two's-complement bit pattern, while the handle the caller holds is
still the negative number. Every membership compare is `dense[i] === entity`:

    unsigned-stored (e.g. 2147483648)  ===  signed-handle (e.g. -2147483648)

which is ALWAYS false for gen >= 2048. Half of every slot's generation range
(2048..4095) was a silent corruption zone:

- `has(e)` -> false for a live, attached entity.
- `add(e)` -> loses idempotency; appends a duplicate on every call.
- `remove(e)` -> false; the entity can never be detached.
- `despawn(e)` -> returns true while its cascade removes nothing, so
  `dense[0..count)` -- the documented hot loop -- fills with dead and
  duplicated entities forever.

It was not theoretical: a slot recycled once per frame at 60 fps reaches
generation 2048 in ~34 seconds, and the LIFO free list hands the same hot slots
back first. Bullet-hell and particle systems -- the two workloads the README
leads with -- churn a small set of slots exactly this way. Shipped on npm at
v1.4.0.

## Decision

`SparseSet.dense` becomes an `Int32Array`, in both the constructor and the
`_grow()` reallocation used by `reserve()`. The stored form and the compared
form now share signedness, so `dense[i] === entity` round-trips across the whole
generation range 1..4095. Verified by the rewritten AR-02 regression test and by
torture Phase E, which drives slots to generations {1, 2047, 2048, 2049, 4094,
4095} and asserts the full SparseSet contract at each.

`sparse`, `generations` and `freeList` stay `Uint32Array`: they store slot
indices and generation counters, which are always non-negative. Only `dense`
holds whole handles, so only `dense` needs the signed type.

## Rejected alternative: `spawn()` returning `(... ) >>> 0`

The obvious-looking alternative is to make the handle unsigned at the source --
`return ((gen << 20) | index) >>> 0` -- so it matches a `Uint32Array` dense.
This is rejected.

`>>> 0` produces values up to 2^32 - 1. Everything above 2^31 - 1 is outside
V8's small-integer (SMI) range and is represented as a heap-allocated double.
That puts an allocation on the `spawn()` path -- in the one package whose entire
identity is that spawning does not allocate. It trades a correctness bug for a
zero-GC-guarantee bug, on the hottest creation path, to avoid changing one array
type. The signed handle is right; the container was wrong.

(Measurement: with the signed handle + `Int32Array`, spawning is pure SMI
arithmetic and typed-array stores, zero allocation -- the property Phase A/B
already gate. `>>> 0` would surface as heap growth in that same window.)

## Consequences

- `SparseSet.dense` is a documented public member; its TypeScript type changes
  from `Uint32Array` to `Int32Array`. Callers that read a handle out of `dense`
  and pass it straight back to the API are unaffected. Callers that copied
  `dense` into their own `Uint32Array` view, or applied `>>> 0` to a value read
  from it, must stop -- the handle is signed. Noted in the v1.4.1 CHANGELOG
  under Changed.
- `Int32Array` and `Uint32Array` have identical load/store cost; the hot
  iteration path is unchanged (asserted within noise against v1.3.0).
