# 0004 - Retirement observability, clear(), and checked mode

Status: accepted
Date: 2026-07-28
Findings: AR-05, AR-09, AR-11
Ships in: v1.6.0

## Context

Decision 0001 made generational rollover fail-closed: a slot that exhausts its
4095 live generations is permanently RETIRED on despawn rather than wrapping its
counter and re-issuing a stale generation. That is the right call and it is well
argued. What 0001 left open is that the caller cannot see retirement coming.

- **AR-05 (observability).** A `new Arena(3)` can quietly become an arena that
  holds 2. `spawn()` then throws `"lite-arena: out of memory"` while
  `activeCount === 0` -- the arena is EMPTY, not full -- and the message sends
  the reader hunting for a leak that does not exist. There was no
  `remainingCapacity()`, and `retiredCount` was the only clue. A long-running
  simulation retires slots at a steady rate (a hot slot recycled every frame at
  60 fps retires roughly every 68 seconds), so an eight-hour stream is not an
  edge case -- it is Tuesday.
- **AR-09 (join scratch).** `join()` hands back a reused scratch that is only
  valid until the next `join()`. Retaining it across a second `join()` silently
  reads the newer plan's `driver`/`other`/`count`. Nothing said so at runtime.
- **AR-11 (idx guard).** `idx()` skips the liveness and membership checks by
  design. Calling it on a dead or unattached entity returns a garbage index.
  Considered in 0003 and DEFERRED there, because any `checked` branch inside the
  `idx()` body taxes the fast path even when the flag is off.

## Decisions

### 1. `remainingCapacity()` -- name the free count (AR-05)

Add `remainingCapacity() -> capacity - activeCount - retiredCount`, O(1). Every
slot is in exactly one of three states -- live, free, or retired -- so this
equals the free-list length and the conservation law

    activeCount + retiredCount + remainingCapacity() === capacity

holds after every operation (asserted after every op in torture Phase F). It is
distinct from spare ADDRESS space: retirement permanently withdraws slots, so a
long-running arena's remainingCapacity() can sit below `capacity - activeCount`.

### 2. `spawn()` names the cause of exhaustion (AR-05)

A genuinely full arena and a retirement-shrunk arena both leave `freeHead` at
the sentinel, but they are different problems with different fixes (raise
capacity vs. stop churning one slot). `spawn()`'s throw now reports
`capacity`, `activeCount`, and `retiredCount` inline, and when `retiredCount > 0`
it says the slots were retired by generation exhaustion and points at 0001. The
message is built in a cold `_exhausted()` helper so spawn()'s allocation path is
byte-for-byte unchanged; only its already-cold throw branch calls the helper.

### 3. `clear()` revives retired slots; every pre-clear handle dies

`clear()` resets the arena to empty WITHOUT reallocating -- it overwrites the
existing generation, free-list, and per-component `count` state in place. The
open question 0001 forced here is what `clear()` does to RETIRED slots:

- **Do not revive:** `clear()` does not fully reset -- a "cleared" arena silently
  holds less than its capacity, reintroducing exactly the invisible attrition
  AR-05 is about.
- **Revive (chosen):** map every generation `g -> (g % GEN_MASK) + 1`. In one
  step this advances a live slot (its outstanding handle stops matching), wraps
  `GEN_MASK -> 1`, and revives a retired slot (poison `GEN_MASK+1 -> 2`) back
  into the live range. The result is never 0 (which isAlive rejects) and never
  `GEN_MASK+1` (retired), and always differs from the slot's pre-clear value.

We revive. The honest contract of a reset is that EVERY handle issued before
`clear()` is invalid afterward -- which the generation bump guarantees for the
most recent handle of every slot (older handles for a slot were already stale).
Reviving does re-open the ABA window for a pathological handle held across the
clear (one minted, then invalidated by churn, then re-validated when its slot's
generation is bumped back onto that value). That is acceptable and documented:
"all pre-clear handles are invalid" is the contract; do not retain a handle
across a clear(). The alternative -- a clear() that leaks capacity -- is worse.

### 4. No `onRetire` callback -- rejected in writing (AR-05)

An `onRetire` hook is tempting and is the wrong shape: it is a callback into
user code from the DESPAWN path (a hot path), inviting re-entrancy,
allocation, and exceptions where the invariant is mid-update. The counter
(`retiredCount`) plus `remainingCapacity()` is enough to observe and act on
retirement between frames, which is when a caller can actually respond (raise
capacity, stop churning). An `onRetire` option is therefore inert: passing one
is silently ignored, and a test pins that it never fires.

### 5. Checked mode -- one flag, off by default, zero production cost (AR-09, AR-11)

`new Arena(n, { checked: true })` turns on development-only assertions. It closes
AR-11, which 0003 deferred, WITHOUT the fast-path tax that forced the deferral:

- **join() (AR-09):** in checked mode `join()` stamps a monotonically increasing
  epoch and returns a small plan object that validates the epoch on every field
  read, throwing if a later `join()` superseded it. Production `join()` returns
  the plain reused scratch and allocates nothing (torture Phase C proves it); the
  only addition to the production path is a single predicted-false branch.
- **idx() (AR-11):** in checked mode the SparseSet constructor installs a
  validating `idx` as an OWN property that throws when the entity is dead or does
  not hold the component. It shadows `SparseSet.prototype.idx`, which is left
  byte-for-byte untouched -- so the production `idx()` fast path is unchanged and
  every unchecked set stays monomorphic on the prototype method. This is the
  "separate checked variant" 0003 anticipated: the cost lands only in checked
  mode, never on the flag being merely present.

## Consequences

- New API: `remainingCapacity()`, `clear()`, and an optional
  `new Arena(n, { checked: true })`. All additive; no existing signature changes
  meaning. `new Arena(n)` behaves exactly as before.
- `spawn()`'s exhaustion message text changed (it still contains
  `"out of memory"`, so `/out of memory/` matchers keep passing) and now names
  the cause and the counts.
- Hot paths unchanged: spawn's allocation path, `despawn`, `isAlive`, `add`,
  `has`, `remove`, and the prototype `idx()` are byte-for-byte identical (proven
  by diff). `clear()` is O(capacity) and allocates nothing (torture Phase F holds
  buffer identity across it). The join epoch and checked idx exist only under the
  flag.
- Torture Phase F asserts the conservation law and `remainingCapacity()`
  exactness after every operation across a full retire-everything soak, that the
  exhaustion throw names retirement, and that `clear()` revives every retired
  slot. It is self-controlling.
- Related: 0001 (retirement) is what made observability necessary; 0002 (signed
  handle container) and 0003 (schema validation, deferred AR-11) are unaffected.
