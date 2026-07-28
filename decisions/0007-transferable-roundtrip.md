# 0007 - Transferable-ArrayBuffer round-trip (S6, additive)

Status: accepted
Date: 2026-07-29
Track: S6 (cross-thread)
Ships in: v1.8.0
Supersedes: the "shared iteration / v2.0.0" plan gestured at in the 1.7.0
CHANGELOG and the original S-track sketch.

## Context

S5 (1.7.0) let a component's payload VIEW a buffer the caller owns
(`registerComponent(schema, { buffers })`). The natural next step -- letting a
Worker do real work on that payload -- has two candidate shapes, and the choice
between them was forced by one hard platform fact.

## The platform fact that decided the design

**A Twitch Extension iframe cannot be cross-origin isolated** (confirmed
2026-07-29). `SharedArrayBuffer` requires cross-origin isolation
(`COOP: same-origin` + `COEP: require-corp`, `crossOriginIsolated === true`);
inside the extension iframe that state is unreachable, and multi-threaded
WebAssembly -- which also needs SAB -- crashes on init there for the same reason.

The package's flagship stated target is that iframe. So the SAB/seqlock "shared
iteration" design -- a shared control block published under a memory-ordering
model -- would have delivered ZERO value where the package is meant to ship. The
platform's own sanctioned cross-thread path without shared memory is
structured-clone `postMessage` or, for zero-copy, a **transferable
`ArrayBuffer`**. S6 follows that.

## The two decisions this record fixes

### 1. S6 is the transferable round-trip, NOT SAB shared iteration

Transfer detaches: `worker.postMessage(buf, [buf])` moves ownership and leaves
the sender's view detached (`byteLength === 0`). S5 already gave the send-side
half (a component can be backed by a caller `ArrayBuffer`); what was missing is
the RETURN half -- re-adopting the buffer the Worker transfers back. S6 adds
exactly that, as three cold methods:

- `rebind(buffers)` -- re-point one or more `data[key]` at returned buffers. A
  PARTIAL map: you rebind only the field(s) that came home (transfer is
  per-buffer, so a multi-field component detaches field by field). Validated
  fail-closed, reusing the S5 per-field checker (`validateBufferTypeAndSize`):
  unknown schema key, wrong type, or wrong `byteLength` throws, and NOTHING is
  re-pointed until every supplied buffer passes (no half-applied state). A
  garbage buffer returned by a Worker throws instead of silently corrupting the
  component. After a successful rebind the set is marked `_callerBacked`.
- `detach(keys)` -- collect the backing `ArrayBuffer`(s) for a transfer list.
  Sugar over `comp.data[key].buffer`, but it validates the field names. It does
  NOT itself detach: the caller's `postMessage` transfer does, and
  `isDetached()` reads the truth afterward.
- `isDetached(key)` -- TRUTHFUL, not bookkept: a transferred buffer detaches its
  view to zero length, so this returns `data[key].byteLength === 0` directly.
  No flag to fall out of sync with reality.

This is Twitch-iframe safe (plain `ArrayBuffer`, no COI, no atomics), and -- like
S5 -- additive: the default path is byte-for-byte 1.7.0, and the six hot methods
(`spawn`/`despawn`/`add`/`has`/`remove`/`idx`) are proven identical by diff. By
the package's own rule ("an optional options bag that leaves the default path
byte-identical is a minor, not a major") that makes S6 a **1.8.0**, not the
2.0.0 the SAB sketch assumed.

SAB/seqlock shared iteration is not deleted, only un-prioritized: it remains a
legitimate FUTURE item for Node `worker_threads` / Electron / COI-capable
same-origin apps, where it would earn its own version. It is simply not what the
flagship needs.

### 2. Fail-closed lives where it can without taxing the hot path

Raw `data[key][i]` reads are plain TypedArray indexing; they cannot be
intercepted without a wrapper that would violate the zero-cost-hot-path Law. So
"fail closed" is placed exactly where it costs nothing on the per-element path:

- `rebind()` validates every supplied buffer before re-pointing anything.
- `reserve()` (option A, held from S5) already refuses `_callerBacked`
  components; it now ALSO refuses any component with a detached field -- an
  own-allocated set that was transferred out is not `_callerBacked`, so this is a
  separate, truthful `byteLength === 0` check. `_grow`'s `newArr.set(detachedArr)`
  would otherwise silently copy zero bytes. Fail closed instead.
- `isDetached(key)` is the sanctioned ONCE-PER-FRAME system guard: a hot loop
  over a detached field is a caller bug, checked once at the top of the system,
  never per element. A detached read yields `NaN`/undefined -- visibly wrong,
  never a plausible `0`.

`reserve()` stays option A (exclusive). The epoch mechanism that would make
option C (epoch + re-hoist) cheap belongs to the SAB sync model that S6 dropped,
so there is nothing to build it against here; option A remains the smallest
honest contract.

## Rejected / deferred

- **SAB seqlock shared iteration** -- rejected as the S6 deliverable (flagship
  cannot run it); kept as a future item for SAB-capable runtimes.
- **`VERSION` const + four-place version sync** -- DEFERRED. The docs-drift guard
  checks documented methods and link resolution, not version strings, and
  `/release`'s sync logic is not visible here; an un-gated fourth sync place
  would let `Arena.js` drift silently after a release, the opposite of fail
  closed. It should ship WITH a docs-drift assertion tying the const to
  `package.json` (so it cannot drift) and `/release` taught the fourth place.
  Version-sync stays three-place for 1.8.0.
- **A managed detach() that mutates state / policed raw reads** -- rejected;
  detection via `byteLength` is truthful and free, and policing raw reads would
  tax the hot path.

## Consequences

- `Arena.js` gains three cold `SparseSet` methods (`rebind`/`detach`/
  `isDetached`), one extracted cold helper (`validateBufferTypeAndSize`, now
  shared with S5's `validateBuffers`), and one added branch in `reserve`. The six
  hot methods are byte-for-byte identical to 1.7.0 by diff.
- Tests: a unit suite covering both validation directions, partial rebind, the
  atomic (no half-applied) multi-field rebind, `isDetached`, `detach`, the
  `reserve()` detached refusal, and a full in-thread round-trip -- plus a
  `worker_threads` test that transfers a real `ArrayBuffer` to a Worker, doubles
  it, transfers it back, and rebinds, TWICE (proving repeatable ping-pong).
- Torture Phase H runs the arena side of the hand-off (`detach` + `rebind`,
  same buffer) for many frames, gated `maxArrayBuffersGrowth:0` (rebind is
  zero-copy -- it views the existing buffer, never reallocates). Control:
  `ARENA_TORTURE_HLEAK=1` injects a retained per-frame allocation that grows
  `arrayBuffers` and trips the gate, proving it load-bearing.
- Runs inside a Twitch extension iframe: no `SharedArrayBuffer`, no
  cross-origin isolation, no atomics.
- Related: builds directly on [[0006-caller-supplied-buffers]];
  [[0005-docs-drift-guard]] keeps the README and llms.txt honest about exactly
  what shipped.
