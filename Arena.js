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
 *   - Optional checked mode (`new Arena(n, { checked: true })`): development-only
 *     assertions -- a stale `join()` plan and a misused `idx()` throw instead of
 *     failing silently. OFF and zero-cost in production; the hot paths (join()'s
 *     reused scratch and the prototype `idx()`) are byte-for-byte identical
 *     whether or not it is on.
 *
 * @module @zakkster/lite-arena
 * @author Zahary Shinikchiev
 * @license MIT
 */

const INDEX_MASK = 0xFFFFF; // 20 bits -> Max 1,048,575 entities
const GEN_MASK = 0xFFF;     // 12 bits -> 4096 generations

// The nine numeric TypedArray constructors -- the ONLY legal component field
// types. Building a Set once, at module load, so schema validation is a cold
// O(keys) membership test with no per-registration allocation. BigInt64Array /
// BigUint64Array are deliberately excluded: component data is numeric SoA read
// and written as Number, and a BigInt view throws on a Number store.
const TYPED_ARRAY_CTORS = new Set([
    Int8Array, Uint8Array, Uint8ClampedArray,
    Int16Array, Uint16Array,
    Int32Array, Uint32Array,
    Float32Array, Float64Array,
]);

// Human-readable description of a rejected schema value, for the thrown message.
function describeSchemaValue(v) {
    if (v === null) return 'null';
    if (typeof v === 'function') return v.name || 'an anonymous function';
    return typeof v; // 'string', 'number', 'object', 'undefined', 'symbol', ...
}

/**
 * Validate a component schema at registration (a COLD path -- runs once per
 * component at startup, so cost is irrelevant). Fail closed: a schema that lies
 * about its field types is rejected here rather than silently producing a
 * polymorphic Array or a boxed Number that quietly voids the zero-GC guarantee.
 *
 * @param {Object<string, Function>} schema
 * @throws {Error} A library error naming the offending key / what was passed.
 */
function validateSchema(schema) {
    if (schema === null || typeof schema !== 'object') {
        throw new Error(
            `lite-arena: component schema must be an object, got ${describeSchemaValue(schema)}`);
    }
    // A `__proto__` entry in a schema literal sets the object's PROTOTYPE and
    // silently drops the field (Object.keys never sees it). Detect that footgun
    // and throw, instead of handing back a component missing a field. A plain
    // `{}` has Object.prototype; Object.create(null) schemas are allowed too.
    const proto = Object.getPrototypeOf(schema);
    if (proto !== Object.prototype && proto !== null) {
        throw new Error(
            'lite-arena: component schema has a non-default prototype -- a `__proto__` ' +
            'key in the schema literal sets the prototype and silently drops that field; ' +
            'use a plain string key instead');
    }
    // Component field names are strings. Symbol keys are never iterated into
    // `data`, so reject them loudly rather than dropping them.
    if (Object.getOwnPropertySymbols(schema).length > 0) {
        throw new Error('lite-arena: component schema keys must be strings; symbol keys are not allowed');
    }
    const keys = Object.keys(schema); // own, enumerable, string-keyed only
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const ctor = schema[key];
        if (!TYPED_ARRAY_CTORS.has(ctor)) {
            throw new Error(
                `lite-arena: component field "${key}" must be one of the 9 numeric TypedArray ` +
                'constructors (Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, ' +
                `Int32Array, Uint32Array, Float32Array, Float64Array), got ${describeSchemaValue(ctor)}`);
        }
    }
    // An empty schema is intentionally legal: registerTag() is registerComponent({}).
}

/**
 * Shared per-field buffer check (type + exact byte size), used by BOTH
 * `validateBuffers` (registration, S5) and `SparseSet.rebind` (re-adopt after a
 * transfer round-trip, S6). Throws a library error naming the field and, for a
 * size mismatch, both byte lengths. Deliberately does NOT check presence --
 * that policy differs between callers: registration demands every field, rebind
 * accepts a partial map -- so each caller handles presence itself before calling.
 *
 * @param {string} key
 * @param {ArrayBufferLike} buf
 * @param {Function} ctor - the field's TypedArray constructor (BYTES_PER_ELEMENT + name)
 * @param {number} capacity - each buffer must span exactly capacity * BYTES_PER_ELEMENT
 * @param {boolean} hasSAB - whether SharedArrayBuffer exists in this runtime
 * @throws {Error} On a wrong-typed or wrong-sized buffer.
 */
function validateBufferTypeAndSize(key, buf, ctor, capacity, hasSAB) {
    if (!(buf instanceof ArrayBuffer) && !(hasSAB && buf instanceof SharedArrayBuffer)) {
        throw new Error(
            `lite-arena: the buffer for component field "${key}" must be an ArrayBuffer or ` +
            `SharedArrayBuffer, got ${describeSchemaValue(buf)}`);
    }
    const bytesPerElement = ctor.BYTES_PER_ELEMENT;
    const expected = capacity * bytesPerElement;
    if (buf.byteLength !== expected) {
        throw new Error(
            `lite-arena: the buffer for component field "${key}" has the wrong byteLength: ` +
            `expected ${expected} (capacity ${capacity} * ${bytesPerElement} bytes/element for ` +
            `${ctor.name}), got ${buf.byteLength}. The arena never resizes a caller-supplied ` +
            'buffer, so it must span exactly the arena capacity.');
    }
}

/**
 * Validate a caller-supplied `buffers` map at registration (a COLD path). Fail
 * closed in BOTH directions before a single view is built: every declared schema
 * field must have a correctly-typed, correctly-sized backing buffer, and every
 * supplied buffer must map to a declared field. A partially shared component --
 * some fields sharing caller memory, others silently own-allocated -- is the
 * worst of both worlds and impossible to debug, so a missing/null buffer for a
 * declared key is an ERROR here, never a quiet fall back to own-allocation.
 *
 * Accepts both `ArrayBuffer` and `SharedArrayBuffer`: the feature is "the caller
 * owns the memory"; sharing across a Worker is one reason to want that, and the
 * path is far easier to test with a plain ArrayBuffer.
 *
 * @param {Object<string, Function>} schema - already validated by validateSchema.
 * @param {Object<string, ArrayBufferLike>} buffers
 * @param {number} capacity - arena capacity; each buffer must span exactly it.
 * @throws {Error} A library error naming the offending key and both byte lengths.
 */
function validateBuffers(schema, buffers, capacity) {
    if (buffers === null || typeof buffers !== 'object') {
        throw new Error(
            'lite-arena: the buffers option must be an object mapping each schema field to an ' +
            `ArrayBuffer or SharedArrayBuffer, got ${describeSchemaValue(buffers)}`);
    }
    const hasSAB = typeof SharedArrayBuffer === 'function';
    // Forward: every declared field needs a valid, exactly-sized buffer.
    const keys = Object.keys(schema);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const buf = buffers[key];
        if (buf === undefined || buf === null) {
            throw new Error(
                `lite-arena: the buffers option is missing a buffer for component field "${key}". ` +
                'Every declared field must get its own buffer -- a partially caller-backed component ' +
                '(some fields shared, some own-allocated) is impossible to debug. Supply a buffer for ' +
                'every field, or omit the buffers option entirely to own-allocate all of them. ' +
                'See decisions/0006-caller-supplied-buffers.md');
        }
        validateBufferTypeAndSize(key, buf, schema[key], capacity, hasSAB);
    }
    // Reverse: no buffer may target a field the schema does not declare -- a
    // buffer with no home is a typo or a stale key, and dropping it silently is
    // exactly how the payload the caller thinks is shared ends up own-allocated.
    const bufKeys = Object.keys(buffers);
    for (let i = 0; i < bufKeys.length; i++) {
        const key = bufKeys[i];
        if (!Object.prototype.hasOwnProperty.call(schema, key)) {
            throw new Error(
                `lite-arena: the buffers option supplies a buffer for "${key}", which is not a field ` +
                'in the component schema. Every buffer must map to a declared schema field (both ' +
                'directions are checked). Remove it or add the field. ' +
                'See decisions/0006-caller-supplied-buffers.md');
        }
    }
}

/**
 * Checked-mode replacement for `SparseSet.prototype.idx` (AR-11). Installed as an
 * OWN property by the SparseSet constructor ONLY when the owning arena was built
 * with `{ checked: true }`, so the production `idx()` fast path is byte-for-byte
 * untouched and stays monomorphic for every unchecked set. Refuses to hand back
 * an index for an entity that is dead or does not hold this component -- the exact
 * precondition the unchecked `idx()` trusts the caller to have already met.
 *
 * @this {SparseSet}
 * @param {number} entity
 * @returns {number}
 */
function checkedIdx(entity) {
    if (!this.has(entity)) {
        throw new Error(
            'lite-arena: idx() in checked mode was called on an entity that is dead or does ' +
            'not hold this component. idx() is an UNCHECKED fast path -- guard it with has(), ' +
            'or iterate dense[0..count). (checked mode; OFF and zero-cost in production.)');
    }
    return this.sparse[entity & INDEX_MASK];
}

export class Arena {
    /**
     * Allocates the memory pools for the ECS universe. Call once at setup.
     * @param {number} maxEntities - Hard cap on living entities. Must be an
     *   integer in the range [1, 1048575]. Values outside this range throw.
     * @param {{ checked?: boolean }} [options] - Optional. `checked: true` turns
     *   on development-mode assertions that are OFF and zero-cost in production:
     *   `join()` returns a plan that throws if read after a later `join()`
     *   superseded it, and `idx()` throws on an entity that is dead or lacks the
     *   component. Leave it off in shipping builds -- the production hot paths
     *   (join()'s reused scratch and the prototype `idx()`) are byte-for-byte
     *   unaffected by this flag.
     * @throws {Error} If `maxEntities` is not an integer in [1, 1048575].
     */
    constructor(maxEntities, options) {
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

        // Optional development-mode assertions (AR-09 / AR-11). OFF by default and
        // never consulted on any production hot path. When on: join() hands back a
        // staleness-checked plan and every SparseSet gets a validating idx().
        this._checked = !!(options && options.checked === true);

        // Monotonic version stamp for join() plans, bumped on every checked join()
        // so a plan read after a subsequent join() throws instead of silently
        // reporting the newer join's driver/other/count. Unused when not checked.
        this._joinEpoch = 0 | 0;
    }

    /**
     * O(1) entity allocation. Pops from the free list.
     * @returns {number} A 32-bit integer entity handle. The handle encodes
     *   both the slot index (low 20 bits) and the generation (high 12 bits).
     *   Always pass the handle as-is to other API methods; do not decompose it.
     * @throws {Error} If the arena is full.
     */
    spawn() {
        if (this.freeHead === INDEX_MASK) throw this._exhausted();

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
     * COLD: builds the Error thrown by `spawn()` when no slot is free. Split out
     * so spawn()'s already-cold exhaustion branch carries only `throw
     * this._exhausted()` and its allocation path stays byte-for-byte unchanged.
     *
     * Names the CAUSE. A genuinely full arena and a retirement-shrunk arena both
     * leave `freeHead` at the sentinel, but they are different problems: the first
     * wants more capacity, the second is churning a single slot to generation
     * exhaustion -- and there `activeCount` can be 0 while spawn() throws, which
     * without this message reads as a phantom leak. Both counts are reported
     * inline so the reader is not sent hunting for a leak a retired arena
     * does not have.
     * @returns {Error}
     */
    _exhausted() {
        if (this.retiredCount > 0) {
            return new Error(
                `lite-arena: out of memory -- no free slot. capacity=${this.capacity}, ` +
                `activeCount=${this.activeCount}, retiredCount=${this.retiredCount}. ` +
                `${this.retiredCount} slot(s) were permanently retired by generation ` +
                'exhaustion (fail-closed rollover; see retiredCount and ' +
                'decisions/0001-generational-rollover.md), so this arena holds at most ' +
                'capacity - retiredCount concurrent entities. Stop churning a single slot, ' +
                'or raise capacity with reserve().');
        }
        return new Error(
            `lite-arena: out of memory -- no free slot. capacity=${this.capacity}, ` +
            `activeCount=${this.activeCount}, retiredCount=0. The arena is full; despawn ` +
            'entities or raise capacity with reserve().');
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
     * O(1) count of further entities that can be spawned right now:
     * `capacity - activeCount - retiredCount`. Equivalently the length of the
     * free list -- every slot is in exactly one of three states (live, free, or
     * retired), so `activeCount + retiredCount + remainingCapacity() === capacity`
     * holds at all times.
     *
     * Distinct from spare ADDRESS space: retirement (fail-closed rollover)
     * permanently withdraws slots, so a long-running arena's remainingCapacity()
     * can fall below `capacity - activeCount`. A `0` here with a low `activeCount`
     * and a non-zero `retiredCount` means slots have retired, NOT that the arena
     * is full -- the same distinction `spawn()`'s exhaustion throw now names.
     *
     * @returns {number} Slots available for `spawn()`; never negative.
     */
    remainingCapacity() {
        return (this.capacity - this.activeCount - this.retiredCount) | 0;
    }

    /**
     * Mounts a new SoA component definition to the arena.
     * Each key of the schema becomes a parallel TypedArray of length `capacity`.
     *
     * By default the arena allocates each field's backing array itself. Pass
     * `{ buffers }` to have each `data[key]` instead VIEW a buffer the caller
     * owns -- an `ArrayBuffer` or a `SharedArrayBuffer` -- so a component's
     * payload can live in memory shared with a Worker. When `buffers` is given it
     * must supply one correctly-sized buffer for EVERY schema field and no
     * others (validated fail-closed in both directions); when omitted, the path
     * is byte-identical to own-allocation. The arena never frees, grows, or
     * reassigns a caller-supplied buffer -- see decisions/0006 and note that
     * `reserve()` refuses to grow an arena that has any caller-backed component.
     *
     * The tick loop is unaffected either way: `data.x` is the same
     * `Float32Array` whether it views an own buffer or a caller's.
     *
     * @param {Object<string, Function>} schema - e.g. `{ x: Float32Array, y: Float32Array }`.
     * @param {{ buffers?: Object<string, ArrayBufferLike> }} [options] - Optional.
     *   `buffers` maps each schema field to a caller-owned ArrayBuffer /
     *   SharedArrayBuffer of exactly `capacity * BYTES_PER_ELEMENT` bytes.
     * @returns {SparseSet}
     */
    registerComponent(schema, options) {
        const buffers = options != null ? options.buffers : undefined;
        const set = new SparseSet(this.capacity, schema, this, buffers);
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
        // Production: hand back the reused scratch, zero allocation (Phase C proves
        // it -- the branch below is predicted-false and never runs). Checked mode:
        // stamp a fresh, staleness-guarded plan (AR-09) so a read after the next
        // join() throws instead of silently returning the newer plan's fields.
        if (this._checked) {
            this._joinEpoch = (this._joinEpoch + 1) | 0;
            return new CheckedJoinPlan(this, this._joinEpoch, r.driver, r.other, r.count);
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
     * S5 -- caller-backed components (option A, exclusive): `reserve()` throws if
     * ANY registered component views caller-supplied buffers. Growth reallocates
     * every `data.*`, which the arena cannot do to a buffer it does not own, and
     * there is no synchronous way to tell a Worker its view just detached. The
     * smallest honest contract is to forbid the combination; S6 revisits it once
     * a shared epoch exists to signal a re-hoist. See decisions/0006.
     *
     * @param {number} newCapacity - Target capacity. Must be an integer
     *   <= 1048575 (the 20-bit handle-index ceiling).
     * @returns {boolean} `true` if the arena grew; `false` (a no-op) if
     *   `newCapacity <= capacity`.
     * @throws {Error} If `newCapacity` is not an integer, exceeds 1048575, or any
     *   registered component is caller-backed.
     */
    reserve(newCapacity) {
        if (!Number.isInteger(newCapacity) || newCapacity > INDEX_MASK) {
            throw new Error(`lite-arena: reserve capacity must be an integer <= ${INDEX_MASK}, got ${newCapacity}`);
        }
        // S5 option A: refuse to grow an arena with any caller-backed component --
        // the arena never resizes a buffer it does not own. Cold scan; names the
        // first offending component (registration index + its fields) so the
        // caller knows which registerComponent(schema, { buffers }) call to fix.
        for (let i = 0; i < this.components.length; i++) {
            if (this.components[i]._callerBacked) {
                const fields = Object.keys(this.components[i].data).join(', ');
                throw new Error(
                    `lite-arena: reserve() cannot grow this arena because component #${i} ` +
                    `(fields: ${fields || '<tag>'}) is backed by caller-supplied buffers, which the ` +
                    'arena never resizes or reassigns. Size caller-backed buffers for the maximum ' +
                    'capacity you need up front, or register the component with own-allocation if it ' +
                    'must grow. See decisions/0006-caller-supplied-buffers.md');
            }
            // S6: refuse a component with any DETACHED field -- its backing buffer
            // was transferred to a Worker and not yet rebound, so `_grow`'s
            // `newArr.set(detachedArr)` would silently copy zero bytes. An
            // own-allocated set that was transferred out is not `_callerBacked`,
            // so this is a separate, truthful check (a detached view is
            // byteLength 0). Fail closed. See decisions/0007-transferable-roundtrip.md.
            const data = this.components[i].data;
            const dkeys = Object.keys(data);
            for (let k = 0; k < dkeys.length; k++) {
                if (data[dkeys[k]].byteLength === 0) {
                    throw new Error(
                        `lite-arena: reserve() cannot grow this arena because component #${i} has a detached ` +
                        `field "${dkeys[k]}" -- its backing buffer was transferred to a Worker and not yet ` +
                        'rebound. Rebind the returned buffer (comp.rebind({ ... })) before calling reserve(). ' +
                        'See decisions/0007-transferable-roundtrip.md');
                }
            }
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

    /**
     * Resets the arena to empty WITHOUT reallocating -- rebuilds the free list,
     * advances every generation, revives every retired slot, and drops every
     * registered component's `count` to 0. O(capacity); a cold, between-frames
     * operation, never a per-frame call. Allocates nothing: it only overwrites
     * buffers that already exist.
     *
     * HANDLE POLICY (decided; see decisions/0004): every entity handle minted
     * before `clear()` is INVALID afterward. clear() advances each slot's
     * generation, so `isAlive()` rejects every pre-clear handle -- the honest
     * contract of a reset. Retired slots are REVIVED by the same step (their
     * poison generation maps back into the live range), so the arena regains its
     * full capacity and `retiredCount` returns to 0. Do not retain or test any
     * pre-clear handle across a clear().
     */
    clear() {
        const cap = this.capacity;
        const gens = this.generations;
        const free = this.freeList;

        // Advance every generation into a fresh LIVE value in [1, GEN_MASK]. The
        // map g -> (g % GEN_MASK) + 1 does three jobs at once: it bumps a live slot
        // (so its outstanding handle no longer matches isAlive), it wraps
        // GEN_MASK -> 1, and it revives a retired slot (poison GEN_MASK+1 -> 2)
        // back into a spawnable generation. The result is never 0 (which isAlive
        // rejects) and never GEN_MASK+1 (retired), and always differs from the
        // slot's pre-clear value -- so every slot ends live and reusable, and every
        // pre-clear handle is rejected.
        for (let i = 0; i < cap; i++) {
            gens[i] = (gens[i] % GEN_MASK) + 1;
        }

        // Rebuild the implicit free list across the whole capacity -- revived slots
        // included -- exactly as the constructor laid it out.
        for (let i = 0; i < cap - 1; i++) free[i] = (i + 1) | 0;
        free[cap - 1] = INDEX_MASK;
        this.freeHead = 0 | 0;

        // Empty every component without touching a buffer: the tail at
        // [count, capacity) is undefined by the SparseSet contract, so dropping
        // count to 0 is a complete logical reset with zero allocation.
        for (let i = 0; i < this.components.length; i++) {
            this.components[i].count = 0 | 0;
        }

        this.activeCount = 0 | 0;
        this.retiredCount = 0 | 0;
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
     * @param {Object<string, ArrayBufferLike>} [buffers] - Optional caller-owned
     *   backing buffers, one per schema field (see `Arena.registerComponent`).
     *   When supplied, each `data[key]` views `buffers[key]` instead of a freshly
     *   allocated array; validated fail-closed in both directions.
     */
    constructor(maxEntities, schema, arena, buffers) {
        // AR-10: a SparseSet whose capacity does not match its arena's is a trap
        // -- writes past `sparse.length` are silently discarded and `despawn`
        // never cleans an unregistered set. Fail closed: require a real arena and
        // an exactly-matching capacity. `arena.registerComponent()` always passes
        // `arena.capacity`, so this only ever fires on hand-rolled construction.
        if (!(arena instanceof Arena)) {
            throw new Error('lite-arena: SparseSet requires the owning Arena; use arena.registerComponent(schema)');
        }
        if (maxEntities !== arena.capacity) {
            throw new Error(
                `lite-arena: SparseSet capacity (${maxEntities}) must equal the arena capacity ` +
                `(${arena.capacity}); use arena.registerComponent(schema)`);
        }
        // AR-03 / AR-04: reject a lying schema before allocating anything.
        validateSchema(schema);

        // S5: if the caller supplied backing buffers, validate them fail-closed
        // (both directions, exact sizes) BEFORE building any view. Only `data.*`
        // payload can be caller-backed; `sparse` and `dense` remain private
        // own-buffer arrays -- sharing the read path (count/dense) is S6.
        //
        // OMITTED (undefined) means own-allocate. Any OTHER provided value --
        // including null -- goes through validation and fails closed: a caller
        // who wrote `{ buffers: someVar }` with `someVar` accidentally null wants
        // a loud error, not a silent private allocation they think is shared.
        const callerBacked = buffers !== undefined;
        if (callerBacked) validateBuffers(schema, buffers, maxEntities);

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

        // AR-04: null-prototype bag. A schema key of `toString` / `constructor`
        // now lands in a clean own slot instead of colliding with an inherited
        // Object.prototype member, and the `for...in` in remove() walks a shorter
        // chain. `data` is built only from own, enumerable, string keys, already
        // validated by validateSchema() above.
        /** @type {Object<string, ArrayBufferView>} Parallel SoA payload arrays. */
        this.data = Object.create(null);
        const keys = Object.keys(schema);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const TypedArrayConstructor = schema[key];
            // Own-allocation is byte-identical to 1.6.1. The caller-backed branch
            // builds a length-bounded view [0, maxEntities) over the supplied
            // buffer -- validateBuffers already proved it spans exactly that.
            this.data[key] = callerBacked
                ? new TypedArrayConstructor(buffers[key], 0, maxEntities)
                : new TypedArrayConstructor(maxEntities);
        }

        // S5: mark caller-backed sets so reserve() can refuse to grow them (it
        // cannot resize a buffer it does not own; see decisions/0006). The flag is
        // an OWN property set ONLY on the caller path, so an own-allocated set --
        // the production default -- keeps the exact 1.6.1 instance shape.
        if (callerBacked) this._callerBacked = true;

        // AR-11: in checked mode only, shadow the prototype idx() with a validating
        // one, installed as an OWN property so the production idx() fast path is
        // never touched and stays monomorphic for every unchecked set. See checkedIdx.
        if (arena._checked) {
            this.idx = checkedIdx;
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

    /**
     * COLD PATH: collect the backing `ArrayBuffer`(s) for the given fields,
     * ready to spread into a `postMessage(msg, transferList)` transfer list.
     * This is the SEND half of a transferable round-trip (S6): hand a field's
     * buffer to a Worker, let it transform the payload in place, and get it back
     * via `rebind()`.
     *
     * It does NOT detach anything itself -- transferring the returned buffer is
     * what detaches the sender's view; `isDetached()` reads the truth afterward.
     * Sugar over `comp.data[key].buffer`, but it validates the field names and
     * returns them in a transfer-ready array. See
     * decisions/0007-transferable-roundtrip.md.
     *
     * @param {string[]} [keys] - fields to collect; omit for every field.
     * @returns {ArrayBufferLike[]} the backing buffers, in `keys` order.
     * @throws {Error} If `keys` is not an array, or names a field not in the schema.
     */
    detach(keys) {
        const fields = keys === undefined ? Object.keys(this.data) : keys;
        if (!Array.isArray(fields)) {
            throw new Error(
                'lite-arena: detach() expects an array of field names (or no argument for all fields), ' +
                `got ${describeSchemaValue(keys)}`);
        }
        const out = [];
        for (let i = 0; i < fields.length; i++) {
            const key = fields[i];
            if (!Object.prototype.hasOwnProperty.call(this.data, key)) {
                throw new Error(
                    `lite-arena: detach() was asked for field "${key}", which is not a field in this ` +
                    'component schema. See decisions/0007-transferable-roundtrip.md');
            }
            out.push(this.data[key].buffer);
        }
        return out;
    }

    /**
     * COLD PATH: is this field's backing buffer currently detached -- transferred
     * away and not yet rebound? TRUTHFUL, not bookkept: transferring a buffer
     * detaches its view to zero length, so this reads `byteLength === 0` directly
     * (a live field spans `capacity * BYTES_PER_ELEMENT > 0`). No flag to fall
     * out of sync.
     *
     * Use it as a ONCE-PER-FRAME system guard -- iterating a detached field is a
     * caller bug -- never per element. Raw `data[key][i]` reads cannot be
     * intercepted without taxing the hot path, so this cheap guard is the
     * sanctioned fail-closed check. See decisions/0007-transferable-roundtrip.md.
     *
     * @param {string} key
     * @returns {boolean}
     * @throws {Error} If `key` is not a field in the schema.
     */
    isDetached(key) {
        if (!Object.prototype.hasOwnProperty.call(this.data, key)) {
            throw new Error(
                `lite-arena: isDetached() was asked about field "${key}", which is not a field in this ` +
                'component schema. See decisions/0007-transferable-roundtrip.md');
        }
        return this.data[key].byteLength === 0;
    }

    /**
     * COLD PATH: re-point one or more `data[key]` views at caller-supplied
     * buffers -- typically the ones a Worker just transferred back. This is the
     * RETURN half of a transferable round-trip (S6): `detach()` -> transfer ->
     * Worker transforms -> transfer back -> `rebind()`.
     *
     * `buffers` is a PARTIAL map `{ [field]: ArrayBufferLike }`: only the
     * supplied fields are re-pointed; every other field is left exactly as it was
     * (rebind just the field(s) that came home). Fail-closed like registration --
     * an unknown schema key, a wrong-typed buffer, or one that does not span
     * exactly `capacity * BYTES_PER_ELEMENT` throws, naming the field, and
     * NOTHING is re-pointed until every supplied buffer has passed (no
     * half-applied state). A garbage buffer returned by a Worker throws instead
     * of silently corrupting the component.
     *
     * After a successful rebind the set is marked caller-backed, so `reserve()`
     * refuses to grow it -- the arena never resizes a buffer it does not own.
     * See decisions/0007-transferable-roundtrip.md.
     *
     * @param {Object<string, ArrayBufferLike>} buffers - partial field -> buffer map.
     * @throws {Error} Non-object/empty map, unknown key, wrong type, or wrong size.
     */
    rebind(buffers) {
        if (buffers === null || typeof buffers !== 'object') {
            throw new Error(
                'lite-arena: rebind() requires an object mapping one or more component fields to an ' +
                `ArrayBuffer or SharedArrayBuffer, got ${describeSchemaValue(buffers)}`);
        }
        const keys = Object.keys(buffers);
        if (keys.length === 0) {
            throw new Error(
                'lite-arena: rebind() was given an empty buffers map -- nothing to rebind. Supply the ' +
                'field(s) whose buffers a Worker transferred back, e.g. rebind({ x: returnedBuffer }).');
        }
        const hasSAB = typeof SharedArrayBuffer === 'function';
        const capacity = this.arena.capacity;
        // Validate EVERY supplied buffer before re-pointing anything, so a bad
        // buffer in a multi-field rebind leaves the component untouched.
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (!Object.prototype.hasOwnProperty.call(this.data, key)) {
                throw new Error(
                    `lite-arena: rebind() was given a buffer for "${key}", which is not a field in this ` +
                    'component schema. Every buffer must map to a declared field. ' +
                    'See decisions/0007-transferable-roundtrip.md');
            }
            // The field's TypedArray constructor survives detachment on the view
            // itself, so there is no need to retain the schema separately.
            validateBufferTypeAndSize(key, buffers[key], this.data[key].constructor, capacity, hasSAB);
        }
        // All valid: re-point each supplied field to a fresh length-bounded view.
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const Ctor = this.data[key].constructor;
            this.data[key] = new Ctor(buffers[key], 0, capacity);
        }
        this._callerBacked = true;
    }
}

/**
 * Checked-mode wrapper for a `join()` plan (AR-09). Only ever constructed when
 * the arena was created with `{ checked: true }`; production `join()` returns the
 * plain reused scratch and never allocates one of these. It snapshots the plan
 * and validates on every field read that no later `join()` has superseded it --
 * the reused-scratch contract ("consume before the next join()") made loud
 * instead of silently handing back the newer join's driver/other/count.
 *
 * Structurally a `{ driver, other, count }`, so it is a drop-in for the
 * production scratch at every call site.
 */
class CheckedJoinPlan {
    constructor(arena, epoch, driver, other, count) {
        this._arena = arena;
        this._epoch = epoch;
        this._driver = driver;
        this._other = other;
        this._count = count;
    }

    _live() {
        if (this._arena._joinEpoch !== this._epoch) {
            throw new Error(
                'lite-arena: stale join() plan read. A later join() on this arena superseded ' +
                'it -- the plan is a single-use scratch; read driver/other/count (or run your ' +
                'loop) before calling join() again. (checked mode.)');
        }
    }

    get driver() { this._live(); return this._driver; }
    get other()  { this._live(); return this._other; }
    get count()  { this._live(); return this._count; }
}
