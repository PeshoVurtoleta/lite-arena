# Changelog

All notable changes to `@zakkster/lite-arena` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.8.0] - 2026-07-29

Transferable-`ArrayBuffer` round-trip -- the cross-thread half of the S-track,
the piece that actually runs inside a Twitch Extension iframe. S5 (1.7.0) let a
component's payload live in a buffer you own; 1.8.0 closes the loop so you can
hand that buffer to a Worker with `postMessage(buf, [buf])`, let the Worker
transform it, and re-adopt it on return.

This SUPERSEDES the "shared iteration / v2.0.0" direction referenced in the
1.7.0 note. A Twitch Extension iframe cannot be cross-origin isolated, so
`SharedArrayBuffer` (and the seqlock shared-iteration design) is unavailable on
the flagship target; the platform's sanctioned zero-copy cross-thread path there
is the transferable `ArrayBuffer`. That path needs no cross-origin isolation, no
atomics, and no shared control block -- and, being opt-in and additive, it is a
minor: with no transfer the path is byte-for-byte 1.7.0, and the six hot methods
are proven unchanged by diff. SAB shared iteration remains a possible future item
for SAB-capable runtimes (Node `worker_threads`, Electron, COI'd same-origin
apps). See [decisions/0007](decisions/0007-transferable-roundtrip.md).

### Added

- `SparseSet.rebind(buffers)` -- re-point one or more `data[key]` views at
  caller-supplied buffers (the ones a Worker transferred back). A partial map;
  validated fail-closed in both directions (unknown key, wrong type, wrong size),
  and atomic: a bad buffer in a multi-field rebind re-points nothing. Marks the
  set caller-backed, so `reserve()` then refuses it.
- `SparseSet.detach(keys?)` -- collect the backing `ArrayBuffer`(s) for a
  `postMessage` transfer list (all fields if `keys` omitted). Validates the field
  names; does not itself detach.
- `SparseSet.isDetached(key)` -- truthful (`byteLength === 0`) detachment check,
  meant as a once-per-frame system guard, never per element.
- Cross-thread test (`test/transfer.test.js` + `test/transfer-worker.mjs`): a
  real `ArrayBuffer` transferred to a Worker, doubled, transferred back, and
  rebound -- twice, proving repeatable ping-pong. Plain `ArrayBuffer`, no SAB, no
  cross-origin isolation.
- Torture **Phase H**: the arena side of the hand-off (`detach` + `rebind`, same
  buffer) over many frames, gated `maxArrayBuffersGrowth:0` -- `rebind` is
  zero-copy (views the existing buffer, never reallocates). Its control is
  `ARENA_TORTURE_HLEAK=1` (a retained per-frame allocation that trips the gate).

### Changed

- `reserve()` now also refuses to grow an arena that has any component with a
  DETACHED field (buffer transferred away, not yet rebound), naming the component
  and field -- `_grow` would otherwise silently copy zero bytes. The existing
  caller-backed refusal (S5) is unchanged. Nothing else is breaking: the default,
  no-transfer path is byte-for-byte 1.7.0.

### Notes

- Non-goals (unchanged): no `SharedArrayBuffer`, no seqlock, no atomics, no
  shared iteration, no auto double-buffering. The arena provides
  `detach`/`rebind`; the caller owns the message plumbing.
- `VERSION` const deferred (see decisions/0007): it needs a docs-drift assertion
  tying it to `package.json` and `/release` taught a fourth sync place first.
- Unit suite: 111 cases (98 + 12 transfer unit + 1 cross-thread transfer; 2
  zero-alloc cases still need `--expose-gc`). Torture gate is now Phases A-H.

## [1.7.0] - 2026-07-28

Caller-supplied component payload buffers -- the first step of the S-track
(SharedArrayBuffer). A component's `data.*` can now VIEW buffers the caller
owns, so its payload can live in memory shared with a Worker. This release ships
ONLY the payload path: a Worker can read and write `data.*` over a range the
main thread hands it by message (the `postMessage` round trip is the fence). It
cannot iterate the set -- `count` and `dense` are not shared, that is S6
(v2.0.0). Additive and opt-in: with no `buffers` option the path is byte-for-byte
1.6.1, and the six hot methods are proven unchanged by diff.

### Added

- **`registerComponent(schema, { buffers })`.** Each `data[key]` views
  `buffers[key]` -- an `ArrayBuffer` or `SharedArrayBuffer` of exactly
  `capacity * BYTES_PER_ELEMENT` bytes -- instead of an allocated array. Both
  buffer types are accepted (the feature is "the caller owns the memory"; a
  plain `ArrayBuffer` makes the path testable without a Worker). Validated
  fail-closed in BOTH directions before any view is built: every declared field
  needs a correctly-typed, correctly-sized buffer, and no buffer may target a
  field the schema does not declare. A missing / null / undefined buffer for a
  declared field throws -- never a silent fall back to own-allocation, which
  would leave a component the caller thinks is shared quietly private. See
  [`decisions/0006`](decisions/0006-caller-supplied-buffers.md).
- **Cross-thread smoke test** (`test/cross-thread.test.js` + `sab-worker.mjs`):
  a `worker_threads` Worker registers a component over the same
  `SharedArrayBuffer`, reads what the main thread wrote, and writes back --
  proven visible on the main thread through the same view, postMessage-fenced,
  no atomics.
- **Torture Phase G**: the hot tick over own-allocated AND SAB-backed payload,
  each gated `maxMajor:0` / `maxPauseMs:4` / `maxArrayBuffersGrowth:0`
  (`measureOps` with `stabilize:'deep'`). Proves the caller-backed hot path
  allocates nothing -- not on the heap, not a single new backing buffer -- and is
  as quiet as own-allocation. Verified load-bearing: a per-op buffer allocation
  injected into the measured tick flips the gate to fail.

### Changed

- **`reserve()` now throws if any registered component is caller-backed** (option
  A, exclusive). The arena never resizes a buffer it does not own, and there is
  no synchronous way to tell a Worker its view detached. The throw names the
  offending component and its fields. Own-allocated arenas grow exactly as
  before. See [`decisions/0006`](decisions/0006-caller-supplied-buffers.md).

### Notes

- Non-goals, stated plainly and enforced by their absence: no shared
  `count`/`dense` (the Worker cannot iterate yet), no atomics, no multi-writer,
  no locking, no auto-threading. Those are S6.
- `Arena.js` changes are confined to cold paths: one new `validateBuffers`
  helper and three branches (`registerComponent`, the `SparseSet` ctor,
  `reserve`). `spawn` / `despawn` / `add` / `has` / `remove` / `idx` are
  byte-for-byte identical to 1.6.1 (verified by diff). Zero runtime deps.
- Unit suite: 98 cases (84 + 13 caller-buffer unit + 1 cross-thread; 2 zero-alloc
  cases still need `--expose-gc`). Torture gate is now Phases A-G, green at
  `maxMajor: 0`.

## [1.6.1] - 2026-07-28

Docs-reconciliation release (finishes finding AR-08). **No library logic
changed -- `Arena.js` is untouched.** The prose reconciliation shipped across
1.5.0 / 1.6.0; this release adds the guard that keeps the docs from drifting
again, and re-measures the benchmarks on current hardware.

### Added

- **Docs-drift guard test** (`test/docs-drift.test.js`). Fails CI when the docs
  and the code disagree, all checked against the shipped prototype surface (no
  allowlist to maintain): every public `Arena` / `SparseSet` method must be
  documented as a call in `llms.txt`; every method call shown in an `llms.txt`
  code block must be a real public method (no hallucinated signature for a
  sibling package to copy); every relative link in README and `llms.txt` must
  resolve to a repo file. Passes green today -- it ships as a ratchet against the
  next drift, not a fix. See
  [`decisions/0005`](decisions/0005-docs-drift-guard.md).

### Changed

- **Benchmark numbers re-measured and stamped.** The README headline block now
  carries fresh figures from a stated machine + Node + package version (median
  of 7 `npm run bench` trials), and the takeaway is corrected to what the numbers
  actually show on current hardware: iteration is the win (matches a hand-rolled
  SoA, ~1.9x over `Array<Object>`, ~2.7x over `Map`); one-shot removal is
  competitive rather than a 2-3x win (a fast native `Map` delete edges it on this
  engine); spawn/despawn churn is mid-pack by design. `llms.txt`'s headline table
  and the 50k-particle case study are marked illustrative and machine-stamped.

### Notes

- No behaviour change and no `Arena.js` diff -- a docs + test release. Unit suite:
  84 cases (81 + 3 drift-guard; 2 zero-alloc cases still need `--expose-gc`).
  Torture gate (Phases A-F) remains green at `maxMajor: 0`.
- Completes the lite-arena R-track (R1-R4). Findings AR-06 and AR-08 are both
  closed; the drift guard now enforces AR-08 going forward.

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
