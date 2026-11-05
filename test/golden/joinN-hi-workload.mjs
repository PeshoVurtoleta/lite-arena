/**
 * @zakkster/lite-arena -- joinN() full-plan capture + Hi-masked golden workload (PLAN-F2, TASK T2).
 *
 * Two jobs, both for the A8 oracle test/golden/joinN-f2-fe8d7d5.json (cut from the frozen
 * fe8d7d5 (1.11.0) build .handoff/before-F2-fe8d7d5/Arena.js, sha256 08e04bab..., by
 * .handoff/evidence/F2/joinN-cut.mjs):
 *
 * 1. capturePlans(ArenaClass, runFn) -> { sink, result }: calls runFn(Spy), where Spy =
 *    makeSpy(ArenaClass, sink) is `class Spy extends ArenaClass` whose constructor wraps the
 *    INSTANCE's joinN (the prototype method in production, the own checkedJoinN in checked mode)
 *    with a function that forwards `arguments` unchanged (checkedJoinN reads arguments.length)
 *    and snapshots every RETURNED plan, in call order, before handing it back. Spy.prototype adds
 *    nothing, so checkedJoinN's Object.getPrototypeOf(this).joinN still resolves to the class
 *    prototype joinN. sink = { keyLists, keyIds, records }; one record per plan:
 *
 *      [checked 0|1, readKeyListId, ownKeyListId, ...values in read-key order]
 *
 *    Read keys: production = Object.keys(plan); checked = the getter names on
 *    Object.getPrototypeOf(plan) (Object.getOwnPropertyNames order, descriptors with a `get`),
 *    read through the getters. Own keys = Object.keys(plan) (the checked plan's `_` fields).
 *    Values by key name (an unknown key throws): driver -> index into the call's required list
 *    (indexOf); others -> indices into required, first othersCount only; excl -> indices into
 *    excluded, first exclCount only; flags -> plan.flags === arena.flags; flagsHi ->
 *    plan.flagsHi === arena.flagsHi; count / othersCount / exclCount / the four masks and, on
 *    an F2 build, driverFlag / driverFlagCount -> the raw number (a non-number throws).
 *
 * 2. runHi(ArenaClass, { checked, hiOptions }) -> { plans }: a seeded churn (seed 0x6A09E667,
 *    2000 steps) on Arena(128) with registerFlags(f0..f31) + registerFlagsHi(h0..h31), grown
 *    once with reserve(256) at step 1000, that takes a joinN() plan every 10 steps: 200 plans
 *    over SETS[snap % 7] (no set in both lists) and MASKS[(snap * 3) % 16] (2-, 5- and 6-arg
 *    calls; reqMaskHi / excMaskHi incl. bit 31 as the signed map value and the unsigned literal
 *    0x80000000; no per-word reqMask & excMask overlap, so checked mode accepts every call).
 *    checked: true builds the arena with { checked: true }; hiOptions, when supplied, is passed
 *    as registerFlagsHi's second argument (the cut passes none).
 *
 * Imports no Arena -- the caller passes it. No side effects on import.
 */

function getterKeys(plan) {
    const proto = Object.getPrototypeOf(plan);
    const names = Object.getOwnPropertyNames(proto);
    const out = [];
    for (const n of names) {
        const d = Object.getOwnPropertyDescriptor(proto, n);
        if (d && typeof d.get === 'function') out.push(n);
    }
    return out;
}

function encode(arena, required, excluded, plan, keys) {
    const vals = [];
    for (const k of keys) {
        const v = plan[k];
        if (k === 'driver') vals.push(required.indexOf(v));
        else if (k === 'others') {
            const a = [];
            for (let i = 0; i < plan.othersCount; i++) a.push(required.indexOf(v[i]));
            vals.push(a);
        } else if (k === 'excl') {
            const a = [];
            for (let i = 0; i < plan.exclCount; i++) a.push(excluded.indexOf(v[i]));
            vals.push(a);
        } else if (k === 'flags') vals.push(v === arena.flags);
        else if (k === 'flagsHi') vals.push(v === arena.flagsHi);
        else if (k === 'count' || k === 'othersCount' || k === 'exclCount' || k === 'reqMask' ||
            k === 'excMask' || k === 'reqMaskHi' || k === 'excMaskHi' || k === 'driverFlag' || k === 'driverFlagCount') {
            if (typeof v !== 'number') throw new Error('non-number ' + k);
            vals.push(v);
        } else throw new Error('unknown plan key ' + k);
    }
    return vals;
}

// Capture state for one source: distinct key lists + records.
export function makeSink() {
    return { keyLists: [], keyIds: new Map(), records: [] };
}
function keyId(sink, list) {
    const s = JSON.stringify(list);
    let id = sink.keyIds.get(s);
    if (id === undefined) { id = sink.keyLists.length; sink.keyLists.push(list); sink.keyIds.set(s, id); }
    return id;
}

function snapshot(sink, arena, required, excluded, plan) {
    const checked = arena._checked === true;
    let readKeys, ownKeys;
    if (checked) {
        readKeys = getterKeys(plan);
        ownKeys = Object.keys(plan);
    } else {
        if (plan !== arena._joinNResult) throw new Error('production plan is not the scratch');
        readKeys = Object.keys(plan);
        ownKeys = readKeys;
    }
    const rec = [checked ? 1 : 0, keyId(sink, readKeys), keyId(sink, ownKeys)];
    const vals = encode(arena, required, excluded, plan, readKeys);
    for (const v of vals) rec.push(v);
    sink.records.push(rec);
}

/**
 * @param {Function} ArenaClass - the Arena constructor under test.
 * @param {{ keyLists: Array, keyIds: Map, records: Array }} sink - from makeSink().
 * @returns {Function} a subclass whose instances snapshot every returned joinN() plan into sink.
 */
export function makeSpy(ArenaClass, sink) {
    return class Spy extends ArenaClass {
        constructor(...args) {
            super(...args);
            const inner = this.joinN;
            this.joinN = function () {
                const p = inner.apply(this, arguments);
                snapshot(sink, this, arguments[0], arguments[1], p);
                return p;
            };
        }
    };
}

/**
 * @param {Function} ArenaClass - the Arena constructor under test.
 * @param {(Spy: Function) => *} runFn - runs a workload on the Spy class it is given.
 * @returns {{ sink: { keyLists: Array, keyIds: Map, records: Array }, result: * }}
 */
export function capturePlans(ArenaClass, runFn) {
    const sink = makeSink();
    const result = runFn(makeSpy(ArenaClass, sink));
    return { sink, result };
}

// ---- runHi: 200 Hi-masked plans (see header) -------------------------------------------------
const HI_STEPS = 2000;
const HI_EVERY = 10;
const HI_CAP = 128;
const HI_GROW_AT = 1000;
const HI_GROW_TO = 256;

function names32(p) {
    const out = [];
    for (let i = 0; i < 32; i++) out.push(p + i);
    return out;
}

/**
 * @param {Function} ArenaClass - the Arena constructor under test.
 * @param {{ checked?: boolean, hiOptions?: Object }} [opts]
 * @returns {{ plans: number }}
 */
export function runHi(ArenaClass, opts) {
    const checked = !!(opts && opts.checked);
    const arena = checked ? new ArenaClass(HI_CAP, { checked: true }) : new ArenaClass(HI_CAP);
    const A = arena.registerComponent({ v: Float32Array });
    const B = arena.registerComponent({ v: Int32Array });
    const C = arena.registerTag();
    const D = arena.registerTag();
    const F = arena.registerFlags(names32('f'));
    const H = opts && opts.hiOptions !== undefined
        ? arena.registerFlagsHi(names32('h'), opts.hiOptions)
        : arena.registerFlagsHi(names32('h'));
    const COMPS = [A, B, C, D];
    const HOT = [F.f0, F.f1, F.f2, F.f3, F.f31];
    const HOTH = [H.h0, H.h1, H.h2, H.h3, H.h31];

    // No set in both lists (checked mode would throw).
    const SETS = [
        [[A, B], [D]],
        [[A], null],
        [[C, A], []],
        [[B], [C]],
        [[A, C, B], null],
        [[D, A], [B]],
        [[C, C, A], [D]],
    ];
    // [argc, reqMask, excMask, reqMaskHi, excMaskHi]; no per-word overlap (checked M-13), cross-word
    // overlaps allowed. Bit 31 Hi as the signed map value and the unsigned literal 0x80000000.
    const MASKS = [
        [6, 0, 0, H.h0, 0],
        [6, 0, 0, H.h31, 0],
        [6, 0, 0, 0x80000000, 0],
        [6, 0, 0, 0, H.h31],
        [6, 0, 0, 0, 0x80000000],
        [6, F.f0, F.f1, H.h0 | H.h31, H.h2],
        [6, F.f31, 0, H.h1, H.h31],
        [6, 0, F.f31, H.h31, H.h3],
        [5, F.f2, 0, H.h2],
        [5, 0, 0, H.h31 | H.h1],
        [6, F.f31, 0, 0, H.h31],
        [6, 0x0F, 0, 0x0F, 0xF0],
        [6, 0, 0, H.h0 | H.h1 | H.h2 | H.h3, H.h31],
        [6, F.f1 | F.f31, F.f2, 0, 0],
        [6, 0, 0, 0, 0],
        [2, 0, 0, 0, 0],
    ];

    let s = 0x6A09E667 | 0;
    const next = () => {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        s = Math.imul(s, 0x2545F491) | 0;
        return s >>> 0;
    };

    const live = [];
    const pick = () => live[next() % live.length];
    const kill = (i) => {
        arena.despawn(live[i]);
        live[i] = live[live.length - 1];
        live.pop();
    };
    let plans = 0, snap = 0;

    for (let step = 1; step <= HI_STEPS; step++) {
        if (step === HI_GROW_AT) arena.reserve(HI_GROW_TO);
        const op = next() % 10;
        if (op <= 1 || live.length === 0) {
            if (live.length < arena.capacity - 16) live.push(arena.spawn());
            else kill(next() % live.length);
        } else if (op === 2) {
            kill(next() % live.length);
        } else if (op === 3) {
            COMPS[next() & 3].add(pick());
        } else if (op === 4) {
            COMPS[next() & 3].remove(pick());
        } else if (op === 5) {
            arena.setFlags(pick(), HOT[next() % HOT.length]);
        } else if (op === 6) {
            arena.setFlagsHi(pick(), HOTH[next() % HOTH.length]);
        } else if (op === 7) {
            arena.clearFlagsHi(pick(), HOTH[next() % HOTH.length]);
        } else if (op === 8) {
            arena.clearFlags(pick(), HOT[next() % HOT.length]);
        } else {
            const e = pick();
            COMPS[next() & 3].add(e);
            arena.setFlagsHi(e, (next() & 0x8000000F) | 0);
        }

        if (step % HI_EVERY !== 0) continue;
        snap++;
        const set = SETS[snap % SETS.length];
        const mk = MASKS[(snap * 3) % MASKS.length];
        const req = set[0], exc = set[1];
        if (mk[0] === 2) arena.joinN(req, exc);
        else if (mk[0] === 5) arena.joinN(req, exc, mk[1], mk[2], mk[3]);
        else arena.joinN(req, exc, mk[1], mk[2], mk[3], mk[4]);
        plans++;
    }
    return { plans };
}
