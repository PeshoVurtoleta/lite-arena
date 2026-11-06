# 0010 - Entity flags: one Int32 word per slot (+ second word, 1.11.0)

Status: accepted
Date: 2026-10-27
Ships in: v1.10.0 (second flag word + M-33 amendment: v1.11.0; indexed flags amendment: v1.12.0)
Supersedes: nothing. Builds on 0009 (a flag word is only meaningful for a live handle).

## Context

Cheap boolean per-entity state ("hot", "dirty", "frozen") had one home: a
`registerTag()` SparseSet per state. Each tag costs a `sparse` Uint32Array plus a
`dense` Int32Array (8 B per slot per tag), a membership change is an add/remove
with swap-and-pop, and a state test is `has(e)`. For many short-lived boolean
states that is a lot of structure for one bit.

## Decision

`arena.registerFlags(names)` is called once and allocates `arena.flags`, an
`Int32Array` with one word per SLOT (length = capacity). It returns a frozen
null-prototype `{ name: bit }` map, name i -> `1 << i`; name #32 is
`-2147483648` (the Int32 sign bit). `registerFlags()` and `registerFlags([])`
allocate the row and return a frozen `{}`.

- `setFlags(e, mask)` / `clearFlags(e, mask)` return a boolean; a dead handle
  returns `false` and writes nothing. `hasFlags(e, required, excluded = 0)` is
  `alive && (row & required) === required && (row & excluded) === 0`.
  `hasFlags(e, 0)` on a live entity is `true`; `setFlags(e, 0)` is a no-op
  returning `true`.
- Masks are normalised with `| 0`, so `0x80000000` works.
- `registerFlags` throws on a second call, more than 32 names, a duplicate / empty
  / non-string name, an options object that is not plain (prototype
  Object.prototype or null), or any options key. `'__proto__'` is a legal name.
  Validation runs before allocation, so a throw allocates no row (on a re-entry the
  inner call's row stands; see M-33 below).
- `arena.indexMask` (read-only, 0xFFFFF today) lets hot loops write
  `const m = arena.indexMask; row[e & m]`. Do not hard-code 0xFFFFF. This keeps
  callers correct if the handle split ever becomes configurable; it does not
  promise that split.
- Bit operations are inlined in the three methods; there is no import.

## Alternatives

| | Flags row (chosen) | Per-flag SparseSet tag | Column bitset |
|---|---|---|---|
| Bytes per slot | 4 B for 32 flags | 8 B per tag | 1 bit per flag (4 B per 32 flags), caller-owned |
| Test | `isAlive` + one row read | `has(e)` | caller index + mask |
| Iterate | scan O(capacity) | dense list O(count) | scan O(capacity / 32) words |
| `joinN` | yes (1.10.0, M-4 / M-10..M-13) | yes | no |
| Cleanup on despawn | built in | cascade | caller's job |

Tags stay the right tool for sets that are small, iterated or joined. A column
bitset is a recipe a caller can build on `indexMask`; it is not an API here.
No timings were measured for this decision; the table is structural.

## Consequences

- `despawn()` zeroes the entity's word BEFORE the retirement branch, and
  `clear()` zeroes every word (same array), so a respawned slot starts with no
  flags and a retired slot holds none. `reserve()` copies the row into a larger
  array and REPLACES `arena.flags`: re-read it after growing, like `data.x`.
- Bit 31 is the Int32 sign bit: the 32nd flag reads as `-2147483648`. Bits 30-31
  are outside the 31-bit Smi range on pointer-compressed engines (e.g. Chrome), so
  such a value held in a JS variable may be a heap number; inside the Int32Array
  it is a plain int32. NOMINAL: Node cannot observe it. For `joinN` masks the
  same applies: a mask outside [-2^30, 2^30 - 1] may be a heap number on
  pointer-compressed engines (NOMINAL; Node cannot measure it).
- Precondition (M-6): calling a flag method before `registerFlags()` on a live handle (a dead handle returns false first) throws a
  native TypeError (the row is null). Documented, not guarded: a guard would cost
  bytes in three methods.
- PRODUCTION FAILS OPEN on a typo: `F.tpyo` is `undefined`, `undefined | 0` is 0,
  so `setFlags(e, F.tpyo)` is a silent no-op returning `true` and
  `hasFlags(e, F.tpyo)` is `true`. Checked mode (`checked: true`, M-16 / M-18) throws
  unless every mask is a 32-bit integer (non-number, NaN, fraction, +-Infinity, or
  outside both int32 and uint32); `0x80000000` is accepted and an omitted
  `excluded` is fine. It does not reject unregistered bits. The checked methods
  are own properties that shadow the prototype ones (as for `idx`), so production
  is byte-identical; subclass overrides are honoured. Use checked mode in
  development.
- Options (M-17): `registerFlags` options must be a plain object or null /
  undefined; any own key throws (no options exist in 1.10.0).
- Gates: `test/flags.test.js`, `test/flags-checked.test.js`.

## joinN masks (M-4, M-10..M-13, M-20, M-25; 1.10.0)

`joinN(required, excluded, reqMask, excMask)` (see 0008 amendment). The caller's
loop does one row read per candidate: `w = row[e & indexMask]`, match when
`(w & rm) === rm && (w & xm) === 0`.

- M-4: masks are optional, normalised `| 0` (omitted -> 0). The driver is still
  the smallest required SET; masks never change the plan's sets.
- M-10: a non-zero mask without `registerFlags()` throws before any state write.
- M-11: `required = []` still throws (there is no driver). A flags-only scan is a
  caller loop over `arena.flags`, O(capacity); it is not an API here.
- M-12: the plan carries `reqMask`, `excMask` and `flags` (null without
  `registerFlags()`). `reserve()` replaces the row and refreshes the production plan's `flags`; a
  hoisted `row` (and a checked plan) keeps the pre-reserve row, so re-read after
  `reserve()`.
- M-13: `(reqMask & excMask) !== 0` matches nothing in production; checked mode
  throws.
- M-20 / M-25: checked mode throws when a SUPPLIED mask is not a 32-bit integer,
  including a supplied-but-undefined one (`F.tpyo`: "must be a 32-bit integer,
  got undefined"); a truly omitted mask is 0. Production stays `| 0`, so a
  misspelled joinN mask reads 0 and fails open there (it matches as if no mask),
  as for `setFlags`.
- Bits 30-31: NOMINAL -- a mask outside [-2^30, 2^30 - 1] may be a heap number
  on pointer-compressed engines; hoist it into a local once per system. Node
  cannot measure it.
- Gates: `test/joinN-masks.test.js`, `test/joinN-checked.test.js`,
  `test/joinN-parity.test.js` (no-mask golden).

## Amendment: Second word (M-26, 1.11.0)

The text above is the 1.10.0 decision and stays as history. This section adds
what 1.11.0 changes.

### Decision

64 flags = a SECOND Int32 row with its own Hi API, not a wider type. Word 0 is
unchanged (`registerFlags`, `arena.flags`, `setFlags` / `clearFlags` /
`hasFlags`, `reqMask` / `excMask`). New: `registerFlagsHi(names)` -> its own
frozen map + `arena.flagsHi` (one Int32 per slot), `setFlagsHi` /
`clearFlagsHi` / `hasFlagsHi`, and `joinN(required, excluded, reqMask, excMask,
reqMaskHi, excMaskHi)` with plan fields `reqMaskHi` / `excMaskHi` / `flagsHi`.
Capped at 64; each word keeps its 32-name cap; Hi bit 31 is -2147483648. An
arena that never calls `registerFlagsHi()` allocates no second row (0 B per slot;
`despawn()` adds one nested null check); the extra `joinN` cost is O(1) per call (not zero).

Rejected here: a BigInt row (BigInt64Array reads allocate), per-entity objects,
and column bitsets. The latter two are F2 material, not this release.

### M-27 rulings

- Q1: `registerFlagsHi()` throws unless `registerFlags()` was called first;
  `registerFlags([])` gives a Hi-only arena.
- Q2: Hi-only `joinN` masks are allowed; under M-25 checked mode args 3-4 are
  padded with `0, 0` (a supplied `undefined` throws).
- Q3: checked-mode wording says "the required Hi" / "the excluded Hi" mask; a
  non-zero Hi mask with no Hi row throws "joinN() got reqMaskHi=...,
  excMaskHi=..., but this arena has no Hi flag row (arena.flagsHi is null). Call
  registerFlagsHi() ...". The word-0 no-flags error fires first when both apply;
  an empty `required` still throws first (M-11).
- Q4: the same name may appear in the word-0 map and the Hi map; the maps are
  independent and the arena stores neither. M-13 holds per word; a bit shared
  across the words is allowed.

### Inline budget (M-28) and checked-plan construction (M-32)

`joinN` must stay TurboFan-inlinable: bytecode <= 460 B (V8 single-inline
limit). 1.10.0 was 423 B. Constructing the checked plan inline would have cost
69 B (489 -> 420), so it moved to the cold module function
`stampCheckedJoinNPlan(arena, required, excluded)` (epoch bump + the
`CheckedJoinNPlan` from the scratch), and the M-10 guards for both words use a
truthy `(a | b) &&` test. A Hi guard moved to a cold helper was measured at 502 B
and rejected.

Deterministic bytecode lengths (node v26.8.2, measured 2026-11-04, pinned in
`test/bytecode-budget.test.js`): joinN 420 B, despawn 215 B (199 before: the Hi
word is zeroed), `setFlagsHi` 45, `clearFlagsHi` 47, `hasFlagsHi` 65 (equal to
their word-0 twins; M-33 below raised these to 48 / 50 / 68).

### M-33 (1.11.0): convert the mask before the alive check

`setFlags` / `clearFlags` / `hasFlags` and the Hi twins now convert the mask
(`mask | 0`; `hasFlags`: required and excluded, each once) BEFORE the alive
check. A mask whose `valueOf()` despawns the entity can no longer write a freed
slot, and `hasFlags` cannot return `true` for an entity its own mask despawned.
On a dead handle a number / undefined / plain-object mask still returns `false`
with no write (the object's `valueOf` runs once); a BigInt or Symbol mask now
throws TypeError (was `false`), live or dead. Before `registerFlags()` on a live
handle an object mask's `valueOf` runs once, then the TypeError (null row).
Checked mode is unchanged (it rejects non-number masks first).

`registerFlags` / `registerFlagsHi` re-check "already called" after reading
names / options: a names getter or an options Proxy trap that re-enters the
method makes the OUTER call throw the existing "already called" error (the
inner call's map and row stand).

Cost: +3 B of bytecode per method (node v26.8.2: setFlags 48, clearFlags 50,
hasFlags 68, Hi twins identical; were 45 / 47 / 65). Gates: `test/flags-m33.test.js`,
`test/flags-hi-qa.test.js`.

## Amendment: Indexed flags (F2)

The text above is history and stays. 0011 is the decision; this section lists which
statements above it overrides in 1.12.0, by the lines they appear on in the 1.11.0 text.

- Options (the "any options key" clause under Decision, and the M-17 line under
  Consequences, "no options exist in 1.10.0"): the options object now accepts ONE key,
  `indexed`, a `string[]` of names from the same call. Any other own key (Symbol and
  non-enumerable too) throws `lite-arena: registerFlags options accept only "indexed"; got
  <key>` (R1, M-40); `registerFlagsHi` says its own name. The plain-object rule is
  unchanged (prototype Object.prototype or null).
- Column bitset (the Alternatives table's "Column bitset" column, "1 bit per flag ...
  caller-owned", "scan O(capacity / 32) words", and the sentence "A column bitset is a recipe
  ... it is not an API here"): an indexed flag IS that column, as an API. It is not
  caller-owned: it is declared at registration and kept in step by `setFlags` / `clearFlags`
  / `despawn` / `reserve` / `clear`. It costs 135,296 B per indexed flag at capacity
  1,048,575 (column 131,072 + summaries 4,096 + 128) plus a 128 B count table per word, and
  0 B when nothing is indexed. Iteration walks matches plus capacity / 1024 summary words;
  this is derived from the code, not timed. The Alternatives comparison is otherwise
  unchanged: tags stay the tool for small, iterated or joined sets.
- "Rejected here: ... column bitsets ... F2 material" (Amendment: Second word): F2 shipped
  them in 1.12.0.
- M-11 (the joinN section: "A flags-only scan is a caller loop over `arena.flags`,
  O(capacity); it is not an API here"): `required = []` still throws. For an INDEXED flag a
  flags-only walk is now `firstFlagged(F)` / `nextFlagged(F, h)`; for an unindexed flag it
  is still a caller loop over `arena.flags`.
- M-12 (the plan fields): the plan also carries `driverFlag` / `driverFlagCount` (M-38,
  M-43): the MASK and live count of the rarest indexed required word-0 flag rarer than the
  driver, else `0` / `-1`. The other fields are unchanged.
- Checked-mode shadowing ("The checked methods are own properties that shadow the prototype
  ones ... subclass overrides are honoured"): still true for a plain arena. On an arena that
  indexes a flag, `setFlags` / `clearFlags` (word 0), `setFlagsHi` / `clearFlagsHi` (Hi)
  and `despawn` (either word) are OWN methods and a subclass override of them is SHADOWED
  (M-42); production and checked mode alike. The checked wrappers delegate to the installed
  indexed body, so the M-18 check is kept (M-36).
- Direct row writes: unchanged for unindexed bits (the row is the API's own data). A direct
  write to an indexed bit leaves the column and count out of step: UNSUPPORTED, undetected
  in every mode (M-39).
- Inline budget ("joinN 420 B", Deterministic bytecode lengths): joinN is 435 B on the 1.12.0
  build (one cold `pickFlagDriver(this, r)` call under `if (this._ixMask)`, M-44); the
  M-28 ceiling 460 never moves. The other pinned lengths (despawn 215, setFlags 48,
  clearFlags 50, hasFlags 68, the Hi twins) are unchanged: indexed arenas use own methods
  with their own pins, listed in 0011.
- Precondition M-6 and the typo fail-open note are unchanged. The new flag methods
  (`flagCount`, `firstFlagged`, `clearFlagAll` + Hi) throw E-ROW when nothing is indexed;
  production `nextFlagged` trusts both arguments (M-39, M-52).
