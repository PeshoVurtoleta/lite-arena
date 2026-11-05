/**
 * @zakkster/lite-arena -- F2 L1 mixed call site, PARENT (G3 T2). REPORTED lane.
 *
 * Each config runs in its OWN child process (mixed-child.mjs, --allow-natives-syntax):
 *   PLAIN     plain arena only (the baseline)
 *   POLY      plain + word-0 indexed arenas through one call site
 *   MEGA      plain, word-0 indexed, Hi-only indexed, both words indexed, checked,
 *             checked + indexed (precondition: >= 5 distinct maps, else NO-VERDICT)
 *   PLAIN-FE  plain arena on the frozen fe8d7d5 build ("free at 0 indexed")
 *   AA        PLAIN again (baseline vs itself, lane control)
 *   SLOW      PLAIN + a 16-step xorshift per op (lane control)
 * Timed (PLAIN arena only): setFlags+clearFlags pair, setFlags + despawn + spawn, joinN.
 * K = 11 interleaved rounds after a discarded warm-up, children in rotated order.
 * Rows: POLY vs PLAIN, MEGA vs PLAIN, PLAIN (final) vs PLAIN-FE; AA / SLOW are read
 * against PLAIN for every row (lib.mjs verdict, controlBase).
 *
 * Timed runs go through the quiet lock:
 *   node ~/.claude/hooks/quiet-lock.mjs run --strict "lite-arena f2-L1" -- node bench/f2/mixed-site.mjs
 * Options: --build <Arena.js> (final; default .handoff/after-F2-180d1268/Arena.js)
 *          --before <Arena.js> (default .handoff/before-F2-fe8d7d5/Arena.js)
 *          --dry-run (K = 1, tiny op counts, no timing verdict) --K n --ops n
 * Exit: 0 ran, 1 harness error, 2 precondition / NO-VERDICT.
 *
 * MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { provenance, start, end, interleave, verdict, indexedApiMissing, K_REQ } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const CHILD = join(HERE, 'mixed-child.mjs');
const LANE = 'f2-L1 mixed call site';
const BODIES = ['pair (setFlags+clearFlags)', 'churn (setFlags+despawn+spawn)', 'joinN'];

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
const BEFORE = resolve(arg('--before', join(ROOT, '.handoff/before-F2-fe8d7d5/Arena.js')));
const K = DRY ? 1 : Number(arg('--K', String(K_REQ)));
const OPS = DRY ? 2000 : Number(arg('--ops', '2000000'));
const WARM = DRY ? 2000 : 200000;
if (!Number.isInteger(K) || K < 1 || !Number.isInteger(OPS) || OPS < 1) await stop(1, 'mixed-site: --K / --ops must be positive integers');

start();
const header = () => provenance({ lane: LANE + (DRY ? ' (DRY-RUN)' : ''), K, runs: 1, builds: [BUILD, BEFORE] });

for (const p of [BUILD, BEFORE]) {
    if (!existsSync(p)) { end(); await stop(2, header() + '\nNO-VERDICT: build not found: ' + p); }
}
let missing;
try {
    missing = indexedApiMissing((await import(pathToFileURL(BUILD).href)).Arena);
} catch (e) {
    missing = 'final build failed to import: ' + (e && e.message);
}
if (missing !== null) { end(); await stop(2, header() + '\nNO-VERDICT: final build ' + BUILD + ': ' + missing); }

const CONFIGS = [
    { name: 'PLAIN', build: BUILD },
    { name: 'POLY', build: BUILD },
    { name: 'MEGA', build: BUILD },
    { name: 'PLAIN-FE', build: BEFORE },
    { name: 'AA', build: BUILD },
    { name: 'SLOW', build: BUILD },
];
const IDX = {};
CONFIGS.forEach((c, i) => { IDX[c.name] = i; });

// Per-config per-round results: ns[c][body] Float64Array(K); maps / sink folded into provenance.
const NS = CONFIGS.map(() => [new Float64Array(K).fill(NaN), new Float64Array(K).fill(NaN), new Float64Array(K).fill(NaN)]);
const MAPS = new Float64Array(CONFIGS.length).fill(NaN);
let sink = 0;
let precond = null;

function runChild(cfg, round) {
    const args = ['--allow-natives-syntax', CHILD, '--config', cfg.name, '--build', cfg.build,
        '--ops', String(OPS), '--warm', String(WARM)];
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: DRY ? 120000 : 600000 });
    if (r.status === 2) {
        const why = (r.stdout || '').trim().split('\n').pop();
        throw Object.assign(new Error(cfg.name + ': ' + why), { precondition: true });
    }
    if (r.status !== 0) throw new Error(cfg.name + ': child exit ' + r.status + ' ' + (r.signal || '') + ' ' + (r.stderr || '').trim());
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
    if (line === undefined) throw new Error(cfg.name + ': child printed no RESULT line');
    const j = JSON.parse(line.slice(7));
    const c = IDX[cfg.name];
    MAPS[c] = j.maps;
    sink = (Math.imul(sink, 31) + (j.sink | 0)) | 0;   // order-sensitive fold (XOR would cancel repeats)
    if (round >= 0) for (let b = 0; b < 3; b++) NS[c][b][round] = j.ns[b];
    return j.ns[0];
}

try {
    interleave(K, CONFIGS, runChild);
} catch (e) {
    end();
    if (e && e.precondition) await stop(2, header() + '\nNO-VERDICT: ' + e.message);
    await stop(1, header() + '\nHARNESS ERROR: ' + (e && e.stack));
}
end();

const out = [header()];
out.push('maps: ' + CONFIGS.map((c, i) => c.name + '=' + MAPS[i]).join(' ') + ' | sink ' + (sink | 0));
if (!(MAPS[IDX.MEGA] >= 5)) precond = 'MEGA has ' + MAPS[IDX.MEGA] + ' distinct maps (< 5)';
if (precond !== null) await stop(2, out.join('\n') + '\nNO-VERDICT: ' + precond);

if (DRY) {
    for (let c = 0; c < CONFIGS.length; c++) {
        let ok = true;
        for (let b = 0; b < 3; b++) for (let r = 0; r < K; r++) if (!(NS[c][b][r] > 0)) ok = false;
        out.push('config ' + CONFIGS[c].name + ': ' + (ok ? 'ran (3 bodies, finite positive)' : 'BAD RESULT'));
        if (!ok) await stop(1, out.join('\n') + '\nHARNESS ERROR: ' + CONFIGS[c].name + ' returned a non-positive time');
    }
    out.push('DRY-RUN (no timing verdict)');
    await stop(0, out.join('\n'));
}

const ROWS = [['POLY vs PLAIN', 'PLAIN', 'POLY'], ['MEGA vs PLAIN', 'PLAIN', 'MEGA'], ['PLAIN final vs PLAIN fe8d7d5', 'PLAIN-FE', 'PLAIN']];
let anyNv = false;
for (let b = 0; b < 3; b++) {
    out.push('body: ' + BODIES[b]);
    const cb = NS[IDX.PLAIN][b];
    for (const [label, baseName, candName] of ROWS) {
        const v = verdict({ base: NS[IDX[baseName]][b], cand: NS[IDX[candName]][b], aa: NS[IDX.AA][b], slow: NS[IDX.SLOW][b], controlBase: cb });
        if (v.verdict === 'NO-VERDICT') anyNv = true;
        out.push('  ' + label.padEnd(30) + ' ' + v.label + ' | median ' + (Number.isFinite(v.median) ? v.median.toFixed(3) : 'NaN') +
            ' | rounds>1 ' + v.roundsOver + '/' + K + ' | ' + v.reason);
    }
    for (const c of CONFIGS) {
        out.push('  ns/op ' + c.name.padEnd(9) + ' ' + Array.from(NS[IDX[c.name]][b], (x) => x.toFixed(2)).join(' '));
    }
}
await stop(anyNv ? 2 : 0, out.join('\n'));
