/**
 * @zakkster/lite-arena -- F2 L1 mixed call site, CHILD (G3 T2). One config per
 * process (prototype ICs are process-wide). Spawned by mixed-site.mjs with
 * --allow-natives-syntax; prints ONE `RESULT {json}` line.
 *
 * Every arena of the config runs through the SAME three body functions below (one
 * call site per method), then only the PLAIN arena is timed:
 *   pair    -- setFlags + clearFlags of word-0 bit 0
 *   churn   -- setFlags + despawn + spawn
 *   join    -- one joinN([T, U], null, bit0) plan per op
 * SLOW times the *Slow twins (the same body + a 16-step xorshift per op).
 *
 *   node --allow-natives-syntax bench/f2/mixed-child.mjs --config MEGA --build <Arena.js>
 *        [--ops N] [--warm N]
 * Exit: 0 ran, 1 harness error, 2 precondition (MEGA < 5 maps, missing API) = NO-VERDICT.
 *
 * MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const CONFIGS = ['PLAIN', 'POLY', 'MEGA', 'PLAIN-FE', 'AA', 'SLOW'];
const NAMES = [];
for (let i = 0; i < 32; i++) NAMES.push('f' + i);
const WN = 1024;                       // live entities per arena (power of 2)
const WMASK = WN - 1;
const CAP = 4096;

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function nv(reason) {
    console.log('NO-VERDICT: ' + reason);
    process.exit(2);
}

const config = arg('--config', '');
const build = arg('--build', '');
const OPS = Number(arg('--ops', '200000'));
const WARM = Number(arg('--warm', '20000'));
if (!CONFIGS.includes(config)) { console.error('mixed-child: --config must be one of ' + CONFIGS.join(', ')); process.exit(1); }
if (build === '') { console.error('mixed-child: --build <Arena.js> is required'); process.exit(1); }
if (!Number.isInteger(OPS) || OPS < 1 || !Number.isInteger(WARM) || WARM < 0) {
    console.error('mixed-child: --ops / --warm must be integers'); process.exit(1);
}

const { Arena } = await import(pathToFileURL(resolve(build)).href);

// ---------------------------------------------------------------- arenas
// kind: plain | ix0 (word-0 indexed) | ixHi (Hi-only indexed) | ixBoth | checked | checkedIx
function make(kind) {
    const checked = kind === 'checked' || kind === 'checkedIx';
    const a = checked ? new Arena(CAP, { checked: true }) : new Arena(CAP);
    const ix0 = kind === 'ix0' || kind === 'ixBoth' || kind === 'checkedIx';
    const F = ix0 ? a.registerFlags(NAMES, { indexed: ['f0'] }) : a.registerFlags(NAMES);
    if (kind === 'ixHi' || kind === 'ixBoth') a.registerFlagsHi(NAMES, { indexed: ['f0'] });
    const T = a.registerTag(), U = a.registerTag();
    const es = new Int32Array(WN);
    for (let i = 0; i < WN; i++) {
        const e = a.spawn();
        es[i] = e;
        T.add(e);
        if ((i & 1) === 0) U.add(e);
    }
    return { kind, a, es, m: F.f0, req: [T, U] };
}

const KINDS = config === 'MEGA' ? ['plain', 'ix0', 'ixHi', 'ixBoth', 'checked', 'checkedIx']
    : config === 'POLY' ? ['plain', 'ix0'] : ['plain'];
const ARENAS = [];
try {
    for (const k of KINDS) ARENAS.push(make(k));
} catch (e) {
    nv(config + ': arena setup threw on this build: ' + (e && e.message));
}
const P = ARENAS[0];                   // the timed PLAIN arena

// ---------------------------------------------------------------- map census
let maps = 1;
if (ARENAS.length > 1) {
    let same;
    try {
        same = new Function('a', 'b', 'return %HaveSameMap(a, b);');
    } catch {
        nv('%HaveSameMap unavailable (run with --allow-natives-syntax)');
    }
    const reps = [];
    for (const x of ARENAS) {
        let found = false;
        for (const r of reps) if (same(r, x.a)) { found = true; break; }
        if (!found) reps.push(x.a);
    }
    maps = reps.length;
}
if (config === 'MEGA' && !(maps >= 5)) nv('MEGA has ' + maps + ' distinct arena maps (< 5)');

// ---------------------------------------------------------------- bodies (one call site each)
function pair(a, es, m, ops) {
    let k = 0, s = 0;
    for (let n = 0; n < ops; n++) {
        const e = es[k];
        k = (k + 1) & WMASK;
        if (a.setFlags(e, m)) s++;
        if (a.clearFlags(e, m)) s++;
    }
    return s | 0;
}
function churn(a, es, m, ops) {
    let k = 0, s = 0;
    for (let n = 0; n < ops; n++) {
        a.setFlags(es[k], m);
        a.despawn(es[k]);
        const e = a.spawn();
        es[k] = e;
        s = (s + e) | 0;
        k = (k + 1) & WMASK;
    }
    return s | 0;
}
function join(a, req, m, ops) {
    let s = 0;
    for (let n = 0; n < ops; n++) s = (s + a.joinN(req, null, m, 0).count) | 0;
    return s | 0;
}
// SLOW twins: the same body + a 16-step xorshift per op folded into the sink.
function xs16(x) {
    for (let j = 0; j < 16; j++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; }
    return x | 0;
}
function pairSlow(a, es, m, ops) {
    let k = 0, s = 0, x = 0x2545F491;
    for (let n = 0; n < ops; n++) {
        const e = es[k];
        k = (k + 1) & WMASK;
        if (a.setFlags(e, m)) s++;
        if (a.clearFlags(e, m)) s++;
        x = xs16(x);
    }
    return (s ^ x) | 0;
}
function churnSlow(a, es, m, ops) {
    let k = 0, s = 0, x = 0x2545F491;
    for (let n = 0; n < ops; n++) {
        a.setFlags(es[k], m);
        a.despawn(es[k]);
        const e = a.spawn();
        es[k] = e;
        s = (s + e) | 0;
        k = (k + 1) & WMASK;
        x = xs16(x);
    }
    return (s ^ x) | 0;
}
function joinSlow(a, req, m, ops) {
    let s = 0, x = 0x2545F491;
    for (let n = 0; n < ops; n++) {
        s = (s + a.joinN(req, null, m, 0).count) | 0;
        x = xs16(x);
    }
    return (s ^ x) | 0;
}

// ---------------------------------------------------------------- warm-up (pollute the call sites)
let sink = 0;
const slow = config === 'SLOW';
const fPair = slow ? pairSlow : pair, fChurn = slow ? churnSlow : churn, fJoin = slow ? joinSlow : join;
const per = Math.max(1, Math.floor(WARM / ARENAS.length));
for (let r = 0; r < 4; r++) {
    for (const x of ARENAS) {
        sink ^= fPair(x.a, x.es, x.m, per);
        sink ^= fChurn(x.a, x.es, x.m, per);
        sink ^= fJoin(x.a, x.req, x.m, per >> 4 || 1);
    }
}

// ---------------------------------------------------------------- timed (PLAIN arena only)
const T = new Float64Array(3);         // ns/op per body (accumulators stay in typed slots)
let t0 = process.hrtime.bigint();
sink ^= fPair(P.a, P.es, P.m, OPS);
T[0] = Number(process.hrtime.bigint() - t0) / OPS;
t0 = process.hrtime.bigint();
sink ^= fChurn(P.a, P.es, P.m, OPS);
T[1] = Number(process.hrtime.bigint() - t0) / OPS;
const JOPS = Math.max(1, OPS >> 2);
t0 = process.hrtime.bigint();
sink ^= fJoin(P.a, P.req, P.m, JOPS);
T[2] = Number(process.hrtime.bigint() - t0) / JOPS;

console.log('RESULT ' + JSON.stringify({
    config, kinds: KINDS, maps, ns: [T[0], T[1], T[2]], sink: sink | 0, ops: OPS,
}));
