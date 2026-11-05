/**
 * @zakkster/lite-arena -- F2 L5 headline numbers (G3 T6). REPORTED lane.
 * research/F2 p3-bench ported to the FINAL API: one process, plain and indexed
 * arenas both live. Every bench body is compiled per config (new Function) from a
 * UNIQUE source (a "cfg n" comment prefix: V8 caches eval-compiled source, so identical
 * text would share one feedback vector and one optimized code), so each config's
 * call sites stay monomorphic; L1 (mixed-site.mjs) owns the shared-site case.
 *
 * Lanes (base = the plain-arena way, cand = the indexed way; each lane has its own
 * AA = base again and SLOW = base + a 16-step xorshift per op / per row):
 *   pair-1     setFlags+clearFlags, 1 indexed bit (f0)                vs plain
 *   pair-4     setFlags+clearFlags, 4 indexed bits (f0 f1 f2 f31)     vs plain
 *   churn-4    setFlags(4 bits) + despawn + spawn                     vs plain
 *   walk d     firstFlagged / nextFlagged walk  vs a row scan         d = 0.01% 0.1% 1% 10%
 *   count d    flagCount                        vs a row count
 *   clear d    clearFlagAll                     vs a row clear loop; the refill runs
 *              AFTER each timed clear rep (untimed) and after the reps (F-9b)
 * No 50% density here: it enters only on an L2 ARTEFACT verdict.
 * K = 11 interleaved rounds after a discarded warm-up (lib.mjs interleave + verdict).
 * Precondition: per density, walk count + FNV of handles == the row scan's (on the
 * plain twin arena), before AND after the timed rounds, else NO-VERDICT (exit 2).
 *
 *   node ~/.claude/hooks/quiet-lock.mjs run --strict "lite-arena f2-L5" -- node bench/f2/headline.mjs
 * Options: --build <Arena.js> (default .handoff/after-F2-180d1268/Arena.js) --dry-run --K n
 * Exit: 0 ran, 1 harness error, 2 precondition / NO-VERDICT.
 *
 * MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { provenance, start, end, interleave, verdict, indexedApiMissing, K_REQ } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const LANE = 'f2-L5 headline';

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
/** Writes msg, waits for the flush (async pipes on macOS), then exits with code. */
async function stop(code, msg) {
    process.exitCode = code;
    await new Promise((r) => process.stdout.write(msg + '\n', r));
    process.exit(code);
}

const DRY = process.argv.includes('--dry-run');
const BUILD = resolve(arg('--build', join(ROOT, '.handoff/after-F2-180d1268/Arena.js')));
const K = DRY ? 1 : Number(arg('--K', String(K_REQ)));
if (!Number.isInteger(K) || K < 1) await stop(1, 'headline: --K must be a positive integer');
const WN = 4096, WMASK = WN - 1;              // live entities per write arena
const WCAP = DRY ? WN : 1 << 16;
const WOPS = DRY ? 2000 : 2000000;
const RCAP = DRY ? 4096 : (1 << 20) - 1;      // read arenas: all slots live
const REPS = DRY ? 2 : 20;
const CNT_INNER = 1024;                       // flagCount calls per timed body
const DENS = [0.0001, 0.001, 0.01, 0.1];
const DTAG = ['0.01%', '0.1%', '1%', '10%'];

start();
const header = () => provenance({ lane: LANE + (DRY ? ' (DRY-RUN)' : ''), K, runs: 1, builds: [BUILD] });
if (!existsSync(BUILD)) { end(); await stop(2, header() + '\nNO-VERDICT: build not found: ' + BUILD); }
let Arena, missing;
try {
    Arena = (await import(pathToFileURL(BUILD).href)).Arena;
    missing = indexedApiMissing(Arena);
} catch (e) {
    missing = 'build failed to import: ' + (e && e.message);
}
if (missing !== null) { end(); await stop(2, header() + '\nNO-VERDICT: ' + BUILD + ': ' + missing); }

const NAMES = [];
for (let i = 0; i < 32; i++) NAMES.push('f' + i);
let FN_SEQ = 0;
const fn = (args, body) => new Function(...args, '/* cfg ' + (FN_SEQ++) + ' */ ' + body);
const XS = 'x ^= x << 13; x ^= x >>> 17; x ^= x << 5; ';
const XS16 = 'for (let j = 0; j < 16; j++) { ' + XS + '} ';

// ---------------------------------------------------------------- write lanes
const pairBody = (slow) => `let k = 0, s = 0, x = 0x2545F491; for (let n = 0; n < ops; n++) { const e = es[k]; k = (k + 1) & ${WMASK}; ` +
    `if (a.setFlags(e, m)) s++; if (a.clearFlags(e, m)) s++; ${slow ? XS16 : ''}} return (s ^ x) | 0;`;
const churnBody = (slow) => `let k = 0, s = 0, x = 0x2545F491; for (let n = 0; n < ops; n++) { a.setFlags(es[k], m); a.despawn(es[k]); ` +
    `const e = a.spawn(); es[k] = e; s = (s + e) | 0; k = (k + 1) & ${WMASK}; ${slow ? XS16 : ''}} return (s ^ x) | 0;`;

function writeArena(indexed) {
    const a = new Arena(WCAP);
    const F = indexed.length ? a.registerFlags(NAMES, { indexed }) : a.registerFlags(NAMES);
    const es = new Int32Array(WN);
    for (let i = 0; i < WN; i++) es[i] = a.spawn();
    return { a, F, es };
}
const IX1 = ['f0'], IX4 = ['f0', 'f1', 'f2', 'f31'];
const M1 = 1, M4 = 1 | 2 | 4 | (1 << 31);
const CONFIGS = [];
const LANES = [];
const ROLES = ['base', 'cand', 'aa', 'slow'];
function writeLane(name, ix, m, mk) {
    const lane = { name, unit: 'ns/op', idx: {} };
    for (const role of ROLES) {
        const w = writeArena(role === 'cand' ? ix : []);
        const c = { lane: name, role, kind: 'write', a: w.a, es: w.es, m, f: fn(['a', 'es', 'm', 'ops'], mk(role === 'slow')), indexed: role === 'cand' };
        lane.idx[role] = CONFIGS.length;
        CONFIGS.push(c);
    }
    LANES.push(lane);
}
writeLane('pair-1 (bit f0)', IX1, M1, pairBody);
writeLane('pair-4 (f0 f1 f2 f31)', IX4, M4, pairBody);
writeLane('churn-4 (set+despawn+spawn)', IX4, M4, churnBody);

// ---------------------------------------------------------------- read lanes
const scanRow = (slow) => `const f = a.flags, g = a.generations, n = a.capacity; let s = 0, x = 0x2545F491; ` +
    `for (let i = 0; i < n; i++) { if ((f[i] & 1) !== 0) s = (s + ((g[i] << 20) | i)) | 0; ${slow ? XS16 : ''}} return (s ^ x) | 0;`;
const walkCol = 'let s = 0; for (let e = a.firstFlagged(1); e !== -1; e = a.nextFlagged(1, e)) s = (s + e) | 0; return s | 0;';
const cntRow = (slow) => `const f = a.flags, n = a.capacity; let c = 0, x = 0x2545F491; ` +
    `for (let i = 0; i < n; i++) { if ((f[i] & 1) !== 0) c++; ${slow ? XS16 : ''}} return (c ^ x) | 0;`;
const cntCol = `let c = 0; for (let j = 0; j < ${CNT_INNER}; j++) c = (c + a.flagCount(1)) | 0; return c | 0;`;
const clrRow = (slow) => `const f = a.flags, n = a.capacity; let x = 0x2545F491; ` +
    `for (let i = 0; i < n; i++) { f[i] &= -2; ${slow ? XS16 : ''}} return x | 0;`;
const clrCol = 'a.clearFlagAll(1); return 0;';

function readArena(indexed, d) {
    const a = new Arena(RCAP);
    if (indexed) a.registerFlags(NAMES, { indexed: ['f0'] }); else a.registerFlags(NAMES);
    const es = new Int32Array(RCAP);
    for (let i = 0; i < RCAP; i++) es[i] = a.spawn();
    const pick = new Int32Array(RCAP);
    let x = 0x2545F491, n = 0;
    for (let i = 0; i < RCAP; i++) {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        if ((x >>> 0) / 4294967296 < d) pick[n++] = es[i];
    }
    const st = { a, pick, n };
    refill(st);
    return st;
}
function refill(st) { for (let i = 0; i < st.n; i++) st.a.setFlags(st.pick[i], 1); }

const DSTATE = [];
for (let di = 0; di < DENS.length; di++) {
    const d = DENS[di];
    const P = readArena(false, d), I = readArena(true, d);
    DSTATE.push({ d, P, I });
    const tag = DTAG[di];
    const lanes = [
        ['walk ' + tag, 'ns/call', [scanRow(false), walkCol, scanRow(false), scanRow(true)], false],
        ['count ' + tag, 'ns/call', [cntRow(false), cntCol, cntRow(false), cntRow(true)], false],
        ['clear ' + tag, 'ns/call', [clrRow(false), clrCol, clrRow(false), clrRow(true)], true],
    ];
    for (const [name, unit, bodies, mut] of lanes) {
        const lane = { name, unit, idx: {}, matches: P.n };
        ROLES.forEach((role, r) => {
            const st = role === 'cand' ? I : P;
            const inner = role === 'cand' && name.startsWith('count') ? CNT_INNER : 1;
            lane.idx[role] = CONFIGS.length;
            CONFIGS.push({ lane: name, role, kind: mut ? 'clear' : 'read', st, f: fn(['a'], bodies[r]), inner });
        });
        LANES.push(lane);
    }
}

// ---------------------------------------------------------------- precondition (walk == row scan)
const FNV_OFF = 0x811C9DC5 | 0, FNV_PRIME = 16777619;
const ORA = new Int32Array(4);          // [walk count, walk fnv, scan count, scan fnv]
function oracle(st) {
    const P = st.P.a, I = st.I.a;
    let c = 0, h = FNV_OFF;
    for (let e = I.firstFlagged(1); e !== -1; e = I.nextFlagged(1, e)) { c++; h = Math.imul(h ^ e, FNV_PRIME); }
    ORA[0] = c; ORA[1] = h;
    const f = P.flags, g = P.generations, n = P.capacity;
    c = 0; h = FNV_OFF;
    for (let i = 0; i < n; i++) if ((f[i] & 1) !== 0) { c++; h = Math.imul(h ^ ((g[i] << 20) | i), FNV_PRIME); }
    ORA[2] = c; ORA[3] = h;
    if (ORA[0] !== ORA[2] || ORA[1] !== ORA[3] || ORA[0] !== st.P.n || I.flagCount(1) !== st.I.n) {
        return 'd=' + st.d + ': walk count ' + ORA[0] + ' fnv ' + (ORA[1] >>> 0).toString(16) + ' vs row scan count ' + ORA[2] +
            ' fnv ' + (ORA[3] >>> 0).toString(16) + ' (picks ' + st.P.n + ', flagCount ' + I.flagCount(1) + ')';
    }
    return null;
}
function checkAll(when) {
    for (const st of DSTATE) {
        const bad = oracle(st);
        if (bad !== null) return when + ': ' + bad;
    }
    return null;
}
const pre = checkAll('before timing');
if (pre !== null) { end(); await stop(2, header() + '\nNO-VERDICT: ' + pre); }
const preLine = 'precondition before timing: walk == row scan (count + FNV) at ' + DSTATE.map((s) => s.d + ':' + s.P.n).join(' ');

// ---------------------------------------------------------------- timed rounds
const ACC = new Float64Array(1);
let sink = 0;
let t0;
function runOne(c) {
    if (c.kind === 'write') {
        t0 = process.hrtime.bigint();
        sink = (Math.imul(sink, 31) + c.f(c.a, c.es, c.m, WOPS)) | 0;
        return Number(process.hrtime.bigint() - t0) / WOPS;
    }
    ACC[0] = 0;
    if (c.kind === 'read') {
        t0 = process.hrtime.bigint();
        for (let j = 0; j < REPS; j++) sink = (Math.imul(sink, 31) + c.f(c.st.a)) | 0;
        ACC[0] = Number(process.hrtime.bigint() - t0);
        return ACC[0] / (REPS * c.inner);
    }
    for (let j = 0; j < REPS; j++) {             // clear: timed clear, then the untimed refill (F-9b)
        t0 = process.hrtime.bigint();
        sink = (Math.imul(sink, 31) + c.f(c.st.a)) | 0;
        ACC[0] += Number(process.hrtime.bigint() - t0);
        refill(c.st);
    }
    return ACC[0] / REPS;
}

let R;
try {
    R = interleave(K, CONFIGS, runOne);
} catch (e) {
    end();
    await stop(1, header() + '\nHARNESS ERROR: ' + (e && e.stack));
}
end();

const out = [header(), preLine];
const post = checkAll('after timing');
if (post !== null) await stop(2, out.join('\n') + '\nNO-VERDICT: ' + post);
for (const c of CONFIGS) {
    if (c.kind === 'write' && c.indexed) {
        for (const b of [1, 2, 4, 1 << 31]) {
            if ((c.m & b) !== 0 && c.a.flagCount(b) !== 0) await stop(2, out.join('\n') + '\nNO-VERDICT: ' + c.lane + ' indexed count != 0 after the write lane');
        }
    }
}
out.push('precondition after timing: walk == row scan; write-lane indexed counts back to 0 | sink ' + (sink | 0));

if (DRY) {
    for (let i = 0; i < CONFIGS.length; i++) {
        for (let r = 0; r < K; r++) {
            if (!(R[i][r] > 0)) await stop(1, out.join('\n') + '\nHARNESS ERROR: ' + CONFIGS[i].lane + ' ' + CONFIGS[i].role + ' non-positive time');
        }
    }
    out.push('configs ran: ' + CONFIGS.length + ' (' + LANES.length + ' lanes x base / cand / aa / slow), all finite positive');
    out.push('DRY-RUN (no timing verdict)');
    await stop(0, out.join('\n'));
}

let anyNv = false;
for (const L of LANES) {
    const v = verdict({ base: R[L.idx.base], cand: R[L.idx.cand], aa: R[L.idx.aa], slow: R[L.idx.slow] });
    if (v.verdict === 'NO-VERDICT') anyNv = true;
    out.push(L.name.padEnd(28) + ' ' + v.label + ' | median cand/base ' + (Number.isFinite(v.median) ? v.median.toFixed(4) : 'NaN') +
        ' | rounds>1 ' + v.roundsOver + '/' + K + ' | ' + v.reason + (L.matches !== undefined ? ' | matches ' + L.matches : ''));
    for (const role of ROLES) {
        out.push('  ' + role.padEnd(5) + ' ' + L.unit + ' ' + Array.from(R[L.idx[role]], (x) => x.toFixed(2)).join(' '));
    }
}
await stop(anyNv ? 2 : 0, out.join('\n'));
