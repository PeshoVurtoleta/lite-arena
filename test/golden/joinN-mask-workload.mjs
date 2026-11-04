/**
 * @zakkster/lite-arena -- joinN() word-0-masked golden workload (PLAN-F1, TASK 0).
 *
 * run(ArenaClass) drives a seeded churn on Arena(256) that calls registerFlags()
 * with 32 names (word 0 full, so bit 31 is in play), sets / clears flags on live
 * entities (and, as a no-write control, on dead handles), grows the arena once
 * with reserve(512) mid-run, and records, every 20 steps, six masked joinN()
 * plans: 100 snapshots x 6 = 600 records of
 *
 *   [driverIdx, count, reqMask, excMask, flagsSame, match, fnv1a32]
 *
 * driverIdx = the driver's position in the required list, count = plan count,
 * reqMask / excMask = the plan's normalised masks, flagsSame = (p.flags ===
 * arena.flags), match = the match count of the masked loop documented in
 * Arena.js joinN() (one row read `w = p.flags[e & arena.indexMask]`, reject on
 * `(w & rm) !== rm || (w & xm) !== 0`, then the others / excl has() checks),
 * fnv1a32 = FNV-1a-32 of the matched handles in driver order.
 * Mask pairs rotate over the snapshots and cover: omitted masks (2-arg and
 * 3-arg calls), 0, single bits, bit 31 (signed -2147483648 and the unsigned
 * literal 0x80000000), multi-bit masks, a production reqMask & excMask overlap
 * (matches nothing) and excluded sets.
 *
 * It also records the error behaviour of the 1.10.0 flag surface as
 * [label, ctorName, message, flag]: registerFlags bad inputs (flag = the flag
 * row reference is unchanged by the throw), the production no-flags error
 * (M-10 / _noFlags) and the checked-mode errors M-13 / M-18 / M-20 / M-25 / M-11
 * plus set errors (flag = M-22: the plan taken just before the throw is still
 * readable; on an 'ok:' checked joinN row it is false by design -- the new plan
 * supersedes it). Labels starting 'ok:' must NOT throw (ctorName 'NO-THROW'); labels
 * starting 'v8:' carry a V8 TypeError message (engine wording, node-pinned).
 *
 * Uses ONLY the 1.10.0 surface; imports no Arena -- the caller passes it (the
 * golden is cut from the frozen 2c7af47 build by .handoff/evidence/F1-cut.mjs).
 */

const STEPS = 2000;
const EVERY = 20;
const CAP = 256;
const GROW_AT = 1000;
const GROW_TO = 512;

function fnvHandle(h, e) {
    h = Math.imul(h ^ (e & 0xFF), 16777619);
    h = Math.imul(h ^ ((e >>> 8) & 0xFF), 16777619);
    h = Math.imul(h ^ ((e >>> 16) & 0xFF), 16777619);
    h = Math.imul(h ^ ((e >>> 24) & 0xFF), 16777619);
    return h;
}

function names32() {
    const out = [];
    for (let i = 0; i < 32; i++) out.push('f' + i);
    return out;
}

function capture(errors, label, fn, flagFn) {
    let ctor = 'NO-THROW', msg = '';
    try { fn(); } catch (err) {
        ctor = err && err.constructor ? err.constructor.name : typeof err;
        msg = err && typeof err.message === 'string' ? err.message : String(err);
    }
    errors.push([label, ctor, msg, flagFn()]);
}

function registerFlagsErrors(ArenaClass, errors) {
    const cases = [
        ['registerFlags 33 names', () => { const n = names32(); n.push('f32'); return [n]; }],
        ['registerFlags duplicate name', () => [['x', 'x']]],
        ['registerFlags empty name', () => [['']]],
        ['registerFlags non-string name', () => [['a', 1]]],
        ['registerFlags names not an array (string)', () => ['abc']],
        ['registerFlags names null', () => [null]],
        ['registerFlags options unknown key', () => [['a'], { k: 1 }]],
        ['registerFlags options symbol key', () => [['a'], { [Symbol('s')]: 1 }]],
        ['registerFlags options custom prototype', () => [['a'], Object.create({})]],
        ['registerFlags options Array-prototype object', () => [['a'], Object.create(Array.prototype)]],
        ['registerFlags options is an array', () => [['a'], []]],
    ];
    for (let i = 0; i < cases.length; i++) {
        const a = new ArenaClass(8);
        const args = cases[i][1]();
        capture(errors, cases[i][0], () => a.registerFlags(args[0], args[1]), () => a.flags === null);
    }
    const a = new ArenaClass(8);
    a.registerFlags(['a']);
    const row = a.flags;
    capture(errors, 'registerFlags second call', () => a.registerFlags(['b']), () => a.flags === row);
    const ok = new ArenaClass(8);
    capture(errors, 'ok:registerFlags 32 names', () => ok.registerFlags(names32()), () => ok.flags !== null);
}

function productionErrors(ArenaClass, errors) {
    const a = new ArenaClass(8);
    const A = a.registerComponent({ v: Float32Array });
    const B = a.registerTag();
    const e = a.spawn();
    A.add(e);
    const none = () => a.flags === null;
    capture(errors, 'noFlags reqMask', () => a.joinN([A], null, 1, 0), none);
    capture(errors, 'noFlags excMask bit31 unsigned', () => a.joinN([A], [B], 0, 0x80000000), none);
    capture(errors, 'noFlags reqMask -1', () => a.joinN([A], null, -1), none);
    capture(errors, 'noFlags empty required wins (M-11)', () => a.joinN([], null, 1, 0), none);
    capture(errors, 'ok:noFlags zero masks', () => a.joinN([A], null, 0, 0), none);
    capture(errors, 'v8:setFlags before registerFlags', () => a.setFlags(e, 1), none);
    capture(errors, 'v8:hasFlags before registerFlags', () => a.hasFlags(e, 1), none);
}

function checkedErrors(ArenaClass, errors) {
    const a = new ArenaClass(16, { checked: true });
    const A = a.registerComponent({ v: Float32Array });
    const B = a.registerTag();
    const F = a.registerFlags(names32());
    const e = a.spawn();
    A.add(e); B.add(e);
    const other = new ArenaClass(4);
    const X = other.registerTag();
    let prev = null;
    const live = () => { try { return prev.count === 1; } catch (err) { return false; } };
    const J = (label, fn) => {
        prev = a.joinN([A], null, 0, 0);
        capture(errors, label, fn, live);
    };
    J('M-13 reqMask & excMask overlap', () => a.joinN([A], null, F.f0 | F.f1, F.f1));
    J('M-13 bit31 overlap (unsigned vs signed)', () => a.joinN([A], null, 0x80000000, F.f31));
    J('M-20 reqMask fraction', () => a.joinN([A], null, 1.5, 0));
    J('M-20 excMask NaN', () => a.joinN([A], null, 0, NaN));
    J('M-20 reqMask 2**32', () => a.joinN([A], null, 2 ** 32, 0));
    J('M-20 reqMask string', () => a.joinN([A], null, '1', 0));
    J('M-20 excMask Infinity', () => a.joinN([A], [B], 0, Infinity));
    J('M-25 supplied undefined reqMask', () => a.joinN([A], null, undefined));
    J('M-25 supplied undefined excMask', () => a.joinN([A], null, 0, undefined));
    J('M-11 null required wins over a bad mask', () => a.joinN(null, null, NaN));
    J('checked set in both lists', () => a.joinN([A], [A], 0, 0));
    J('checked foreign required set', () => a.joinN([X], null, 0, 0));
    J('checked foreign excluded set', () => a.joinN([A], [X], 0, 0));
    J('ok:checked bit31 unsigned accepted', () => a.joinN([A], null, 0x80000000, 0));
    J('ok:checked omitted masks', () => a.joinN([A], null));
    J('ok:checked cross-mask disjoint', () => a.joinN([A], [B], F.f0, F.f31));
    J('M-18 setFlags undefined', () => a.setFlags(e, undefined));
    J('M-18 clearFlags fraction', () => a.clearFlags(e, 1.5));
    J('M-18 hasFlags excluded NaN', () => a.hasFlags(e, 1, NaN));
    J('M-18 hasFlags required string', () => a.hasFlags(e, '1'));
    J('ok:M-18 hasFlags excluded omitted', () => a.hasFlags(e, F.f31));

    const b = new ArenaClass(8, { checked: true });
    const C = b.registerTag();
    const f = b.spawn();
    C.add(f);
    prev = b.joinN([C], null, 0, 0);
    capture(errors, 'checked noFlags reqMask', () => b.joinN([C], null, 1, 0), live);
    prev = b.joinN([C], null, 0, 0);
    capture(errors, 'checked noFlags M-20 before M-10', () => b.joinN([C], null, 0.5, 0), live);
}

/**
 * @param {Function} ArenaClass - the Arena constructor under test.
 * @returns {{ records: Array<Array>, errors: Array<Array>, flagMap: Array<number> }}
 */
export function run(ArenaClass) {
    const arena = new ArenaClass(CAP);
    const A = arena.registerComponent({ v: Float32Array });
    const B = arena.registerComponent({ v: Int32Array });
    const C = arena.registerTag();
    const D = arena.registerComponent({ v: Uint8Array });
    const F = arena.registerFlags(names32());
    const COMPS = [A, B, C, D];
    const flagMap = [];
    for (let i = 0; i < 32; i++) flagMap.push(F['f' + i]);
    // Hot bits: 0..7 and 31, so masked queries keep matching.
    const HOT = [F.f0, F.f1, F.f2, F.f3, F.f4, F.f5, F.f6, F.f7, F.f31];

    const SETS = [
        [[A, B], [D]],
        [[A], null],
        [[C, A], []],
        [[B], [C]],
        [[A, C, B], null],
        [[D, A], [B]],
    ];
    // [argc, reqMask, excMask]: argc 2 / 3 omit trailing masks.
    const MASKS = [
        [2, 0, 0],
        [4, 0, 0],
        [3, F.f0, 0],
        [4, 0, F.f3],
        [4, 0x80000000, 0],
        [4, F.f31, 0],
        [4, 0, F.f31],
        [4, F.f0 | F.f2, F.f31 | F.f1],
        [4, F.f31 | F.f4, F.f5 | F.f6],
        [4, 0x0F, 0],
        [4, F.f1, F.f1],
        [4, F.f7 | F.f31, F.f2],
        [4, F.f5, 0x0F0],
    ];

    let s = 0x2545F491 | 0;
    const next = () => {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        s = Math.imul(s, 0x2545F491) | 0;
        return s >>> 0;
    };

    const live = [];
    let dead = -1;
    const pick = () => live[next() % live.length];
    const kill = (i) => {
        dead = live[i];
        arena.despawn(dead);
        live[i] = live[live.length - 1];
        live.pop();
    };
    const records = [];
    let snap = 0;

    for (let step = 1; step <= STEPS; step++) {
        if (step === GROW_AT) arena.reserve(GROW_TO);
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
            arena.clearFlags(pick(), HOT[next() % HOT.length]);
        } else if (op === 7) {
            arena.setFlags(pick(), (next() & 0x800000FF) | 0);
        } else if (op === 8) {
            const r = next();
            if ((r & 15) === 0) arena.clearFlags(pick(), -1);
            else arena.clearFlags(pick(), r | 0);
            // A dead handle is a no-write control: a write here would leak into
            // the slot's next entity and move later match hashes.
            if (dead !== -1 && arena.setFlags(dead, -1) !== false) throw new Error('workload: dead setFlags wrote');
        } else {
            const e = pick();
            COMPS[next() & 3].add(e);
            COMPS[next() & 3].add(e);
            arena.setFlags(e, HOT[next() % HOT.length]);
        }

        if (step % EVERY !== 0) continue;
        snap++;
        for (let q = 0; q < SETS.length; q++) {
            const req = SETS[q][0], exc = SETS[q][1];
            const mk = MASKS[(snap * 7 + q * 5) % MASKS.length];
            const p = mk[0] === 2 ? arena.joinN(req, exc)
                : mk[0] === 3 ? arena.joinN(req, exc, mk[1])
                    : arena.joinN(req, exc, mk[1], mk[2]);
            const drv = p.driver, n = p.count;
            const oth = p.others, no = p.othersCount;
            const ex = p.excl, nx = p.exclCount;
            const row = p.flags, m = arena.indexMask, rm = p.reqMask, xm = p.excMask;
            let match = 0, h = 0x811C9DC5 | 0;
            for (let i = 0; i < n; i++) {
                const e = drv.dense[i];
                const w = row[e & m];
                if ((w & rm) !== rm || (w & xm) !== 0) continue;
                let ok = true;
                for (let k = 0; k < no; k++) if (!oth[k].has(e)) { ok = false; break; }
                if (ok) for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
                if (!ok) continue;
                match++;
                h = fnvHandle(h, e);
            }
            records.push([req.indexOf(drv), n, rm, xm, row === arena.flags, match, h >>> 0]);
        }
    }

    const errors = [];
    registerFlagsErrors(ArenaClass, errors);
    productionErrors(ArenaClass, errors);
    checkedErrors(ArenaClass, errors);
    return { records, errors, flagMap };
}
