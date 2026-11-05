/**
 * @zakkster/lite-arena -- F2 G3 bench harness A (U6): bench/f2/lib.mjs statistic +
 * self-test (with must-fail mutants), and the --dry-run contract of the L1
 * (mixed-site.mjs) and L5 (headline.mjs) lanes. No timing is asserted.
 *
 * Expected verdict classes come from PLAN-F2 G3 SPEC (NONE within +-5%; COST =
 * median >= 1.05 AND >= 9 / 11 rounds > 1; AA must read NONE and SLOW COST >= 1.20,
 * else NO-VERDICT), never from lib.mjs. .handoff/ is gitignored, so nothing here
 * reads it: the green dry-runs use the live Arena.js, the exit-2 rows materialize
 * fe8d7d5 (the pre-F2 build, no indexed API) with `git show` into a temp dir.
 *
 * Run: `node --test test/f2-bench-a.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdict, selfTest, interleave } from '../bench/f2/lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = join(ROOT, 'Arena.js');
const LIB = join(ROOT, 'bench/f2/lib.mjs');
const MIXED = join(ROOT, 'bench/f2/mixed-site.mjs');
const HEAD = join(ROOT, 'bench/f2/headline.mjs');
const BEFORE_SHA = 'fe8d7d5';

const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
const fill = (v) => new Array(11).fill(v);
const AA = [100, 101, 99, 100, 102, 98, 100, 101, 99, 100, 100];
const SLOW = fill(130);
const BASE = fill(100);

// fe8d7d5 materialized once (skip, with the reason, when the object is missing).
let BEFORE = null, BEFORE_WHY = '';
try {
    execFileSync('git', ['cat-file', '-e', BEFORE_SHA + ':Arena.js'], { cwd: ROOT, stdio: 'ignore' });
    const src = execFileSync('git', ['show', BEFORE_SHA + ':Arena.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
    const dir = mkdtempSync(join(tmpdir(), 'lite-arena-f2-before-'));
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
    BEFORE = join(dir, 'Arena.js');
    writeFileSync(BEFORE, src);
    process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } });
} catch (e) {
    BEFORE_WHY = 'git object ' + BEFORE_SHA + ':Arena.js unavailable (' + (e && e.message) + ')';
}

test('lib self-test: every canned case passes (>= 4 cases)', () => {
    const r = selfTest();
    assert.deepEqual(r.failures, []);
    assert.equal(r.ok, true);
    assert.ok(r.cases >= 4, 'cases ' + r.cases);
});

test('lib --self-test CLI exits 0', () => {
    const r = run([LIB, '--self-test']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /lib self-test: ok/);
});

test('MUST-FAIL: a verdict() mutant reporting COST at 1.00 fails the self-test', () => {
    // Mutant 1: COST threshold 1.05 -> 1.00 on the candidate (controls untouched).
    const cost100 = (x) => {
        const v = verdict(x);
        return v.verdict === 'NONE' && v.median >= 1.00 ? { ...v, verdict: 'COST' } : v;
    };
    const r1 = selfTest(cost100);
    assert.equal(r1.ok, false);
    assert.ok(r1.failures.some((f) => /BOUNDARY every round 1\.00/.test(f)), r1.failures.join('\n'));
    // Mutant 2: rounds rule dropped (median >= 1.05 alone reads COST).
    const noRounds = (x) => {
        const v = verdict(x);
        return v.verdict === 'INCONCLUSIVE' && v.median >= 1.05 ? { ...v, verdict: 'COST' } : v;
    };
    assert.equal(selfTest(noRounds).ok, false);
});

test('verdict: NONE when the median ratio is within +-5%', () => {
    const v = verdict({ base: BASE, cand: [101, 99, 104, 96, 100, 100, 102, 98, 100, 101, 99], aa: AA, slow: SLOW });
    assert.equal(v.verdict, 'NONE');
    assert.equal(v.median, 1);
});

test('verdict: COST 1.10 when median >= 1.05 and 11/11 rounds > 1', () => {
    const v = verdict({ base: BASE, cand: fill(110), aa: AA, slow: SLOW });
    assert.equal(v.verdict, 'COST');
    assert.equal(v.roundsOver, 11);
    assert.ok(Math.abs(v.median - 1.1) < 1e-12);
    assert.match(v.reason, /COST 1\.10/);
});

test('verdict: COST needs >= 9 rounds: 9 passes, 8 is INCONCLUSIVE', () => {
    const nine = verdict({ base: BASE, cand: [110, 110, 110, 110, 110, 110, 110, 110, 110, 90, 90], aa: AA, slow: SLOW });
    assert.equal(nine.verdict, 'COST');
    assert.equal(nine.roundsOver, 9);
    const eight = verdict({ base: BASE, cand: [110, 110, 110, 110, 110, 110, 110, 110, 90, 90, 90], aa: AA, slow: SLOW });
    assert.equal(eight.verdict, 'INCONCLUSIVE');
    assert.equal(eight.roundsOver, 8);
});

test('verdict: INCONCLUSIVE for a median outside +-5% that is not COST (incl. a faster candidate)', () => {
    assert.equal(verdict({ base: BASE, cand: [110, 90, 110, 90, 110, 90, 110, 90, 110, 90, 110], aa: AA, slow: SLOW }).verdict, 'INCONCLUSIVE');
    assert.equal(verdict({ base: BASE, cand: fill(50), aa: AA, slow: SLOW }).verdict, 'INCONCLUSIVE');
});

test('verdict BOUNDARY: every round ratio 1.00 is NOT COST (reads NONE)', () => {
    const v = verdict({ base: BASE, cand: fill(100), aa: AA, slow: SLOW });
    assert.notEqual(v.verdict, 'COST');
    assert.equal(v.verdict, 'NONE');
    assert.equal(v.roundsOver, 0);
});

test('verdict BOUNDARY: median 1.04 with 11/11 rounds > 1 is NOT COST', () => {
    assert.equal(verdict({ base: BASE, cand: fill(104), aa: AA, slow: SLOW }).verdict, 'NONE');
});

test('verdict NO-VERDICT: AA control not NONE', () => {
    const v = verdict({ base: BASE, cand: fill(110), aa: fill(106), slow: SLOW });
    assert.equal(v.verdict, 'NO-VERDICT');
    assert.match(v.reason, /AA control failed/);
});

test('verdict NO-VERDICT: SLOW control below 1.20 or with < 9 rounds over', () => {
    const a = verdict({ base: BASE, cand: fill(110), aa: AA, slow: fill(115) });
    assert.equal(a.verdict, 'NO-VERDICT');
    assert.match(a.reason, /SLOW control failed/);
    const b = verdict({ base: BASE, cand: fill(110), aa: AA, slow: [130, 130, 130, 130, 130, 130, 130, 130, 90, 90, 90] });
    assert.equal(b.verdict, 'NO-VERDICT');
    assert.match(b.reason, /SLOW control failed/);
});

test('verdict NO-VERDICT (fail closed): wrong K, NaN, zero, negative, missing series', () => {
    assert.equal(verdict({ base: fill(100).slice(1), cand: fill(110).slice(1), aa: AA.slice(1), slow: SLOW.slice(1) }).verdict, 'NO-VERDICT');
    assert.equal(verdict({ base: BASE, cand: [NaN, ...fill(110).slice(1)], aa: AA, slow: SLOW }).verdict, 'NO-VERDICT');
    assert.equal(verdict({ base: [0, ...BASE.slice(1)], cand: fill(110), aa: AA, slow: SLOW }).verdict, 'NO-VERDICT');
    assert.equal(verdict({ base: BASE, cand: fill(110), aa: AA, slow: [-1, ...SLOW.slice(1)] }).verdict, 'NO-VERDICT');
    assert.equal(verdict({ base: BASE, cand: fill(110), aa: AA }).verdict, 'NO-VERDICT');
    assert.equal(verdict(null).verdict, 'NO-VERDICT');
});

test('interleave: discarded warm-up, K rounds, start rotates r % n', () => {
    const calls = [];
    const out = interleave(3, ['a', 'b', 'c'], (cfg, r) => { calls.push(cfg + r); return r < 0 ? -1 : 10 * r + cfg.charCodeAt(0) - 96; });
    assert.deepEqual(calls, ['a-1', 'b-1', 'c-1', 'a0', 'b0', 'c0', 'b1', 'c1', 'a1', 'c2', 'a2', 'b2']);
    assert.deepEqual(out.map((f) => Array.from(f)), [[1, 11, 21], [2, 12, 22], [3, 13, 23]]);
});

test('verdict controlBase: AA / SLOW read against controlBase, cand against base', () => {
    const v = verdict({ base: fill(50), cand: fill(55), aa: AA, slow: SLOW, controlBase: BASE });
    assert.equal(verdict({ base: fill(120), cand: fill(132), aa: AA, slow: SLOW, controlBase: BASE }).verdict, 'COST');
    assert.equal(v.verdict, 'COST');
    assert.ok(Math.abs(v.median - 1.1) < 1e-12);
});

function assertProvenance(out, builds) {
    assert.match(out, /^# provenance$/m);
    for (const k of ['lane:', 'date:', 'host:', 'load1 start:', 'busy node', 'node:', 'K: 1', 'commit:']) assert.ok(out.includes(k), 'provenance field ' + k);
    for (const b of builds) assert.match(out, new RegExp('^sha256 [0-9a-f]{64}  ' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'));
}

test('L1 mixed-site --dry-run on the live build exits 0 (provenance + DRY-RUN, MEGA >= 5 maps)', () => {
    const before = BEFORE === null ? LIVE : BEFORE;   // the PLAIN-on-fe8d7d5 child runs on fe8d7d5 when git has it
    const r = run([MIXED, '--dry-run', '--build', LIVE, '--before', before]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assertProvenance(r.stdout, [LIVE, before]);
    assert.match(r.stdout, /^DRY-RUN \(no timing verdict\)$/m);
    const m = /MEGA=(\d+)/.exec(r.stdout);
    assert.ok(m && Number(m[1]) >= 5, 'MEGA maps ' + (m && m[1]));
    for (const c of ['PLAIN', 'POLY', 'MEGA', 'PLAIN-FE', 'AA', 'SLOW']) assert.match(r.stdout, new RegExp('^config ' + c + ': ran', 'm'));
});

test('L1 mixed-site --dry-run --build <fe8d7d5> exits 2 (no indexed API)', (t) => {
    if (BEFORE === null) { t.skip(BEFORE_WHY); return; }
    const r = run([MIXED, '--dry-run', '--build', BEFORE, '--before', BEFORE]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /^NO-VERDICT: .*no indexed API/m);
    assertProvenance(r.stdout, [BEFORE]);
});

test('L5 headline --dry-run on the live build exits 0 (walk == row scan precondition, DRY-RUN)', () => {
    const r = run([HEAD, '--dry-run', '--build', LIVE]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assertProvenance(r.stdout, [LIVE]);
    assert.match(r.stdout, /^precondition before timing: walk == row scan/m);
    assert.match(r.stdout, /^precondition after timing: walk == row scan/m);
    assert.match(r.stdout, /^configs ran: 60 \(15 lanes/m);
    assert.match(r.stdout, /^DRY-RUN \(no timing verdict\)$/m);
});

test('L5 headline --dry-run --build <fe8d7d5> exits 2 (no indexed API)', (t) => {
    if (BEFORE === null) { t.skip(BEFORE_WHY); return; }
    const r = run([HEAD, '--dry-run', '--build', BEFORE]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /^NO-VERDICT: .*no indexed API/m);
    assertProvenance(r.stdout, [BEFORE]);
});
