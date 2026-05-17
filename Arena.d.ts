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

export class Arena {
    /** Hard cap on total entities, as passed to the constructor. */
    readonly capacity: number;

    /** Current number of living entities. Read-only from user code. */
    readonly activeCount: number;

    /**
     * Pre-allocates the ECS universe.
     * @param maxEntities Integer in `[1, 1048575]`.
     * @throws Error when `maxEntities` is not an integer in that range.
     */
    constructor(maxEntities: number);

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
     * Mounts a new SoA component definition to the arena.
     * Each schema key becomes a parallel TypedArray of length `capacity`.
     *
     * @example
     *   const Transform = arena.registerComponent({
     *       x: Float32Array,
     *       y: Float32Array,
     *   });
     */
    registerComponent<T extends Record<string, TypedArrayConstructor>>(
        schema: T
    ): SparseSet<T>;
}

export class SparseSet<T extends Record<string, TypedArrayConstructor>> {
    /** Current number of entities possessing this component. */
    readonly count: number;

    /**
     * The packed, contiguous array of living entity handles.
     * Valid range: `[0, count)`. Indices >= count contain stale data.
     */
    readonly dense: Uint32Array;

    /**
     * The parallel SoA payload data. Each key is a TypedArray of the
     * declared type, indexable from 0 to `count - 1`.
     */
    readonly data: ComponentData<T>;

    /**
     * Prefer `arena.registerComponent(schema)` — the arena version registers
     * this set for automatic cleanup on entity despawn.
     */
    constructor(maxEntities: number, schema: T, arena: Arena);

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
     */
    idx(entity: Entity): number;
}
