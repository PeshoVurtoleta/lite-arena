/**
 * @zakkster/lite-arena -- 1.12.1-B handle-canonical golden workload (PLAN-1.12.1-B TASK 0 (b)).
 *
 * run(mod) drives a seeded (xorshift32) stream of spawn / add / tag / setFlags / setFlagsHi /
 * clearFlags(Hi) / remove / despawn with CANONICAL handles only (the int32 spawn() returned),
 * on slots pre-churned past generation 2048 (so negative handles occur; two slots retire
 * mid-stream). Unit 1.12.1-B (despawn `entity |= 0`, checked isAlive, checked hasFlags(Hi)
 * `arguments.length > 2`) must leave every byte of the output unchanged.
 *   G1: the stream on a production arena and on an indexed arena.
 *   G2: the same stream on { checked: true } (plain + indexed), plus valid 2-arg and 3-arg
 *       hasFlags / hasFlagsHi calls (results recorded) and the throw messages of a fixed list
 *       of invalid calls that B does not change (bad masks, idx on a non-member, joinN set
 *       errors, exhaustion). No non-int32 handle, no supplied-undefined excluded mask.
 * Each run dumps generations, freeHead, the raw freeList and the walked free list, active /
 * retired counts, both flag rows, every set's count / dense[0..count) / sparse of each member,
 * per indexed bit flagCount and the firstFlagged..nextFlagged walk, and an FNV-1a 32 hash of
 * every op's return value (`ret`) over the whole stream. The state dumps are small (CAP = 16),
 * so nothing is digested except the return stream.
 *
 * Cut ONLY from the frozen before-B build (.handoff/builds/before-1.12.1-B/Arena.js, sha256/8
 * 83f754df == git show 296d193:Arena.js):
 *   node test/golden/handle-canonical-workload.mjs /abs/path/to/frozen/Arena.js \
 *     > test/golden/handle-canonical-83f754df.json
 * The module is loaded by the path argument; this file never imports the live Arena.js and
 * never reads .handoff/. Hashes at cut time (FNV-1a 32): return stream 0x404490f8 in all four
 * runs (G1 / G2 x plain / indexed: the has-calls draw from their own generator, so the
 * mutating stream and the final state are identical across the four); G2 has-call results
 * 0x21a041c6. JSON ~25 KB. A replay compares the whole object, not only the hashes.
 */
import { pathToFileURL } from 'node:url';

export const CAP = 16;
export const OPS = 20000;
export const SEED = 0x1BADB002;
// Pre-churn target generation per slot (spawn / despawn cycles before the stream). Slots
// 4 and 5 sit near GEN_MASK (4095) and retire during the stream; most sit past 2048.
const TARGET = [2046, 2047, 2048, 2040, 4060, 4070, 2100, 2500, 3000, 1, 2049, 2200, 3500, 2047, 2600, 2050];
const IX_LO = ['f0', 'f5', 'f31'];
const IX_HI = ['h1', 'h17', 'h31'];

function names(p) { const a = []; for (let i = 0; i < 32; i++) a.push(p + i); return a; }

function fnv(h, v) {
    // FNV-1a 32 over the 4 bytes of an int32 (v | 0); integer math only.
    v |= 0;
    for (let k = 0; k < 4; k++) {
        h ^= (v >>> (k * 8)) & 0xFF;
        h = Math.imul(h, 0x01000193);
    }
    return h;
}
const hex = (h) => '0x' + (h >>> 0).toString(16).padStart(8, '0');

function cap(fn) {
    try { const v = fn(); return { ok: true, v: v === undefined ? null : v }; }
    catch (e) { return { threw: (e && e.constructor && e.constructor.name) + ': ' + (e && e.message) }; }
}

function build(Arena, checked, indexed) {
    const a = checked ? new Arena(CAP, { checked: true }) : new Arena(CAP);
    const C = a.registerComponent({ x: Float32Array });
    const T = a.registerTag();
    const F = indexed ? a.registerFlags(names('f'), { indexed: IX_LO }) : a.registerFlags(names('f'));
    const H = indexed ? a.registerFlagsHi(names('h'), { indexed: IX_HI }) : a.registerFlagsHi(names('h'));
    return { a, C, T, F, H };
}

// Pre-churn: slot i reaches generation TARGET[i], then every slot is despawned in a
// seed-independent fixed order, so the stream starts on an empty arena with a mixed free list.
function churn(a) {
    const h = new Array(CAP);
    for (let i = 0; i < CAP; i++) h[i] = a.spawn();
    for (let i = 0; i < CAP; i++) {
        const t = TARGET[i];
        a.despawn(h[i]);
        let e = a.spawn();                       // LIFO: slot i again
        while ((e >>> 20) < t) { a.despawn(e); e = a.spawn(); }
        h[i] = e;
    }
    for (let k = 0; k < CAP; k++) a.despawn(h[(k * 7) & (CAP - 1)]);
}

function stream(w, checkedHas) {
    const { a, C, T } = w;
    let s = SEED | 0;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
    // the has-calls draw from their OWN generator, so the mutating stream is identical in G1 and G2
    let z = (SEED ^ 0x5A5A5A5A) | 0;
    const rnz = () => { z ^= z << 13; z ^= z >>> 17; z ^= z << 5; return z >>> 0; };
    const live = [];
    const dead = new Int32Array(32);
    let deadN = 0;
    let ret = 0x811C9DC5 | 0, has = 0x811C9DC5 | 0;
    const kinds = { spawn: 0, add: 0, tag: 0, setFlags: 0, setFlagsHi: 0, clear: 0, remove: 0, despawn: 0, staleDespawn: 0, skipped: 0 };
    let negOps = 0, hasTrue = 0, hasFalse = 0;
    const hasFirst = [];
    const pick = () => live[rnd() % live.length];
    for (let op = 0; op < OPS; op++) {
        const r = rnd() % 100;
        let e;
        if (r < 24 || live.length === 0) {
            if (a.remainingCapacity() === 0) { kinds.skipped++; ret = fnv(ret, -7); continue; }
            e = a.spawn(); live.push(e); kinds.spawn++; ret = fnv(ret, e);
        } else if (r < 38) {
            e = pick(); kinds.add++; ret = fnv(ret, C.add(e));
            const i = C.idx(e); C.data.x[i] = op;
        } else if (r < 47) {
            e = pick(); kinds.tag++; ret = fnv(ret, T.add(e));
        } else if (r < 57) {
            e = pick(); kinds.setFlags++; ret = fnv(ret, a.setFlags(e, rnd() | 0) ? 1 : 0);
        } else if (r < 65) {
            e = pick(); kinds.setFlagsHi++; ret = fnv(ret, a.setFlagsHi(e, rnd() | 0) ? 1 : 0);
        } else if (r < 70) {
            e = pick(); kinds.clear++;
            const m = rnd() | 0;
            ret = fnv(ret, ((r & 1) === 0 ? a.clearFlags(e, m) : a.clearFlagsHi(e, m)) ? 1 : 0);
        } else if (r < 76) {
            e = pick(); kinds.remove++;
            ret = fnv(ret, ((r & 1) === 0 ? C.remove(e) : T.remove(e)) ? 1 : 0);
        } else if (r < 80 && deadN > 0) {
            e = dead[rnd() % (deadN < 32 ? deadN : 32)]; kinds.staleDespawn++;
            ret = fnv(ret, a.despawn(e) ? 1 : 0);
        } else {
            const j = rnd() % live.length;
            e = live[j]; live[j] = live[live.length - 1]; live.pop();
            kinds.despawn++; ret = fnv(ret, a.despawn(e) ? 1 : 0);
            dead[deadN & 31] = e; deadN++;
        }
        if (e < 0) negOps++;
        if (checkedHas && live.length !== 0) {
            const x = live[rnz() % live.length], q = rnz() | 0, xm = rnz() | 0;
            const v1 = a.hasFlags(x, q & 0x0F0F);            // 2-arg
            const v2 = a.hasFlags(x, q & 0x30, xm & 0x0C00);  // 3-arg
            const v3 = a.hasFlagsHi(x, q & 0x0303);
            const v4 = a.hasFlagsHi(x, q & 0x4, xm & 0x8800);
            const bits = (v1 ? 1 : 0) | (v2 ? 2 : 0) | (v3 ? 4 : 0) | (v4 ? 8 : 0);
            has = fnv(has, bits);
            for (let b = 0; b < 4; b++) { if ((bits >> b) & 1) hasTrue++; else hasFalse++; }
            if (hasFirst.length < 32) hasFirst.push(bits);
        }
    }
    const out = { ret: hex(ret), kinds, negOps };
    if (checkedHas) out.hasCalls = { hash: hex(has), trueCount: hasTrue, falseCount: hasFalse, first32: hasFirst };
    return out;
}

function dump(w, indexed) {
    const { a, C, T, F, H } = w;
    const walk = [];
    for (let i = a.freeHead, n = 0; i !== 0xFFFFF && n <= CAP; i = a.freeList[i], n++) walk.push(i);
    const set = (S) => {
        const dense = Array.from(S.dense.subarray(0, S.count));
        return { count: S.count, dense, sparse: dense.map((e) => S.sparse[e & 0xFFFFF]) };
    };
    const out = {
        generations: Array.from(a.generations),
        freeHead: a.freeHead,
        freeListRaw: Array.from(a.freeList),
        freeWalk: walk,
        activeCount: a.activeCount,
        retiredCount: a.retiredCount,
        remainingCapacity: a.remainingCapacity(),
        flags: Array.from(a.flags),
        flagsHi: Array.from(a.flagsHi),
        C: set(C),
        Cx: Array.from(C.data.x.subarray(0, C.count)),
        T: set(T),
    };
    if (indexed) {
        const q = (bits, map, count, first, next) => {
            const o = {};
            for (const n of bits) {
                const f = map[n], seq = [];
                for (let e = first(f); e !== -1; e = next(f, e)) seq.push(e);
                o[n] = { count: count(f), walk: seq };
            }
            return o;
        };
        out.ix = q(IX_LO, F, (f) => a.flagCount(f), (f) => a.firstFlagged(f), (f, e) => a.nextFlagged(f, e));
        out.ixHi = q(IX_HI, H, (f) => a.flagCountHi(f), (f) => a.firstFlaggedHi(f), (f, e) => a.nextFlaggedHi(f, e));
    }
    return out;
}

function one(Arena, checked, indexed) {
    const w = build(Arena, checked, indexed);
    churn(w.a);
    const preStream = { generations: Array.from(w.a.generations), freeWalk: [] };
    for (let i = w.a.freeHead, n = 0; i !== 0xFFFFF && n <= CAP; i = w.a.freeList[i], n++) preStream.freeWalk.push(i);
    const st = stream(w, checked);
    return { preStream, stream: st, state: dump(w, indexed), w };
}

// Fixed invalid calls on a checked arena whose B-era messages must not change. Every
// handle here is a canonical int32 (live positive, live negative, dead, 0).
function invalidCalls(Arena) {
    const w = build(Arena, true, true);
    const { a, C, F, H } = w;
    churn(a);
    let neg = a.spawn();
    while (neg >= 0) neg = a.spawn();            // the stream-free arena: first negative handle
    const pos = new Arena(4, { checked: true });
    const p = pos.spawn();
    pos.registerFlags(['a']); pos.registerFlagsHi(['b']);
    const P = pos.registerComponent({ x: Float32Array });
    const Q = pos.registerTag();
    const full = new Arena(2, { checked: true }); full.spawn(); full.spawn();
    const L = [
        ['setFlags(neg, undefined)', () => a.setFlags(neg, undefined)],
        ['setFlags(neg, 1.5)', () => a.setFlags(neg, 1.5)],
        ['setFlags(p, NaN)', () => pos.setFlags(p, NaN)],
        ['setFlags(p, "1")', () => pos.setFlags(p, '1')],
        ['setFlags(p, 2**32)', () => pos.setFlags(p, 2 ** 32)],
        ['clearFlags(neg, {})', () => a.clearFlags(neg, {})],
        ['clearFlags(p, -Infinity)', () => pos.clearFlags(p, -Infinity)],
        ['hasFlags(neg, undefined)', () => a.hasFlags(neg, undefined)],
        ['hasFlags(p)', () => pos.hasFlags(p)],
        ['hasFlags(neg, 1, 1.5)', () => a.hasFlags(neg, 1, 1.5)],
        ['hasFlags(p, 1, null)', () => pos.hasFlags(p, 1, null)],
        ['hasFlags(p, 1, "x")', () => pos.hasFlags(p, 1, 'x')],
        ['setFlagsHi(neg, -0.5)', () => a.setFlagsHi(neg, -0.5)],
        ['clearFlagsHi(p, Infinity)', () => pos.clearFlagsHi(p, Infinity)],
        ['hasFlagsHi(neg, NaN)', () => a.hasFlagsHi(neg, NaN)],
        ['hasFlagsHi(p, 1, "x")', () => pos.hasFlagsHi(p, 1, 'x')],
        ['hasFlagsHi(neg, 1, 2**33)', () => a.hasFlagsHi(neg, 1, 2 ** 33)],
        ['flagCount(3)', () => a.flagCount(3)],
        ['flagCount(F.f1) non-indexed', () => a.flagCount(F.f1)],
        ['flagCount(undefined)', () => a.flagCount(undefined)],
        ['firstFlagged(0)', () => a.firstFlagged(0)],
        ['nextFlagged(F.f0, 1.5)', () => a.nextFlagged(F.f0, 1.5)],
        ['nextFlagged(F.f1, neg)', () => a.nextFlagged(F.f1, neg)],
        ['flagCountHi(H.h0) non-indexed', () => a.flagCountHi(H.h0)],
        ['nextFlaggedHi(H.h1, "p")', () => a.nextFlaggedHi(H.h1, 'p')],
        ['C.idx(neg) non-member', () => C.idx(neg)],
        ['P.idx(p) non-member', () => P.idx(p)],
        ['P.idx(0) dead', () => P.idx(0)],
        ['joinN([C], null, 1.5)', () => a.joinN([C], null, 1.5)],
        ['joinN([C], [C])', () => a.joinN([C], [C])],
        ['joinN([C], null, 1, 1)', () => a.joinN([C], null, 1, 1)],
        ['joinN([P]) foreign set', () => a.joinN([P])],
        ['joinN([Q], null, 0, 0, 2, 2)', () => pos.joinN([Q], null, 0, 0, 2, 2)],
        ['spawn() exhausted', () => full.spawn()],
    ];
    const out = {};
    for (const [k, fn] of L) out[k] = cap(fn);
    // valid canonical calls that must keep their result (no throw)
    out.valid = {
        'isAlive(neg)': cap(() => a.isAlive(neg)),
        'isAlive(0) never-spawned gen 0': cap(() => a.isAlive(0)),
        'isAlive(-1)': cap(() => a.isAlive(-1)),
        'hasFlags(neg, 0)': cap(() => a.hasFlags(neg, 0)),
        'setFlags(neg, F.f0|F.f31)': cap(() => a.setFlags(neg, F.f0 | F.f31)),
        'hasFlags(neg, F.f0, F.f5)': cap(() => a.hasFlags(neg, F.f0, F.f5)),
        'hasFlags(neg, F.f31, F.f0)': cap(() => a.hasFlags(neg, F.f31, F.f0)),
        'setFlagsHi(neg, 0x80000000)': cap(() => a.setFlagsHi(neg, 0x80000000)),
        'hasFlagsHi(neg, H.h31)': cap(() => a.hasFlagsHi(neg, H.h31)),
        'hasFlagsHi(neg, H.h31, H.h1)': cap(() => a.hasFlagsHi(neg, H.h31, H.h1)),
        'flagCount(F.f31)': cap(() => a.flagCount(F.f31)),
        'C.add(neg)': cap(() => C.add(neg)),
        'C.has(neg)': cap(() => C.has(neg)),
        'C.idx(neg)': cap(() => C.idx(neg)),
        'despawn(neg)': cap(() => a.despawn(neg)),
        'despawn(neg) again': cap(() => a.despawn(neg)),
        'C.count after': cap(() => C.count),
        'flagCount(F.f31) after': cap(() => a.flagCount(F.f31)),
        'flagCountHi(H.h31) after': cap(() => a.flagCountHi(H.h31)),
    };
    return out;
}

export function run(mod) {
    const { Arena } = mod;
    const g1p = one(Arena, false, false), g1i = one(Arena, false, true);
    const g2p = one(Arena, true, false), g2i = one(Arena, true, true);
    const strip = (r) => ({ preStream: r.preStream, stream: r.stream, state: r.state });
    return {
        meta: { CAP, OPS, SEED: hex(SEED), TARGET },
        G1: { plain: strip(g1p), indexed: strip(g1i) },
        G2: { plain: strip(g2p), indexed: strip(g2i), invalid: invalidCalls(Arena) },
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const target = process.argv[2];
    if (!target || !target.startsWith('/')) { console.error('usage: node handle-canonical-workload.mjs /abs/path/Arena.js'); process.exit(2); }
    const mod = await import(pathToFileURL(target).href);
    process.stdout.write(JSON.stringify(run(mod), null, 2) + '\n');
}
