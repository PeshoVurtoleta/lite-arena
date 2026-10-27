/**
 * @zakkster/lite-arena
 * Zero-GC Entity-Component-System (ECS) memory allocator.
 */

/**
 * An int32 handle holding both the entity slot index (low 20 bits)
 * and the generation counter (high 12 bits).
 *
 * Always pass entity handles as-is to API methods; never decompose them
 * by hand — the bit layout is an implementation detail.
 *
 * High-generation handles will appear negative when printed in decimal
 * (the high bit is set). This is the intended bit pattern; equality and
 * `isAlive()` comparisons remain correct.
 *
 * The handle is an int32: a Smi on 64-bit Node, but it may be a heap number on
 * 31-bit-Smi platforms (pointer compression, e.g. Chrome) for generations
 * 1024..3071 (nominal; Node cannot measure it).
 *
 * The 12-bit generation field issues 4095 live values per slot. A slot that
 * exhausts them is retired on despawn (see {@link Arena.retiredCount}) rather
 * than wrapping, so a stale handle can never alias as valid. Handles are not
 * unique across arenas: a handle from one arena (or a previous run) is only
 * meaningful to the arena that minted it.
 */
export type Entity = number;

/**
 * Valid typed-array constructors for SoA component schemas.
 */
export type TypedArrayConstructor =
    | Float32ArrayConstructor
    | Float64ArrayConstructor
    | Int32ArrayConstructor
    | Uint32ArrayConstructor
    | Int16ArrayConstructor
    | Uint16ArrayConstructor
    | Int8ArrayConstructor
    | Uint8ArrayConstructor
    | Uint8ClampedArrayConstructor;

/**
 * Maps a schema definition (`{ key: TypedArrayConstructor }`) to the
 * instantiated parallel TypedArrays on the resulting SparseSet.
 *
 * @example
 *   const set = arena.registerComponent({ x: Float32Array, hp: Uint16Array });
 *   //   set.data.x  has type Float32Array
 *   //   set.data.hp has type Uint16Array
 */
export type ComponentData<T extends Record<string, TypedArrayConstructor>> = {
    [K in keyof T]: InstanceType<T[K]>;
};

/**
 * The scratch object returned by {@link Arena.join}. `driver` is the component
 * with the smaller `count` (iterate its `dense[0..count)`), `other` is the one
 * to `has()`-check inside the loop, and `count` mirrors `driver.count`.
 *
 * This object is reused across `join()` calls on the same arena -- read it (or
 * start your loop) before the next `join()`; never retain it across calls. In
 * checked mode (`new Arena(n, { checked: true })`) reading any field of a plan
 * after a later `join()` superseded it throws instead of silently returning the
 * newer plan's values.
 */
export interface JoinPlan {
    driver: SparseSet<any>;
    other: SparseSet<any>;
    count: number;
}

/**
 * The scratch object returned by {@link Arena.joinN} -- the k-way generalization
 * of {@link JoinPlan}. `driver` is the rarest of the `required` sets (iterate its
 * `dense[0..count)`); `others[0..othersCount)` are the remaining required sets to
 * `has()`-check; `excl[0..exclCount)` are the excluded sets to `!has()`-check.
 *
 * `others` and `excl` are grow-once scratch arrays reused across calls: loop to
 * `othersCount`/`exclCount`, NEVER `others.length` (a larger prior call may leave
 * a stale tail). Like {@link JoinPlan}, the whole object is reused -- consume it
 * before the next `join()`/`joinN()` on the same arena; never retain it. In
 * checked mode, reading any field after a later `join()`/`joinN()` superseded it
 * throws (both share one epoch).
 */
export interface JoinNPlan {
    driver: SparseSet<any>;
    count: number;
    others: SparseSet<any>[];
    othersCount: number;
    excl: SparseSet<any>[];
    exclCount: number;
    /** The `reqMask` passed to `joinN()`, normalised `| 0` (omitted -> 0). */
    reqMask: number;
    /** The `excMask` passed to `joinN()`, normalised `| 0` (omitted -> 0). */
    excMask: number;
    /**
     * `arena.flags` at plan time; `null` without `registerFlags()`. `reserve()` replaces
     * the flag row and refreshes the production plan's `flags`, but a hoisted `row`
     * (and a checked plan) keeps the pre-reserve row -- re-read after growing.
     */
    flags: Int32Array | null;
}

export class Arena {
    /** Hard cap on total entities, as passed to the constructor. */
    readonly capacity: number;

    /** Current number of living entities. Read-only from user code. */
    readonly activeCount: number;

    /**
     * Number of slots permanently retired by generation exhaustion.
     *
     * A slot is retired when it has issued all 4095 of its live generations;
     * it is never recycled, so a stale handle can never alias as valid
     * (fail-closed rollover; see the docs on {@link Entity}). Retirement is a
     * cold-path event, but it is a budget, not a rarity: at the default 20/12
     * split the arena has `capacity x 4095` despawns from construction (the
     * free list is LIFO, so a hot slot is reused at once). The first retirement
     * lands at about `4095 x entity lifetime` and `spawn()` fails at or before
     * `capacity x 4095 / despawns-per-second`, sooner when many entities are
     * alive. `clear()` refills 4094 per revived slot; `reserve()` adds
     * `(newCap - cap) x 4095`. See decisions/0001 (erratum). Read-only.
     */
    readonly retiredCount: number;

    /**
     * Per-slot flag words (Int32Array, slot-indexed, length = capacity), or
     * `null` until {@link Arena.registerFlags} is called. Index with `e & indexMask`.
     * Like `data.x`, `reserve()` REPLACES this array: re-read it after growing.
     * Read-only from user code; write through setFlags / clearFlags.
     * Bits 30-31 are plain int32 inside the array; held in a JS variable they may be
     * heap numbers on pointer-compressed engines (nominal; Node cannot observe it).
     */
    readonly flags: Int32Array | null;

    /**
     * Mask that turns an {@link Entity} handle into its slot index (0xFFFFF
     * today). Hoist it in hot loops: `const m = arena.indexMask; row[e & m]`.
     * Do not hard-code 0xFFFFF. Read-only.
     */
    readonly indexMask: number;

    /**
     * Pre-allocates the ECS universe.
     * @param maxEntities Integer in `[1, 1048575]`.
     * @param options Optional. `checked: true` enables development-mode
     *   assertions -- a stale {@link Arena.join} plan and a misused
     *   {@link SparseSet.idx} throw, and setFlags / clearFlags / hasFlags throw
     *   unless every mask is a 32-bit integer (non-number, NaN, fraction, +-Infinity
     *   or a value outside both int32 and uint32 throws; 0x80000000 is accepted) -- that are OFF and
     *   zero-cost in production.
     *   The production hot paths are byte-for-byte unaffected by this flag.
     * @throws Error when `maxEntities` is not an integer in that range.
     */
    constructor(maxEntities: number, options?: { checked?: boolean });

    /**
     * O(1) entity allocation.
     * @returns An int32 generational handle.
     * @throws Error when all slots are in use.
     */
    spawn(): Entity;

    /**
     * O(1) liveness check. Safe to call on any 32-bit integer.
     * Returns true only when the handle matches the slot's current generation.
     * A free slot (never spawned, despawned, cleared or reserved) is never alive,
     * including its next handle (FREE flag, decisions/0009).
     */
    isAlive(entity: Entity): boolean;

    /**
     * Despawn: O(registered components). Removes the entity from every
     * registered component (via swap-and-pop), bumps the slot's generation, and returns the slot
     * to the free list.
     * @returns true if the entity was alive, false if the handle was already stale
     *   or names a free slot (nothing changes in that case).
     */
    despawn(entity: Entity): boolean;

    /**
     * O(1). Slots still available for {@link Arena.spawn} right now:
     * `capacity - activeCount - retiredCount`. Equals the free-list length, so
     * `activeCount + retiredCount + remainingCapacity() === capacity` always
     * holds. Falls below `capacity - activeCount` once slots retire, so a `0`
     * here with a low `activeCount` means slots have retired (see
     * {@link Arena.retiredCount}), not that the arena is full. Never negative.
     */
    remainingCapacity(): number;

    /**
     * Mounts a new SoA component definition to the arena.
     * Each schema key becomes a parallel TypedArray of length `capacity`.
     *
     * The schema is validated at registration (a cold path): every field type
     * must be one of the nine numeric TypedArray constructors. A lying schema
     * (`Array`, `Object`, `SharedArrayBuffer`, `BigInt64Array`, a string, etc.)
     * throws a library error naming the offending key. `data` is built as an
     * `Object.create(null)` bag, so `toString` / `constructor` are usable field
     * names and a `__proto__` key throws instead of silently dropping a field.
     *
     * Pass `{ buffers }` to have each `data[key]` VIEW a caller-owned buffer --
     * an `ArrayBuffer` or `SharedArrayBuffer` -- instead of one the arena
     * allocates, so a component's payload can live in memory shared with a
     * Worker. When supplied, `buffers` must give one buffer of exactly
     * `capacity * BYTES_PER_ELEMENT` bytes for EVERY schema field and no others,
     * validated fail-closed in both directions; omitting it own-allocates as
     * before. The arena never frees, grows, or reassigns a caller-supplied
     * buffer, and `reserve()` refuses to grow an arena that has any caller-backed
     * component (see decisions/0006). The tick loop is identical either way.
     *
     * @example
     *   const Transform = arena.registerComponent({
     *       x: Float32Array,
     *       y: Float32Array,
     *   });
     *   // Shared payload for a Worker:
     *   const sab = new SharedArrayBuffer(arena.capacity * 4);
     *   const Vel = arena.registerComponent({ vx: Float32Array }, { buffers: { vx: sab } });
     * @throws {Error} If any field type is not a numeric TypedArray constructor,
     *   the schema carries a `__proto__` / symbol key, or (when `buffers` is
     *   given) any field lacks a correctly-typed, correctly-sized buffer or a
     *   buffer targets no declared field.
     */
    registerComponent<T extends Record<string, TypedArrayConstructor>>(
        schema: T,
        options?: { buffers?: { [K in keyof T]?: ArrayBufferLike } }
    ): SparseSet<T>;

    /**
     * Registers a zero-size TAG component: membership tracking with no payload.
     * Equivalent to `registerComponent({})`; the returned set's `data` is an
     * empty null-prototype object. Use `add`/`has`/`remove` and iterate
     * `dense[0..count)`.
     */
    registerTag(): SparseSet<{}>;

    /**
     * Cold-path planner for a two-component join. Returns references (not an
     * iterator) so the caller writes the tight loop; picks the component with
     * the smaller `count` as `driver`. Allocates nothing -- the returned object
     * is a scratch reused across calls; consume it before the next `join()`.
     *
     * @param a One component.
     * @param b The other component.
     * @returns The reused {@link JoinPlan}: `{ driver, other, count }`.
     */
    join(a: SparseSet<any>, b: SparseSet<any>): JoinPlan;

    /**
     * Cold-path planner for a k-way join with exclusions: "entities in every
     * `required` set AND in none of the `excluded` sets". The k-input
     * generalization of {@link Arena.join}; the two-set `join` is untouched.
     * Returns references (not an iterator) so the caller writes the tight loop;
     * picks the rarest `required` set as `driver` (ties favour the first).
     * Allocates nothing in steady state -- the returned object and its `others`/
     * `excl` arrays are reused scratch (the arrays grow once to their high-water
     * mark). Consume before the next `join()`/`joinN()`.
     *
     * Fail-closed: throws if `required` is empty or null (there is no honest
     * result for zero required sets). `excluded` omitted or null is the empty
     * list. A set that is both required and excluded yields the empty match (and
     * throws in checked mode).
     *
     * Flag masks (M-4, optional): both are normalised `| 0` (omitted -> 0) and
     * carried on the plan with a `flags` reference, so the caller's loop does ONE
     * `flags[e & arena.indexMask]` read per candidate and tests
     * `(w & rm) === rm && (w & xm) === 0`. A non-zero mask on an arena without
     * `registerFlags()` throws before any state write (M-10); an empty `required`
     * still throws the required-set error first (M-11 -- a flags-only scan is a
     * caller loop over `arena.flags`, O(capacity)). `reqMask & excMask` != 0
     * matches nothing in production and throws in checked mode (M-13). Checked
     * mode also throws when a SUPPLIED mask is not a 32-bit integer (M-20),
     * including a supplied-but-`undefined` one (a misspelled `F.tpyo`, M-25); a
     * truly omitted mask is 0. Production stays a plain `| 0`: there a misspelled
     * mask reads 0 and fails open (matches as if no mask). NOMINAL: a mask outside [-2^30, 2^30 - 1]
     * may be a heap number on pointer-compressed engines; hoist it into a local.
     *
     * @param required Non-empty; entities must be in ALL of these.
     * @param excluded Entities must be in NONE of these (default: empty).
     * @param reqMask Every bit must be set in the entity's flag word (default 0;
     *   pass 0 to skip it -- a positional `undefined`, as in
     *   `joinN(R, E, undefined, F.c)`, throws in checked mode).
     * @param excMask No bit may be set in the entity's flag word (default 0).
     * @returns The reused {@link JoinNPlan}.
     */
    joinN(required: SparseSet<any>[], excluded?: SparseSet<any>[], reqMask?: number, excMask?: number): JoinNPlan;

    /**
     * Explicit, opt-in capacity growth -- the ONLY way the universe grows.
     * There is no auto-grow: `spawn()` at capacity throws and never calls this.
     *
     * Reallocates every backing buffer (arena-level and each component's `dense`
     * + every `data.*`), copying live contents, so every {@link Entity} handle,
     * every membership, and every dense index is preserved. Grow-only: a
     * `newCapacity <= capacity` request is a no-op that returns `false`.
     *
     * COLD, BETWEEN-FRAMES ONLY. Because the buffers move, any typed-array
     * reference you hoisted before the call -- `const x = comp.data.x`, a saved
     * `comp.dense`, etc. -- is STALE afterward and must be re-read. This is by
     * design; it is precisely why growth is never implicit.
     *
     * Throws if ANY registered component is backed by caller-supplied buffers
     * (option A, exclusive): the arena cannot resize a buffer it does not own,
     * and there is no synchronous way to signal a Worker that its view detached.
     * Size caller-backed buffers for the maximum capacity up front. See
     * decisions/0006. It ALSO throws if any component has a DETACHED field (a
     * buffer transferred to a Worker and not yet rebound) -- growing it would
     * silently copy zero bytes; rebind the returned buffer first. See
     * decisions/0007.
     *
     * New slots start free (their next handle is not alive) and add
     * `(newCap - cap) x 4095` to the despawn budget.
     *
     * @param newCapacity Target capacity; an integer `<= 1048575`.
     * @returns `true` if the arena grew, `false` if it was already large enough.
     * @throws Error when `newCapacity` is not an integer, exceeds 1048575, any
     *   registered component is caller-backed, or any component has a detached field.
     */
    reserve(newCapacity: number): boolean;

    /**
     * Resets the arena to empty WITHOUT reallocating: rebuilds the free list,
     * advances every generation, revives every retired slot, and drops each
     * registered component's `count` to 0. O(capacity); a cold, between-frames
     * operation that allocates nothing. Every slot is left free, with 4094
     * generations per revived slot still to issue.
     *
     * Every {@link Entity} handle minted before `clear()` is INVALID afterward --
     * `isAlive()` rejects it (the honest contract of a reset). Reviving retired
     * slots restores full capacity and returns `retiredCount` to 0. Do not retain
     * or test any pre-clear handle across a `clear()`; handles persisted from
     * another run fail closed on a fresh or cleared arena.
     */
    clear(): void;

    /**
     * COLD, once per arena: allocates {@link Arena.flags} and returns a frozen
     * null-prototype map `{ name: bit }`, name i -> `1 << i` (name #32 is
     * -2147483648, the Int32 sign bit). `registerFlags()` and `registerFlags([])`
     * allocate the row and return a frozen `{}`.
     *
     * @param names At most 32 distinct non-empty strings (`'__proto__'` is allowed).
     * @param options `undefined` / `null` / a plain object with NO own keys (prototype
     *   Object.prototype or null).
     * @throws Error on a second call, more than 32 names, a duplicate / empty /
     *   non-string name, a non-plain options object, or any options key. A throw
     *   leaves `flags` null.
     */
    registerFlags(names?: readonly string[], options?: Record<string, never> | null): Readonly<Record<string, number>>;

    /**
     * O(1): ORs `mask | 0` into the entity's flag word (0x80000000 works).
     * Precondition: registerFlags() was called; before that, on a live handle, it throws a native
     * TypeError (null row). A dead handle returns `false` and writes nothing;
     * `setFlags(e, 0)` on a live entity is a no-op returning `true`.
     * PRODUCTION fails open on a typo: `F.tpyo` is undefined, `undefined | 0` is 0,
     * so the call is a silent no-op that returns `true`. Checked mode throws instead.
     * @returns `true` if the entity is alive.
     */
    setFlags(entity: Entity, mask: number): boolean;

    /**
     * O(1): clears `mask | 0` in the entity's flag word. Same precondition,
     * dead-handle and typo behaviour as {@link Arena.setFlags}.
     * @returns `true` if the entity is alive.
     */
    clearFlags(entity: Entity, mask: number): boolean;

    /**
     * O(1): alive AND `(row & required) === required` AND `(row & excluded) === 0`.
     * `excluded` defaults to 0. `hasFlags(e, 0)` on a live entity is `true`. A dead
     * handle is `false`. Same precondition as {@link Arena.setFlags}; a typo'd mask
     * reads as 0 in production (so `hasFlags(e, F.tpyo)` is `true`), and throws in
     * checked mode. Checked mode does NOT reject unregistered bits.
     */
    hasFlags(entity: Entity, required: number, excluded?: number): boolean;
}

export class SparseSet<T extends Record<string, TypedArrayConstructor>> {
    /** Current number of entities possessing this component. */
    readonly count: number;

    /**
     * The packed, contiguous array of living entity handles.
     * Valid range: `[0, count)`. Indices >= count contain stale data.
     *
     * Int32Array, not Uint32Array: an entity handle is a SIGNED 32-bit int
     * (negative once a slot reaches generation 2048), and `dense` stores whole
     * handles. Read a handle out of `dense[i]` and pass it straight back to the
     * API; do not `>>> 0` it or store it in an unsigned view.
     */
    readonly dense: Int32Array;

    /**
     * The parallel SoA payload data. Each key is a TypedArray of the
     * declared type, indexable from 0 to `count - 1`. Replace a column only
     * via `rebind()`; `reserve()` replaces every column -- re-read after.
     * Never assign `data[key]` directly (`remove()` will not honour it).
     */
    readonly data: ComponentData<T>;

    /**
     * Prefer `arena.registerComponent(schema)` — the arena version registers
     * this set for automatic cleanup on entity despawn.
     *
     * Direct construction is validated: `arena` must be an `Arena` and
     * `maxEntities` must equal `arena.capacity`, or the constructor throws. A
     * mismatched-capacity set would silently discard out-of-range writes and,
     * being unregistered, would never be cleaned on despawn.
     *
     * The optional `buffers` map makes each `data[key]` view a caller-owned
     * `ArrayBuffer` / `SharedArrayBuffer` instead of an allocated array; it is
     * validated fail-closed in both directions. See {@link Arena.registerComponent}.
     *
     * @throws {Error} If `arena` is not an `Arena`, `maxEntities !== arena.capacity`,
     *   the schema is invalid, or (when `buffers` is given) any field lacks a
     *   correctly-typed, correctly-sized buffer or a buffer targets no field
     *   (see {@link Arena.registerComponent}).
     */
    constructor(
        maxEntities: number,
        schema: T,
        arena: Arena,
        buffers?: { [K in keyof T]?: ArrayBufferLike }
    );

    /** O(1). True if the entity is alive AND possesses this component. */
    has(entity: Entity): boolean;

    /**
     * Attaches the component to the entity.
     * @returns The dense array index to access `this.data`, or `-1` if the entity is dead.
     *   If the entity already has this component, returns the existing index.
     */
    add(entity: Entity): number;

    /**
     * O(1) Swap-and-Pop removal.
     * @returns true if removed, false if the entity didn't have this component.
     */
    remove(entity: Entity): boolean;

    /**
     * Unsafe fast-path: returns the dense data index for an entity.
     * Does NOT check liveness or membership.
     * Only use this inside tight loops where validity is guaranteed
     * (e.g. iterating `dense[0..count)`).
     *
     * In checked mode (`new Arena(n, { checked: true })`) this throws when the
     * entity is dead or does not hold the component; production is unchecked and
     * uses the prototype fast path unchanged.
     */
    idx(entity: Entity): number;

    /**
     * COLD PATH. Collect the backing `ArrayBuffer`(s) for the given fields, ready
     * to spread into a `postMessage(msg, transferList)` transfer list -- the SEND
     * half of a transferable round-trip. Does NOT itself detach: transferring the
     * returned buffer is what detaches the sender's view; {@link isDetached} reads
     * the truth afterward. Sugar over `comp.data[key].buffer`, but it validates
     * the field names.
     *
     * @param keys Fields to collect; omit for every field, in schema order.
     * @returns The backing buffers, in `keys` order.
     * @throws If `keys` is not an array, or names a field not in the schema.
     */
    detach(keys?: (keyof T & string)[]): ArrayBufferLike[];

    /**
     * COLD PATH. Is this field's backing buffer currently detached -- transferred
     * away and not yet rebound? Truthful, not bookkept: a transferred buffer
     * detaches its view to zero length, so this reads `byteLength === 0`. Use it
     * as a ONCE-PER-FRAME system guard (iterating a detached field is a caller
     * bug), never per element.
     *
     * @throws If `key` is not a field in the schema.
     */
    isDetached(key: keyof T & string): boolean;

    /**
     * COLD PATH. Re-point one or more `data[key]` views at caller-supplied
     * buffers -- typically the ones a Worker transferred back (the RETURN half of
     * a transferable round-trip). A PARTIAL map: only the supplied fields are
     * re-pointed; the rest are left untouched. Fail-closed like registration --
     * an unknown key, wrong type, or a buffer not spanning exactly
     * `capacity * BYTES_PER_ELEMENT` throws, and nothing is re-pointed until every
     * supplied buffer passes (no half-applied state). After a successful rebind
     * the set is caller-backed, so {@link Arena.reserve} refuses to grow it.
     *
     * @throws On a non-object/empty map, unknown key, wrong type, or wrong size.
     */
    rebind(buffers: { [K in keyof T]?: ArrayBufferLike }): void;
}
