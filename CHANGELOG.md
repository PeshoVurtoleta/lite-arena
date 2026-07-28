# Changelog

All notable changes to `@zakkster/lite-arena` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] - 2026-07-28

Retirement observability and `clear()`. A shrinking arena can now say so:
`remainingCapacity()` reports the free count, `spawn()`'s exhaustion throw names
whether the arena is full or has retired slots, and `clear()` resets the arena in
place without reallocating. An optional checked mode makes two silent misuses
loud. All hot paths are untouched.

### Added

- **`remainingCapacity()`** (AR-05). O(1); returns
  `capacity - activeCount - retiredCount` -- the number of further entities that
  can be spawned right now. Equals the free-list length, so
  `activeCount + retiredCount + remainingCapacity() === capacity` holds after
  every operation. It falls below `capacity - activeCount` once slots retire,
  which is exactly the signal a phantom-leak hunt would otherwise miss.
- **`clear()`** (AR-05). Resets the arena to empty WITHOUT reallocating --
  rebuilds the free list, advances every generation, revives every retired slot,
  and drops each component's `count` to 0. O(capacity); allocates nothing. Every
  handle minted before `clear()` is invalid afterward (the honest contract of a
  reset); reviving retired slots restores full capacity and returns `retiredCount`
  to 0. Handle policy decided in
  [`decisions/0004`](decisions/0004-retirement-observability-and-clear.md).
- **Checked mode** -- `new Arena(n, { checked: true })` (AR-09, AR-11). OFF by
  default and zero-cost in production. When on: `join()` returns a plan that
  throws if read after a later `join()` superseded it (AR-09), and `idx()` throws
  on an entity that is dead or does not hold the component (AR-11). The checked
  `idx` is installed as an OWN property shadowing the prototype method, so the
  production `idx()` fast path is byte-for-byte untouched -- this closes the AR-11
  that 1.5.0 deferred, without the fast-path tax that forced the deferral.
- Torture **Phase F** (retirement soak): retires every slot of a small arena and
  then `clear()`s it, asserting the conservation law and `remainingCapacity()`
  exactness after every operation, that the exhaustion throw names retirement,
  and that `clear()` revives every retired slot. Self-controlling.
- Twelve tests covering `remainingCapacity()` exactness, both exhaustion
  messages, `clear()` semantics (pre-clear handles rejected, counts reset,
  buffers reused), the rejected `onRetire`, and checked-mode `join` / `idx`.
- Benchmark **Workload 4 (reset & refill)**: `clear()` reuse vs. a fresh
  `new Arena()` vs. `Map.clear()` vs. `Array.length = 0`. `clear()` resets in
  place allocation-free, several times faster than reallocating a fresh arena.

### Changed

- **`spawn()`'s exhaustion message now names the cause** (AR-05). It reports
  `capacity`, `activeCount`, and `retiredCount` inline, and when slots have
  retired it says so and points at `decisions/0001` rather than throwing a bare
  `"out of memory"` while `activeCount === 0`. The string still contains
  `"out of memory"`, so existing `/out of memory/` matchers are unaffected. Built
  in a cold `_exhausted()` helper; spawn()'s allocation path is unchanged.
- `Arena.d.ts`: the constructor gains the optional `{ checked?: boolean }`;
  `remainingCapacity()` and `clear()` are typed; `JoinPlan` and `idx()` document
  their checked-mode behavior.
- **README and `llms.txt` reconciled with the code** (AR-08, pulled forward from
  R4). Fixes a standing documentation error -- `SparseSet.dense` was still typed
  `Uint32Array` in the README though it has been `Int32Array` since 1.4.1 --
  documents `remainingCapacity()` / `clear()` / checked mode / schema validation,
  corrects the test count (41 -> 81) and the `verify` command, adds the
  `npm run torture` gate and the reset benchmark, and updates the "~190 lines"
  figure. The README method reference now matches the shipped surface.

### Notes

- **No `onRetire` callback** (rejected in writing; see
  [`decisions/0004`](decisions/0004-retirement-observability-and-clear.md)). A
  callback into user code from the despawn path is the wrong shape;
  `retiredCount` plus `remainingCapacity()` is the whole contract. Passing an
  `onRetire` option is silently inert.
- Hot paths unchanged: spawn's allocation path, `despawn`, `isAlive`, `add`,
  `has`, `remove`, and the prototype `idx()` are byte-for-byte identical (proven
  by diff). Phases A-F of the torture gate stay green at `maxMajor: 0`; `clear()`
  holds buffer identity across the reset.
- Docs reconciliation (AR-08) ships here rather than in a separate R4 pass, so
  the released README documents this version's surface and no longer carries the
  stale `dense` type or test counts.

## [1.5.0] - 2026-07-28

Schema validation and data hardening. A schema that lies about its field types
is now rejected at registration instead of silently voiding the zero-GC
guarantee. All validation is on the cold registration path; the hot loop is
untouched.

### Added

- **Schema validation in `registerComponent()` / `SparseSet`** (AR-03). Every
  field type must be one of the nine numeric TypedArray constructors
  (`Int8Array`, `Uint8Array`, `Uint8ClampedArray`, `Int16Array`, `Uint16Array`,
  `Int32Array`, `Uint32Array`, `Float32Array`, `Float64Array`). Anything else --
  `Array` (which used to produce a polymorphic, GC-visible sparse array),
  `Object` (a boxed `Number` that swallowed writes), `Function`,
  `SharedArrayBuffer`, `BigInt64Array` / `BigUint64Array` (numeric SoA is stored
  as `Number`, which a BigInt view rejects), a string, `null`, `undefined`, or a
  plain object -- throws a library error naming the offending key and describing
  what was passed. Runs once per component at startup; zero hot-path cost.
- **Owner + capacity validation on direct `SparseSet` construction** (AR-10).
  The constructor now requires an `Arena` owner and `maxEntities ===
  arena.capacity`; a mismatch throws instead of silently discarding out-of-range
  writes and leaking an unregistered (never-despawn-cleaned) set.
- Eight tests covering the nine accepted types, ten rejected types, the empty
  schema / `registerTag()` allowance, `__proto__` / symbol keys, `toString` /
  `constructor` field names, the null prototype, and rogue `SparseSet`
  construction. See
  [`decisions/0003-schema-validation.md`](decisions/0003-schema-validation.md).

### Changed

- **`comp.data` is now an `Object.create(null)` bag, not a plain `{}`** (AR-04).
  Consequences: `toString` / `constructor` are usable component field names
  (previously they collided with inherited `Object.prototype` members); a
  `__proto__` key in a schema literal now throws (previously it set the
  prototype and silently produced a component missing that field); symbol keys
  throw. Migration: code that read `data === {}` as literally-a-plain-object, or
  relied on `data.hasOwnProperty` / inherited `data.toString`, must adjust --
  `data` has no prototype. The docs' "`data === {}`" wording is corrected to "an
  empty null-prototype object" for tags.
- `Arena.d.ts`: `registerComponent` and the `SparseSet` constructor document the
  new `@throws`; `registerTag`'s `data === {}` note corrected.

### Notes

- Hot paths unchanged. `remove()`'s body is byte-for-byte identical; it iterates
  `data` with `for...in`, and `data`'s new null prototype only shortens that
  chain. Measured: ~36 ns/op (best) removing over a three-field component on a
  100k-entity arena. Phases A-E of the torture gate remain green at
  `maxMajor: 0`.
- AR-11 (a `checked: true` mode making `idx()` on an unattached entity throw) was
  considered and DEFERRED: any form of it adds a branch to the `idx()` fast path
  even when off. Recorded in decision 0003 as a separate future decision.

## [1.4.1] - 2026-07-28

A silent-corruption fix. Every `SparseSet` operation broke once a slot reached
generation 2048, on a package shipped to npm. If you run `@zakkster/lite-arena`
in a system that recycles entities steadily -- particles, bullets, anything with
per-frame churn -- upgrade.

### Fixed

- **Sign-bit corruption across half of every slot's generation range.** An
  entity handle is `(gen << 20) | index`, a SIGNED 32-bit int that goes NEGATIVE
  at generation 2048. `SparseSet.dense` was a `Uint32Array`, which stored the
  unsigned bit pattern while the caller held the negative handle, so the
  membership compare `dense[i] === entity` was ALWAYS false for `gen >= 2048`.
  Consequences, all silent: `has()` returned false for a live attached entity,
  `add()` appended a duplicate on every call, `remove()` could not detach, and
  `despawn()` returned `true` while its cascade removed nothing -- leaving the
  documented hot loop `dense[0..count)` full of dead and duplicated entities. A
  slot recycled once per frame at 60 fps hits generation 2048 in ~34 seconds,
  and the LIFO free list recycles hot slots first, so steady spawn/despawn
  workloads reach it routinely. The fix is one type: `dense` is now an
  `Int32Array` (in the constructor and in the `reserve()` grow path), so the
  stored and compared forms share signedness across the full range 1..4095. See
  [`decisions/0002-signed-handle-container.md`](decisions/0002-signed-handle-container.md),
  which also records why the `spawn()`-returns-`>>> 0` alternative was rejected
  (it boxes high handles as heap doubles, adding an allocation to the spawn
  path).
- **A false-confidence regression test.** The test named
  `high-generation handles work correctly even when their bit pattern is
  negative` asserted only `isAlive`/`despawn` on an arena with ZERO components
  registered, so the cascade was a no-op and it passed green while the entire
  SparseSet layer was broken. It now registers three components and exercises
  `add` (stable + idempotent), `has`, `idx`, `remove`, and the `despawn` cascade
  over a sign-bit-set handle. It fails against a `Uint32Array` `dense` and passes
  against `Int32Array`, with a comment forbidding a trim back to the old shape.
- **`package.json` metadata pointed at the wrong project.** `homepage`,
  `repository`, and `bugs` all resolved to `lite-scheduler`, so the npm page,
  `npm repo`, and `npm bugs` sent users -- and any filed issue -- to another
  package. All three now point at `lite-arena`.
- **Two dead demo links.** README (two spots) and `llms.txt` linked
  `example/demo.html`; the file lives at `demo/demo.html`. Corrected.

### Changed

- `SparseSet.dense` is a documented public member, and its TypeScript type in
  `Arena.d.ts` changes from `Uint32Array` to `Int32Array`. Migration: reading a
  handle out of `dense` and passing it straight back to the API is unaffected;
  do NOT copy `dense` into a `Uint32Array` view or apply `>>> 0` to a value read
  from it -- the handle is signed.

### Added

- Torture **Phase E (handle-space sweep)**: for generations bracketing the sign
  bit -- {1, 2047, 2048, 2049, 4094, 4095} -- drives a slot to that exact
  generation and asserts the full SparseSet contract (add stable/idempotent,
  has, idx, remove, count-to-zero, and a despawn cascade across three
  components), swept over many slot indices. It exits non-zero if `dense` is ever
  reverted to `Uint32Array`, so it is its own control. (Named E, not D: Phase D
  is the pre-existing 1.4.0 reserve gate; renaming it would falsify that entry.)

### Notes

- Hot paths are untouched. `Int32Array` and `Uint32Array` have identical
  load/store cost; the `spawn` / `despawn` / `isAlive` / `idx` bodies are
  otherwise byte-for-byte unchanged, and the Phase B iteration budget still
  passes at `maxMajor: 0`.

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
