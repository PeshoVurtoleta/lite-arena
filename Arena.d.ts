/**
 * @zakkster/lite-arena
 * Zero-GC Entity-Component-System (ECS) memory allocator.
 */

/**
 * A 32-bit SMI handle holding both the entity slot index (low 20 bits)
 * and the generation counter (high 12 bits).
 *
 * Always pass entity handles as-is to API methods; never decompose them
 * by hand — the bit layout is an implementation detail.
 *
 * High-generation handles will appear negative when printed in decimal
 * (the high bit is set). This is the intended bit pattern; equality and
 * `isAlive()` comparisons remain correct.
 *
 * The 12-bit generation field issues 4095 live values per slot. A slot that
 * exhausts them is retired on despawn (see {@link Arena.retiredCount}) rather
 * than wrapping, so a stale handle can never alias as valid.
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
     * cold-path event and never fires on realistic workloads -- entities that
     * live for >= 1 frame never cycle a single slot 4095 times. Non-zero here
     * means you have entered the adversarial-churn regime and are losing a slot
     * of capacity per exhausted slot. Read-only.
     */
    readonly retiredCount: number;

    /**
     * Pre-allocates the ECS universe.
     * @param maxEntities Integer in `[1, 1048575]`.
     * @param options Optional. `checked: true` enables development-mode
     *   assertions -- a stale {@link Arena.join} plan and a misused
     *   {@link SparseSet.idx} throw -- that are OFF and zero-cost in production.
     *   The production hot paths are byte-for-byte unaffected by this flag.
     * @throws Error when `maxEntities` is not an integer in that range.
     */
    constructor(maxEntities: number, options?: { checked?: boolean });

    /**
     * O(1) entity allocation.
     * @returns A 32-bit generational handle.
     * @throws Error when all slots are in use.
     */
    spawn(): Entity;

    /**
     * O(1) liveness check. Safe to call on any 32-bit integer.
     * Returns true only when the handle matches the slot's current generation.
     */
    isAlive(entity: Entity): boolean;

    /**
     * O(1) despawn. Removes the entity from every registered component
     * (via swap-and-pop), bumps the slot's generation, and returns the slot
     * to the free list.
     * @returns true if the entity was alive, false if the handle was already stale.
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
     * decisions/0006.
     *
     * @param newCapacity Target capacity; an integer `<= 1048575`.
     * @returns `true` if the arena grew, `false` if it was already large enough.
     * @throws Error when `newCapacity` is not an integer, exceeds 1048575, or any
     *   registered component is caller-backed.
     */
    reserve(newCapacity: number): boolean;

    /**
     * Resets the arena to empty WITHOUT reallocating: rebuilds the free list,
     * advances every generation, revives every retired slot, and drops each
     * registered component's `count` to 0. O(capacity); a cold, between-frames
     * operation that allocates nothing.
     *
     * Every {@link Entity} handle minted before `clear()` is INVALID afterward --
     * `isAlive()` rejects it (the honest contract of a reset). Reviving retired
     * slots restores full capacity and returns `retiredCount` to 0. Do not retain
     * or test any pre-clear handle across a `clear()`.
     */
    clear(): void;
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
     * declared type, indexable from 0 to `count - 1`.
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
}
