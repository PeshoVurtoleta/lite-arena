/**
 * @zakkster/lite-arena -- F2 non-indexed parity golden workload (PLAN-F2, TASK T1 / A7).
 *
 * run(ArenaClass) drives seeded (xorshift) churn on four NON-INDEXED arenas -- shape A
 * (Arena(256), 32 word-0 names + 32 Hi names, reserve(512) mid-run) and shape B (Arena(64),
 * registerFlags([]) + a 3-name Hi word, reserve(100) mid-run), each plain AND
 * { checked: true } -- and returns exactly 2,000 records, every one ending in an FNV-1a-32:
 *
 *   ['ops', cfg, iter, codes[8], results[8], activeCount, capacity, fnv1a32]
 *     one burst of 8 ops: spawn / despawn (live + dead handles) / setFlags / clearFlags /
 *     hasFlags and the Hi twins (masks -1, bit 31 signed + unsigned literal, 0, single bits,
 *     random int32, fail-open values 1.5 / NaN / undefined / '3' / 2^32 / Infinity),
 *     component add / remove, reserve() (grow, then a no-op shrink) and clear(). A result is
 *     the return value, or 'T:' + message when it throws (checked mode). fnv1a32 = the op
 *     results plus the arena state after the burst: capacity, activeCount, retiredCount,
 *     every flags / flagsHi row word, every component count + dense[0..count).
 *   ['plan', cfg, iter, driverIdx, count, othersIdx[], othersCount, exclIdx[], exclCount,
 *    reqMask, excMask, flagsSame, reqMaskHi, excMaskHi, flagsHiSame, stale, match, fnv1a32]
 *     one masked / Hi-masked joinN() plan, read by an EXPLICIT list of the 1.11.0 plan fields
 *     (never Object.keys, so fields F2 appends do not move it). Indices are positions in the
 *     arena's component list [A, B, C]. stale = plain: the previous plan is the same object;
 *     checked: the previous plan's count read ('T:' + the stale-read message). match / fnv1a32
 *     = the matched handles of the documented masked loop (word 0 + Hi row reads), in driver
 *     order. A throwing joinN (checked M-13 overlap) records ['planT', cfg, iter, msg, fnv].
 *   ['err', mode, label, ctorName, message, state, fnv1a32]
 *     every registerFlags / registerFlagsHi option / name error, EXCEPT the unknown-options-key
 *     family ("takes no options; got k" -- own key, symbol key, array or non-object options),
 *     which F2 rewords on purpose (M-40). Labels starting 'ok:' must not throw. state =
 *     flags / flagsHi row lengths (or null), own setFlags, the returned map (ok rows).
 *
 * Uses ONLY the 1.11.0 public surface; imports no Arena -- the caller passes it (the golden
 * is cut from the frozen fe8d7d5 build by .handoff/evidence/F2/f2-cut.mjs).
 */

const TOTAL = 2000;
const BURST = 8;
const PLAN_EVERY = 4;

function fnvInt(h, v) {
    h = Math.imul(h ^ (v & 0xFF), 16777619);
    h = Math.imul(h ^ ((v >>> 8) & 0xFF), 16777619);
    h = Math.imul(h ^ ((v >>> 16) & 0xFF), 16777619);
    h = Math.imul(h ^ ((v >>> 24) & 0xFF), 16777619);
    return h;
}

function fnvStr(h, s) {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h = Math.imul(h ^ (c & 0xFF), 16777619);
        h = Math.imul(h ^ (c >>> 8), 16777619);
    }
    return h;
}

function fnvVal(h, v) {
    if (typeof v === 'number') return fnvInt(fnvInt(h, 1), v | 0);
    if (typeof v === 'boolean') return fnvInt(h, v ? 3 : 2);
    if (v === null || v === undefined) return fnvInt(h, v === null ? 4 : 5);
    return fnvStr(fnvInt(h, 6), String(v));
}

function names(prefix, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(prefix + i);
    return out;
}

function tryCall(fn) {
    try {
        const v = fn();
        return v === undefined ? null : v;
    } catch (err) {
        return 'T:' + (err && typeof err.message === 'string' ? err.message : String(err));
    }
}

const SHAPES = {
    A: { cap: 256, grow: 512, shrink: 100, word: names('f', 32), hi: names('h', 32), seed: 0x2545F491 },
    B: { cap: 64, grow: 100, shrink: 32, word: [], hi: ['x', 'y', 'z'], seed: 0x1B873593 },
};
const CONFIGS = [['A', false], ['A', true], ['B', false], ['B', true]];
// Values a production arena takes fail-open (`| 0`) and a checked arena rejects (M-18).
const BAD = [1.5, NaN, undefined, '3', 4294967296, Infinity, null, -0.5];

function runConfig(ArenaClass, cfg, shapeName, checked, budget, records) {
    const sh = SHAPES[shapeName];
    const arena = checked ? new ArenaClass(sh.cap, { checked: true }) : new ArenaClass(sh.cap);
    const A = arena.registerComponent({ v: Float32Array });
    const B = arena.registerTag();
    const C = arena.registerComponent({ v: Int32Array });
    const COMPS = [A, B, C];
    const F = arena.registerFlags(sh.word);
    const H = arena.registerFlagsHi(sh.hi);
    const wordBits = [];
    for (const k of sh.word) wordBits.push(F[k]);
    const hiBits = [];
    for (const k of sh.hi) hiBits.push(H[k]);

    let s = sh.seed | 0;
    const next = () => {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        s = Math.imul(s, 0x2545F491) | 0;
        return s >>> 0;
    };
    const mask = (bits) => {
        const r = next() % 9;
        if (r === 0) return -1;
        if (r === 1) return -2147483648;
        if (r === 2) return 0x80000000;
        if (r === 3) return 0;
        if (r === 4) return next() | 0;
        if (r === 5) return next() & 0xFF;
        if (r === 6 && bits.length > 0) return bits[next() % bits.length];
        if (r === 7 && bits.length > 1) return bits[next() % bits.length] | bits[next() % bits.length];
        return 1 << (next() & 31);
    };

    // Plan masks lean to 0 / one or two named bits / bit 31, so masked loops still match.
    const planMask = (bits) => {
        const r = next() % 8;
        if (r <= 2) return 0;
        if (r === 3) return next() & 1 ? -2147483648 : 0x80000000;
        if (r === 7) return mask(bits);
        if (bits.length === 0) return 1 << (next() & 3);
        const b = bits[next() % bits.length];
        return r === 6 ? b | bits[next() % bits.length] : b;
    };

    const live = [];
    const dead = [];
    const toDead = (e) => { dead.push(e); if (dead.length > 16) dead.shift(); };
    const pickIdx = () => next() % live.length;
    const kill = () => {
        const i = pickIdx();
        const e = live[i];
        live[i] = live[live.length - 1];
        live.pop();
        toDead(e);
        return arena.despawn(e);
    };
    const pickDead = () => (dead.length === 0 ? 0 : dead[next() % dead.length]);

    const GROW_AT = (budget * 0.4) | 0;
    const CLEAR_AT = (budget * 0.75) | 0;
    let prev = null;

    // Joinable lists: [required, excluded]; [A] / [A] is a set both required and
    // excluded (production: empty match; checked: throws).
    const SETS = [
        [[A, B], [C]], [[A], null], [[C, A], []], [[B], [C]], [[A, C, B], null],
        [[B, A], [C]], [[A, A, B], null], [[A], [A]],
    ];

    for (let iter = 0; iter < budget; iter++) {
        const isPlan = iter % PLAN_EVERY === PLAN_EVERY - 1 && iter !== GROW_AT && iter !== CLEAR_AT;
        if (isPlan) {
            const q = SETS[next() % SETS.length];
            const req = q[0], exc = q[1];
            const form = next() % 6;
            const rm = planMask(wordBits), xm = form === 5 ? rm : planMask(wordBits);
            const rh = planMask(hiBits), xh = planMask(hiBits);
            let p;
            try {
                p = form === 0 ? arena.joinN(req, exc)
                    : form === 1 ? arena.joinN(req, exc, rm)
                        : form === 2 ? arena.joinN(req, exc, rm, xm)
                            : form === 3 ? arena.joinN(req, exc, 0, 0, rh)
                                : arena.joinN(req, exc, rm, xm, rh, xh);
            } catch (err) {
                const msg = err.message;
                records.push(['planT', cfg, iter, msg, fnvStr(0x811C9DC5 | 0, msg) >>> 0]);
                continue;
            }
            let stale;
            if (prev === null) stale = 'none';
            else if (checked) stale = tryCall(() => prev.count);
            else stale = prev === p;
            const drv = p.driver, n = p.count;
            const oth = p.others, no = p.othersCount;
            const ex = p.excl, nx = p.exclCount;
            const pr = p.reqMask, px = p.excMask, row = p.flags;
            const prh = p.reqMaskHi, pxh = p.excMaskHi, rowHi = p.flagsHi;
            const othIdx = [], exIdx = [];
            for (let k = 0; k < no; k++) othIdx.push(COMPS.indexOf(oth[k]));
            for (let k = 0; k < nx; k++) exIdx.push(COMPS.indexOf(ex[k]));
            const m = arena.indexMask;
            let match = 0, h = 0x811C9DC5 | 0;
            for (let i = 0; i < n; i++) {
                const e = drv.dense[i];
                const w = row[e & m], wh = rowHi[e & m];
                if ((w & pr) !== pr || (w & px) !== 0) continue;
                if ((wh & prh) !== prh || (wh & pxh) !== 0) continue;
                let ok = true;
                for (let k = 0; k < no; k++) if (!oth[k].has(e)) { ok = false; break; }
                if (ok) for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
                if (!ok) continue;
                match++;
                h = fnvInt(h, e);
            }
            records.push(['plan', cfg, iter, COMPS.indexOf(drv), n, othIdx, no, exIdx, nx,
                pr, px, row === arena.flags, prh, pxh, rowHi === arena.flagsHi, stale, match, h >>> 0]);
            prev = p;
            continue;
        }

        const codes = [], results = [];
        for (let j = 0; j < BURST; j++) {
            let code = next() % 14;
            if (iter === GROW_AT && j < 2) code = 20 + j;
            if (iter === CLEAR_AT && j === 0) code = 22;
            if (live.length === 0 && code >= 2 && code <= 10) code = 0;
            let res;
            switch (code) {
                case 0: case 1:
                    if (live.length < arena.capacity - 4) {
                        const e = arena.spawn();
                        live.push(e);
                        // Every spawn joins A, half join B: joinN plans keep real drivers.
                        A.add(e);
                        if (next() & 1) B.add(e);
                        res = e;
                    } else {
                        res = kill();
                    }
                    break;
                case 2: res = kill(); break;
                case 3: { const e = live[pickIdx()], mk = mask(wordBits); res = tryCall(() => arena.setFlags(e, mk)); break; }
                case 4: { const e = live[pickIdx()], mk = mask(wordBits); res = tryCall(() => arena.clearFlags(e, mk)); break; }
                case 5: {
                    const e = live[pickIdx()], r = mask(wordBits);
                    if (next() & 1) res = tryCall(() => arena.hasFlags(e, r));
                    else { const x = mask(wordBits); res = tryCall(() => arena.hasFlags(e, r, x)); }
                    break;
                }
                case 6: { const e = live[pickIdx()], mk = mask(hiBits); res = tryCall(() => arena.setFlagsHi(e, mk)); break; }
                case 7: { const e = live[pickIdx()], mk = mask(hiBits); res = tryCall(() => arena.clearFlagsHi(e, mk)); break; }
                case 8: {
                    const e = live[pickIdx()], r = mask(hiBits);
                    if (next() & 1) res = tryCall(() => arena.hasFlagsHi(e, r));
                    else { const x = mask(hiBits); res = tryCall(() => arena.hasFlagsHi(e, r, x)); }
                    break;
                }
                case 9: {
                    // Component churn on a live entity.
                    const e = live[pickIdx()], c = COMPS[next() % 3];
                    if (next() & 1) { c.add(e); res = c.has(e); } else res = c.remove(e);
                    break;
                }
                case 10: {
                    // Fail-open (production) / M-18 throw (checked) mask values on a live entity.
                    const e = live[pickIdx()], b = BAD[next() % BAD.length], w = next() % 6;
                    res = tryCall(() => (w === 0 ? arena.setFlags(e, b) : w === 1 ? arena.clearFlags(e, b)
                        : w === 2 ? arena.hasFlags(e, b) : w === 3 ? arena.setFlagsHi(e, b)
                            : w === 4 ? arena.clearFlagsHi(e, b) : arena.hasFlagsHi(e, 0, b)));
                    break;
                }
                case 11: case 12: {
                    // Dead-handle no-write controls (the slot may be reused by a live entity).
                    const e = pickDead(), w = next() % 7;
                    res = w === 0 ? arena.setFlags(e, -1) : w === 1 ? arena.clearFlags(e, -1)
                        : w === 2 ? arena.hasFlags(e, 0) : w === 3 ? arena.setFlagsHi(e, -1)
                            : w === 4 ? arena.clearFlagsHi(e, -1) : w === 5 ? arena.hasFlagsHi(e, 0)
                                : arena.despawn(e);
                    break;
                }
                case 13: res = arena.isAlive(pickDead()); break;
                case 20: res = tryCall(() => arena.reserve(sh.grow)); break;
                case 21: res = tryCall(() => arena.reserve(sh.shrink)); break;
                case 22:
                    arena.clear();
                    for (let i = 0; i < live.length; i++) toDead(live[i]);
                    live.length = 0;
                    res = null;
                    break;
                default: res = 'bad-code';
            }
            codes.push(code);
            results.push(res === undefined ? null : res);
        }

        let h = 0x811C9DC5 | 0;
        for (let j = 0; j < results.length; j++) h = fnvVal(fnvInt(h, codes[j]), results[j]);
        const cap = arena.capacity;
        h = fnvInt(h, cap);
        h = fnvInt(h, arena.activeCount);
        h = fnvInt(h, arena.retiredCount);
        const row = arena.flags, rowHi = arena.flagsHi;
        h = fnvInt(h, row.length);
        h = fnvInt(h, rowHi.length);
        for (let i = 0; i < cap; i++) h = fnvInt(fnvInt(h, row[i]), rowHi[i]);
        for (let k = 0; k < COMPS.length; k++) {
            const c = COMPS[k];
            h = fnvInt(h, c.count);
            for (let i = 0; i < c.count; i++) h = fnvInt(h, c.dense[i]);
        }
        records.push(['ops', cfg, iter, codes, results, arena.activeCount, cap, h >>> 0]);
    }
}

function capture(rows, mode, label, makeArena, call, state) {
    const a = makeArena();
    let ctor = 'NO-THROW', msg = '', ret = null;
    try { ret = call(a); } catch (err) {
        ctor = err && err.constructor ? err.constructor.name : typeof err;
        msg = err && typeof err.message === 'string' ? err.message : String(err);
    }
    let st = (a.flags === null ? 'null' : String(a.flags.length)) + '/' +
        (a.flagsHi === null ? 'null' : String(a.flagsHi.length)) + '/own=' + Object.hasOwn(a, 'setFlags');
    if (ret !== null && typeof ret === 'object') {
        st += '/frozen=' + Object.isFrozen(ret) + '/proto=' + (Object.getPrototypeOf(ret) === null) +
            '/map=' + JSON.stringify(Object.entries(ret));
    }
    if (state) st += '/' + state(a);
    const h = fnvStr(fnvStr(fnvStr(fnvStr(0x811C9DC5 | 0, label), ctor), msg), st);
    rows.push(['err', mode, label, ctor, msg, st, h >>> 0]);
}

function registrationErrors(ArenaClass, rows) {
    class Foo {}
    function namedFn() {}
    const n33 = names('f', 33);
    // [label, names, options] -- every case runs on a fresh arena; none is in the M-40 family.
    const CASES = [
        ['33 names', () => n33, () => undefined],
        ['duplicate name', () => ['x', 'x'], () => undefined],
        ['empty name', () => ['a', ''], () => undefined],
        ['non-string name (number)', () => ['a', 1], () => undefined],
        ['non-string name (null)', () => [null], () => undefined],
        ['non-string name (undefined)', () => [undefined], () => undefined],
        ['non-string name (object)', () => [{}], () => undefined],
        ['non-string name (function)', () => [namedFn], () => undefined],
        ['non-string name (symbol)', () => [Symbol('s')], () => undefined],
        ['names a string', () => 'abc', () => undefined],
        ['names null', () => null, () => undefined],
        ['names a number', () => 5, () => undefined],
        ['names array-like object', () => ({ length: 1, 0: 'a' }), () => undefined],
        ['options custom prototype', () => ['a'], () => Object.create({})],
        ['options inherited indexed key', () => ['a'], () => Object.create({ indexed: ['a'] })],
        ['options Array-prototype object', () => ['a'], () => Object.create(Array.prototype)],
        ['options class instance', () => ['a'], () => new Foo()],
        ['options Map', () => ['a'], () => new Map()],
        ['options bad prototype wins over bad names', () => 5, () => Object.create({})],
        ['ok:options {}', () => ['a', 'b'], () => ({})],
        ['ok:options null', () => ['a', 'b'], () => null],
        ['ok:options null-prototype', () => ['a', 'b'], () => Object.create(null)],
        ['ok:no names', () => undefined, () => undefined],
        ['ok:empty names', () => [], () => undefined],
        ['ok:32 names', () => names('f', 32), () => undefined],
    ];
    for (const mode of ['plain', 'checked']) {
        const make = (cap) => () => (mode === 'checked' ? new ArenaClass(cap, { checked: true }) : new ArenaClass(cap));
        for (const [label, nm, op] of CASES) {
            capture(rows, mode, 'registerFlags ' + label, make(8), (a) => a.registerFlags(nm(), op()));
        }
        for (const [label, nm, op] of CASES) {
            capture(rows, mode, 'registerFlagsHi ' + label, make(8), (a) => {
                a.registerFlags(['w']);
                return a.registerFlagsHi(nm(), op());
            });
        }
        capture(rows, mode, 'registerFlags second call', make(8), (a) => {
            a.registerFlags(['a']);
            return a.registerFlags(['b']);
        });
        capture(rows, mode, 'registerFlags second call with bad options', make(8), (a) => {
            a.registerFlags(['a']);
            return a.registerFlags(5, Object.create({}));
        });
        capture(rows, mode, 'registerFlagsHi before registerFlags', make(8), (a) => a.registerFlagsHi(['h']));
        capture(rows, mode, 'registerFlagsHi before registerFlags with bad options', make(8),
            (a) => a.registerFlagsHi(['h'], Object.create({})));
        capture(rows, mode, 'registerFlagsHi second call', make(8), (a) => {
            a.registerFlags([]);
            a.registerFlagsHi(['h']);
            return a.registerFlagsHi(['i']);
        });
        capture(rows, mode, 'registerFlagsHi second call with bad options', make(8), (a) => {
            a.registerFlags([]);
            a.registerFlagsHi(['h']);
            return a.registerFlagsHi(5, Object.create({}));
        });
        capture(rows, mode, 'ok:registerFlags after a throw still registers', make(8), (a) => {
            try { a.registerFlags(['a', 'a']); } catch (err) { /* recorded by the row above */ }
            return a.registerFlags(['a', 'b']);
        });
        capture(rows, mode, 'ok:registerFlags after reserve sizes the row', make(8), (a) => {
            a.reserve(40);
            const map = a.registerFlags(['a']);
            a.registerFlagsHi(['h']);
            return map;
        });
    }
}

/**
 * @param {Function} ArenaClass - the Arena constructor under test.
 * @returns {{ records: Array<Array>, errorRows: number }}
 */
export function run(ArenaClass) {
    const errs = [];
    registrationErrors(ArenaClass, errs);
    const budget = TOTAL - errs.length;
    const records = [];
    for (let c = 0; c < CONFIGS.length; c++) {
        const share = ((budget / CONFIGS.length) | 0) + (c < budget % CONFIGS.length ? 1 : 0);
        runConfig(ArenaClass, c, CONFIGS[c][0], CONFIGS[c][1], share, records);
    }
    for (let i = 0; i < errs.length; i++) records.push(errs[i]);
    return { records, errorRows: errs.length };
}
