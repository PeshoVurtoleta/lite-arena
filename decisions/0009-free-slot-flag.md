# 0009 - A FREE flag in `generations`: a free slot's next handle is not alive

Status: accepted
Date: 2026-10-27
Ships in: v1.10.0 (unreleased)
Supersedes: nothing. Amends 0001 (rollover) and 0004 section 3 (`clear()`).

## Context

`isAlive(h)` is one compare: the handle's generation against
`generations[index]`. A free slot stores the generation its NEXT spawn will
issue, so the next handle for every free slot compared equal and was accepted:

- fresh `Arena(4)`: `isAlive((1 << 20) | 0)` was `true` with `activeCount` 0;
- `registerTag().add()` on that handle succeeded, and `spawn()` then returned
  exactly that handle, already tagged;
- `despawn()` of it returned `true`, drove `activeCount` to -1 and inserted the
  slot into the free list a second time (fresh `Arena(4)`: `despawn(1048576)`
  -> `true`, `activeCount` -1, `remainingCapacity()` 5).

The same held for despawned, cleared and reserved slots.

## Decision

Free slots store `gen | FREE`, where `FREE = (GEN_MASK + 1) << 1` (0x2000, bit
13), kept apart from the retirement poison `GEN_MASK + 1` (0x1000). A stored
value with FREE set never equals a minted generation, so `isAlive` needs no
change and is byte-identical (source and bytecode).

- `spawn()` strips the flag with XOR and stores the generation back; it still
  does ONE `generations` load. A free slot always has FREE set; if that ever
  broke, XOR would SET the flag and the handle would be dead (fail closed),
  never generation 0. `& GEN_MASK` was rejected: it can store 0.
- `despawn()` sets FREE in the relink bump: `(g + 1) | FREE`. The retire branch
  and poison are unchanged; a retired slot never carries FREE.
- The constructor and `reserve()` fill `1 | FREE`.
- `clear()` maps `(((g & ~FREE) % GEN_MASK) + 1) | FREE`: the 4094-per-slot
  refill of 0001's erratum is preserved.
- The generation sequence is unchanged, so retirement timing and the budget
  gate (`test/budget.test.js`) are identical.

## The literal in hot bodies

`spawn` and `despawn` use the literal `0x2000`, not the module const. Reading a
module-level `const` from a function costs a 2-byte TDZ hole check. Measured on
Node 26.8.2 with `--print-bytecode`: spawn 81 -> 93 B and despawn 177 -> 183 B
with the literal; 95 / 185 B when the const is read by name. The const is kept
for the cold paths (constructor, `reserve`, `clear`).

## Consequences

- Fixed: a free slot's next handle is not alive; `add()` on it returns -1;
  `despawn()` of it returns `false` and changes nothing (fresh `Arena(4)`:
  `activeCount` 0, `remainingCapacity()` 4); no double free-list insert.
- Behaviour change for persisted handles: a handle saved from another run and
  replayed into a FRESH or just-`clear()`ed arena was accepted before (it equalled
  the free slot's next generation) and now fails closed. Handles are NOT unique
  across arenas; do not carry them between arenas.
- Gates: `test/free-slot.test.js` (T1-T7 census `aliveCount === activeCount`,
  P1 generation-stream parity vs goldens cut from the pre-fix build);
  `test/torture.mjs` Phase F census and Phase J "lifecycle churn zero-major"
  (200,000 spawn/add/despawn on `Arena(4096)`), control `ARENA_TORTURE_SLEAK=1`.

## Rules for a variable generation split (a later change, "C")

- `FREE = poison << 1`; `(GEN_MASK | FREE)` must stay below 2^30 so stored
  values remain Smi (generation bits <= 28).
- `spawn` strips FREE explicitly; never rely on `<<` overflow (that only works
  when generation bits + index bits = 32).
- `clear()` strips FREE before the `%`.
- A per-instance `GEN_MASK` means a per-instance FREE, which is one more load in
  `spawn`; that change's A/B must count it.
- Handles are not unique across arenas.

## Amendments

- 2026-10-27: torture Phase J renamed "lifecycle churn zero-GC"; it
now also gates maxMinor: 0 (remove() allocates nothing after warm-up for <= 4
TypedArray kinds, M-19; despawn() inherits it through remove(); above 4 kinds a
Float32/Float64 swap boxes a HeapNumber, 16 B on Node, 12 B pointer-compressed,
NOMINAL; Uint32 >= 2^31 boxes too -- below 2^31 vs at >= 2^31: 0 vs 7-8
scavenges per 500,000 swapping removes (REPORTED, 2026-10-27, darwin 12 cores,
Node 26.8.2, 6 kinds warmed, 1 MiB semi-space; 11 runs: 7 in 9 runs at load1
4.5-6.8, 8 in 2 runs at load1 1.56; scavenge counts, not timings)) and
reports, not gates, its pause.
