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
    /** The `reqMaskHi` passed to `joinN()`, normalised `| 0` (omitted -> 0). Tested against `flagsHi` (M-26). */
    reqMaskHi: number;
    /** The `excMaskHi` passed to `joinN()`, normalised `| 0` (omitted -> 0). */
    excMaskHi: number;
    /**
     * `arena.flagsHi` at plan time; `null` without `registerFlagsHi()`. Same `reserve()`
     * caveat as `flags`: a hoisted row (and a checked plan) keeps the pre-reserve row.
     */
    flagsHi: Int32Array | null;
    /**
     * (1.12.0) The indexed-flag driver hint: the MASK (`1 << b`; bit 31 is -2147483648) of
     * the rarest INDEXED word-0 flag in `reqMask` whose live count is STRICTLY below `count`
     * (the lowest bit wins a tie), else 0. When it is not 0, walk
     * `firstFlagged(driverFlag)` / `nextFlagged(driverFlag, e)` instead of `driver.dense`, and test driver.has(e) plus every others / excl set and the other mask bits per entity.
     * Always written on an arena with an indexed word-0 flag; an arena with none (and a
     * Hi-only indexed arena) keeps the constructed 0. `driver`, `count` and every other
     * field are unchanged. A checked plan has the same field as a getter: a stale read
     * throws like every other field (M-43).
     */
    driverFlag: number;
    /**
     * (1.12.0) The live count of the `driverFlag` flag (`flagCount(driverFlag)`), or -1
     * when `driverFlag` is 0. Same writer and same stale-read rule as `driverFlag`.
     */
    driverFlagCount: number;
}

/**
 * The options of {@link Arena.registerFlags} / {@link Arena.registerFlagsHi} (1.12.0).
 * A plain object (prototype Object.prototype or null); `indexed` is the only allowed own
 * key and is read as an own key only.
 */
export interface RegisterFlagsOptions {
    /** Names (from the same call's `names`, each once) whose flags get a column and a count. */
    indexed?: readonly string[];
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
     * Read-only from user code; write through setFlags / clearFlags. A direct write to a bit
     * registered with `{ indexed }` (e.g. `flags[s] |= F.x`) is UNSUPPORTED: it leaves the
     * column and `flagCount` out of step, and no mode detects it (M-39).
     * Bits 30-31 are plain int32 inside the array; held in a JS variable they may be
     * heap numbers on pointer-compressed engines (nominal; Node cannot observe it).
     */
    readonly flags: Int32Array | null;

    /**
     * The SECOND flag word (bits 32..63, M-26): per-slot Int32Array, length =
     * capacity, or `null` until {@link Arena.registerFlagsHi} is called. Index with
     * `e & indexMask`. `reserve()` REPLACES this array: re-read it after growing.
     * Read-only from user code; write through setFlagsHi / clearFlagsHi (a direct write to an
     * indexed Hi bit is UNSUPPORTED, as for {@link Arena.flags}). An arena
     * that never registers it allocates no Hi row (0 B per slot; despawn() adds one nested null check). Bits 30-31 carry the same
     * nominal pointer-compressed boxing note as {@link Arena.flags}.
     */
    readonly flagsHi: Int32Array | null;

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
     *   {@link SparseSet.idx} throw, and setFlags / clearFlags / hasFlags (and the Hi twins) throw
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
     *
     * On an arena with an indexed flag (1.12.0) this is an OWN method that drops the
     * entity's indexed bits from the columns and counts, then runs `Arena.prototype.despawn`;
     * a subclass `despawn` override is shadowed there (M-42).
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
     * still throws the required-set error first (M-11 -- there is no driver set; a
     * flags-only walk is `firstFlagged` / `nextFlagged` on an INDEXED flag (1.12.0), or a
     * caller loop over `arena.flags`, O(capacity)). `reqMask & excMask` != 0
     * matches nothing in production and throws in checked mode (M-13). Checked
     * mode also throws when a SUPPLIED mask is not a 32-bit integer (M-20),
     * including a supplied-but-`undefined` one (a misspelled `F.tpyo`, M-25); a
     * truly omitted mask is 0. Production stays a plain `| 0`: there a misspelled
     * mask reads 0 and fails open (matches as if no mask). NOMINAL: a mask outside [-2^30, 2^30 - 1]
     * may be a heap number on pointer-compressed engines; hoist it into a local.
     *
     * Second word (M-26, optional args 5-6): `reqMaskHi` / `excMaskHi` do the same
     * against `arena.flagsHi` and ride on the plan with a `flagsHi` reference. The
     * extra cost is O(1) per call (two more `| 0`, one no-row guard, three plan-field stores), not zero; an arena that never calls
     * registerFlagsHi() allocates no Hi row (0 B per slot; despawn() adds one nested null check). A non-zero Hi mask with no Hi row throws before
     * any state write, with its own message naming `registerFlagsHi()`; when both
     * words are missing the word-0 no-flags error fires first. In checked mode the mask type
     * checks (M-20 / M-25) fire before either no-row error. A Hi-only call pads
     * args 3-4 with 0, 0 (M-27). M-13 applies PER WORD: `reqMaskHi & excMaskHi` != 0
     * matches nothing (throws in checked mode); a bit shared ACROSS the two words
     * (`reqMask & excMaskHi`) is fine. Checked mode validates a supplied Hi mask like
     * the word-0 ones (M-20 / M-25; a supplied `undefined` throws). NOMINAL: Hi
     * masks with bit 30 != bit 31 may be heap numbers on pointer-compressed
     * engines; hoist them into locals.
     *
     * Indexed driver hint (1.12.0, M-38): on an arena with an indexed word-0 flag, the plan
     * also carries `driverFlag` / `driverFlagCount` (see {@link JoinNPlan}); the sets,
     * `driver` and `count` are unchanged.
     *
     * @param required Non-empty; entities must be in ALL of these.
     * @param excluded Entities must be in NONE of these (default: empty).
     * @param reqMask Every bit must be set in the entity's flag word (default 0;
     *   pass 0 to skip it -- a positional `undefined`, as in
     *   `joinN(R, E, undefined, F.c)`, throws in checked mode).
     * @param excMask No bit may be set in the entity's flag word (default 0).
     * @param reqMaskHi Every bit must be set in the entity's Hi flag word (default 0).
     * @param excMaskHi No bit may be set in the entity's Hi flag word (default 0).
     * @returns The reused {@link JoinNPlan}.
     */
    joinN(required: SparseSet<any>[], excluded?: SparseSet<any>[], reqMask?: number, excMask?: number, reqMaskHi?: number, excMaskHi?: number): JoinNPlan;

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
     * Indexed flags (1.12.0, M-37): `{ indexed: ['a', ...] }` INDEXES those flags (a flag
     * can be indexed ONLY here, at registration). Per indexed flag the arena keeps a column
     * and a live count, so {@link Arena.flagCount}, {@link Arena.firstFlagged},
     * {@link Arena.nextFlagged} and {@link Arena.clearFlagAll} work on it. `indexed` is read
     * as an OWN key only; omitted or `[]` indexes nothing and installs nothing (the arena
     * is the plain one). On an arena with an indexed flag, `setFlags`, `clearFlags` and
     * `despawn` are installed as OWN methods, so a subclass override of them is SHADOWED
     * (M-42; `despawn` still runs the prototype `despawn` last). Write indexed bits only
     * through the API: a direct `flags[i] |= F.x` on an indexed bit desyncs the column and
     * the count, which is UNSUPPORTED and undetected, even in checked mode (M-39). Memory:
     * 135,296 B per indexed flag at capacity 1,048,575 (column 131,072 + two summaries
     * 4,096 + 128), plus a 128 B count table per word; 0 B when nothing is indexed.
     *
     * @param names At most 32 distinct non-empty strings PER WORD (`'__proto__'` is allowed).
     * @param options `undefined` / `null` / a plain object (prototype Object.prototype or
     *   null) whose only allowed own key is `indexed`, a `readonly string[]` of distinct
     *   entries of `names`.
     * @throws Error (R1) `lite-arena: registerFlags options accept only "indexed"; got <key>`
     *   on any other own key (Symbol and non-enumerable keys too), or on a non-object /
     *   array options value.
     * @throws Error (R2) when an own `indexed` is not an array:
     *   `lite-arena: registerFlags options.indexed must be an array of flag names, got <value>`
     * @throws Error (R3) when an entry is unknown or repeated (<entry> is the quoted name):
     *   `lite-arena: registerFlags options.indexed #<j> (<entry>)`
     *   followed by ` is not one of the names, or a duplicate`
     * @throws Error on a second call (or if a names getter or an options Proxy trap
     *   re-entered it: the OUTER call throws), more than 32 names, a duplicate / empty /
     *   non-string name, or a non-plain options object. A throw allocates no row and no
     *   column (on a re-entry the inner call's row stands).
     */
    registerFlags(
        names?: readonly string[], options?: RegisterFlagsOptions | null,
    ): Readonly<Record<string, number>>;

    /**
     * O(1): ORs `mask | 0` into the entity's flag word (0x80000000 works).
     * `mask | 0` is converted BEFORE the alive check, so a mask whose valueOf() despawns the
     * entity cannot write a freed slot; a BigInt or Symbol mask throws TypeError, live or dead.
     * Precondition: registerFlags() was called; before that, on a live handle, it throws a native
     * TypeError (null row; an object mask's valueOf runs once first). A dead handle with a
     * number / undefined / object mask returns `false` and writes nothing;
     * `setFlags(e, 0)` on a live entity is a no-op returning `true`.
     * PRODUCTION fails open on a typo: `F.tpyo` is undefined, `undefined | 0` is 0,
     * so the call is a silent no-op that returns `true`. Checked mode throws instead.
     * On an arena with an indexed word-0 flag (1.12.0) this is an OWN method that also keeps
     * the columns and counts in step on a real 0 -> 1 change; a subclass override is
     * shadowed (M-42).
     * @returns `true` if the entity is alive.
     */
    setFlags(entity: Entity, mask: number): boolean;

    /**
     * O(1): clears `mask | 0` in the entity's flag word. Same precondition,
     * dead-handle and typo behaviour as {@link Arena.setFlags}, including the indexed OWN
     * method and the M-42 shadowing.
     * @returns `true` if the entity is alive.
     */
    clearFlags(entity: Entity, mask: number): boolean;

    /**
     * O(1): alive AND `(row & required) === required` AND `(row & excluded) === 0`.
     * Both masks are converted (`| 0`, each once) BEFORE the alive check, so it cannot
     * return `true` for an entity its own mask despawned. `excluded` defaults to 0.
     * `hasFlags(e, 0)` on a live entity is `true`. A dead
     * handle is `false` (a BigInt or Symbol mask throws TypeError first, as in
     * {@link Arena.setFlags}). Same precondition as {@link Arena.setFlags}; a typo'd mask
     * reads as 0 in production (so `hasFlags(e, F.tpyo)` is `true`), and throws in
     * checked mode. Checked mode does NOT reject unregistered bits.
     */
    hasFlags(entity: Entity, required: number, excluded?: number): boolean;

    /**
     * COLD, once per arena: the SECOND flag word (M-26). Allocates {@link Arena.flagsHi}
     * and returns a frozen null-prototype map `{ name: bit }`, name i -> `1 << i`
     * (name #32 is -2147483648, Hi bit 31). Together with {@link Arena.registerFlags}
     * an arena holds up to 64 flags. The two maps are independent: a name may appear
     * in both (M-27 Q4). `registerFlagsHi()` and `registerFlagsHi([])` allocate the row
     * and return a frozen `{}`.
     *
     * Requires {@link Arena.registerFlags} to have been called first (M-27); call
     * `registerFlags([])` for a Hi-only arena.
     *
     * @param names At most 32 distinct non-empty strings (`'__proto__'` is allowed).
     * Indexed flags (1.12.0): `{ indexed: [...] }` indexes Hi flags exactly as
     * {@link Arena.registerFlags} does for word 0 ({@link Arena.flagCountHi},
     * {@link Arena.firstFlaggedHi}, {@link Arena.nextFlaggedHi}, {@link Arena.clearFlagAllHi};
     * own `setFlagsHi`, `clearFlagsHi` and `despawn`; M-42 shadowing applies). The joinN
     * driver hint reads word-0 flags only, so a Hi-only indexed arena keeps `driverFlag` 0.
     *
     * @param names At most 32 distinct non-empty strings (`'__proto__'` is allowed).
     * @param options `undefined` / `null` / a plain object whose only allowed own key is
     *   `indexed` (see {@link RegisterFlagsOptions}).
     * @throws Error (R1) `lite-arena: registerFlagsHi options accept only "indexed"; got <key>`.
     * @throws Error (R2) when an own `indexed` is not an array:
     *   `lite-arena: registerFlagsHi options.indexed must be an array of flag names, got <value>`.
     * @throws Error (R3) when an entry is unknown or repeated (<entry> is the quoted name):
     *   `lite-arena: registerFlagsHi options.indexed #<j> (<entry>)`
     *   followed by ` is not one of the names, or a duplicate`
     * @throws Error on a second call (or if a names getter or an options Proxy trap
     *   re-entered it), when `registerFlags()` was not called, more than
     *   32 names, a duplicate / empty / non-string name, or a non-plain options object.
     *   A validation throw allocates no row and no column
     *   (on a re-entry the inner call's row stands).
     */
    registerFlagsHi(
        names?: readonly string[], options?: RegisterFlagsOptions | null,
    ): Readonly<Record<string, number>>;

    /**
     * O(1): ORs `mask | 0` into the entity's Hi flag word. Twin of {@link Arena.setFlags}
     * for `flagsHi`; precondition: registerFlagsHi() was called (a live handle before
     * that throws a native TypeError). `mask | 0` is converted BEFORE the alive check (a
     * BigInt or Symbol mask throws TypeError, live or dead). A dead handle returns `false`
     * and writes nothing.
     * Production fails open on a typo (`undefined | 0` is 0); checked mode throws.
     * @returns `true` if the entity is alive.
     */
    setFlagsHi(entity: Entity, mask: number): boolean;

    /**
     * O(1): clears `mask | 0` in the entity's Hi flag word. Same precondition,
     * dead-handle and typo behaviour as {@link Arena.setFlagsHi}.
     * @returns `true` if the entity is alive.
     */
    clearFlagsHi(entity: Entity, mask: number): boolean;

    /**
     * O(1): alive AND `(hiRow & required) === required` AND `(hiRow & excluded) === 0`.
     * `excluded` defaults to 0. Twin of {@link Arena.hasFlags} for `flagsHi`; same
     * precondition as {@link Arena.setFlagsHi}.
     */
    hasFlagsHi(entity: Entity, required: number, excluded?: number): boolean;
    /**
     * (1.12.0) O(1): the number of live entities carrying the INDEXED word-0 flag `flag`
     * (a one-bit value from the map `registerFlags(names, { indexed })` returned).
     * Converts `flag | 0`, then checks it is exactly one indexed bit. Production and
     * checked mode both check; checked mode first applies the M-18 32-bit-integer check.
     * @throws Error (E-ROW) when no word-0 flag is indexed:
     *   `lite-arena: flagCount() needs registerFlags() with { indexed: [...] } first`
     * @throws Error (E-BIT) `lite-arena: flagCount() needs exactly one indexed flag bit
     *   (indexed mask 0x<8 hex digits>), got <flag>` for 0, several bits or an unindexed bit.
     */
    flagCount(flag: number): number;

    /**
     * (1.12.0) The handle of the lowest-slot live entity carrying the indexed flag, or -1.
     * Validates `flag` like {@link Arena.flagCount} (E-ROW / E-BIT, same texts with the
     * method name `firstFlagged`). The walk, M-39 / M-52:
     * `for (let e = a.firstFlagged(F.x); e !== -1; e = a.nextFlagged(F.x, e)) { ... }`
     * Visit cost is about matches + capacity / 1024 summary words, derived from the code,
     * not timed.
     */
    firstFlagged(flag: number): number;

    /**
     * (1.12.0) HOT: the handle of the next live entity with the indexed flag in a slot
     * ABOVE `prev`'s slot, or -1 at the end. It continues from the SLOT of `prev` and
     * ignores its generation (M-39), so despawning or un-flagging `prev` inside the loop is
     * supported, and a flag set mid-loop on a HIGHER slot is visited (on a lower slot, not).
     *
     * Start every walk with `firstFlagged(flag)` and pass only a handle that `firstFlagged`
     * or `nextFlagged` returned (M-52). PRODUCTION TRUSTS both arguments and does not
     * validate them: a `flag` that is not exactly one indexed bit is UNSUPPORTED (may throw a TypeError or walk another flag's column), and a
     * non-integer `prev` (undefined / NaN / null) is UNSUPPORTED and silently resumes after
     * slot 0, skipping a flagged slot 0. CHECKED mode validates (M-41): the M-18 32-bit
     * integer check on `flag` and on `prev`, and E-ROW / E-BIT on `flag`.
     * @throws Error (checked mode only) the E-ROW / E-BIT texts of {@link Arena.flagCount}
     *   with the method name `nextFlagged`, or the M-18 `must be a 32-bit integer` error
     *   for a bad `flag` or `prev`.
     */
    nextFlagged(flag: number, prev: number): number;

    /**
     * (1.12.0) O(flagged): clears the indexed flag on every entity carrying it (rows and
     * column); `flagCount(flag)` is 0 afterwards. Validates `flag` like
     * {@link Arena.flagCount} (E-ROW / E-BIT, method name `clearFlagAll`).
     */
    clearFlagAll(flag: number): void;

    /**
     * (1.12.0) Hi-word twin of {@link Arena.flagCount} (`registerFlagsHi(names, { indexed })`).
     * @throws Error (E-ROW) when no Hi flag is indexed:
     *   `lite-arena: flagCountHi() needs registerFlagsHi() with { indexed: [...] } first`
     * @throws Error (E-BIT) `lite-arena: flagCountHi() needs exactly one indexed flag bit
     *   (indexed mask 0x<8 hex digits>), got <flag>`.
     */
    flagCountHi(flag: number): number;

    /** (1.12.0) Hi-word twin of {@link Arena.firstFlagged} (E-ROW / E-BIT as `flagCountHi`). */
    firstFlaggedHi(flag: number): number;

    /**
     * (1.12.0) HOT: Hi-word twin of {@link Arena.nextFlagged}, same M-39 / M-41 / M-52
     * contract (production trusts `flag` and `prev`; checked mode validates both).
     */
    nextFlaggedHi(flag: number, prev: number): number;

    /** (1.12.0) Hi-word twin of {@link Arena.clearFlagAll} (E-ROW / E-BIT as `flagCountHi`). */
    clearFlagAllHi(flag: number): void;
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
