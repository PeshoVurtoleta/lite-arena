# lite-arena -- the consolidated ledger

*Every design call that cost a measurement, every review round that bounced a unit, every
audit finding that taught a rule, and the laws each one produced. It is the evidence base
behind "joinN is inlinable", "the flag methods fail closed" and "a gate has teeth" being
measured results rather than assertions. Nothing here is re-litigated without a **new
mechanism** clearing every gate it names.*

Evidence note: paths under `.handoff/` and `audit/` are maintainer-local evidence (gitignored,
not in a fresh clone). Commits, `decisions/` ADRs, `CHANGELOG.md` and this file are public.
Every measured figure below names where it came from and its tier (DETERMINISTIC /
STATISTICAL / REPORTED / PRELIMINARY / NOMINAL); numbers are copied from the source, never
recomputed. This file is not shipped (not in `package.json` `files[]`).

Numbering note: #1-#5 are the inlining / bytecode-budget family (section A), #6-#11 the
fail-closed semantics family (B), #12-#15 the allocation-gate family (C), #16-#22 the
measurement and harness family (D), #23 the docs-drift family (E), #24-#33 the 2026-11-06
audit family (F). The audit's 15 distinct findings (O-1..O-10, F-1..F-8, with O-5 = F-2,
O-10 = F-3, O-7 ~ F-5) are all CONFIRMED by both auditors; triage rulings are M-56..M-67.
Tracking notes for decided-but-unshipped fixes use the 1.12.1 label from DECISIONS.md.

---

## The laws that fell out (read this first)

The entries below collapse into eight rules (#9, #12, #19, #22, #28 are context). The rules are the payoff; the entries are the
proof.

1. **Bytes in a hot body cost even when the branch never runs.** `joinN` must stay at or
   under 460 B of bytecode or TurboFan stops inlining it into its callers; the fix for a
   too-big body is to move cold work out, not to trim instructions. *(#1, #2, #3, #4, #5)*
2. **Convert, then check; read once, then use.** An argument conversion (`valueOf`) or an
   option getter can run user code. Do every conversion and every read BEFORE the liveness
   check or the first state write, and use the value you read, not the property again.
   *(#7, #8, #10, #25, #32)*
3. **A value check is not a membership check; a canonical form is part of the contract.**
   `isAlive` accepting a handle does not mean the SparseSet `===` will; canonicalize at the
   boundary or reject. *(#6, #11, #24)*
4. **Every door to the same state gets the same hardening.** Registration, direct construction and `rebind` need one read per key, one own-key check, one buffer-alias check and one registration step; a no-op return precedes every scan. *(#25, #26, #27)*
5. **A gate's teeth are tested by mutants, not assumed.** A gate that is green on the old
   build, or that measures retention when it is titled allocation, or that cannot see a
   once-per-N allocation, is not a gate. Every gate gets a must-fail control and a
   revert-check; a parity gate's revert-check is a live-build mutant. *(#13, #14, #15,
   #20, #31)*
6. **A control that fails voids the harness, not just the row.** An A/A control that reads
   1.76x in 11/11 rounds means no row of that harness is trusted. Identical `new Function`
   sources share V8 feedback; give each config unique source. *(#16, #17)*
7. **Every claim has one verification tier, and a claim with no tier is unproven.** Timing
   is REPORTED only in this package (no statistical host); counts and bytecode lengths are
   DETERMINISTIC and gated; docs word measurements as measurements. *(#18, #23, #30, #31)*
8. **Settled behavior still needs true docs; a test must not depend on gitignored paths.**
   A ruling that keeps an edge (clear() re-opens the ABA window, re-entrant masks are
   unsupported) obliges the README / d.ts / llms.txt to say so; and no `npm test` file may
   read `.handoff/`. *(#21, #29, #32, #33)*

Gate consequence: **no single green gate authorises a ship.** The order used for every unit
is: oracle independent of the coder -> mutants / revert-check -> reviewer (doc-truth for
docs) -> torture (`npm run torture`) -> closing `verify` under the quiet lock.

---

## A. Inlining and the bytecode budget

### #1 -- joinN must stay TurboFan-inlinable (<= 460 B)

**Tried / broke.** Before F1 grew `joinN` (it gained the Hi masks), the inlining question was
asked first, with a trial instead of an assumption: the vendored inlining A/B ran a null
variant and a padded-`isAlive` control.
**Mechanism.** TurboFan inlines `joinN` into its callers only while its bytecode is within
V8's single-inline limit, 460 B on node v26.8.2. Bytes cost even when the branch is cold.
**Outcome.** 1.10.0 `joinN` = 423 B, so F1 headroom was +37 B, not the +80 B PLAN-F1 A4 had
allowed (DETERMINISTIC bytecode length, node v26.8.2). The trial: null SAME, padded-`isAlive`
control DIFF. Ruling M-28: the gate is the inlining A/B reading SAME on both tiers, which
keeps the "Inlining joinN into query" decision line.
**Source:** M-28; M-29; HISTORY.md "2026-11-01 inlining A/B tool vendored (M-28, M-29)";
evidence `.handoff/evidence/inline-trial/report-null.txt` and `report-mutant.txt`; commit
fb8bebb.

### #2 -- Checked-plan construction moves out of joinN

**Tried / broke.** F1 needed Hi-mask guards inside `joinN`. PLAN-F1 A2's fallback (the Hi
guard moved to a cold helper) measured 502 B -- over the 460 B ceiling.
**Mechanism.** The expensive part was the checked-plan construction (epoch bump +
`CheckedJoinNPlan` from the scratch), not the guards.
**Outcome.** Maintainer: "Adopt Dt". A cold module function `stampCheckedJoinNPlan(arena,
required, excluded)` builds it, and the M-10 guards become truthy tests for both words:
`joinN` 420 B, despawn 215 B, Hi twins = word-0 bytecode (DETERMINISTIC, node v26.8.2). The
inline A/B vs before-F1 read SAME 37/37 on turbofan and SAME 40/40 on maglev, control OK
(REPORTED, QUIET host, `--strict`; M-29).
**Source:** M-32; HISTORY.md "2026-11-04 F1 built" and "F1 close-out"; evidence
`.handoff/evidence/F1-A6/`; commit 1e6e2a9.

### #3 -- Exact bytecode pins plus a ceiling that never moves

**Tried / broke.** A budget that says "stay small" is silent growth by 3 bytes at a time.
**Mechanism.** M-30 vendored `bytecode-budget.sh` and added an Arena gate: EXACT pins of
the hot-method lengths (despawn 199, joinN 423, isAlive 40, spawn 93, setFlags 45,
hasFlags 65, clearFlags 47, add 113, has 66, remove 140, idx 16 at the time; DETERMINISTIC,
node v26.8.2 only, other versions skip) so any growth is OVER until a reviewed diff raises
the pin; plus a FIXED ceiling `joinN <= 460` that never moves.
**Outcome.** The first review bounced it on a bash-probe skip that failed open, a 120 s
guard and stale counts; r2 APPROVED. F2 later raised `PINS.joinN` 420 -> 435 inside the
ceiling through a reviewed unit (U4).
**Source:** M-30; HISTORY.md "2026-11-04 bytecode-budget vendored (M-30)" and "F2 U4";
commit 1498014.

### #4 -- The joinN driver hint lives in a cold helper that reads r.reqMask itself

**Tried / broke.** The F2 research burst measured the hint in-body at 525 B and as a helper
at 444 B (research bytecode variants, PRELIMINARY). The built form passes the plan, not the
mask.
**Mechanism.** `pickFlagDriver(a, r)` reads `r.reqMask` itself, so no bit-31 int32 crosses
a non-inlined call (zero-box on pointer-compressed V8); the `joinN` call site is a single
`if (this._ixMask)`.
**Outcome.** Built: `joinN` 435 B, `pickFlagDriver` 133 B cold (DETERMINISTIC, node
v26.8.2). The timed G3-A3 inlining A/B passed: L4a SAME + CONTROL OK, L4b A/A SAME and the
padded-indexed control DIFF (REPORTED, one quiet-window run).
**Source:** M-38; M-44; HISTORY.md "F2 research burst", "F2 U4 (joinN driver hint)" and "F2
U9 (G3-B3 timed lanes)"; commit 63e864f.

### #5 -- Indexed bodies are installed as OWN methods; prototype bodies stay byte-identical

**Tried / broke.** A branch inside `setFlags` / `despawn` ("branch" variants) grew the hot
bodies (research: branch-min 77/79/254, branch 103/101/258 vs own-method keeping pins
48/50/215; PRELIMINARY).
**Mechanism.** `registerFlags(Hi)` with `indexed` installs indexed `setFlags` / `clearFlags`
/ `despawn` (and Hi twins) as own methods; the prototype stays untouched, so the M-30 pins do
not move. Never `delete` a method slot (dictionary mode). Checked mode must delegate to the
INSTALLED body: probe p5 showed the naive order loses the M-18 check.
**Outcome.** Every M-30 pin held exact through U2; new lengths 90..319 B. Cost caveat:
if the mixed call-site lane reads COST on plain arenas, the README carries a REPORTED caveat
(M-47); the L1 mixed-site lane passed (G3-A4 PASS for L1).
**Source:** M-36; M-42; M-47; HISTORY.md "F2 research burst" and "F2 U2 (engine core)";
commit 1bf080a.

---

## B. Fail-closed semantics

### #6 -- A free slot must not accept its next handle (the FREE bit)

**Tried / broke.** `isAlive` was one compare against `generations[index]`, and a free slot
stored the generation its NEXT spawn would issue. So on a fresh `Arena(4)`,
`isAlive((1 << 20) | 0)` was `true` with `activeCount` 0; `despawn(1048576)` returned `true`
and drove `activeCount` to -1 and the free list got the slot twice.
**Mechanism.** Free slots store `gen | FREE` (bit 13, 0x2000, apart from the retirement
poison 0x1000). A stored value with FREE set never equals a minted generation, so `isAlive`
is byte-identical; `& GEN_MASK` was rejected because it can store 0.
**Outcome.** Fixed in 1.10.0; the generation sequence is unchanged, so the budget gate is
identical. The inlining A/B (ce3f63c vs e675a64 vs current) showed identical inlined-edge sets.
**Source:** M-2; ADR `decisions/0009-free-slot-flag.md`; commit e675a64; HISTORY.md "burst 3".

### #7 -- Flag methods convert the mask BEFORE the alive check

**Tried / broke.** `setFlags` / `clearFlags` / `hasFlags` tested `isAlive` and then did
`mask | 0`. qa (F1 close-out, Q-QA1) found that a mask's `valueOf()` can despawn the entity
between the two; `hasFlags` then returned `true` for an entity its own mask had despawned
(found by an orchestrator probe, not in qa's report).
**Mechanism.** Conversion can run user code. Convert first (`has`: required and excluded,
each ONCE), then test liveness.
**Outcome.** Measured 48 / 50 / 68 B (+3 each, node v26.8.2, DETERMINISTIC) vs the rejected
"check alive twice" form 62 / 64 / 82 B. Visible change: on a DEAD handle a BigInt / Symbol
mask throws TypeError (was `false`). QB1 + QB2 were REJECTED r1 (no live valueOf-once leg;
double-convert mutants survived) and APPROVED r2.
**Source:** M-33; HISTORY.md "2026-11-04 M-33 -- qa LOW defects fixed before 1.11.0"; commit
10ed76c.

### #8 -- Re-check state after any read that can run user code

**Tried / broke.** `registerFlags` / `registerFlagsHi` read option names (a getter or Proxy
`ownKeys` trap) and then allocated; a re-entrant inner call could register first and the
outer one then registered twice (qa Q-QA2).
**Mechanism.** Registration is a state transition guarded by `this.flags !== null`; user code
between the guard and the write must be assumed to have moved it.
**Outcome.** Re-test `this.flags(Hi) !== null` after `flagMap()` and throw the existing
byte-identical "already called" error before allocating (the re-entrant inner call wins,
the outer throws).
**Source:** M-33 (Q-QA2); HISTORY.md "M-33"; commit 10ed76c.

### #9 -- Checked mode distinguishes "omitted" from "supplied undefined"

**Tried / broke.** A typo'd flag name (`F.tpyo`) evaluates to `undefined`, and `| 0` made it
0: a misspelled `joinN` mask silently matched everything. The Unit 0 doc review caught
the first guard still treating a supplied `undefined` as omitted.
**Mechanism.** Use `arguments.length` in the checked wrapper: a truly omitted mask is 0, a
supplied `undefined` throws "must be a 32-bit integer" (M-18). Production stays plain
`| 0`, zero cost, and the docs say the typo fails open in production only.
**Outcome.** M-25 amended M-20; the same fix was later missing on `hasFlags` /
`hasFlagsHi` (see #28).
**Source:** M-16; M-18; M-20; M-25; HISTORY.md "burst 5".

### #10 -- A throwing checked call leaves earlier state valid

**Tried / broke.** Checked `joinN` validated after the epoch bump, so a rejected call
invalidated every earlier plan. The first fix then exposed a shared `others` / `excl`
scratch to a surviving plan (fail-open), and the tests read only `count`.
**Mechanism.** Validation (foreign set, set in both lists, shared mask bits) must run BEFORE
any write. Round 1 of the F unit was REJECTED for the scratch aliasing.
**Outcome.** `checkJoinNSets` runs in the checked wrapper before any write (burst 6,
APPROVED); the constructor guard keeps direct prototype calls fail-closed.
**Source:** M-22; HISTORY.md "burst 5" and "burst 6"; commit ec06830.

### #11 -- An int32 handle is a Smi on Node, not on Chrome

**Tried / broke.** ADRs 0001 / 0002 called the handle "a 32-bit SMI". PLAN-C (the
entity-bit-split measurement plan) recorded the risk: Chrome's pointer compression has 31-bit
Smis, so 20/12 handles are boxed for generations 1024..3071 when they cross non-inlined
boundaries.
**Mechanism.** Node has no pointer compression, so Node cannot show the box.
**Outcome.** Wording corrected in the 1.10.0 docs batch with a dated erratum in ADR 0001 /
0002: "an int32; a Smi on 64-bit Node, may be a heap number on 31-bit-Smi platforms
(pointer compression, e.g. Chrome) for generations 1024..3071". NOMINAL. PLAN-C's census
counted 2048 of 4095 generations outside the 31-bit Smi range at 20/12 (derived count in the
plan, not a timing).
**Source:** M-15; ADR `decisions/0002-signed-handle-container.md` (erratum);
`.handoff/PLAN-C.md` (RISK and census lines); HISTORY.md "burst 2".

---

## C. Allocation gates

### #12 -- remove() allocated 48 B per swap; the fix has a scope

**Tried / broke.** `SparseSet.remove()` allocated 48 B per swapping remove (burst-1 measurement; no tier recorded) (for...in over a
dictionary-mode data bag). First found in burst 1.
**Mechanism.** A per-set column array cached at construction (refreshed in `_grow` /
`rebind`) removes it. The E1 attempt was REJECTED: a partial `rebind` re-point left `_cols`
stale (fail-open); then the fix was made atomic.
**Outcome.** Fixed in 1.10.0, and the limit is documented (M-19): `remove()` allocates
nothing while the whole app's components use <= 4 distinct TypedArray kinds at the shared
swap site (V8's polymorphic limit); above that each Float32/Float64 column boxes 16 B per
swapping remove. The probe GATES the <= 4-kind lanes at 0 and prints the 6-kind lane
as REPORTED. The "5-kind regression" was a measurement artifact.
**Source:** M-14; M-19; HISTORY.md "burst 1", "burst 3", "burst 4"; commit 9b461be.

### #13 -- A retention gate is not an allocation gate

**Tried / broke.** The U3 oracle's A5 rows were titled "allocate 0 B" but measured
`arrayBuffers` retention after a settled GC; four transient-allocation mutants passed. The
review bounced it as DESIGN.
**Mechanism.** Retention cannot see a short-lived allocation.
**Outcome.** M-50: node:test A5 rows are a RETENTION gate only, titled so; the allocation
gate is torture Phase N (`maxMinor 0`) plus `test/flags-indexed-alloc.test.js` scavenge
counts (DETERMINISTIC, M-46: every F2 lane <= noop + 1 Scavenge per 500,000 ops, box
control >= noop + 8). U7 recorded: 10 F2 lanes 0 scavenges, box 15-16, retention 256 tracked
-> 0 (DETERMINISTIC, `flags-indexed-alloc.test.js`).
**Source:** M-50; M-46; HISTORY.md "F2 U2 + U3" and "F2 U6 + U7"; commits 8303aee, fc26d9f.

### #14 -- A once-per-1,000 allocation is invisible to scavenge counts

**Tried / broke.** Phase N's `ixSetFlags` window makes about 98,568 calls (~20 KB new-space
growth vs ~4 MB free new space, 0 scavenges). A mutant allocating once per 1,000 calls
survived Phase N: growth over N1 clean 7,456 / 5,728 / 13,816 B vs mutant 28,312 / 31,640
/ 26,912 B (B5 coder, node v26.8.2, load ~20-33; PRELIMINARY host).
**Mechanism.** Scavenge COUNTS only move when a semi-space fills; a rare allocation never
fills it in a short window.
**Outcome.** M-51: Phase N catches PER-CALL allocation only (plus the `NLEAK=1` / `NLEAK=hint`
knobs); the once-per-1,000 mutant is caught by a new-space BYTE-delta lane in
`flags-indexed-alloc.test.js` with a fixed margin of 16,384 B. U7 measured, 6 + 6 runs, clean
0 B vs mutant 89,600 B (DETERMINISTIC, so no ruling was needed). A reach check was added
later so a plain-flag mutant under the indexed probe can no longer read as noop.
**Source:** M-51; HISTORY.md "F2 U5", "F2 U6 + U7" and "F2 U8 step 1"; commit fc26d9f.

### #15 -- A probe that clamps to 0 cannot detect a heavily allocating mutant

**Tried / broke.** The remove() probe in E1 clamped its reading to 0 when a scavenge landed
inside the window; a heavily allocating mutant passed.
**Mechanism.** A delta that can go negative must not be clamped; use scavenge counts and
byte deltas with a settle step instead.
**Outcome.** The burst-4 fix replaced it with a scavenge-count probe.
**Source:** HISTORY.md "burst 3" (E1 REJECTED) and "burst 4"; evidence
`.handoff/archive/1.10.0/evidence/`.

---

## D. Measurement and harness

### #16 -- V8's eval cache shares feedback across identical `new Function` sources

**Tried / broke.** The U6 L5 headline built 60 configs with `new Function`; identical
sources shared V8 feedback across configs. Review r1 REJECTED it (plus 4 surviving lib
mutants: interleave rotation / warm-up, SLOW vs controlBase).
**Mechanism.** The eval cache keys on source text, so two configs with the same text are one
function to the optimizer.
**Outcome.** Each generated body gets a unique source; r2 APPROVED.
**Source:** HISTORY.md "F2 U6 (G3-B1) + U7 (G3-B2)", review r1; commit 108c369;
`.handoff/archive/1.12.0/COMMIT_MSG-U6.txt`.

### #17 -- A failed A/A control voids every row of the harness

**Tried / broke.** U9's L5 run (quiet host, `--strict`) exited 2: 3 of 15 rows failed their
A/A control; the walk 0.01% A/A read 1.758x in 11/11 rounds (REPORTED, one run).
**Mechanism.** The harness is asymmetric, so its other walk rows are not trusted either.
**Outcome.** M-53: report the 10 clean non-walk rows (indexed write cost pair 7.6x, churn
9.2x; flagCount; clearFlagAll 0.0035x-0.98x; REPORTED), drop every walk row including 1%
(0.22x) and 10% (0.88x), keep the README's "derived from the code, not timed" walk sentence.
The fix is a release gate for the next L5 run (NEXT.md FILLER 28).
**Source:** M-53; HISTORY.md "F2 U9" and "F2 U11"; evidence
`.handoff/evidence/F2/L5-2026-11-06.log`.

### #18 -- Statistical host: none. Statistical claims are REPORTED only

**Tried / broke.** The suite's default (hosted CI) did not exist for this package, and a
local timing is PRELIMINARY unless QUIET.
**Mechanism.** Without a noise-designed gate a ratio cannot be DETERMINISTIC.
**Outcome.** M-45: ROADMAP declares "none"; every F2 timing ships REPORTED with provenance;
docs say complexity is "derived from the code, not timed". M-48: README / llms.txt /
CHANGELOG quote only final-build G3 numbers; research-burst numbers stay in ADR 0011 as
decision evidence. M-49: F2 prose labelled "(1.12.0)" and `/release` verifies the label.
**Source:** M-45; M-48; M-49; ADR `decisions/0011-indexed-flags.md`; commit dba1cf9.

### #19 -- A noisy host is a host fact, and a wall-clock rule does not belong in a deterministic lane

**Tried / broke.** The U6 coder's torture run tripped Phase B's `maxPauseMs: 4` wall-clock
rule at load1 ~50; the re-run at load1 7 passed (NEXT.md FILLER 10, a test bug). U9 began at
load1 26.3 vs a quiet-lock baseline of 2.21 and used ONE background wait job that polled
`quiet-lock.mjs status` every 60 s and ran each step once under `run --strict`: QUIET after
23 min (the lock was BUSY once, for another package's witness, and the job waited). The
release verify waited 34 min (NOISY; BUSY in 14 of 35 polls; load1 up to 131.41) and then ran once, exit 0.
**Mechanism.** `load1` is a 1-minute average, so it lags after a burst, and an IDE indexer
(WebStorm, ~2 cores per the maintainer-relayed audit plan) can hold a host NOISY on its own;
neither is the code under test. A wall-clock threshold in a DETERMINISTIC lane makes the
host a test input.
**Outcome.** Rule: record load average and busy `node` processes in every timed run;
NOISY / BUSY = PENDING, never a retry loop; the closing verify waits for QUIET. The
host.log of U6 shows the same shape: "host NOISY / PRELIMINARY" (load1 58.47, baseline 2.21,
12 cores).
**Source:** HISTORY.md "F2 U9" and "F2 U6 + U7"; NEXT.md FILLER 10 and the release block;
evidence `.handoff/evidence/F2/host.log` and `.handoff/evidence/release-1.12.0/poll.log`; `.handoff/PLAN-AUDIT.md` (host-lessons candidate
line, maintainer-relayed; the IDE-indexing and 1-minute-average points are not re-measured
here).

### #20 -- A parity gate is green on the before build by design

**Tried / broke.** The release revert-check found every new F2 gate red on the frozen
fe8d7d5 build except `test/flags-f2-parity.test.js` (5/5 green).
**Mechanism.** A parity gate must PASS on 1.11.0 and on every F2 build; its golden was cut
from fe8d7d5. Its teeth are a different thing.
**Outcome.** M-54: its revert-check is a mutant of the LIVE build (two one-line mutants of
180d1268 each turn a row of the 2,000-record golden red) plus its in-file A7 MUST-FAIL
rows. The first-round review had already bounced the gate because the parity test read the
gitignored freeze (see #21).
**Source:** M-54; evidence `.handoff/evidence/release-1.12.0/revert-check.log` and
`parity-live-mutants.log`; HISTORY.md "release 1.12.0" and "F2 planner pass + U1"; commit
f9f44cd.

### #21 -- No `npm test` file may read a gitignored `.handoff/` path

**Tried / broke.** U1's parity test read the gitignored frozen build; the capture threw on
the F2 plan keys. A fresh clone would silently lose (or fail) the gate.
**Mechanism.** `.handoff/` is not in the repo; the tracked golden is the oracle.
**Outcome.** PLAN-F2 ADDENDUM A11: no npm-test file reads a .handoff/ path; the G3 test files skip their fe8d7d5 rows on a failed `git cat-file -e`; the parity MUST-FAIL rows do not skip yet (NEXT.md item 15, open).
**Source:** `.handoff/archive/1.12.0/PLAN-F2.md` (ADDENDA, "A11 (2026-11-05, orchestrator,
U6)"); HISTORY.md "F2 planner pass + U1" and "F2 U6"; commit f9f44cd.

### #22 -- Peer dependencies count as zero deps; the inline build won on evidence

**Tried / broke.** The 2026-11-01 reading was that a peerDependency broke the zero-deps law;
the maintainer ruled the opposite.
**Mechanism.** `dependencies` stays empty; a peer is permitted.
**Outcome.** M-34. F2 still built indexed flags inline (M-35, option B): a lite-o1 BitSet
peer did not help -- it lacks the O(1) count / resize / transition result, a static import
makes the peer required, and inline measured 2.4x faster scans at 1-10% and 2-5.5x faster
bulk clear (PRELIMINARY, `.handoff/research/F2/RESEARCH.md`).
**Source:** M-34; M-35; HISTORY.md "F-track planning" and "F2 research burst"; evidence
`.handoff/research/F2/RESEARCH.md`.

---

## E. Docs drift

### #23 -- "Realistic workloads never retire" was wrong, and a doc is only true if something fails when it lies

**Tried / broke.** The ADR 0001 erratum (2026-10-27): at the default 20/12 split an
`Arena(1000)` fails after `capacity x 4095` despawns at most, and sooner with live entities;
counts PINNED by `test/budget.test.js` (DETERMINISTIC): C1 4,095,000 (100%), C2 3,685,310
(90%), C3 3,115,308 (76.08%). At 60 fps those are derived arithmetic, not a measurement
(C1 first retirement 68.3 s, failure 18.96 h).
**Mechanism.** The prose had carried a "never fires" claim that no test could contradict;
ADR 0005 (AR-08) had already shown that a doc drifts the same way when a code change does
not carry its doc change.
**Outcome.** Every "never fires" wording removed; the budget gate (commit 711c38d) and the
docs-drift guard (ADR 0005) fail when code and docs disagree.
**Source:** ADR `decisions/0001-generational-rollover.md` (Erratum 2026-10-27); ADR
`decisions/0005-docs-drift-guard.md`; commit 711c38d; HISTORY.md "burst 1".

---

## F. The 2026-11-06 audit

Two independent auditors (Opus 5.5, Fable 5.1) probed the 1.12.0 release; both
Cross-check sections CONFIRM all 15 distinct findings. Triage is M-56..M-67 (maintainer, in
chat). Nothing here is fixed in 1.12.0: each Outcome is a ruling planned for the DECISIONS.md unit named; every audit figure is a DETERMINISTIC repro on Node v26.8.2 (SUMMARY.md) unless labelled; none changes the settled
behavior of M-2 / ADR 0004.

### #24 -- A value check is not a membership check (O-1)

**Tried / broke.** `isAlive(h >>> 0)` is true for a live slot of generation >= 2048, but
SparseSet compares with `===`. `despawn(u)` freed the slot while the dead handle stayed in
every `dense`; `add(u)` appended a duplicate each call (count 7 on capacity 4; the audit's
repro). The trigger is documented misuse (a handle stored in a `Uint32Array` field).
**Mechanism.** Two layers disagree about what a handle IS. Every test and torture phase
passed canonical handles only, so no gate saw it.
**Outcome.** M-57 (planned, 1.12.1-B): `despawn()` canonicalizes (`entity |= 0` on entry) and CHECKED mode
rejects a non-canonical handle in `isAlive` / `add` / `has` / `remove` / `despawn`;
production pinned hot bodies untouched. Rejected: an engine-wide `isAlive` check (40 B pin).
**Source:** audit O-1 (`audit/2026-11-06/opus-5.5_FINDINGS.md`); M-57.

### #25 -- A registration path must be hardened like the rebind path (O-3 / F-1 / F-4)

**Tried / broke.** `registerComponent` ignored every option key but `buffers` (a
`{ buffer: ... }` typo silently own-allocated a "shared" payload: F-1); read `buffers[key]`
twice, so a getter swap left a wrong-length own allocation marked caller-backed (O-3); and
accepted one ArrayBuffer for two fields on registration and on `rebind` (F-4: a write to
`x[3]` read back at `y[3]`).
**Mechanism.** `rebind()` had been hardened (single read, atomic) and registration had not;
the same trust boundary had two doors.
**Outcome.** M-56 and M-61 (planned, 1.12.1-A): plain-object options, any own key other than `buffers` rejected
(M-40 wording); `validateBuffers` reads each key once into a local array the constructor
builds from; registration and rebind reject a buffer already used by another field (rebind
also checks fields it is not rebinding). Its gate must fail on 1.12.0.
**Source:** audit O-3, F-1, F-4; M-56; M-61.

### #26 -- Validation order: the no-op test precedes the scans (O-10 / F-3)

**Tried / broke.** `reserve(n <= capacity)` is documented as a no-op returning `false`; on a
caller-backed, rebound or detached arena it threw "cannot grow this arena" because the
caller-backed and detached scans ran first.
**Mechanism.** Every early-return precedes every scan: the cheapest, most common outcome
must be decided before the expensive checks that can only fail for other outcomes.
**Outcome.** M-59 (planned, 1.12.1-A): the no-op check moves above both scans, after the integer / ceiling
check; gate `reserve(capacity)` and `reserve(capacity - 1)` return `false` on all three
kinds.
**Source:** audit O-10, F-3; M-59.

### #27 -- Direct construction is a registration path too (O-4)

**Tried / broke.** A directly constructed `SparseSet` passed the capacity check but was not
in `arena.components`, so `reserve()` left its `sparse` short and `add()` of a high slot
dropped the sparse write and re-appended every call (3 adds gave count 3, `has()` false).
AR-10 claimed to close this trap.
**Mechanism.** Two ways to make a set (the constructor and `registerComponent`); only one
registered it.
**Outcome.** M-62 (planned, 1.12.1-A): the constructor pushes itself and `registerComponent` stops pushing twice;
gate: direct set + `reserve()` + high-slot `add` keeps count 1.
**Source:** audit O-4; M-62.

### #28 -- A fix that covered joinN must be applied to its sibling (O-6)

**Tried / broke.** Checked `hasFlags` / `hasFlagsHi` treated a SUPPLIED `undefined`
excluded mask as omitted; the d.ts said it throws, `joinN` threw in the same case (M-25).
`flags-checked.test.js:45` pinned the fail-open as intended.
**Mechanism.** M-25 was applied to `joinN` and not carried to the other mask-taking
methods; a test had pinned the bug.
**Outcome.** M-60 (planned, 1.12.1-B): M-25 applies to checked `hasFlags` / `hasFlagsHi` (`arguments.length > 2`
-> validated), checked wrappers only, zero production bytes; the pinned tests are to be flipped.
**Source:** audit O-6; M-60; see also #9.

### #29 -- Settled behavior still needs true docs (O-5 / F-2)

**Tried / broke.** README said a stale handle "never aliases as valid, on any code path" and
`isAlive()` "rejects them" (every pre-clear handle). `clear()` re-issues an already-used generation
(a retired slot to 2, 4095 to 1), so an old handle can be live again after the next spawn.
**Mechanism.** The behavior is SETTLED (M-2, ADR 0004 section 3: "re-open the ABA window
... acceptable and documented"); only the wording overclaimed.
**Outcome.** M-58 (planned, 1.12.1-C): docs fix only -- README, d.ts and llms.txt say that no pre-clear or
persisted handle may be retained across `clear()` or into a fresh arena. Engine fix
rejected (it would reopen M-2).
**Source:** audit O-5, F-2; M-58; ADR `decisions/0004-retirement-observability-and-clear.md`.

### #30 -- A doc claim with no tier is unproven (O-7 / F-5)

**Tried / broke.** README "When it matters" carried untiered numbers ("~0.5 ms/frame, no
GC", a "~2,000" rule of thumb) and law wording on REPORTED data ("hold across machines",
"you should see"). The headline was stamped Node v26.3.1 / lite-arena v1.6.1: README
10.8x churn vs `bench/bench-results.json` (1.12.0) 4.45x; iteration 1.9x vs 1.84x and 2.7x
vs 2.49x (REPORTED, audit O-7 table). llms.txt had an 8.5 ms table with no provenance that
contradicted the README's 1.70 ms (F-5).
**Mechanism.** Verification tiers: a claim belongs to one tier or it is unproven; a
REPORTED number is worded as a measurement.
**Outcome.** M-64 (planned, 1.12.1-C / D): every surviving number labelled REPORTED with provenance or NOMINAL;
law phrasing reworded; the llms.txt table replaced or deleted; the headline said to be from
v1.6.1; a docs-drift row requires a tier marker next to every ms / x figure. No new timing
(the re-stamp waits for the next quiet L5 run, see #17).
**Source:** audit O-7, F-5; M-64.

### #31 -- A gate's teeth are tested by mutants, not assumed (O-8 / O-9 / F-8)

**Tried / broke.** A per-call allocation in `clearFlagAllHi` passed torture and the full
suite (546 / 0); the same mutant in word-0 `clearFlagAll` was caught (4 scavenges vs noop 0),
so the allocation lanes were word-0 only. README bytecode figures (`nextFlagged` 209 B) were
not tied to the pins: "199 B" passed the suite (546 / 0). Torture Phase N stayed green on
two S2-summary mutants that the node:test F2 suites caught (F-8). All DETERMINISTIC
audit mutant runs, node v26.8.2 for the pinned rows.
**Mechanism.** A gate is only as wide as its mutant set. The bytecode pins catch Hi growth
only on one Node version.
**Outcome.** M-65 (planned, 1.12.1-D): Hi lanes in `bench/f2/newspace-probe.mjs` and
`flags-indexed-alloc.test.js`, revert-checked by the `clearFlagAllHi` mutant, and docs-f2-claims
A7 parses README / llms.txt / CHANGELOG bytecode figures against the pins with a
mutated-README control. M-66 (backlog): a summary-sensitive walk in Phase N after
`clearFlagAll` / `reserve`.
**Source:** audit O-8, O-9, F-8; M-65; M-66; see also #13, #14.

### #32 -- Re-entrancy inside a pinned prototype body is unsupported, and the docs say so (O-2)

**Tried / broke.** A mask whose `valueOf()` registers INDEXED flags, passed to the prototype
`setFlags` / `setFlagsHi` before the row exists, writes the row bit and not the column;
`flagCount` reads 0 for a flagged entity and a later `clearFlags` drives it to -1.
**Mechanism.** The same conversion-runs-user-code hazard as #7 and #8, but here fixing it
would cost bytes in a pinned body.
**Outcome.** M-63 (planned, 1.12.1-C): "by design, document" -- unsupported re-entrancy, to be documented next to
M-39's direct-row-write rule (README / d.ts). Rejected: an engine fix in the pinned
prototype bodies.
**Source:** audit O-2; M-63; M-39.

### #33 -- Scope guards belong to the call they were designed for (F-6 / F-7)

**Tried / broke.** `new Arena(8, { checked: 1 })` or a typo (`checkd`) silently leaves the
arena unchecked (F-6). Checked `join(a, b)` has no foreign-set / same-set guard, while
`joinN` does (F-7).
**Mechanism.** F-7 is the intended scope: AR-09 / ADR 0004 section 5 give checked `join()`
the staleness guard only, and M-13 / M-22 scope foreign / contradiction checks to `joinN`.
F-6 is a real fail-open on a development-only switch.
**Outcome.** M-67: F-6 to backlog (a NEXT.md filler for a future minor, since it makes a
silent typo throw); F-7 by design, one README / d.ts line.
**Source:** audit F-6, F-7; M-67; ADR `decisions/0004-retirement-observability-and-clear.md`.
