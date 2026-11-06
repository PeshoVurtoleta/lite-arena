# 0011 - Indexed flags: rare-flag queries without a scan (1.12.0)

Status: accepted
Date: 2026-11-05
Ships in: v1.12.0 (the ROADMAP target, M-49; `/release` verifies the label)
Supersedes: nothing. Amends 0010 (see its "Amendment: Indexed flags (F2)").
Rulings: M-35 .. M-52 (the F2 research burst, the planner pass, and the U3 / U5 / U8 maintainer rulings).

## Context

0010 gave every slot one Int32 flag word (and, since 1.11.0, a second one). It answers
"does THIS entity carry the flag" in O(1) but nothing else: "how many entities carry it",
"visit the ones that do" and "clear it everywhere" are caller loops over the row,
O(capacity) however rare the flag is. 0010 called a column bitset "a recipe, not an API
here" and left it as F2 material.

F2 makes that an API for the case it fits: a RARE flag. A flag is indexed at registration;
the arena then keeps a per-flag column (one bit per slot), a two-level summary over it and
a live count. The row word stays the source of truth.

## Decision

The rulings, verbatim from the maintainer's decision log.

- M-35 (2026-11-05, Q-F2-1) F2 indexed flags are built INLINE in Arena.js (option B): a
  Uint32 column + 2-level summary + Int32 count per indexed flag, design parity with
  lite-o1 BitSet, no peerDependency. M-34 still permits a lite-o1 peer, but (A) did not
  "help": BitSet lacks the O(1) count / resize / transition result, a static import makes
  the peer required, and inline measured 2.4x faster scans at 1-10% and 2-5.5x faster bulk clear
  (PRELIMINARY).
  Provenance of those ratios: research probe, pre-implementation, REPORTED. F2 research burst,
  HEAD fe8d7d5, node v26.8.2; K=7 interleaved rounds, median. Runs 2 and 3 (2026-11-05 03:30Z, quiet
  lock non-strict, load1 2.37-2.65 vs baseline 2.21, another busy node process) are PRELIMINARY;
  run 4 (2026-11-05 05:14Z, `run --strict` exit 0, QUIET, load1 2.79-2.82, no other node
  process, 1 run) is the REPORTED confirmation. No STATISTICAL claim.
- M-36 (Q-F2-2) Indexed write path = OWN-METHOD INSTALL: registerFlags(Hi) with `indexed`
  installs indexed setFlags / clearFlags / despawn (and Hi twins) as own methods; prototype
  bodies stay byte-identical (M-30 pins unchanged). Checked mode composes explicitly
  (wrappers delegate to the installed body, never straight to the prototype -- probe p5
  showed the naive order loses the M-18 check). Never `delete` a method slot (dictionary mode).
- M-37 (Q-F2-3..6) Surface: flagCount(flag) / firstFlagged(flag) / nextFlagged(flag, prev)
  / clearFlagAll(flag) + Hi twins; iteration yields ENTITY HANDLES (-1 = end); a flag is
  indexed ONLY at registration via registerFlags(names, { indexed: [...] }) /
  registerFlagsHi (M-9 / M-24 widened: `indexed` is the first allowed options key; M-17
  unchanged); Hi indexing is symmetric and ships in F2.
- M-38 (Q-F2-7) joinN on an indexed arena calls one cold helper (`if (this._ixMask)`) that
  ALWAYS writes plan.driverFlag (MASK of the rarest indexed required word-0 flag rarer
  than the driver, else 0) and plan.driverFlagCount (else -1); non-indexed arenas keep the
  constructed 0 / -1; driver / count / every existing field unchanged. Measured 444 B
  (M-28 ceiling 460); the planner re-measures the final form.
- M-39 (Q-F2-8..10) nextFlagged continues from prev's SLOT, ignoring its generation
  (despawn / un-flag of prev inside the loop supported; higher-slot bits set mid-loop are
  visited). Bad `flag`: M-25 split -- production `flag | 0` + throw unless exactly one
  indexed bit on firstFlagged / flagCount / clearFlagAll (nextFlagged trusts its loop's
  flag); checked mode adds the M-18 non-int32 throw. Direct row writes on indexed bits are
  documented UNSUPPORTED (no checked detection); the torture gate proves the API keeps row
  and column equal.
- M-40 (Q-F2-11) Unknown registerFlags(Hi) options key -> new text: "lite-arena: ${method}
  options accept only \"indexed\"; got ${k}" (R1).
- M-41 (Q-F2-12) Checked nextFlagged(Hi) validates: M-18 non-int32 check AND E-BIT (exactly
  one indexed bit) on `flag`, and the M-18 non-int32 check on `prev`. Production
  nextFlagged still trusts its flag (M-39).
- M-42 (Q-F2-13) The installed indexed despawn delegates to Arena.prototype.despawn.call(this,
  e) (no per-call lookup); a subclass despawn override is shadowed on indexed arenas, like
  the indexed setFlags / clearFlags own bodies. Documented.
- M-43 (Q-F2-14) CheckedJoinNPlan exposes driverFlag / driverFlagCount as two _live()
  getters (positional args appended last in stampCheckedJoinNPlan): the checked plan stays
  a drop-in for the production plan.
- M-44 (Q-F2-15) The joinN hint helper is pickFlagDriver(a, r): it reads r.reqMask itself,
  so no bit-31 int32 crosses a non-inlined call (zero-box on pointer-compressed V8); joinN
  length re-measured under M-28 (<= 460).

Rulings that shape what the docs may say:

- M-45 (Q-F2-16) STATISTICAL host for lite-arena: none -- statistical claims are REPORTED
  only. Docs word complexity as "derived from the code, not timed".
- M-48 (Q-F2-19) README / llms.txt / CHANGELOG quote only G3 final-build numbers;
  research-burst numbers stay in this ADR as decision evidence with provenance.
- M-49 (Q-F2-20) F2 prose is labelled "(1.12.0)".
- M-50 / M-51 The node:test indexed rows are a RETENTION gate only. The allocation gates
  are torture Phase N (per-call transient allocation, maxMajor 0 / maxMinor 0) and the
  new-space lane `test/flags-indexed-alloc.test.js` (M-46, scavenge COUNTS at a pinned
  1 MiB semi-space).
- M-52 (2026-11-06, U8 qa Q-1) Production nextFlagged(F, prev) with prev undefined / NaN /
  null throws nothing and resumes after slot 0, so a flagged slot 0 is skipped (M-39:
  production trusts prev; checked mode throws M-18). Ruled: DOCUMENT it. The walk idiom
  starts with firstFlagged(F) and passes only a handle that firstFlagged / nextFlagged
  returned; a non-int prev in production is UNSUPPORTED, checked mode throws M-18. No
  engine change. Rejected: leave it undocumented; a cold prev guard in nextFlagged (bytes in
  the 209 B hot body, reopens M-39).

### The surface (1.12.0)

```js
const F = arena.registerFlags(['hot', 'dirty', 'boss'], { indexed: ['boss'] });
arena.setFlags(e, F.boss);
arena.flagCount(F.boss);                                   // O(1)
for (let h = arena.firstFlagged(F.boss); h !== -1; h = arena.nextFlagged(F.boss, h)) { /* ... */ }
arena.clearFlagAll(F.boss);                                // O(flagged)
```

`registerFlagsHi(names, { indexed })` is symmetric (`flagCountHi`, `firstFlaggedHi`,
`nextFlaggedHi`, `clearFlagAllHi`). The error texts, copied from the code:

| id | when | text |
|---|---|---|
| R1 | any other own options key, or a non-object / array options | `lite-arena: ${method} options accept only "indexed"; got ${k}` |
| R2 | own `indexed` is not an array | `lite-arena: ${method} options.indexed must be an array of flag names, got ${v}` |
| R3 | entry unknown, non-string or repeated | `lite-arena: ${method} options.indexed #${j} (${entry}) is not one of the names, or a duplicate` |
| E-ROW | flag method with no indexed flag in that word | `lite-arena: ${m}() needs registerFlags${hi}() with { indexed: [...] } first` |
| E-BIT | `flag` is not exactly one indexed bit | `lite-arena: ${m}() needs exactly one indexed flag bit (indexed mask 0x${mask}), got ${flag}` |

`indexed` is read as an OWN key only. A throw happens before any row or column is allocated.

### Memory (deterministic)

Per indexed flag at capacity 1,048,575: 135,296 B = column W 131,072 + summary S1 4,096 +
summary S2 128. That is 3.23% of one 4,194,300 B row word. Every word also holds one
`_ixCnt` table of 128 B (Int32Array(32)); it is `null` when no bit of that word is indexed,
so an arena that indexes nothing pays 0 B. At capacity 65,536 the figure is 8,456 B per flag
(research, F-10).

### Hot and cold

HOT bodies: the installed `ixSetFlags` / `ixClearFlags` (+ Hi), `ixDespawn`, and
`nextFlagged` (+ Hi). COLD: registration, the validation in `flagCount` / `firstFlagged` /
`clearFlagAll`, column upkeep in `reserve()` / `clear()`, and `pickFlagDriver`.
Complexity is derived from the code, not timed: `flagCount` O(1); a walk costs about the
number of matches plus capacity / 1024 summary words; `clearFlagAll` is O(flagged).

### Unsupported, documented

- A direct write to an indexed bit (`flags[s] |= F.x`) leaves the column and the count out
  of step and is not detected, in any mode (M-39). Write through the API.
- A subclass override is shadowed on an indexed arena (M-42): `setFlags` / `clearFlags` when
  word 0 indexes a flag, `setFlagsHi` / `clearFlagsHi` when Hi does, and `despawn` when
  either does. On a plain arena, and for the twin of an unindexed word, it is honoured as
  before.
- Production `nextFlagged` with a non-integer `prev` (M-52), or with a `flag` that is not
  one indexed bit (M-39).

## Alternatives

| | Inline (chosen) | lite-o1 BitSet per flag (A) | Branch in the shared bodies | Caller-owned bitset (C) |
|---|---|---|---|---|
| Dependency | none | required peer (a static import fails the module without it) | none | none |
| O(1) count | maintained | `popcount()` is O(words) | maintained | caller's job |
| Grow on `reserve()` | column copy | fixed capacity: rebuild a set per flag | column copy | caller's job |
| Transition result | from the row word | `set()` returns `this` | from the row word | caller's job |
| Plain-arena write bytecode | unchanged (own-method install) | unchanged | setFlags 77 .. 103 B (was 48) | unchanged |
| Stays in sync with `despawn` | built in | built in | built in | fail-open at the first forgotten call site |

Research evidence (the F2 research burst, 2026-11-05, HEAD fe8d7d5, node v26.8.2; the
numbers below are DETERMINISTIC counts and bytes; probe logs live in the maintainer's
research folder, not in this package):

- API fit (A): BitSet has set / unset / test, summary-backed firstSet / nextSet and capacity
  up to 2^25, but no maintained count, no resize or copy-from, and no transition result.
  Building on it still leaves count, resize, checked composition and joinN wiring inside
  the arena; it saves about 50 lines of column core.
- Peer mechanics (A): a static `import { BitSet } from '@zakkster/lite-o1'` fails the whole
  module with ERR_MODULE_NOT_FOUND when the peer is absent, so an optional peer is
  impossible from the single main file; a required peer makes every arena user install a
  322,551 B file (84,397 B gzip) beside an 89,199 B Arena.js (bundlers can tree-shake it).
  An optional peer through a second entry file breaks the single-main-file law.
- Memory (A): 135,300 B per flag at capacity 1,048,575 (adds a 4 B third level) against
  135,296 B inline.
- Write path bytecode at 0 indexed flags (node v26.8.2): the live prototype bodies are
  setFlags 48 / clearFlags 50 / despawn 215. The own-method install keeps exactly those. A
  branch with a cold helper costs setFlags 77 / clearFlags 79 / despawn 254; a transition test in
  the body costs 103 / 101 / 258. The branch form moves setFlags past the Maglev
  single-inline tier (under 100 B); the branch-min form stays under it but crosses the
  TurboFan 75 B tier. Own-method bodies at research time: setFlags 111 (+ the ixSet 153
  per transition), BitSet-backed 134 (+ BitSet.set 117 + 140 when a word turns non-empty).
- Checked composition: installing own methods after the checked wrappers REPLACES them, so
  `setFlags(e, 1.5)` stopped throwing on a checked arena in the probe; the reverse order
  skips the indexing. Hence M-36's explicit composition. The branch forms compose for free.
- `delete` of own methods drops an instance to dictionary mode; a design never uninstalls.
- joinN driver hint (ceiling 460 B, joinN was 420 B): picking the driver inline 525 B
  (breaks M-28); a `!== 0`-guarded call to a cold helper 460 B (0 B headroom); a TRUTHY
  `rm & this._ixMask` guard 447 B but fail-open (a stale hint on a call whose mask has no
  indexed bit, an overwritten `r.count`, and a bit-position hint colliding with the
  mask-taking firstFlagged); the chosen `if (this._ixMask)` guard with a helper that always
  writes both fields 444 B at research time (M-38), 435 B on the final build.
- Correctness oracle: 200,000 random spawn / despawn / set / clear operations plus periodic
  clearFlagAll at capacity 4,096 with 3 indexed bits: every count and every column scan
  equalled the row-word scan, for all three models. The oracle also found a real hazard:
  zeroing an L1 summary word while walking the summary silently loses later words of the
  same group, so the bulk clear zeroes the summary after the walk.
- Zero-GC: retained-heap rate at most 0.097 B/op in every probe lane (inline, BitSet and
  branch models), at the same floor as the live arena's own operations. That measures
  retention only; M-50 / M-51 explain why the final gates are Phase N and the new-space lane.

Timing was measured in the burst (write pairs, scans at five densities, count, bulk
clear), recorded in the research log as PRELIMINARY or one QUIET REPORTED run. The only
ratios quoted in this ADR are the two in M-35 above. The shape that mattered for the decision is structural: a
column wins for a RARE flag and the row scan stays the tool for a dense one. The research
could not settle the crossover (between 10% and 50% density for the inline column, with a
50% result that was never explained); the docs therefore say "rare flag" and give no
threshold.

Tags (0010) stay the right tool for sets that are small, iterated or joined; a dense flag
keeps the row scan.

## Consequences

- An arena that indexes nothing is the plain arena: no column, no `_ixCnt`, the prototype
  bodies and their pins (below) untouched.
- `reserve()` copies each column and rebuilds its summaries, keeping counts; `clear()`
  zeroes the columns, summaries and counts in step with the rows. Re-read `arena.flags`
  after growing, as before.
- `joinN` carries `driverFlag` / `driverFlagCount` (`0` / `-1` when there is no hint, and
  always on an arena with no indexed word-0 flag, a Hi-only indexed arena included). The
  checked plan has the same two fields as `_live()` getters: a stale read throws (M-43).
- A joinN caller may walk `firstFlagged(driverFlag)` / `nextFlagged(driverFlag, e)` instead
  of `driver.dense` when `driverFlag !== 0`; the driver set, the other required sets, the excluded sets and the masks are
  still checked per candidate.
- Checked mode: `flagCount` / `firstFlagged` / `clearFlagAll` / `nextFlagged` (+ Hi) run the
  M-18 32-bit-integer check first; `nextFlagged` adds E-ROW / E-BIT on `flag` and the M-18
  check on `prev` (M-41). Production `nextFlagged` validates neither.
- Gates: `test/flags-indexed*.test.js` (retention, oracle), `test/flags-indexed-alloc.test.js`
  (new-space lane), `test/torture.mjs` Phase N (zero major / zero minor GC, tracker size 0
  after 4,096 cycles), `test/bytecode-budget.test.js`, `test/docs-drift.test.js`.

## Bytecode pins

Deterministic, node v26.8.2, measured on the reviewed build and pinned in
`test/bytecode-budget.test.js` (`IX_PINS`, plus the one HEAD pin F2 moved). Bytecode bytes
per function:

| function | bytes | note |
|---|---|---|
| joinN | 435 | was 420; ceiling 460 (M-28) never moves |
| ixSetFlags | 178 | own method of an indexed arena |
| ixClearFlags | 178 | own method |
| ixSetFlagsHi | 178 | own method |
| ixClearFlagsHi | 178 | own method |
| ixDespawn | 319 | own method (M-42); the prototype despawn stays 215 |
| ixSet | 97 | column set, HOT |
| ixUnset | 116 | column clear, HOT |
| ixWordFrom | 209 | summary walk, HOT |
| nextFlagged | 209 | HOT |
| nextFlaggedHi | 209 | HOT |
| flagCount | 90 | |
| flagCountHi | 90 | |
| firstFlagged | 215 | |
| firstFlaggedHi | 215 | |

The prototype twins keep their pins (setFlags 48, clearFlags 50, despawn 215, the Hi twins
alike): a plain arena compiles the same bodies as 1.11.0.
