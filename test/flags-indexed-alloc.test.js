/**
 * @zakkster/lite-arena -- F2 indexed flags: allocation gate (PLAN-F2 G3 A1 / A2, M-46, M-50, M-51).
 * DETERMINISTIC: GC COUNTS and new-space BYTE deltas, never a timing. Spawns
 * bench/f2/newspace-probe.mjs with --trace-gc and a 1 MiB semi-space (the probe exits 2
 * without them) and reads three things off its stdout:
 *
 * A1 (counts): per lane, the `Scavenge` / `Mark-Compact` lines of --trace-gc between
 *   `LANE-START` / `LANE-END` (500,000 ops; 20,000 for walk). Every F2 lane
 *   <= noop + 1 Scavenge (~2.1 B/op nominal), 0 Mark-Compact in every window; the box lane
 *   (one {a: i} per op) >= noop + 8 proves the counter sees allocation.
 * M-51 (bytes): new-space used bytes over a GC-free window of 400,000 ops (one ixSetFlags
 *   + one ixClearFlags per op), steady state = min of windows 1..3. ixSet1 - noop must stay
 *   under MARGIN = 16,384 B; the harness's ctl1k lane (one new Int32Array(1) per 1,000 ops,
 *   the rate of the once-per-1,000 mutant) must reach it. MARGIN is fixed a priori: 400
 *   Int32Array(1) objects are >= 400 x 64 B = 25,600 B on any 64-bit V8, so MARGIN sits at
 *   ~0.64 of the smallest possible mutant signal and far above a clean delta of 0. Every
 *   `ok` window must show 0 Scavenge lines in the trace (an oracle independent of the
 *   probe's v8.GCProfiler check).
 * A2 (retention): 64 arenas' replaced indexed columns (_ixW / _ixS1 / _ixWHi / _ixS1Hi,
 *   256 tracked) are not retained after reserve(8192) + clear(): tracker.size() === 0 with
 *   the arenas alive and after they are dropped.
 *
 * On fe8d7d5 (no indexed API) the probe exits 2. .handoff/ is gitignored (A11), so that row
 * materializes fe8d7d5 with `git show` into a temp dir and skips, with the reason, when the
 * object is missing.
 *
 * Run: `node --test test/flags-indexed-alloc.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/flags-indexed-alloc.test.js
 *   (per-call / once-per-1,000 transient-allocation mutants must turn it red), and the
 *   probe knobs F2NS_BOX=<lane>|1 and F2NS_LEAK=1 (retention reads 256), passed through.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = join(ROOT, 'bench/f2/newspace-probe.mjs');
const FLAGS = ['--expose-gc', '--trace-gc', '--min-semi-space-size=1', '--max-semi-space-size=1'];
const MARGIN = 16384;
const F2_LANES = ['ixPair1', 'ixPair4', 'hiPair', 'ixChurn', 'flagCount', 'firstFlagged', 'joinNHint', 'checkedPair', 'walk', 'clearAll',
    'flagCountHi', 'firstFlaggedHi', 'walkHi', 'clearAllHi'];   // M-65 / O-8: Hi lanes at the word-0 budget
const OPS = { walk: 20000 };   // every other lane (clearAll, the Hi lanes) runs 500,000 (M-69 / O-8: 20,000 ops cannot see a ~40 B/call mutant)
const BEFORE_SHA = 'fe8d7d5';

const spawnProbe = (flags, env) => spawnSync(process.execPath, [...flags, PROBE], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024,
});
const run = spawnProbe(FLAGS, { ...process.env });

const scav = {}, mark = {};
const bwin = [];          // { lane, k, t, state, bytes, scav }
let r = null;
if (run.status === 0) {
    let lane = null, win = null;
    for (const ln of run.stdout.split('\n')) {
        if (ln.startsWith('LANE-START ')) { lane = ln.slice(11).trim(); scav[lane] = 0; mark[lane] = 0; }
        else if (ln.startsWith('LANE-END ')) lane = null;
        else if (ln.startsWith('BWIN-START ')) win = { scav: 0 };
        else if (ln.startsWith('BWIN-END ')) {
            const p = ln.split(' ');
            if (win !== null) bwin.push({ lane: p[1], k: Number(p[2]), t: Number(p[3]), state: p[4], bytes: Number(p[5]), scav: win.scav });
            win = null;
        } else if (ln.includes('Scavenge')) {
            if (lane !== null) scav[lane]++;
            if (win !== null) win.scav++;
        } else if (lane !== null && /Mark-Compact|Mark-sweep/.test(ln)) mark[lane]++;
        else if (ln.startsWith('{')) r = JSON.parse(ln);
    }
}

test('probe ran (exit 0)', (t) => {
    assert.equal(run.status, 0, run.stderr);
    t.diagnostic('scavenges per lane: ' + JSON.stringify(scav));
    t.diagnostic('mark-compacts per lane: ' + JSON.stringify(mark));
    if (r !== null) t.diagnostic('bytes per window: ' + JSON.stringify(r.bytes) + ' rearms ' + r.rearms);
});

for (const ln of F2_LANES) {
    test('A1: ' + ln + ' <= noop + 1 Scavenge per ' + (OPS[ln] || 500000) + ' ops', (t) => {
        assert.equal(typeof scav[ln], 'number', 'lane ' + ln + ' missing');
        assert.ok(scav[ln] <= scav.noop + 1, ln + ' ' + scav[ln] + ' noop ' + scav.noop);
        t.diagnostic(ln + ' nominal ' + (((scav[ln] - scav.noop) * 1048576) / (OPS[ln] || 500000)).toFixed(2) + ' B/op');
    });
}

test('A1: 0 Mark-Compact in every lane window', () => {
    const lanes = Object.keys(mark);
    assert.ok(lanes.length >= F2_LANES.length + 2, 'lanes ' + lanes.join(','));
    for (const ln of lanes) assert.equal(mark[ln], 0, ln + ' Mark-Compact ' + mark[ln]);
});

test('A1 MUST-FAIL: box lane (one object per op) >= noop + 8', () => {
    assert.ok(scav.box >= scav.noop + 8, 'box ' + scav.box + ' must exceed noop ' + scav.noop + ' by >= 8');
});

test('M-51: every byte window is GC-free (probe GCProfiler and the trace agree)', () => {
    assert.ok(r !== null, 'no probe JSON');
    for (const ln of ['noop', 'ixSet1', 'ctl1k']) {
        const ok = bwin.filter((w) => w.lane === ln && w.state === 'ok');
        assert.equal(ok.length, 4, ln + ' ok windows ' + ok.length);
        for (const w of ok) assert.equal(w.scav, 0, ln + ' window ' + w.k + ' marked ok but the trace shows ' + w.scav + ' Scavenge');
        assert.ok(Number.isFinite(r.bytesMin[ln]), ln + ' bytesMin ' + r.bytesMin[ln]);
    }
});

test('M-51: ixSetFlags lane stays under noop + ' + MARGIN + ' new-space bytes per 400,000 ops', (t) => {
    // null (a NaN window: GC re-arm exhausted) must fail closed, never read as 0
    assert.ok(Number.isFinite(r.bytesMin.ixSet1) && Number.isFinite(r.bytesMin.noop), "bytesMin " + JSON.stringify(r.bytesMin));
    const d = r.bytesMin.ixSet1 - r.bytesMin.noop;
    t.diagnostic('ixSet1 - noop = ' + d + ' B (noop ' + r.bytesMin.noop + ')');
    assert.ok(d < MARGIN, 'ixSet1 ' + r.bytesMin.ixSet1 + ' noop ' + r.bytesMin.noop + ' delta ' + d + ' >= ' + MARGIN);
});

test('M-51 MUST-FAIL: ctl1k (one Int32Array(1) per 1,000 ops) reaches the margin', (t) => {
    assert.ok(Number.isFinite(r.bytesMin.ctl1k) && Number.isFinite(r.bytesMin.noop), "bytesMin " + JSON.stringify(r.bytesMin));
    const d = r.bytesMin.ctl1k - r.bytesMin.noop;
    t.diagnostic('ctl1k - noop = ' + d + ' B');
    assert.ok(d >= MARGIN, 'ctl1k delta ' + d + ' < ' + MARGIN + ': the byte lane cannot see the mutant rate');
});

test('A2: replaced indexed columns are not retained (64 live arenas, 256 tracked)', () => {
    assert.equal(r.rTracked, 256);
    assert.equal(r.rBad, 0);
    assert.equal(r.rArenas, 64);
    assert.equal(r.rAlive, 0, 'retained columns with the arenas alive: ' + r.rAlive);
});

test('A2: nothing retained after the arenas are dropped', () => {
    assert.equal(r.rDropped, 0, 'retained columns after drop: ' + r.rDropped);
});

test('probe fails closed (exit 2) without the semi-space flags', () => {
    const p = spawnProbe(['--expose-gc', '--trace-gc'], { ...process.env });
    assert.equal(p.status, 2, p.stderr);
    assert.match(p.stderr, /min-semi-space-size=1/);
});

test('probe on fe8d7d5 (no indexed API) exits 2', (t) => {
    let dir;
    try {
        execFileSync('git', ['cat-file', '-e', BEFORE_SHA + ':Arena.js'], { cwd: ROOT, stdio: 'ignore' });
        const src = execFileSync('git', ['show', BEFORE_SHA + ':Arena.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
        dir = mkdtempSync(join(tmpdir(), 'lite-arena-f2ns-before-'));
        writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
        writeFileSync(join(dir, 'Arena.js'), src);
    } catch (e) {
        t.skip('git object ' + BEFORE_SHA + ':Arena.js unavailable (' + (e && e.message) + ')');
        return;
    }
    try {
        const p = spawnProbe(FLAGS, { ...process.env, LITE_ARENA_PATH: join(dir, 'Arena.js') });
        assert.equal(p.status, 2, p.stdout.slice(-2000) + p.stderr);
        assert.match(p.stderr, /NO-VERDICT: .*no indexed API/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
