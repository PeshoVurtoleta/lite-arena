/**
 * @zakkster/lite-arena -- F2 bench lib (G3 T1): provenance header, interleaved
 * rounds and the shared A/B statistic of the L1 / L5 lanes. Not shipped.
 *
 * Statistic (PLAN-F2 G3 SPEC): K = 11 interleaved rounds after a discarded warm-up;
 * per-round ratios r_i = cand_i / base_i; the verdict reads the MEDIAN ratio.
 *   NONE         = median within +-5%.
 *   COST x.xx    = median >= 1.05 AND >= 9 of 11 rounds with ratio > 1.
 *   INCONCLUSIVE = anything else (a faster candidate reads INCONCLUSIVE + reason).
 * Lane controls first: AA (baseline vs itself) must read NONE and SLOW (baseline +
 * a 16-step xorshift per op) must read COST with median >= 1.20 (>= 9 / 11 rounds
 * > 1), else NO-VERDICT. Wrong K, NaN or a non-positive time -> NO-VERDICT.
 *
 *   node bench/f2/lib.mjs --self-test     (exit 0 = ok, 1 = a canned case failed)
 *
 * MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 */
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const K_REQ = 11;          // rounds the verdict accepts (fail closed on any other K)
export const NONE_BAND = 0.05;    // NONE: |median - 1| <= 0.05
export const COST_MIN = 1.05;     // COST: median >= 1.05 ...
export const ROUNDS_MIN = 9;      // ... AND >= 9 of 11 rounds with ratio > 1
export const SLOW_MIN = 1.20;     // SLOW control: COST with median >= 1.20

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

// ---------------------------------------------------------------- provenance
// load1 at start / end in Float64Array slots (NaN = not recorded -> "unknown").
const LOAD = new Float64Array([NaN, NaN]);

/** Records load1 at the start of a run. */
export function start() { LOAD[0] = os.loadavg()[0]; }
/** Records load1 at the end of a run. */
export function end() { LOAD[1] = os.loadavg()[0]; }

const UNKNOWN = 'unknown';
const fix2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : UNKNOWN);

function tryRun(file, args, cwd) {
    try {
        return execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    } catch {
        return null;
    }
}

function baselineText() {
    const p = join(os.homedir(), '.claude', 'quiet-baseline.json');
    let raw;
    try {
        raw = readFileSync(p, 'utf8');
    } catch (e) {
        return e && e.code === 'ENOENT' ? 'none' : UNKNOWN;
    }
    try {
        const j = JSON.parse(raw);
        if (typeof j.load1 !== 'number' || !Number.isFinite(j.load1)) return UNKNOWN;
        return j.load1.toFixed(2) + ' (cores ' + (Number.isInteger(j.cores) ? j.cores : UNKNOWN) +
            ', measured ' + (typeof j.measured === 'string' ? j.measured : UNKNOWN) + ')';
    } catch {
        return UNKNOWN;
    }
}

function busyNodeText() {
    const out = tryRun('ps', ['-Ao', 'pid=,pcpu=,comm='], ROOT);
    if (out === null) return UNKNOWN;
    const busy = [];
    for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
        if (m === null) continue;
        const pid = Number(m[1]), cpu = Number(m[2]), comm = m[3];
        if (pid === process.pid) continue;                 // exclude self
        if (!/(^|\/)node$/.test(comm.trim())) continue;
        if (!(cpu >= 10)) continue;
        busy.push('pid ' + pid + ' ' + cpu.toFixed(1) + '%');
    }
    return busy.length === 0 ? 'none' : busy.join(', ');
}

/**
 * sha256 hex of a file, or "unknown" when unreadable.
 * @param {string} p
 */
export function sha256File(p) {
    try {
        return createHash('sha256').update(readFileSync(p)).digest('hex');
    } catch {
        return UNKNOWN;
    }
}

/**
 * Provenance header text. Every field prints; an unreadable one prints "unknown".
 * @param {{ lane: string, K: number, runs: number, builds: string[],
 *           load1Start?: number, load1End?: number, extra?: string[] }} opts
 * @returns {string}
 */
export function provenance(opts) {
    const o = opts || {};
    const ls = typeof o.load1Start === 'number' ? o.load1Start : LOAD[0];
    const le = typeof o.load1End === 'number' ? o.load1End : LOAD[1];
    let host;
    try { host = os.hostname(); } catch { host = UNKNOWN; }
    const head = tryRun('git', ['rev-parse', 'HEAD'], ROOT);
    const st = tryRun('git', ['status', '--porcelain'], ROOT);
    let dirty;
    if (st === null) dirty = UNKNOWN;
    else {
        const paths = st.split('\n').filter((l) => l.length > 0).map((l) => l.slice(3));
        dirty = paths.length === 0 ? 'clean' : 'DIRTY (' + paths.join(', ') + ')';
    }
    const L = [];
    L.push('# provenance');
    L.push('lane: ' + (typeof o.lane === 'string' && o.lane ? o.lane : UNKNOWN));
    L.push('date: ' + new Date().toISOString());
    L.push('host: ' + host);
    L.push('load1 start: ' + fix2(ls) + ' | load1 end: ' + fix2(le) + ' | baseline: ' + baselineText());
    L.push('busy node (>= 10% CPU, self excluded): ' + busyNodeText());
    L.push('node: ' + process.version + ' execArgv: ' + JSON.stringify(process.execArgv));
    L.push('K: ' + (Number.isInteger(o.K) ? o.K : UNKNOWN) + ' runs: ' + (Number.isInteger(o.runs) ? o.runs : UNKNOWN));
    L.push('commit: ' + (head === null ? UNKNOWN : head.trim()) + ' tree: ' + dirty);
    const builds = Array.isArray(o.builds) ? o.builds : [];
    if (builds.length === 0) L.push('sha256: ' + UNKNOWN + ' (no build listed)');
    for (const b of builds) L.push('sha256 ' + sha256File(b) + '  ' + b);
    if (Array.isArray(o.extra)) for (const x of o.extra) L.push(String(x));
    return L.join('\n');
}

// ---------------------------------------------------------------- interleave
/**
 * Runs one discarded warm-up round (configs in order), then K timed rounds; round r
 * starts at config r % n and rotates. runOne(config, round) returns ns/op (or any
 * per-config number); round is -1 for the warm-up.
 * @param {number} K
 * @param {any[]} configs
 * @param {(cfg: any, round: number) => number} runOne
 * @returns {Float64Array[]} results[c][r] for config index c, timed round r.
 */
export function interleave(K, configs, runOne) {
    if (!Number.isInteger(K) || K < 1) throw new Error('interleave: K must be an integer >= 1, got ' + K);
    const n = configs.length;
    if (n < 1) throw new Error('interleave: no configs');
    const out = [];
    for (let c = 0; c < n; c++) out.push(new Float64Array(K).fill(NaN));
    for (let c = 0; c < n; c++) runOne(configs[c], -1);       // warm-up, discarded
    for (let r = 0; r < K; r++) {
        for (let j = 0; j < n; j++) {
            const c = (r + j) % n;
            out[c][r] = runOne(configs[c], r);
        }
    }
    return out;
}

// ---------------------------------------------------------------- verdict
/** Median of a numeric array (NaN on empty). */
export function median(xs) {
    const s = Float64Array.from(xs).sort();
    const n = s.length;
    if (n === 0) return NaN;
    return (n & 1) === 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Fail-closed shape check: null when ok, else the reason. */
function badSeries(name, xs) {
    if (xs == null || typeof xs.length !== 'number') return name + ' missing';
    if (xs.length !== K_REQ) return name + ' has K=' + xs.length + ' (needs ' + K_REQ + ')';
    for (let i = 0; i < xs.length; i++) {
        const v = xs[i];
        if (typeof v !== 'number' || !(v > 0) || !Number.isFinite(v)) return name + '[' + i + '] = ' + v + ' (NaN / non-positive)';
    }
    return null;
}

/** Classifies one ratio series (cand / base). */
function classify(cand, base) {
    const r = new Float64Array(K_REQ);
    let over = 0;
    for (let i = 0; i < K_REQ; i++) {
        r[i] = cand[i] / base[i];
        if (r[i] > 1) over++;
    }
    const m = median(r);
    if (!Number.isFinite(m)) return { verdict: 'NO-VERDICT', median: NaN, roundsOver: over, reason: 'median not finite' };
    if (m >= COST_MIN && over >= ROUNDS_MIN) {
        return { verdict: 'COST', median: m, roundsOver: over, reason: 'COST ' + m.toFixed(2) + ' (' + over + '/' + K_REQ + ' rounds > 1)' };
    }
    if (Math.abs(m - 1) <= NONE_BAND) {
        return { verdict: 'NONE', median: m, roundsOver: over, reason: 'median ' + m.toFixed(3) + ' within +-5%' };
    }
    const why = m < 1 - NONE_BAND
        ? 'median ' + m.toFixed(3) + ' < 0.95 (candidate faster; no cost)'
        : 'median ' + m.toFixed(3) + ' with ' + over + '/' + K_REQ + ' rounds > 1 (COST needs >= 1.05 and >= ' + ROUNDS_MIN + ')';
    return { verdict: 'INCONCLUSIVE', median: m, roundsOver: over, reason: why };
}

/**
 * The shared A/B verdict. Each series is per-round ns/op over K = 11 rounds.
 * `controlBase` (default `base`) is the baseline the AA / SLOW controls are read
 * against, so a row may compare cand vs another base while the lane controls stay
 * pinned to the lane's own baseline.
 * @param {{ base: ArrayLike<number>, cand: ArrayLike<number>, aa: ArrayLike<number>,
 *           slow: ArrayLike<number>, controlBase?: ArrayLike<number> }} x
 * @returns {{ verdict: 'NONE'|'COST'|'INCONCLUSIVE'|'NO-VERDICT', median: number,
 *             roundsOver: number, reason: string, label: string }}
 */
export function verdict(x) {
    const nv = (reason) => ({ verdict: 'NO-VERDICT', median: NaN, roundsOver: NaN, reason, label: 'NO-VERDICT' });
    if (x == null || typeof x !== 'object') return nv('no input');
    const cb = x.controlBase === undefined ? x.base : x.controlBase;
    for (const [name, xs] of [['base', x.base], ['cand', x.cand], ['aa', x.aa], ['slow', x.slow], ['controlBase', cb]]) {
        const bad = badSeries(name, xs);
        if (bad !== null) return nv(bad);
    }
    const aa = classify(x.aa, cb);
    if (aa.verdict !== 'NONE') return nv('AA control failed: ' + aa.verdict + ' (' + aa.reason + ')');
    const sl = classify(x.slow, cb);
    if (sl.verdict !== 'COST' || !(sl.median >= SLOW_MIN)) {
        return nv('SLOW control failed: ' + sl.verdict + ' ' + (Number.isFinite(sl.median) ? sl.median.toFixed(3) : 'NaN') +
            ' (needs COST >= ' + SLOW_MIN.toFixed(2) + ')');
    }
    const c = classify(x.cand, x.base);
    if (c.verdict === 'NO-VERDICT') return nv(c.reason);
    return {
        verdict: c.verdict, median: c.median, roundsOver: c.roundsOver, reason: c.reason,
        label: c.verdict === 'COST' ? 'COST ' + c.median.toFixed(2) : c.verdict,
    };
}

// ---------------------------------------------------------------- self-test
const fill = (v) => new Float64Array(K_REQ).fill(v);
const series = (vals) => Float64Array.from(vals);
const BASE = fill(100);
const AA_OK = series([100, 101, 99, 100, 102, 98, 100, 101, 99, 100, 100]);
const SLOW_OK = fill(135);

/** Canned cases: [name, input, expected verdict]. */
export const CASES = [
    ['NONE (cand within +-5%)', { base: BASE, cand: series([101, 99, 102, 98, 100, 101, 99, 100, 103, 97, 100]), aa: AA_OK, slow: SLOW_OK }, 'NONE'],
    ['COST (1.10 every round)', { base: BASE, cand: fill(110), aa: AA_OK, slow: SLOW_OK }, 'COST'],
    ['INCONCLUSIVE (median 1.10, only 6/11 rounds > 1)', { base: BASE, cand: series([110, 90, 110, 90, 110, 90, 110, 90, 110, 90, 110]), aa: AA_OK, slow: SLOW_OK }, 'INCONCLUSIVE'],
    ['NO-VERDICT (AA reads 1.10)', { base: BASE, cand: fill(110), aa: fill(110), slow: SLOW_OK }, 'NO-VERDICT'],
    ['NO-VERDICT (SLOW reads 1.10 < 1.20)', { base: BASE, cand: fill(110), aa: AA_OK, slow: fill(110) }, 'NO-VERDICT'],
    ['NO-VERDICT (SLOW median 1.30 but 8/11 rounds > 1)', { base: BASE, cand: fill(110), aa: AA_OK, slow: series([130, 130, 130, 130, 130, 130, 130, 130, 90, 90, 90]) }, 'NO-VERDICT'],
    ['BOUNDARY every round 1.00 is NOT COST (NONE)', { base: BASE, cand: fill(100), aa: AA_OK, slow: SLOW_OK }, 'NONE'],
    ['BOUNDARY median 1.04, 11/11 rounds > 1 is NOT COST (NONE)', { base: BASE, cand: fill(104), aa: AA_OK, slow: SLOW_OK }, 'NONE'],
    ['FAIL-CLOSED K=10', { base: BASE.subarray(0, 10), cand: fill(110).subarray(0, 10), aa: AA_OK.subarray(0, 10), slow: SLOW_OK.subarray(0, 10) }, 'NO-VERDICT'],
    ['FAIL-CLOSED NaN round', { base: BASE, cand: series([110, 110, NaN, 110, 110, 110, 110, 110, 110, 110, 110]), aa: AA_OK, slow: SLOW_OK }, 'NO-VERDICT'],
    ['FAIL-CLOSED zero time', { base: series([100, 100, 100, 0, 100, 100, 100, 100, 100, 100, 100]), cand: fill(110), aa: AA_OK, slow: SLOW_OK }, 'NO-VERDICT'],
    ['FAIL-CLOSED negative time', { base: BASE, cand: fill(110), aa: AA_OK, slow: series([135, 135, 135, 135, -1, 135, 135, 135, 135, 135, 135]) }, 'NO-VERDICT'],
];

/**
 * Runs every canned case through verdictFn.
 * @param {(x: object) => { verdict: string }} [verdictFn]
 * @returns {{ ok: boolean, failures: string[], cases: number }}
 */
export function selfTest(verdictFn = verdict) {
    const failures = [];
    for (const [name, input, want] of CASES) {
        let got;
        try {
            const v = verdictFn(input);
            got = v && typeof v.verdict === 'string' ? v.verdict : 'BAD-RETURN';
        } catch (e) {
            got = 'THREW ' + (e && e.message);
        }
        if (got !== want) failures.push(name + ': expected ' + want + ', got ' + got);
    }
    return { ok: failures.length === 0 && CASES.length >= 4, failures, cases: CASES.length };
}

// ---------------------------------------------------------------- indexed-API probe
/**
 * Fail-closed probe of the F2 indexed API on an imported Arena class: null when the
 * build has it (registerFlags indexed option + the 4 indexed queries, behaving),
 * else the NO-VERDICT reason.
 * @param {Function} Arena
 * @returns {string|null}
 */
export function indexedApiMissing(Arena) {
    if (typeof Arena !== 'function') return 'build exports no Arena class';
    for (const m of ['flagCount', 'firstFlagged', 'nextFlagged', 'clearFlagAll', 'joinN']) {
        if (typeof Arena.prototype[m] !== 'function') return 'build has no Arena.prototype.' + m + ' (no indexed API)';
    }
    try {
        const a = new Arena(64);
        const F = a.registerFlags(['x', 'y'], { indexed: ['x'] });
        const e0 = a.spawn(), e1 = a.spawn();
        a.setFlags(e1, F.x);
        if (a.flagCount(F.x) !== 1) return 'indexed flagCount != 1 after one setFlags';
        if (a.firstFlagged(F.x) !== e1) return 'indexed firstFlagged != the flagged handle';
        if (a.nextFlagged(F.x, e1) !== -1) return 'indexed nextFlagged did not end the walk';
        a.clearFlagAll(F.x);
        if (a.flagCount(F.x) !== 0 || a.hasFlags(e1, F.x)) return 'indexed clearFlagAll left the flag';
        void e0;
    } catch (e) {
        return 'registerFlags(names, { indexed }) path threw: ' + (e && e.message);
    }
    return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--self-test')) {
    const r = selfTest();
    console.log('lib self-test: ' + (r.ok ? 'ok' : 'FAIL') + ' (' + r.cases + ' cases, ' + r.failures.length + ' failures)');
    for (const f of r.failures) console.log('  ' + f);
    process.exitCode = r.ok ? 0 : 1;
}
