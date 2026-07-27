/**
 * @zakkster/lite-arena — Zero-GC Entity-Component-System (ECS)
 *
 * Architecture:
 *   - Generational Handles: 32-bit integers (20 bits index, 12 bits generation).
 *     Prevents the ABA problem (modifying a recycled entity slot via a stale handle).
 *     The 12-bit counter issues 4095 live generations per slot. When a slot has
 *     issued its last generation it is RETIRED on despawn -- never recycled -- so
 *     a stale handle can never alias as valid. This is fail-closed: instead of
 *     silently reusing a wrapped generation, the slot is permanently withdrawn
 *     (see `retiredCount` and decisions/0001-generational-rollover.md). Retirement
 *     is a cold-path event; `isAlive()` and the hot loop are unaffected.
 *   - SoA Sparse Sets: Component data is strictly parallel typed arrays.
 *   - Swap-and-Pop: O(1) component removal keeps dense arrays contiguous
 *     without shifting.
 *   - Zero-GC: All buffers and free-lists are allocated once at construction.
 *     They grow only via an explicit, between-frames `reserve()` call -- never
 *     implicitly, so `spawn()` can never reallocate and invalidate hoisted refs.
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

        // Slots withdrawn by generation exhaustion (fail-closed rollover guard).
        // Bumped only in the despawn cold path; never read on any hot path.
        this.retiredCount = 0 | 0;

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

        // Reused scratch for join(). Allocated ONCE here so join() -- a cold
        // per-system planner -- hands back references without allocating on any
        // call. Mutated in place and returned; see join() for the reuse contract.
        this._joinResult = { driver: null, other: null, count: 0 };
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

        // Note: bitwise OR treats operands as signed 32-bit, so a generation of
        // 2048 or more sets the sign bit and the handle is NEGATIVE. That is fine
        // -- but only because `dense` is an Int32Array (same signedness), so a
        // stored handle round-trips through `dense[i] === entity`. Returning
        // `(...) >>> 0` here would push high handles above 2^31, out of the SMI
        // range and into heap-boxed doubles -- an allocation on the spawn path.
        // The signed handle is correct; the container carries the signedness.
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

        this.activeCount = (this.activeCount - 1) | 0;

        // 2. Advance the generation to invalidate stale handles in closures.
        //    A slot issues live generations 1..GEN_MASK. If this despawn returns
        //    the last one (GEN_MASK), the next bump would wrap and re-issue a
        //    previously-handed-out generation -- reopening the ABA hole. Fail
        //    closed instead: RETIRE the slot. Poison its generation to
        //    GEN_MASK + 1 (one bit above the 12-bit handle range, so isAlive
        //    rejects every handle, synthesized gen-0 included) and do NOT relink
        //    it into the free list, so spawn can never reuse it. Cold path only:
        //    isAlive() and idx() are untouched.
        if (this.generations[index] === GEN_MASK) {
            this.generations[index] = GEN_MASK + 1;
            this.retiredCount = (this.retiredCount + 1) | 0;
            return true;
        }

        this.generations[index] = this.generations[index] + 1;

        // 3. Return slot to the head of the free list.
        this.freeList[index] = this.freeHead;
        this.freeHead = index;

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

    /**
     * Registers a zero-size TAG component: a SparseSet that tracks membership
     * only, with no payload arrays. Exactly `registerComponent({})` -- `data`
     * is an empty object -- given a name so the intent reads at the call site.
     *
     * Use `add(e)` to tag, `has(e)` to test, `remove(e)` to untag, and iterate
     * `dense[0..count)` to walk every tagged entity. Like any component, tags
     * are cleared automatically on `despawn(e)`.
     *
     * @returns {SparseSet} A membership-only set (`data === {}`).
     */
    registerTag() {
        return this.registerComponent({});
    }

    /**
     * Cold-path planner for a two-component join ("entities with A AND B").
     * Reads both counts and hands back the component with the SMALLER count as
     * the `driver`, so the caller iterates the rarer set and `has()`-checks the
     * other -- the cheapest way to intersect two sparse sets.
     *
     * This is NOT a query API and it does NOT iterate: it returns references so
     * the caller writes the tight loop themselves. It allocates nothing -- the
     * returned object is a scratch reused across calls, owned by the arena.
     * Read `driver` / `other` / `count` (or start your loop) BEFORE the next
     * `join()` call on this arena; do not retain the object across calls.
     *
     * @param {SparseSet} a
     * @param {SparseSet} b
     * @returns {{ driver: SparseSet, other: SparseSet, count: number }}
     *   `driver` is whichever of `a`/`b` has the smaller `count` (ties favour
     *   `a`); `other` is the remaining component; `count` is `driver.count`.
     *
     * @example
     *   // Iterate the rarer of Poisoned / Position, once per system (cold):
     *   const j = arena.join(Poisoned, Position);
     *   const drv = j.driver, oth = j.other, n = j.count;   // hoist, then loop
     *   for (let i = 0; i < n; i++) {
     *       const e = drv.dense[i];
     *       if (!oth.has(e)) continue;
     *       // ... e has BOTH components ...
     *   }
     */
    join(a, b) {
        const r = this._joinResult;
        if (a.count <= b.count) {
            r.driver = a; r.other = b; r.count = a.count;
        } else {
            r.driver = b; r.other = a; r.count = b.count;
        }
        return r;
    }

    /**
     * Explicit, opt-in capacity growth. The ONLY way the universe ever grows.
     *
     * There is deliberately no auto-grow: `spawn()` at capacity throws and never
     * calls this. Growth reallocates every backing array (arena-level and every
     * component's `dense` + each `data.*`), so it MUST be caller-initiated and
     * MUST happen between frames -- never inside a hot loop. Live contents are
     * copied, so every handle, every membership, and every dense index survives.
     *
     * LOUD CAVEAT -- STALE HOISTED REFERENCES: after `reserve()` returns true,
     * every typed-array reference you previously hoisted (`const x = comp.data.x`,
     * or a saved `arena.generations` / `comp.dense`) points at the OLD, discarded
     * buffer. Re-read `comp.data.x` (etc.) after reserving. This is by design and
     * is exactly why growth is not implicit: an auto-grow would invalidate those
     * references mid-frame with no call site to blame.
     *
     * Cold path only: `spawn` / `despawn` / `isAlive` / `idx` bodies are
     * untouched, and nothing on any hot path ever reaches this method.
     *
     * @param {number} newCapacity - Target capacity. Must be an integer
     *   <= 1048575 (the 20-bit handle-index ceiling).
     * @returns {boolean} `true` if the arena grew; `false` (a no-op) if
     *   `newCapacity <= capacity`.
     * @throws {Error} If `newCapacity` is not an integer, or exceeds 1048575.
     */
    reserve(newCapacity) {
        if (!Number.isInteger(newCapacity) || newCapacity > INDEX_MASK) {
            throw new Error(`lite-arena: reserve capacity must be an integer <= ${INDEX_MASK}, got ${newCapacity}`);
        }
        // Grow-only. Shrinking would strand live entities in dropped slots, so a
        // request for the same-or-smaller capacity is a defined no-op.
        if (newCapacity <= this.capacity) return false;

        const oldCapacity = this.capacity;

        // Generations: copy live/retired state verbatim; initialize the new
        // slots to generation 1 (same as the constructor) so a synthesized
        // gen-0 handle into the new region is rejected by isAlive.
        const newGenerations = new Uint32Array(newCapacity);
        newGenerations.set(this.generations);
        newGenerations.fill(1, oldCapacity);
        this.generations = newGenerations;

        // Free list: copy the existing chain intact, then push the fresh slots
        // [oldCapacity, newCapacity) onto the head so spawn() hands them out
        // first. The tail of the new chain points at the old freeHead -- which
        // is INDEX_MASK when the arena was full, correctly terminating the list.
        const newFreeList = new Uint32Array(newCapacity);
        newFreeList.set(this.freeList);
        for (let i = oldCapacity; i < newCapacity - 1; i++) {
            newFreeList[i] = (i + 1) | 0;
        }
        newFreeList[newCapacity - 1] = this.freeHead;
        this.freeList = newFreeList;
        this.freeHead = oldCapacity | 0;

        // Grow every registered component in lockstep. Copies live contents;
        // stale [count, capacity) tails are copied too but never read.
        for (let i = 0; i < this.components.length; i++) {
            this.components[i]._grow(newCapacity);
        }

        this.capacity = newCapacity | 0;
        return true;
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
        // MUST be Int32Array, not Uint32Array: a handle is `(gen << 20) | index`,
        // a SIGNED 32-bit int that goes NEGATIVE once a slot reaches generation
        // 2048 (the sign bit lands in the generation field). `dense` stores whole
        // handles and `has()`/`add()` compare `dense[i] === entity` -- so the
        // stored form and the compared form must share signedness. A Uint32Array
        // stored the unsigned bit pattern and every such comparison went silently
        // false for gen >= 2048, corrupting has/add/remove and the despawn cascade.
        this.dense = new Int32Array(maxEntities);

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

    /**
     * INTERNAL, COLD PATH: reallocate this set's backing arrays to a larger
     * capacity, copying every existing element. Driven only by `Arena.reserve()`
     * (which grows all components in lockstep); never call it directly, and never
     * from a hot loop. `count` and every dense index are preserved, so live
     * membership and SoA payloads survive unchanged -- only the buffers move.
     *
     * @param {number} newCapacity - Strictly greater than the current length.
     */
    _grow(newCapacity) {
        const newSparse = new Uint32Array(newCapacity);
        newSparse.set(this.sparse);
        this.sparse = newSparse;

        // Int32Array, matching the constructor: `dense` holds signed handles.
        const newDense = new Int32Array(newCapacity);
        newDense.set(this.dense);
        this.dense = newDense;

        // Reallocate each parallel SoA array to the SAME typed-array type.
        for (const key in this.data) {
            const old = this.data[key];
            const grown = new old.constructor(newCapacity);
            grown.set(old);
            this.data[key] = grown;
        }
    }
}
