# 0010 - Entity flags: one Int32 word per slot

Status: accepted
Date: 2026-10-27
Ships in: v1.10.0 (unreleased)
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
  Validation runs before allocation, so a throw leaves `flags` null.
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

## joinN masks (M-4, M-10..M-13, M-20; 1.10.0)

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
