# 0008 - N-way / exclusion joins (S7, additive)

Status: accepted
Date: 2026-07-29
Track: S7 (query ergonomics)
Ships in: v1.9.0
Supersedes: nothing. `join(a, b)` is unchanged; this adds a sibling.

## Context

`join(a, b)` is a two-input driver-picker: it reads two `count`s, hands back the
rarer set as `driver` and the other to `has()`-check, and the caller writes the
intersection loop. It is a planner, not an iterator, and it allocates nothing.

Real systems match on more than two components and frequently on an ABSENCE:
"Renderable AND Position AND Visible, but NOT Culled". Today callers hand-roll
that on top of `join`, and three things go wrong when they do:

1. **Wrong driver.** `join` picks the min of TWO; with k required sets the
   optimal driver is the GLOBAL min. Hand-rolled code rarely computes it, so it
   iterates a larger set than it must -- a silent O(n) tax every frame.
2. **Exclusion done wrong.** `!has()` on a foreign or stale set fails open.
3. **No blessed pattern.** Everyone reinvents the nested-`has` loop; the
   fail-closed and checked-staleness details get dropped.

## Decision

Add ONE cold method, `joinN(required, excluded)`, that generalizes `join` to k
required sets plus a flat NOT list. `join(a, b)` stays byte-identical -- the fast
two-set path is untouched; `joinN` is its k-input sibling. No hot method changes.
Because it is purely additive and the default path is unchanged, it ships as a
minor: **1.9.0**, matching the S5/S6 additive-minor precedent.

### Return shape (reused scratch, like `_joinResult`)

`{ driver, count, others, othersCount, excl, exclCount }`

- `driver` -- the smallest-`count` set in `required` (ties favour the first,
  matching `join`'s "ties favour a").
- `count` -- `driver.count`.
- `others` / `othersCount` -- the required sets except the driver, to
  `has()`-check; `othersCount` is the live length.
- `excl` / `exclCount` -- the excluded sets, to `!has()`-check.

`others` and `excl` are two arena-owned scratch arrays allocated once and GROWN
ONCE to their high-water mark the first time a larger join appears, then never
reallocated -- so steady state is zero-alloc, the same guarantee `join`'s single
reused object gives. Callers loop to `othersCount`/`exclCount`, never `.length`,
so a stale tail beyond the live count is unobservable.

## Alternatives rejected

### A query / iterator / callback API (`query({all, none}).forEach(...)`)

Rejected for the same reason `join` is not one: a callback or a materialized
result set either allocates per frame (the closure, the array) or forces the
match to run where the caller cannot fuse it into their own body. `joinN` plans
and hands back references; the caller writes the loop. That is the only shape
that stays zero-alloc AND lets the system do its real work in the same pass.

### OR / arbitrary boolean trees

Rejected. k-way AND plus a flat NOT list covers the real ECS need. OR is `joinN`
called twice (union the two driver walks). A boolean-expression DSL would bloat a
cold planner to serve a case that decomposes trivially, and would invite the
caller to build the expression object per frame -- an allocation `join`/`joinN`
exist specifically to avoid.

### Caching the driver across frames

Rejected. Counts change every tick as entities are added and removed, so a cached
driver goes stale silently. Fail-closed says recompute: the min-count scan is
cold (once per system per frame) and cheap.

### A `required`/`excluded` object literal instead of two array params

Rejected at the call site level: `joinN([A,B],[C])` with hoisted arrays allocates
nothing per call, whereas `joinN({ all:[A,B], none:[C] })` tempts an inline object
literal every frame. Two positional array params keep the hot-adjacent call
allocation-free by construction.

## Fail-closed rules (null is not zero)

- `required` null or empty -> throw. No required set means no driver and no
  honest result; an empty match must be requested explicitly, never inferred.
- `excluded` null -> the empty list (the common case; ergonomic).
- A set in BOTH `required` and `excluded` -> a contradiction whose only honest
  answer is the empty set. Production yields it NATURALLY (every driver element is
  in the excluded set, so every `!has` fails); checked mode THROWS to name the
  programming error.
- Foreign set (not registered with this arena) -> production trusts the caller
  and is zero-cost, EXACTLY as `join(a, b)` trusts its inputs today; checked mode
  validates against `arena.components` and throws.

## Checked mode (AR-09 parity)

`joinN` shares the arena's `_joinEpoch` with `join`, so a stale plan of either
kind throws once a later `join()`/`joinN()` supersedes it. Production returns the
reused scratch with zero validation and zero allocation; checked mode returns a
`CheckedJoinNPlan` that adds the epoch guard plus the foreign-set and
required/excluded-overlap checks above.

## Consequences

- New cold method only; the six hot methods (`spawn` / `despawn` / `add` /
  `has` / `remove` / `idx`) are byte-identical -- proven by the torture diff gate
  and Phase I (`maxMajor:0`, control `ARENA_TORTURE_JLEAK=1`).
- `join(a, b)` is unchanged in signature, scratch, and numbers.
- No new thread/COI/transfer surface -- this is pure single-thread ECS ergonomics,
  orthogonal to S5/S6.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
