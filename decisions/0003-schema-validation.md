# 0003 - Schema validation, null-prototype data, and rogue-SparseSet policy

Status: accepted
Date: 2026-07-28
Findings: AR-03, AR-04, AR-10 (AR-11 considered, deferred)
Ships in: v1.5.0

## Context

The package's entire value proposition is "your component data is a typed
array". Nothing checked that.

- **AR-03**: `registerComponent({ x: Array })` was accepted and produced a plain
  sparse `Array` -- polymorphic, GC-visible, a silent repeal of both the zero-GC
  and monomorphism guarantees. `{ x: Object }` produced a boxed `Number` and
  writes vanished. The one input that threw (`{ x: 'string' }`) threw a raw
  `TypeError` from the constructor call, not a library error.
- **AR-04**: `data` was a plain `{}`, so its prototype was `Object.prototype`.
  A schema key of `__proto__` silently produced a component with no array for
  that field (`Object.keys(data)` empty); `toString` / `constructor` collided
  with inherited members.
- **AR-10**: `SparseSet` is exported and was constructible standalone with a
  capacity that did not match the arena's. Out-of-range writes were silently
  discarded by the typed array, and, being unregistered, the set was never
  cleaned by `despawn`.

## Decisions

### AR-03 -- validate the schema at registration (fail closed)

Every schema value must be one of the **nine numeric TypedArray constructors**:
`Int8Array`, `Uint8Array`, `Uint8ClampedArray`, `Int16Array`, `Uint16Array`,
`Int32Array`, `Uint32Array`, `Float32Array`, `Float64Array`. Anything else --
`Array`, `Object`, `Function`, `SharedArrayBuffer`, a string, `null`,
`undefined`, a plain object -- throws a library error naming the offending key
and describing what was passed.

`BigInt64Array` / `BigUint64Array` are TypedArrays but are **excluded**:
component data is numeric SoA, read and written as `Number`, and a BigInt view
throws on a `Number` store. Accepting them would hand the caller a component
that throws on first write. If numeric-BigInt components are ever wanted, that
is a deliberate future feature, not an accident of the validator.

The check is a `Set.has` membership test against a Set built once at module
load. It runs once per component at startup -- a cold path -- so it has no
hot-path cost and there is no tradeoff to argue.

### AR-04 -- build `data` with `Object.create(null)`

`data` is now a null-prototype bag. `toString` / `constructor` schema keys land
in clean own slots instead of colliding with inherited members; `__proto__` no
longer has an inherited setter to hijack. The `for...in` in `remove()` walks a
shorter (empty) prototype chain, so if anything it is marginally faster -- the
hot body is byte-for-byte unchanged; only the object it iterates changed shape.

`data` is built from `Object.keys(schema)` -- own, enumerable, string keys only.
Two footguns fail closed rather than silently dropping a field:

- A schema whose prototype is neither `Object.prototype` nor `null` throws. This
  catches `{ __proto__: X }` in a literal, which sets the prototype (to a
  function) and leaves zero own keys -- the old silent field loss.
- A schema carrying symbol keys throws; symbols are never valid field names.

An **empty schema stays legal** by explicit allowance (zero keys pass the loop),
because `registerTag()` is `registerComponent({})`.

Validation lives in the `SparseSet` constructor (a shared `validateSchema()`),
so BOTH `arena.registerComponent()` and any direct `new SparseSet()` are
covered by one code path.

### AR-10 -- keep SparseSet exported, validate capacity + owner

Chosen: the `SparseSet` constructor requires its `arena` argument to be an
`Arena` instance and `maxEntities` to equal `arena.capacity`; otherwise it
throws a library error. `arena.registerComponent()` always passes
`arena.capacity`, so this only ever fires on hand-rolled construction.

**Rejected alternative**: stop exporting `SparseSet` as a constructor and export
it as a type only. It is cleaner, but it is a breaking change to the public
export shape, and `SparseSet` is a documented export in README and llms.txt.
A breaking export change does not belong in a minor. Validation closes the trap
without breaking anyone, so it wins for v1.5.0. The type-only export remains a
candidate for a future major.

### AR-11 -- checked-mode `idx()` -- DEFERRED

The brief invited a `checked: true` arena option making `idx()` on an
unattached entity throw instead of returning `0`. Deferred: every shape of it
adds a branch to `idx()` -- the documented ULTRA-FAST path -- even when the flag
is off, and R2's hot-path contract is that `spawn` / `despawn` / `add` / `has` /
`remove` / `idx` are untouched in the default configuration. Checked mode is a
focused decision of its own (where the flag lives, whether it wraps `idx`/`add`/
`remove`, its measured off-state cost) and is better taken deliberately than
bolted onto this data-hardening pass. Recorded here so it is tracked, not
forgotten.

## Consequences

- A component's `data` is now `Object.create(null)`, not `{}`. Code that read
  `data === {}` as literally-a-plain-object, or relied on `data.hasOwnProperty`
  / `data.toString` being inherited, must adjust. The claim "`data === {}`" in
  the docs is corrected to "a null-prototype object with the schema's keys" (an
  empty one for tags).
- Invalid schemas that used to "work" (silently producing an `Array` or boxed
  `Number`) now throw at registration. This is the point: they never worked; they
  corrupted the guarantees quietly.
- Hot paths unchanged; Phases A-E of the torture gate remain green at
  `maxMajor: 0`.
