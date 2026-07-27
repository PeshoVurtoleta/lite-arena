# lite-arena roadmap — six BRIEF sessions

One package, six versions, six passes through planner -> coder -> reviewer -> qa.
Each session is a complete `BRIEF.md` you drop into the package and run. They are
ordered so each one leaves the package ready for the next.

Ground rules that hold across every session (from the README + your law):

- `idx()` is UNSAFE by design. Never make it safe. That is the hot path.
- The hard `maxEntities` cap is the moat. Auto-grow is forbidden except as the
  explicit opt-in escape hatch in Session 4.
- Iterate `dense[0..count)` only. Never read `[count, capacity)` — stale tail.
- No `forEach`/iterator API. Iterators allocate. `for (let i...)` against
  `comp.data.field`, always.
- Generational counter is 12 bits = 4096 cycles. That number is a decision, not
  an accident. Session 2 owns it.

Run each: author the brief in the package (or vault), then
`Use the planner subagent on BRIEF.md`, then coder/reviewer/qa, then `/release`.

===============================================================================
# SESSION 0 — BRIEF.md — v1.0.1 — de-vitest
===============================================================================

```markdown
---
package: lite-arena
version_target: 1.0.2
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
---

# lite-arena — port test suite to node:test

PURPOSE
  The README says `npm test` runs 41 assertions under vitest. vitest is a
  runtime/dev dependency. Suite law is node:test only, zero deps. Remove vitest
  entirely and port every assertion to node:test with no loss of coverage.

WHY THIS FIRST
  A shipped package that violates the zero-dep + node:test law is broken before
  any feature is added. This is also the smallest possible clean pipeline loop:
  a mechanical, fully-verifiable port. Learn the handoff here, on low stakes.

TASKS
  - Rewrite Arena.test.js using node:test (`import { test } from 'node:test'`,
    `import assert from 'node:assert/strict'`). Keep all 41 assertions and all
    nine test groups named in the README.
  - Remove vitest from package.json devDependencies and any vitest config.
  - Update the `test` script to `node --test`. Keep `test:watch` via
    `node --test --watch`.
  - Preserve the `--expose-gc` zero-allocation test (100k spawn/despawn under 1MB).

ASSERTIONS
  - `node --test` runs and prints 41+ passing, 0 failing.
  - `grep -ri vitest .` (excluding node_modules) returns nothing.
  - package.json has zero dependencies and zero devDependencies, or devDeps is absent.
  - The zero-alloc test still runs under `--expose-gc` and still asserts < 1MB.

HOT PATH
  None changed. Tests only. Arena.js is not touched this session.

NON-GOALS
  No new features. No API change. No behavior change. Port only.

DONE WHEN
  npm test green under node:test
  no vitest anywhere in the repo
  npm pack --dry-run excludes test/ and demo/ and bench/
```

===============================================================================
# SESSION 1 — BRIEF.md — v1.1.0 — the torture gate
===============================================================================

```markdown
---
package: lite-arena
version_target: 1.1.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak >= 1.1.0", "@zakkster/lite-signal >= 1.5.0"]
---

# lite-arena — standalone torture.mjs that prints "ok"

PURPOSE
  There is no `test/torture.mjs` today. The suite DONE-WHEN requires
  `node --expose-gc test/torture.mjs` to print "ok". Build it, wired to the real
  Arena API, gating both the GC budget and retention.

WHY NOW
  Every later session's DONE-WHEN leans on this gate. Build it once, correctly,
  against the real API, and the rest of the roadmap can trust one command.

TASKS
  - Create test/torture.mjs (peer devDeps, not runtime deps).
  - Phase A retention: 4096 create/dispose cycles. spawn N entities, add 3
    components, despawn all, assert arena.activeCount returns to 0 and a
    lite-leak tracker.size() returns to 0. The tracked release must NOT close
    over the entity object — track by the raw 32-bit handle (a primitive).
  - Phase B budget: pre-spawn to capacity OUTSIDE the loop; run a HOT tick over
    dense[0..count) for >= 200k iterations doing typed-array reads/writes only;
    sample heap via lite-gc-profiler; await a settle tick before summary().
  - Gate: checkNoGc(summary, { maxMajor: 0, maxPauseMs: 4 }) AND activeCount===0
    AND tracker.size()===0. Print exactly "ok" on pass; non-zero exit on fail.

ASSERTIONS
  - Fresh clone: `node --expose-gc test/torture.mjs` prints "ok", exit 0.
  - A deliberately leaky variant (skip despawn) makes it exit non-zero — prove
    the gate can fail, so a pass means something.
  - summary() is read only after an awaited settle tick (no empty-window pass).
  - torture.mjs imports the real Arena.js entry, not a stub.

HOT PATH
  Phase B tick is the hot path: dense[0..count) typed-array access only. No
  idx() safety, no allocation, no property chains inside the loop.

NON-GOALS
  Not a benchmark (that is bench/). No API change to Arena.js.

DONE WHEN
  node --expose-gc test/torture.mjs prints "ok"
  the leaky control variant fails as expected
  npm test still green
```

===============================================================================
# SESSION 2 — BRIEF.md — v1.2.0 — generational rollover decision
===============================================================================

```markdown
---
package: lite-arena
version_target: 1.2.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
---

# lite-arena — harden the generational handle, decide the rollover

PURPOSE
  The 12-bit generation counter aliases a stale handle as valid after exactly
  4096 despawn cycles on one slot while an old handle survives. The README calls
  this unreachable for realistic workloads. Decide, on the record, whether to
  leave it, widen it, or detect it — then implement the decision.

WHY THIS IS A DECISION SESSION
  This is the session where you practise recording a tradeoff, not just coding
  one. Widening the counter costs handle bits. Detecting rollover costs a branch.
  Leaving it costs nothing but must be documented as a known, bounded edge. The
  planner's job is to lay out the three options with their exact bit/perf costs;
  YOUR job is to make the call and have it written to a decision record.

TASKS (contingent on the decision)
  - Write the decision to decisions/ (or README "Edge cases") BEFORE coding:
    which option, why, what it costs.
  - If LEAVE: add a torture assertion that documents the 4096 boundary as
    intended behavior (a handle from cycle 0 aliases at cycle 4096, and this is
    asserted, not accidental).
  - If WIDEN: move to a larger generation field, re-verify handle stays a 32-bit
    SMI, update the capacity cap math and Arena.d.ts, note the reduced max
    entities if any.
  - If DETECT: add a cold-path guard that flags rollover; must add ZERO bytes to
    isAlive()/idx() hot bodies (fail-closed cold path only).

ASSERTIONS
  - The chosen behavior at the 4096-cycle boundary is covered by an explicit,
    named test asserting the exact documented outcome.
  - isAlive() and idx() hot bodies are unchanged in instruction count if the
    decision is LEAVE or DETECT (diff the function bodies).
  - Handle remains a 32-bit SMI; synthesizing handle 0 is still rejected on a
    fresh arena.
  - torture + node:test green.

HOT PATH
  isAlive() and idx(). No new branch may enter either hot body. Any rollover
  logic lives in a cold path.

NON-GOALS
  Do not touch spawn/despawn asymptotics. Do not make idx() safe.

DONE WHEN
  decision recorded in a durable file
  boundary behavior asserted by name
  hot bodies unchanged (or bit-cost of WIDEN explicitly accepted in the record)
  node --expose-gc test/torture.mjs prints "ok"
```

===============================================================================
# SESSION 3 — BRIEF.md — v1.3.0 — tag components + rarest-first helper
===============================================================================

```markdown
---
package: lite-arena
version_target: 1.3.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
---

# lite-arena — first-class tag components and a rarest-first iteration helper

PURPOSE
  The README already supports zero-size tag components via an empty schema, and
  documents the "iterate the rarer component, has() the other" join pattern.
  Formalize both: a named tag() constructor and a cold-path helper that picks the
  smaller component to drive a two-component join — WITHOUT adding a query API or
  any per-iteration allocation.

WHY NOW
  This is the "add API without touching the hot loop" rep. The helper must return
  a plain count or drive a caller-supplied index callback; it must not allocate
  an iterator, a result array, or a closure per entity.

TASKS
  - arena.registerTag() -> a SparseSet with data === {} (thin wrapper over the
    empty-schema path; membership only). Document has()/dense/count usage.
  - A cold-path join helper: given two components, it reads the smaller count and
    exposes the driving component so the caller writes the tight loop themselves.
    No callback-per-entity that allocates. Prefer returning {driver, other} refs
    the caller loops over, over an each()-style API.
  - Update Arena.d.ts and llms.txt with both.

ASSERTIONS
  - registerTag() component has count/dense/has working; data is an empty object.
  - The join helper allocates zero bytes when invoked in a 200k-iteration loop
    (torture-measured), because it hands back references, not an iterator.
  - Driving the join always picks the component with the smaller count.
  - No arena.query() or comp.forEach() was added (grep proves absence).

HOT PATH
  The join loop the CALLER writes stays hot; the helper only hands back the
  driver reference and count. The helper itself is called once per system, cold.

NON-GOALS
  No query language. No callback iteration API. No archetypes.

DONE WHEN
  tag + join helper shipped, typed, documented in llms.txt
  zero-alloc proven for the join path under torture
  node --expose-gc test/torture.mjs prints "ok"
```

===============================================================================
# SESSION 4 — BRIEF.md — v1.4.0 — opt-in capacity escape hatch
===============================================================================

```markdown
---
package: lite-arena
version_target: 1.4.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
---

# lite-arena — reserve(): explicit, opt-in capacity growth

PURPOSE
  Auto-grow is forbidden — it would silently reallocate every data.x and
  invalidate every hoisted reference. But a caller who KNOWS they are between
  frames sometimes needs more room. Add an explicit `arena.reserve(newCap)` that
  grows the universe on the cold path, loudly, and only when the caller asks.

WHY THIS IS THE MOAT-GUARD REP
  The danger is an eager coder turning this into implicit growth. The whole
  session is about building a feature that MUST NOT leak into the hot path or
  trigger itself. The reviewer's job is to prove growth can never happen except
  by an explicit reserve() call.

TASKS
  - arena.reserve(newCapacity): if newCapacity <= capacity, no-op returning false.
    Else reallocate arena-level arrays and every registered component's dense +
    every data.* array, copying live contents, preserving all handles and dense
    indices. Return true.
  - spawn() at capacity STILL throws — it must never auto-call reserve().
  - After reserve(), previously hoisted `const x = comp.data.x` references are
    stale by design: document this loudly. reserve() is a between-frames call.
  - Update Arena.d.ts, llms.txt, README FAQ (amend the "why no auto-grow" answer
    to point at reserve() as the explicit alternative).

ASSERTIONS
  - reserve() to a larger cap preserves every live entity, every component
    membership, and every data value (oracle-checked).
  - spawn() at full capacity throws; it does not grow. Prove by test.
  - reserve() adds ZERO bytes to spawn/despawn/idx/isAlive hot bodies (diff).
  - A torture cycle that calls reserve() between phases still prints "ok"
    (reserve itself may allocate — it is cold — but the hot tick after it is
    still 0 major GC).

HOT PATH
  Unchanged. reserve() is cold, between-frames, caller-initiated only.

NON-GOALS
  No auto-grow. No shrink. No growth triggered by spawn(). No hot-path check.

DONE WHEN
  reserve() ships, growth is explicit-only, spawn-at-cap still throws
  hot bodies unchanged
  node --expose-gc test/torture.mjs prints "ok"
```

===============================================================================
# SESSION 5 — BRIEF.md — v2.0.0 — SharedArrayBuffer / Worker components
===============================================================================

```markdown
---
package: lite-arena
version_target: 2.0.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-worker >= 1.0.0"]
---

# lite-arena — SAB-backed components for cross-thread simulation (breaking)

PURPOSE
  The README scopes SharedArrayBuffer support as a v2 candidate: the current
  constructor owns its own ArrayBuffers, so Workers can't share component data.
  Allow components to be backed by caller-supplied SAB buffers so a simulation
  can run across threads. This changes the component construction contract ->
  major bump.

WHY THIS IS THE MAJOR
  It is the only roadmap item that breaks a public contract (component backing
  buffers), so it earns 2.0.0 and the full breaking-change release drill:
  adapter for old callers, migration note, three-place version sync, decision
  record. Same shape as the LiteAmbientFX v2 flow.

TASKS
  - registerComponent(schema, { buffers }) optional: when buffers are supplied,
    build the typed-array views over the caller's SAB instead of allocating.
    When omitted, behavior is identical to v1 (own ArrayBuffers).
  - Validate SAB sizes against capacity * BYTES_PER_ELEMENT; fail closed with a
    did-you-mean-sized message on mismatch. null/undefined buffer is an error,
    not a silent own-allocation fallback.
  - Document the cross-thread ownership model: which thread spawns/despawns
    (single writer), which read. Do NOT add locking — out of scope; document the
    single-writer requirement instead.
  - Adapter: v1 call sites (no options object) keep working unchanged.
  - Full release: CHANGELOG breaking section, llms.txt, VERSION const, README
    SAB section replacing the "out of scope for v1" note, decision record for the
    single-writer choice.

ASSERTIONS
  - registerComponent(schema) with no options is byte-for-byte behavior-identical
    to v1 (existing 41 tests unchanged and green).
  - registerComponent(schema, { buffers }) builds views over the supplied SAB;
    a second component/thread reading the same SAB sees writes.
  - Size mismatch between SAB and capacity throws with a clear message; a null
    buffer throws, never silently allocates.
  - Single-writer contract is documented; no lock/atomic added.
  - node --expose-gc test/torture.mjs prints "ok" for both own-buffer and
    SAB-backed component paths.

HOT PATH
  The tick loop is unchanged — a data.x is a Float32Array whether it views an own
  buffer or a SAB. No hot-path branch on backing type.

NON-GOALS
  No locking, no atomics, no multi-writer. No auto-threading. No renderer.

DONE WHEN
  v1 call sites unchanged and green; SAB path works cross-thread
  single-writer model documented; decision recorded
  three-place version sync 1.4.0 -> 2.0.0; /release 2.0.0 clean
  npm pack --dry-run excludes test/ demo/ bench/
```

===============================================================================

## How to run the roadmap

Do them in order. Each `status:` starts `planned`; set `shipped` after `/release`.
The frontmatter budget block is identical across all six on purpose — lite-arena's
whole identity is that the budget never moves. If a session tempts you to widen a
budget to pass, that is the session telling you the design is wrong, not the gate.

Sessions 0 and 1 are the cheap, mechanical reps — do both before you touch a
design decision, so your first pipeline loops are ones you can fully verify.
Session 2 is your first real judgement call. Session 5 is your first breaking
release. By the time you ship 2.0.0 you will have run the full pipeline six times
on one package and have the muscle memory to point it at the other 169.
```
