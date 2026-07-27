# Changelog

All notable changes to `@zakkster/lite-arena` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-07-27

An explicit, opt-in capacity escape hatch. The arena still never auto-grows --
`spawn()` at capacity throws exactly as before -- but a caller who KNOWS they are
between frames can now grow the universe loudly and on purpose.

### Added

- **`arena.reserve(newCapacity)`** -- the ONLY way the arena grows, and only
  when asked. Reallocates every backing buffer (the arena's `generations` /
  `freeList` and each component's `dense` + every `data.*`), copying live
  contents, so every handle, every component membership, and every dense index
  is preserved. Grow-only: `newCapacity <= capacity` is a defined no-op that
  returns `false`; a real grow returns `true`. Throws on a non-integer or a
  value above the 20-bit ceiling (`1048575`). Cold, between-frames path only.
- `reserve(newCapacity): boolean` in `Arena.d.ts`, with the stale-reference
  caveat documented in the type.
- Torture Phase D: fill to capacity, `reserve()` to grow between "frames" (a
  legitimate cold-path allocation), then run the hot tick over the grown arrays.
  Gated at `maxMajor: 0` -- proof that growth is a one-time cold cost and never
  leaks into the hot loop.
- Nine `reserve` tests: a grow oracle (live entities / memberships / SoA values
  all preserved), spawn-at-capacity-still-throws (no auto-grow), spawning into
  the freshly reserved region, free-list integrity across a grow, and an
  explicit check that hoisted `data.x` / `dense` refs point at the OLD buffer
  afterward (the documented footgun).

### Changed

- README FAQ "why no auto-grow" now points at `reserve()` as the explicit,
  between-frames alternative, with the re-hoist caveat and a code sample.
- `llms.txt` API surface and invariants document `reserve()` and the
  never-auto-grow guarantee.

### Notes

- Hot paths are untouched: `spawn()`, `despawn()`, `isAlive()`, and `idx()`
  bodies are byte-for-byte identical to 1.3.0. `reserve()` is a new cold method;
  nothing on any hot path reaches it, and `spawn()` never calls it.
- STALE REFERENCES BY DESIGN: after `reserve()` returns `true`, any typed-array
  reference hoisted before the call (`const x = comp.data.x`) points at the old,
  discarded buffer. Re-read it. This is exactly why growth is explicit and
  between-frames -- an implicit grow would invalidate such refs mid-frame.

## [1.3.0] - 2026-07-27

First-class tag components and a rarest-first join planner. Both formalize
patterns the README already recommended, WITHOUT adding a query API, a callback
iterator, or any per-iteration allocation. The hot loop stays the caller's.

### Added

- **`arena.registerTag()`** -- registers a zero-size tag component: a
  `SparseSet` whose `data` is an empty object, tracking membership only. Exactly
  `registerComponent({})` given a name so the intent reads at the call site. Use
  `add` / `has` / `remove` and iterate `dense[0..count)`; tags clear
  automatically on `despawn`.
- **`arena.join(a, b)`** -- a cold-path planner for a two-component join. Reads
  both counts and returns `{ driver, other, count }` with the smaller-count
  component as `driver`, so the caller iterates the rarer set and `has()`-checks
  the other. It is NOT a query API and does NOT iterate -- it hands back
  references so the caller writes the tight loop. It allocates nothing: the
  returned object is a scratch reused across calls, owned by the arena (consume
  it, or start your loop, before the next `join()` on the same arena).
- `JoinPlan` type in `Arena.d.ts`; `registerTag()` / `join()` fully typed.
- Torture Phase C: `arena.join()` called 200k times in a loop is gated at
  `maxMajor: 0` to prove the join path allocates zero bytes.
- Tag and join stress tests, plus a guard test asserting no `query()` /
  `forEach()` / `each()` API exists (NON-GOAL enforcement).

### Changed

- `demo/demo.html`: a ~3% subset of particles now carries a `registerTag()`
  marker, highlighted each frame via `arena.join()` (rarest-first). Also fixed
  the module import to point at `../Arena.js` (was `../Arena.d.ts`).

### Notes

- Hot paths are untouched: `isAlive()` and `idx()` bodies are byte-for-byte
  identical to 1.2.0. `join()` is called once per system (cold); the loop it
  enables is the caller's and stays allocation-free.

## [1.2.0] - 2026-07-27

Generational-rollover decision session. Full rationale and the rejected
alternatives (LEAVE, WIDEN) are recorded in
[`decisions/0001-generational-rollover.md`](decisions/0001-generational-rollover.md).

### Changed

- **Generational rollover is now fail-closed.** The 12-bit generation counter
  issues 4095 live generations per slot. Previously, the counter wrapped after
  4096 despawn cycles on a single slot and a stale handle from cycle 0 would
  alias as valid again -- a fail-**open** hole on the safe (`isAlive` / `has`)
  path. Now, on the despawn that would exhaust a slot's generations, the slot is
  **permanently retired**: poisoned to a generation one bit above the handle
  range and withdrawn from the free list, so it is never recycled and no handle
  can ever alias. The change lives entirely on the `despawn` **cold** path;
  `isAlive()` and `idx()` hot bodies are byte-for-byte unchanged, and the handle
  stays a 32-bit SMI with the same 20-bit index / 12-bit generation split (max
  1,048,575 entities is unchanged).

### Added

- `arena.retiredCount` (read-only): number of slots retired by generation
  exhaustion. `0` on any realistic workload; a non-zero value signals the
  adversarial-churn regime and bounded, documented capacity attrition.
- `decisions/0001-generational-rollover.md`: the decision record (context, the
  three options with exact bit/perf costs, the call, and the trade).
- Named boundary test
  `Arena: generational handles > retires a slot at generation exhaustion (no ABA alias)`
  asserting the exact documented outcome (slot retires, `retiredCount === 1`,
  no alias of the first handle, `spawn()` throws at exhaustion).

### Migration

- Behaviour change under adversarial churn only: a slot spawned/despawned 4095
  times now retires instead of aliasing. On such a slot, `spawn()` surfaces the
  withdrawal as the usual "out of memory" throw one cycle earlier than the old
  aliasing behaviour. Realistic workloads (entities living >= 1 frame) are
  unaffected -- retirement never fires, and the two behaviours are otherwise
  identical.

## [1.1.0] - 2026-07-27

### Added

- `test/torture.mjs` -- a standalone gate wired to the real `Arena.js` entry.
  `node --expose-gc test/torture.mjs` prints exactly `ok` (exit 0) on pass and
  exits non-zero on failure. It gates two independent properties:
  - **Retention (Phase A).** 4096 create/dispose cycles: spawn entities, attach
    three components, despawn all. A pass requires both `arena.activeCount` and
    an external `@zakkster/lite-leak` `tracker.size()` to return to 0. Each
    tracked resource is keyed by the raw 32-bit slot (a primitive) with a
    no-op release, so the FinalizationRegistry held value never pins its target.
  - **GC budget (Phase B).** Pre-spawn to capacity outside the loop, then run a
    hot tick over `dense[0..count)` (typed-array reads/writes only, no `idx()`
    safety, no allocation) for >= 200k iterations. The window is measured by
    `@zakkster/lite-gc-profiler` and gated with
    `checkNoGc(summary, { maxMajor: 0, maxPauseMs: 4 })`. The summary is read
    only after an awaited `settle()` tick, so the gate never passes on an empty
    observation window.
- Leaky control: `ARENA_TORTURE_LEAK=1 node --expose-gc test/torture.mjs` skips
  every despawn, leaving the retention oracles non-zero and forcing a non-zero
  exit -- proof that the gate can fail, so a pass means something.
- `@zakkster/lite-gc-profiler` and `@zakkster/lite-leak` as **devDependencies**.
  `Arena.js` keeps zero runtime dependencies.
- `npm run torture` script; `npm run verify` now also runs the torture gate.

### Changed

- `npm test` now scopes to `test/*.test.js` so the standalone torture gate,
  which requires `--expose-gc` and calls `process.exit`, is not swept into the
  default `node --test` discovery. Run it via `npm run torture`.

## [1.0.2]

- Initial published ECS: generational handles, SoA sparse sets, swap-and-pop,
  zero-allocation hot paths.
