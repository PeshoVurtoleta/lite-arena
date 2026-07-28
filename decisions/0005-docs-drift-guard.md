# 0005 - A test enforces docs/code agreement (docs-drift guard)

Status: accepted
Date: 2026-07-28
Findings: AR-08
Ships in: v1.6.1

## Context

Finding AR-08: the README and `llms.txt` had drifted three minor versions behind
the code. They documented a test runner the package had stopped using, a stale
test count, an API missing two public methods (`remainingCapacity()`, `clear()`),
`SparseSet.dense` as `Uint32Array` when it had been `Int32Array` since 1.4.1,
and -- worst -- a rollover paragraph describing a fail-OPEN aliasing behaviour the
code had replaced with fail-closed retirement three versions earlier.

The prose was reconciled in 1.5.0 and 1.6.0. But reconciled-once is not the same
as stays-reconciled: every one of those errors entered the same way, a code
change that did not carry its doc change, and nothing failed when it happened.
`llms.txt` is the file the build pipeline reads when a sibling package needs this
one's API; a stale signature there is how a sibling hallucinates a call.

The lesson from AR-02 (a test named for a hazard that passed while the hazard was
live, because it never exercised the code path) applies to docs too: a doc is
only trustworthy if something fails when it goes wrong.

## Options considered

### Discipline -- "remember to update the docs"

- **Cost:** zero code. **Effect:** none; this is exactly the process that
  produced three versions of drift. Rejected: it has already failed, four times.

### A full doc generator -- emit the API reference from the source

- Would eliminate hand-written drift, but it is a large tool to build and
  maintain, it flattens the hand-written prose (the "why", the tradeoffs, the
  examples) that makes these docs worth reading, and it is far more machinery
  than a ~170-line package warrants. Rejected: disproportionate.

### A guard test that asserts agreement (chosen)

- A `node:test` file that fails CI when the docs and the shipped surface
  disagree. Cheap, runs in the existing suite, and it turns the next drift into
  a red build instead of a slow rot. It does not generate the docs -- the prose
  stays hand-written -- it only checks the machine-checkable claims.

## Decision

Ship **`test/docs-drift.test.js`**. It asserts three things, all against the
SHIPPED prototype surface so there is no second list to keep in sync:

1. **Forward** -- every public method on `Arena.prototype` / `SparseSet.prototype`
   (own, non-`_`, non-constructor) appears in `llms.txt` as an actual call
   `name(`, not merely as a prose word. Add a method, you must document it.
2. **Reverse** -- every `.method(` call inside an `llms.txt` fenced code block is
   a real public method. No hallucinated signature survives review. The
   allowlist for foreign (standard-library) calls is intentionally empty today;
   a new one must be added deliberately, in the test, not slip in silently.
3. **Links** -- every relative link in `README.md` and `llms.txt` (anchors and
   `http(s)`/`mailto` excluded) resolves to a file in the repo.

The guard passes green on 1.6.1 -- the docs already agree -- so it ships as a
ratchet, not a fix. Its value is the next change, not this one.

## The benchmark corollary

AR-08 also flagged stale benchmark numbers. Re-measuring on current hardware
(Apple M4 Pro, Node v26.3.1) showed the old figures were not just old but
directionally wrong in one place: the README claimed lite-arena "wins random
removal by 2-3x", but on a modern engine a native `Map` delete edges it. We do
not assert benchmark numbers in the guard -- they are machine- and
engine-dependent, so a hard assertion would be flaky. Instead the policy
(recorded here) is: **README benchmark figures are stamped with the machine,
Node version, and package version they were measured on, and the takeaway claims
only what the ratios robustly show** (iteration is the win; churn and one-shot
removal are competitive, not blowouts). Stamping, not asserting, is the
proportionate answer for numbers that legitimately move with hardware.

## Consequences

- New test file; the unit suite grows from 81 to 84 cases. No `Arena.js` diff --
  1.6.1 is a docs + test release with zero behaviour change.
- The three failure modes that produced AR-08 (undocumented method, hallucinated
  method, dead link) now fail CI the moment they are introduced.
- The guard is coupled only to the real prototype surface and the real file
  tree, so it cannot itself drift out of sync with a separately-maintained list.
- Related: this closes the R-track (R1-R4) for lite-arena; AR-06 (the missing
  `decisions/0001`) and AR-08 (this) are both closed, and AR-08 is now enforced.
