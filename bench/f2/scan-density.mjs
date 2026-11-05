/**
 * @zakkster/lite-arena -- F2 L2 50% scan anomaly (G3 T3; PLAN-F2 G3 SPEC L2, A5). REPORTED lane.
 * Is the research burst's "50% density walk costs more per match than 10%" a property of
 * the shipped design or an artefact of the research model's Uint32Array columns (a column
 * word >= 2^31 read from a Uint32Array is not a Smi)?
 *
 * Builds: final (Int32Array columns), u32 (the same build with Uint32Array columns, the
 * control) and model (research impl.mjs InlineIdx, REPORTED only). One arena per build,
 * capacity 2^20 - 1, every slot live (every 3rd slot respawned once: generation 1), and 8
 * indexed word-0 flags f0..f7, one per pattern:
 *   r0.0001 r0.001 r0.01 r0.1 r0.25 r0.5   random densities (seeded xorshift, same slots on every build)
 *   odd                                     50% periodic odd slots  (column words 0xAAAAAAAA, bit 31 set)
 *   even                                    50% periodic even slots (column words 0x55555555, bit 31 clear)
 * Timed body: one firstFlagged / nextFlagged walk folding the handles into an `|0` sink,
 * repeated so a sample covers ~2^21 matches. Statistic: ns/match. K = 11 interleaved rounds
 * after a discarded warm-up (lib.mjs interleave), 24 configs (3 builds x 8 patterns).
 *   R        = median over the K rounds of (ns/match at r0.5) / (ns/match at r0.1)
 *   odd/even = median over the K rounds of (ns/match at odd) / (ns/match at even)
 * Classification (final and u32 R, u32 odd/even):
 *   PERSISTS     final R >= 1.5
 *   ARTEFACT     final R <= 1.25, u32 R >= 1.5 and u32 odd/even >= 1.3
 *   UNATTRIBUTED final R <= 1.25 but the u32 control does not reproduce (u32 R < 1.5 or odd/even < 1.3)
 *   UNRESOLVED   otherwise (1.25 < final R < 1.5)
 * Only ARTEFACT lets a 50% number into docs. A non-finite statistic is NO-VERDICT.
 * Precondition (A5): per pattern, walk count + FNV-1a of handles == the row scan's AND the
 * row scan count == the harness's own pick count, on final, u32 (and the model when it
 * runs), before AND after the timed rounds, else NO-VERDICT. The u32 build must allocate
 * Uint32Array columns and final Int32Array, else NO-VERDICT.
 *
 *   node ~/.claude/hooks/quiet-lock.mjs run --strict "lite-arena f2-L2" -- node bench/f2/scan-density.mjs
 * Options: --build <Arena.js>  (final; default .handoff/after-F2-180d1268/Arena.js)
 *          --u32 <Arena.js>    (default .handoff/evidence/F2/variants/u32/Arena.js)
 *          --model <impl.mjs>|none (default .handoff/research/F2/impl.mjs; none prints "model: skipped")
 *          --dry-run (K = 1, capacity 4095, tiny reps; prints no ns and calls no verdict) --K n
 *          --cap n (default 2^20 - 1; dry-run 4095): `--dry-run --cap 1048575` checks the A5
 *          precondition at full size without a timing verdict
 * Exit: 0 ran (any of the four classes), 1 harness error, 2 precondition / NO-VERDICT.
 *
 * MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { provenance, start, end, interleave, median, indexedApiMissing, K_REQ } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const LANE = 'f2-L2 scan-density';

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
const U32 = resolve(arg('--u32', join(ROOT, '.handoff/evidence/F2/variants/u32/Arena.js')));
const MODEL_ARG = arg('--model', join(ROOT, '.handoff/research/F2/impl.mjs'));
const MODEL = MODEL_ARG === 'none' ? null : resolve(MODEL_ARG);
const K = DRY ? 1 : Number(arg('--K', String(K_REQ)));
if (!Number.isInteger(K) || K < 1) await stop(1, 'scan-density: --K must be a positive integer');
const CAP = Number(arg("--cap", DRY ? "4095" : String((1 << 20) - 1)));
if (!Number.isInteger(CAP) || CAP < 64 || CAP > (1 << 20) - 1) await stop(1, "scan-density: --cap must be an integer in [64, 1048575]");
const TARGET = DRY ? 4096 : 1 << 21;          // matches per timed sample
const PAT = [
    { name: 'r0.0001', d: 0.0001 }, { name: 'r0.001', d: 0.001 }, { name: 'r0.01', d: 0.01 },
    { name: 'r0.1', d: 0.1 }, { name: 'r0.25', d: 0.25 }, { name: 'r0.5', d: 0.5 },
    { name: 'odd', d: -1 }, { name: 'even', d: -2 },
];
const P10 = 3, P50 = 5, PODD = 6, PEVEN = 7;
const NAMES = [];
for (let i = 0; i < 32; i++) NAMES.push('f' + i);
const IXN = NAMES.slice(0, PAT.length);

start();
const builds = [BUILD, U32];
if (MODEL !== null) builds.push(MODEL);
const header = () => provenance({ lane: LANE + (DRY ? ' (DRY-RUN)' : ''), K, runs: 1, builds,
    extra: ['capacity: ' + CAP + ' | matches per sample: ~' + TARGET, MODEL === null ? 'model: skipped' : 'model: ' + MODEL] });
const nv = async (why) => { end(); await stop(2, header() + '\nNO-VERDICT: ' + why); };

// ---------------------------------------------------------------- builds
async function loadArena(p, role) {
    if (!existsSync(p)) return { why: role + ' build not found: ' + p };
    try {
        const A = (await import(pathToFileURL(p).href)).Arena;
        const m = indexedApiMissing(A);
        return m === null ? { A } : { why: role + ' ' + p + ': ' + m };
    } catch (e) {
        return { why: role + ' build failed to import: ' + (e && e.message) };
    }
}
const fin = await loadArena(BUILD, 'final');
if (fin.why) await nv(fin.why);
const u32 = await loadArena(U32, 'u32');
if (u32.why) await nv(u32.why);
let Model = null;
if (MODEL !== null) {
    if (!existsSync(MODEL)) await nv('model not found: ' + MODEL + ' (pass --model none to skip it)');
    try {
        Model = (await import(pathToFileURL(MODEL).href)).InlineIdx;
    } catch (e) {
        await nv('model failed to import: ' + (e && e.message));
    }
    if (typeof Model !== 'function') await nv('model ' + MODEL + ' exports no InlineIdx class');
}

/** Pick list per pattern: the harness's own truth (slots), identical on every build. */
const PICK = [];
for (let p = 0; p < PAT.length; p++) {
    const d = PAT[p].d;
    const pk = new Int32Array(CAP);
    let n = 0, x = (0x2545F491 + Math.imul(p, 0x9E3779B1)) | 0;
    for (let i = 0; i < CAP; i++) {
        let on;
        if (d === -1) on = (i & 1) === 1;
        else if (d === -2) on = (i & 1) === 0;
        else { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; on = (x >>> 0) / 4294967296 < d; }
        if (on) pk[n++] = i;
    }
    PICK.push(pk.subarray(0, n));
}

/** One arena: every slot live, every 3rd slot respawned once (generation 1), pattern p on flag f<p>. */
function fill(a) {
    const es = new Int32Array(CAP);
    for (let i = 0; i < CAP; i++) es[i] = a.spawn();
    for (let i = 0; i < CAP; i += 3) {
        a.despawn(es[i]);
        es[i] = a.spawn();
        if ((es[i] & 0xFFFFF) !== i) throw new Error('respawn did not reuse slot ' + i);
    }
    for (let p = 0; p < PAT.length; p++) {
        const pk = PICK[p], m = 1 << p;
        for (let k = 0; k < pk.length; k++) a.setFlags(es[pk[k]], m);
    }
    return a;
}
const B = [];   // { role, a, model }
try {
    const af = new fin.A(CAP);
    af.registerFlags(NAMES, { indexed: IXN });
    B.push({ role: 'final', a: fill(af), model: false });
    const au = new u32.A(CAP);
    au.registerFlags(NAMES, { indexed: IXN });
    B.push({ role: 'u32', a: fill(au), model: false });
    if (Model !== null) {
        const am = new Model(CAP);
        am.registerFlags(NAMES, [0, 1, 2, 3, 4, 5, 6, 7]);
        B.push({ role: 'model', a: fill(am), model: true });
    }
} catch (e) {
    end();
    await stop(1, header() + '\nHARNESS ERROR: arena setup: ' + (e && e.stack));
}
if (!(B[0].a._ixW[0] instanceof Int32Array)) await nv('final build columns are not Int32Array');
if (!(B[1].a._ixW[0] instanceof Uint32Array)) await nv('u32 control columns are not Uint32Array (not a u32 variant)');

// ---------------------------------------------------------------- precondition (A5)
const FNV_OFF = 0x811C9DC5 | 0, FNV_PRIME = 16777619;
const ORA = new Int32Array(4);          // [walk count, walk fnv, scan count, scan fnv]
function walkInto(b, p) {
    const a = b.a;
    let c = 0, h = FNV_OFF;
    if (b.model) {
        const g = a.generations;
        for (let i = a.firstFlagged(p); i !== -1; i = a.nextFlagged(p, i + 1)) { c++; h = Math.imul(h ^ ((g[i] << 20) | i), FNV_PRIME); }
    } else {
        const f = 1 << p;
        for (let e = a.firstFlagged(f); e !== -1; e = a.nextFlagged(f, e)) { c++; h = Math.imul(h ^ e, FNV_PRIME); }
    }
    ORA[0] = c; ORA[1] = h;
}
function scanInto(b, p) {
    const a = b.a, fl = a.flags, g = a.generations, n = a.capacity, m = 1 << p;
    let c = 0, h = FNV_OFF;
    for (let i = 0; i < n; i++) if ((fl[i] & m) !== 0) { c++; h = Math.imul(h ^ ((g[i] << 20) | i), FNV_PRIME); }
    ORA[2] = c; ORA[3] = h;
}
function check(when) {
    for (const b of B) {
        for (let p = 0; p < PAT.length; p++) {
            walkInto(b, p);
            scanInto(b, p);
            if (ORA[0] !== ORA[2] || ORA[1] !== ORA[3] || ORA[2] !== PICK[p].length) {
                return when + ': ' + b.role + ' ' + PAT[p].name + ': walk count ' + ORA[0] + ' fnv ' + (ORA[1] >>> 0).toString(16) +
                    ' vs row scan count ' + ORA[2] + ' fnv ' + (ORA[3] >>> 0).toString(16) + ' (picks ' + PICK[p].length + ')';
            }
        }
    }
    return null;
}
const pre = check('before timing');
if (pre !== null) await nv(pre);
const preLine = 'precondition before timing: walk == row scan (count + FNV) on ' + B.map((b) => b.role).join(' + ') +
    ' for ' + PAT.map((q, p) => q.name + ':' + PICK[p].length).join(' ');

// ---------------------------------------------------------------- timed rounds
let FN_SEQ = 0;
const fn = (body) => new Function('a', 'reps', '/* cfg ' + (FN_SEQ++) + ' */ ' + body);
const CONFIGS = [];
for (let bi = 0; bi < B.length; bi++) {
    for (let p = 0; p < PAT.length; p++) {
        const b = B[bi], n = PICK[p].length;
        const body = b.model
            ? `const g = a.generations; let s = 0; for (let r = 0; r < reps; r++) { for (let i = a.firstFlagged(${p}); i !== -1; ` +
              `i = a.nextFlagged(${p}, i + 1)) s = (s + ((g[i] << 20) | i)) | 0; } return s | 0;`
            : `let s = 0; for (let r = 0; r < reps; r++) { for (let e = a.firstFlagged(${1 << p}); e !== -1; ` +
              `e = a.nextFlagged(${1 << p}, e)) s = (s + e) | 0; } return s | 0;`;
        CONFIGS.push({ bi, p, a: b.a, n, reps: Math.max(1, Math.ceil(TARGET / Math.max(1, n))), f: fn(body) });
    }
}
const T = new Float64Array(2);
let sink = 0;
function runOne(c) {
    T[0] = performance.now();
    sink = (Math.imul(sink, 31) + c.f(c.a, c.reps)) | 0;
    T[1] = performance.now();
    return ((T[1] - T[0]) * 1e6) / (c.reps * c.n);
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
const post = check('after timing');
if (post !== null) await stop(2, out.join('\n') + '\nNO-VERDICT: ' + post);
out.push('precondition after timing: walk == row scan on every build and pattern | sink ' + (sink | 0));
const cfg = (bi, p) => R[bi * PAT.length + p];

if (DRY) {
    for (let i = 0; i < CONFIGS.length; i++) {
        for (let r = 0; r < K; r++) {
            if (!(R[i][r] > 0) || !Number.isFinite(R[i][r])) {
                await stop(1, out.join('\n') + '\nHARNESS ERROR: ' + B[CONFIGS[i].bi].role + ' ' + PAT[CONFIGS[i].p].name + ' non-positive time');
            }
        }
    }
    out.push('configs ran: ' + CONFIGS.length + ' (' + B.length + ' builds x ' + PAT.length + ' patterns), all finite positive');
    out.push('DRY-RUN (no timing verdict)');
    await stop(0, out.join('\n'));
}

/** median over rounds of x[r] / y[r] (NaN on any non-finite round). */
function medRatio(x, y) {
    const q = new Float64Array(K);
    for (let r = 0; r < K; r++) q[r] = x[r] / y[r];
    for (let r = 0; r < K; r++) if (!Number.isFinite(q[r]) || !(q[r] > 0)) return NaN;
    return median(q);
}
const STAT = [];
for (let bi = 0; bi < B.length; bi++) {
    STAT.push({ R: medRatio(cfg(bi, P50), cfg(bi, P10)), oe: medRatio(cfg(bi, PODD), cfg(bi, PEVEN)) });
    out.push(B[bi].role.padEnd(5) + ' ns/match (median of ' + K + '):');
    for (let p = 0; p < PAT.length; p++) {
        out.push('  ' + PAT[p].name.padEnd(8) + ' ' + median(cfg(bi, p)).toFixed(3).padStart(9) + ' | matches ' + PICK[p].length +
            ' | rounds ' + Array.from(cfg(bi, p), (v) => v.toFixed(3)).join(' '));
    }
    out.push('  R (50% / 10%) ' + STAT[bi].R.toFixed(3) + ' | odd/even ' + STAT[bi].oe.toFixed(3));
}
const Rf = STAT[0].R, Ru = STAT[1].R, OEu = STAT[1].oe;
if (!Number.isFinite(Rf) || !Number.isFinite(Ru) || !Number.isFinite(OEu)) {
    await stop(2, out.join('\n') + '\nNO-VERDICT: a statistic is not finite (final R ' + Rf + ', u32 R ' + Ru + ', u32 odd/even ' + OEu + ')');
}
let cls;
if (Rf >= 1.5) cls = 'PERSISTS';
else if (Rf <= 1.25) cls = Ru >= 1.5 && OEu >= 1.3 ? 'ARTEFACT' : 'UNATTRIBUTED';
else cls = 'UNRESOLVED';
out.push('VERDICT ' + cls + ' (final R ' + Rf.toFixed(3) + ', u32 R ' + Ru.toFixed(3) + ', u32 odd/even ' + OEu.toFixed(3) + ')' +
    (cls === 'ARTEFACT' ? ' -- a 50% number may enter docs' : ' -- no 50% number enters docs'));
await stop(0, out.join('\n'));
