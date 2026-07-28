# 0006 - Caller-supplied component payload buffers (SAB, additive)

Status: accepted
Date: 2026-07-28
Track: S5 (SharedArrayBuffer)
Ships in: v1.7.0

## Context

`registerComponent(schema)` always allocated each field's backing array itself
(`this.data[key] = new Ctor(capacity)`), so a component's payload could never
live in memory the caller controls -- which means it could never be shared with
a Worker. The one unticked box in the README's own roadmap was cross-thread
support.

The instinct to "share the arena" is a trap if taken whole. A Worker that
receives a component cannot ITERATE it: the read path is `count` (a plain JS
number field) and `dense` (a private own-buffer `Int32Array`), neither of which
is shared, and both of which need a memory-ordering model the moment two agents
touch them. That is a real, breaking, atomics-bearing change -- and it is NOT
this release. It is S6 (v2.0.0).

What ships cheaply and additively is the OTHER half: let the caller own the
payload buffers, so a Worker can read and write `data.*` over a range the main
thread hands it by message. The `postMessage` round trip is the fence; no shared
`count`/`dense`, no atomics, no locking. That is the whole of S5.

## The two decisions this record fixes

### 1. What "caller-supplied" means, and how it fails

`registerComponent(schema, { buffers })`. When `buffers` is given, each
`data[key]` becomes a length-bounded view over `buffers[key]` instead of a fresh
allocation. Accepted buffer types are `ArrayBuffer` AND `SharedArrayBuffer`: the
feature is "the caller owns the memory", sharing across a Worker is one reason to
want that, and the path is far easier to test with a plain `ArrayBuffer`.

It fails closed, in both directions, before a single view is built:

- a declared field with a missing / null / undefined buffer throws -- NEVER a
  silent fall back to own-allocation. A partially caller-backed component (some
  fields shared, some private) is the worst of both worlds and impossible to
  debug: the caller believes a field is shared, the arena quietly made it
  private, and the Worker reads zeros. Fail loud instead.
- a buffer of the wrong type, or the wrong `byteLength` (it must span exactly
  `capacity * BYTES_PER_ELEMENT`), throws naming the field and both lengths.
- a buffer that targets a field the schema does not declare throws. A buffer
  with no home is a typo or a stale key; dropping it silently is the same class
  of error as the missing-buffer case.

`undefined` (the option omitted) is the ONLY value that own-allocates. Any other
provided value, including `null`, goes through validation -- a caller who wrote
`{ buffers: someVar }` with `someVar` accidentally null wants a loud error.

Only `data.*` payload is caller-backed. `sparse` and `dense` remain private
own-buffer arrays: sharing the read path is S6, and conflating the two is how
this release would have grown atomics it does not need.

### 2. The `reserve()` interaction -- option A (exclusive)

`reserve()` reallocates every component's `data.*` via `_grow()`
(`new Ctor(newCapacity)`). It cannot do that to a buffer the arena does not own,
and cross-thread there is no synchronous way to tell a Worker its view just
detached -- it would read a zero-length detached buffer, silently, until the
next message. Three resolutions were on the table:

- **A. Exclusive (chosen).** `reserve()` throws if any registered component is
  caller-backed, naming the offending component and pointing here. The smallest
  honest contract: it forbids a feature interaction nobody has asked for, and it
  cannot silently corrupt a Worker's view. Size caller-backed buffers for the
  maximum capacity up front.
- **B. Growable SAB.** Require `new SharedArrayBuffer(n, { maxByteLength })` and
  have `_grow` call `sab.grow()`. Elegant -- buffer identity is preserved and
  length-tracking views follow -- but it is the newest platform surface in the
  package by a wide margin and it still leaves plain-`ArrayBuffer` callers
  without an answer. Deferred.
- **C. Epoch + re-hoist.** Bump a shared `bufferEpoch`; Workers re-acquire views
  when it changes. Works everywhere but pushes a rule onto every consumer, and a
  consumer that forgets reads garbage. It becomes cheap in S6, which introduces
  an epoch for the sync model anyway -- so S6 is the right place to revisit it.

Option A is deliberately the least clever choice. S6 can loosen it against a
mechanism that actually exists; S5 should not invent one it does not need.

## Consequences

- `Arena.js` gains one cold helper (`validateBuffers`) and three cold-path
  branches (`registerComponent`, the `SparseSet` ctor, `reserve`). The six hot
  methods -- `spawn` / `despawn` / `add` / `has` / `remove` / `idx` -- are
  proven byte-for-byte identical to 1.6.1 by diff: `data.x` is the same
  `Float32Array` whether it views an own buffer or a caller's, so there is no
  hot-path branch on backing type.
- The caller-backed flag (`_callerBacked`) is set as an OWN property ONLY on the
  caller path, so an own-allocated set -- the production default -- keeps the
  exact 1.6.1 instance shape.
- Tests: 13 unit cases (both validation directions, an independent-view proof
  that the buffer is genuinely the backing store, swap-and-pop through a shared
  buffer, the `reserve()` refusal and its regression guard) plus a
  `worker_threads` smoke test that reads and writes a real `SharedArrayBuffer`
  across threads, postMessage-fenced.
- Torture Phase G runs the hot tick over own-allocated AND SAB-backed payload,
  each gated `maxMajor:0` / `maxPauseMs:4` / `maxArrayBuffersGrowth:0`
  (`measureOps` with `stabilize:'deep'`, which the external arrayBuffers channel
  needs to be gateable). Verified the gate can see SAB: a per-op buffer
  allocation injected into the measured tick flips it to fail.
- No shared `count`/`dense`, no atomics, no multi-writer, no locking -- the
  Worker cannot iterate yet, and the docs say so plainly. That is S6.
- Related: this opens the S-track. [[0005-docs-drift-guard]] keeps the README
  and llms.txt honest about exactly what shipped here and what did not.
