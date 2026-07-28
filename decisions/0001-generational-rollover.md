# 0001 - Generational rollover is fail-closed (slot retirement)

Status: accepted
Date: 2026-07-27
Ships in: v1.2.0
Record note: the decision was made and shipped in v1.2.0; this file was written
later (2026-07-28) to close finding AR-06, which flagged that `Arena.js`, a test
comment, `llms.txt`, `README.md` and the CHANGELOG all cite this record while the
file itself was absent from the tree. A decision record referenced by the code
but missing from the repo is worse than an undocumented decision.

## Context

An entity handle is a 32-bit SMI split `(gen << 20) | index`:

- 20-bit index -- `INDEX_MASK = 0xFFFFF`, max 1,048,575 concurrent slots.
- 12-bit generation -- `GEN_MASK = 0xFFF`. Generation `0` is reserved as "never
  alive" (so a synthesized handle `0` is always rejected), leaving live
  generations `1..4095` -- exactly **4095 generations per slot**.

The generation is the entire ABA defence: `spawn()` mints a handle at the slot's
current generation, `despawn()` bumps it, and `isAlive()` / `has()` accept a
handle only while `generations[index]` still equals the handle's generation. A
stale handle to a recycled slot is rejected because the slot's generation has
moved on.

That defence has a horizon. A single slot cycled spawn/despawn 4095 times walks
its generation `1 -> 2 -> ... -> 4095`. The next despawn is the problem: bumping
`4095` rolls the 12-bit field back toward the low generations, and a stale handle
minted 4095 cycles earlier -- at, say, generation 1 -- **aliases as valid
again**. This is a fail-**open** hole on the SAFE path: `isAlive()` / `has()`
return `true` for a handle that should be dead. It is the precise failure the
generational scheme exists to prevent, resurfacing at the counter's wrap point.

Not purely theoretical: the free list is LIFO, so a steady spawn/despawn workload
hammers a small set of hot slots, and a slot recycled once per frame at 60 fps
reaches the wrap in ~68 seconds. Rare, but silent and on the safe path -- the
worst combination.

## Options considered

### LEAVE -- let the counter wrap (the pre-1.2.0 behaviour)

- **Bit cost:** 0. **Perf cost:** 0.
- **Effect:** does not fix anything. The wrap still aliases a stale handle as
  valid on `isAlive` / `has`. It trades nothing for a silent correctness hole in
  the one guarantee the handle exists to provide.
- Rejected: a fail-open hole on the safe path is disqualifying, at any price.

### WIDEN -- give the generation more bits

- **Within 32 bits:** steal bits from the index. E.g. a 16/16 split gives 65,535
  generations per slot but drops max entities from 1,048,575 to **65,535** -- a
  permanent 16x capacity cut paid by every user, forever, to push an adversarial
  edge further out. And it only *moves* the wrap; it never removes it.
- **Beyond 32 bits** (a wider handle, a BigInt, or a two-field id): the handle
  stops being a 32-bit SMI, so it boxes as a heap double and **`spawn()`
  allocates** -- breaking the zero-GC identity of the package. (Same trap the R1
  `>>> 0` fix was rejected for; see 0002.)
- **Bit cost:** either fewer index bits or a non-SMI handle. **Perf cost:** zero
  on the hot path for the within-32 variant; an allocation per spawn for the
  wider variant.
- Rejected: WIDEN either taxes every user's capacity or breaks zero-alloc, and in
  neither case *closes* the hole -- it relocates it.

### RETIRE -- withdraw the slot on its last generation (chosen)

- **Bit cost:** 0 -- the handle layout is untouched (20/12, still an SMI, max
  1,048,575). **Perf cost:** 0 on any hot path. Retirement is one extra
  comparison and branch on the `despawn` **cold** path; `isAlive()` and `idx()`
  bodies are byte-for-byte unchanged.
- **Effect:** on the despawn that returns a slot at its last live generation
  (`generations[index] === GEN_MASK`, i.e. 4095), the slot is **permanently
  retired**: its generation is poisoned to `GEN_MASK + 1` (4096, one bit above
  the 12-bit handle range, so `(entity >>> 20) & GEN_MASK` can never equal it and
  every handle to the slot is rejected, gen-0 included), and it is **not** relinked
  into the free list, so `spawn()` can never hand it out again. `arena.retiredCount`
  counts retirements.

## Decision

**RETIRE.** Fail closed. When a slot exhausts its 4095 live generations, take the
slot out of service rather than let its counter wrap and alias.

## The trade

The cost of RETIRE is **bounded, documented capacity attrition**: one slot lost
per slot that completes 4095 spawn/despawn cycles. For any realistic workload --
entities that live at least one frame, slots that cycle tens or hundreds of times
at most -- retirement never fires and `retiredCount` stays `0`. Under adversarial
churn (a single slot recycled 4095 times) the arena loses that slot's capacity,
and a later `spawn()` surfaces the withdrawal as the library's normal
"out of memory" throw -- one cycle earlier than the old aliasing behaviour, and
observable in advance via `retiredCount`.

We are trading a capacity edge that only bites pathological churn for the removal
of a silent correctness hole (a resurrected stale handle) that could bite anyone
holding a long-lived handle. That is the right trade for a library whose whole
job is to make stale handles safe.

## Consequences

- New read-only `arena.retiredCount`: `0` on realistic workloads; a non-zero
  value signals the adversarial-churn regime and bounded, documented attrition.
- Behaviour change under adversarial churn only. A slot cycled 4095 times now
  retires instead of aliasing; `spawn()` on it throws one cycle earlier. Workloads
  where entities live >= 1 frame are unaffected -- retirement never fires and the
  two behaviours are otherwise identical.
- Hot paths unchanged: `isAlive()` and `idx()` are byte-for-byte identical; the
  handle stays a 32-bit SMI with the same 20-bit index / 12-bit generation split.
- Related: the generation field's sign behaviour (a handle goes negative at
  generation 2048) is a separate concern, resolved in decision 0002 by making the
  `dense` container `Int32Array`. This decision (retirement) and that one
  (signedness) are independent and compose: a retired slot is simply never spawned
  again, so no handle at the poison generation is ever minted.
