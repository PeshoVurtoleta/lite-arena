/**
 * @zakkster/lite-arena — Zero-GC Entity-Component-System (ECS)
 *
 * Architecture:
 *   - Generational Handles: 32-bit integers (20 bits index, 12 bits generation).
 *     Prevents the ABA problem (modifying a recycled entity slot via a stale handle).
 *     Note: 12 bits = 4096 generations. If a slot is rapidly spawned/despawned
 *     more than 4095 times before a stored handle is discarded, that stale handle
 *     will alias as valid. For most workloads this is effectively unreachable;
 *     for adversarial or extremely long-lived handles, prefer to retire them
 *     when the entity dies.
 *   - SoA Sparse Sets: Component data is strictly parallel typed arrays.
 *   - Swap-and-Pop: O(1) component removal keeps dense arrays contiguous
 *     without shifting.
 *   - Zero-GC: All buffers and free-lists are allocated once at construction.
 *
 * @module @zakkster/lite-arena
 * @author Zahary Shinikchiev
 * @license MIT
 */

const INDEX_MASK = 0xFFFFF; // 20 bits -> Max 1,048,575 entities
const GEN_MASK = 0xFFF;     // 12 bits -> 4096 generations

export class Arena {
    /**
     * Allocates the memory pools for the ECS universe. Call once at setup.
     * @param {number} maxEntities - Hard cap on living entities. Must be an
     *   integer in the range [1, 1048575]. Values outside this range throw.
     * @throws {Error} If `maxEntities` is not an integer in [1, 1048575].
     */
    constructor(maxEntities) {
        if (!Number.isInteger(maxEntities) || maxEntities < 1 || maxEntities > INDEX_MASK) {
            throw new Error(`lite-arena: maxEntities must be an integer in [1, ${INDEX_MASK}], got ${maxEntities}`);
        }

        this.capacity = maxEntities | 0;
        this.activeCount = 0 | 0;

        // Generational anti-stale tracking. Initialized to 1 (not 0) so that
        // the synthesized handle `0` — and any handle whose generation bits
        // are zero — is reliably rejected by isAlive on a fresh arena.
        // Bumped on despawn; wraps via 12-bit mask.
        this.generations = new Uint32Array(maxEntities).fill(1);

        // O(1) internal implicit free-list. Each slot stores the next free index.
        this.freeList = new Uint32Array(maxEntities);
        for (let i = 0; i < maxEntities - 1; i++) {
            this.freeList[i] = (i + 1) | 0;
        }
        // Sentinel value indicating OOM (no more free slots).
        this.freeList[maxEntities - 1] = INDEX_MASK;
        this.freeHead = 0 | 0;

        /** @type {SparseSet[]} Components registered to this arena. */
        this.components = [];
    }

    /**
     * O(1) entity allocation. Pops from the free list.
     * @returns {number} A 32-bit integer entity handle. The handle encodes
     *   both the slot index (low 20 bits) and the generation (high 12 bits).
     *   Always pass the handle as-is to other API methods; do not decompose it.
     * @throws {Error} If the arena is full.
     */
    spawn() {
        if (this.freeHead === INDEX_MASK) throw new Error("lite-arena: out of memory");

        const index = this.freeHead;
        this.freeHead = this.freeList[index];

        const gen = this.generations[index];
        this.activeCount = (this.activeCount + 1) | 0;

        // Note: bitwise OR treats operands as signed 32-bit. High generations
        // will result in a negative integer. This is perfectly safe as a bit pattern.
        return (gen << 20) | index;
    }

    /**
     * Verifies if a handle points to a living entity.
     * Safe to call on any 32-bit integer; never throws.
     * @param {number} entity - The 32-bit handle.
     * @returns {boolean}
     */
    isAlive(entity) {
        const index = entity & INDEX_MASK;
        // Use >>> to prevent sign-extension from high generations.
        const gen = (entity >>> 20) & GEN_MASK;
        return this.generations[index] === gen;
    }

    /**
     * O(1) despawn. Removes the entity from all components, invalidates
     * its generation, and returns the slot to the free list.
     * @param {number} entity
     * @returns {boolean} True if successfully despawned, false if already dead.
     */
    despawn(entity) {
        if (!this.isAlive(entity)) return false;

        const index = entity & INDEX_MASK;

        // 1. Remove from all registered component sets (O(1) swap-and-pop each).
        for (let i = 0; i < this.components.length; i++) {
            this.components[i].remove(entity);
        }

        // 2. Bump generation to invalidate stale handles sitting in closures.
        this.generations[index] = (this.generations[index] + 1) & GEN_MASK;

        // 3. Return slot to the head of the free list.
        this.freeList[index] = this.freeHead;
        this.freeHead = index;
        this.activeCount = (this.activeCount - 1) | 0;

        return true;
    }

    /**
     * Mounts a new SoA component definition to the arena.
     * Each key of the schema becomes a parallel TypedArray of length `capacity`.
     * @param {Object<string, Function>} schema - e.g. `{ x: Float32Array, y: Float32Array }`.
     * @returns {SparseSet}
     */
    registerComponent(schema) {
        const set = new SparseSet(this.capacity, schema, this);
        this.components.push(set);
        return set;
    }
}

export class SparseSet {
    /**
     * Construct a sparse-set-backed component pool. Prefer
     * `arena.registerComponent(schema)` over calling this directly — the arena
     * version also registers the set for automatic cleanup on despawn.
     *
     * @param {number} maxEntities
     * @param {Object<string, Function>} schema
     * @param {Arena} arena
     */
    constructor(maxEntities, schema, arena) {
        this.arena = arena;
        this.count = 0 | 0;

        // Maps global entity index -> local dense array index.
        // Stale slots may contain garbage; always validate via `has()`.
        this.sparse = new Uint32Array(maxEntities);

        // Contiguous array of living entity handles. Indices [0, count) are valid.
        this.dense = new Uint32Array(maxEntities);

        /** @type {Object<string, ArrayBufferView>} Parallel SoA payload arrays. */
        this.data = {};
        for (const key in schema) {
            const TypedArrayConstructor = schema[key];
            this.data[key] = new TypedArrayConstructor(maxEntities);
        }
    }

    /**
     * O(1) membership check. Returns false for dead handles.
     * @param {number} entity
     * @returns {boolean}
     */
    has(entity) {
        if (!this.arena.isAlive(entity)) return false;
        const index = entity & INDEX_MASK;
        const denseIdx = this.sparse[index];
        return denseIdx < this.count && this.dense[denseIdx] === entity;
    }

    /**
     * O(1) attachment. If the entity is dead, returns -1. If the entity
     * already has this component, returns the existing dense index.
     * @param {number} entity
     * @returns {number} The integer index to read/write into `this.data` arrays,
     *   or -1 if the entity is dead.
     */
    add(entity) {
        if (!this.arena.isAlive(entity)) return -1;

        const index = entity & INDEX_MASK;
        const currentDense = this.sparse[index];

        // Inline duplicate check. The full-handle comparison (including generation)
        // correctly rejects stale slot entries left over from previous swap-and-pops.
        if (currentDense < this.count && this.dense[currentDense] === entity) {
            return currentDense; // Already added.
        }

        const denseIdx = this.count;
        this.sparse[index] = denseIdx;
        this.dense[denseIdx] = entity;
        this.count = (denseIdx + 1) | 0;

        return denseIdx;
    }

    /**
     * O(1) Swap-and-Pop removal. Keeps the dense arrays perfectly contiguous
     * without O(N) shifts.
     *
     * Note: Does NOT zero out the slot at `count` after popping. Stale data
     * at indices >= count is undefined; iterate only [0, count).
     *
     * @param {number} entity
     * @returns {boolean} True if removed, false if not found.
     */
    remove(entity) {
        if (!this.has(entity)) return false;

        const index = entity & INDEX_MASK;
        const denseIdx = this.sparse[index];
        const lastDenseIdx = (this.count - 1) | 0;

        // If it's not the very last element, move the last element into this slot.
        if (denseIdx !== lastDenseIdx) {
            const lastEntity = this.dense[lastDenseIdx];
            const lastIndex = lastEntity & INDEX_MASK;

            this.dense[denseIdx] = lastEntity;
            this.sparse[lastIndex] = denseIdx;

            // Swap all parallel SoA data arrays.
            for (const key in this.data) {
                const arr = this.data[key];
                arr[denseIdx] = arr[lastDenseIdx];
            }
        }

        this.count = lastDenseIdx;
        return true;
    }

    /**
     * ULTRA-FAST PATH: Returns the dense-array index for an entity.
     *
     * Skips both the alive check and the membership check. Only safe to call
     * inside tight loops where you have *already* validated via `has()` or you
     * are iterating `dense[0..count)` (which is guaranteed valid).
     *
     * @param {number} entity
     * @returns {number}
     */
    idx(entity) {
        return this.sparse[entity & INDEX_MASK];
    }
}
