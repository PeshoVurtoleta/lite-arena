/**
 * @zakkster/lite-arena -- F2 G3 bench harness B (U7): the --dry-run contract of the L2 lane
 * (bench/f2/scan-density.mjs) and the L4b driver-sink check (bench/f2/inline-indexed/workload.mjs).
 * No timing and no inlining trace is asserted.
 *
 * .handoff/ is gitignored (A11), so nothing here reads it: the L2 green dry-run uses the live
 * Arena.js plus a Uint32Array-column copy built from the live file into a temp dir with the same
 * count-checked replacement as .handoff/evidence/F2/variants/make-variants.mjs (A12: the 3 column
 * lines of ixColumns, each exactly once), and `--model none` (the research model is a bench-script
 * default only). The exit-2 row materializes fe8d7d5 (the pre-F2 build, no indexed API) with
 * `git show`; a missing commit skips that row with the reason.
 *
 * Run: `node --test test/f2-bench-b.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = join(ROOT, 'Arena.js');
const SCAN = join(ROOT, 'bench/f2/scan-density.mjs');
const RUNSH = join(ROOT, 'bench/f2/inline-indexed/run.sh');
const BEFORE_SHA = 'fe8d7d5';

const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
const count = (hay, needle) => hay.split(needle).length - 1;

const TMP = mkdtempSync(join(tmpdir(), 'lite-arena-f2b-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir */ } });
writeFileSync(join(TMP, 'package.json'), '{ "type": "module" }\n');

// ---- u32 control built from the LIVE file (A12: ixColumns' 3 column lines, each exactly once)
const COL = [
    ['w.push(on ? new Int32Array(nw) : null);', 'w.push(on ? new Uint32Array(nw) : null);'],
    ['s1.push(on ? new Int32Array(n1) : null);', 's1.push(on ? new Uint32Array(n1) : null);'],
    ['s2.push(on ? new Int32Array(n2) : null);', 's2.push(on ? new Uint32Array(n2) : null);'],
];
let U32 = null, U32_WHY = '';
{
    const src = readFileSync(LIVE, 'utf8');
    const head = '\nfunction ixColumns(';
    if (count(src, head) !== 1) U32_WHY = 'ixColumns header matches ' + count(src, head) + ' times (need 1)';
    else {
        const a = src.indexOf(head) + 1;
        const b = src.indexOf('\n}\n', a) + 3;
        let body = src.slice(a, b);
        for (const [from, to] of COL) {
            const n = count(body, from);
            if (n !== 1) { U32_WHY = 'ixColumns line `' + from + '` matches ' + n + ' times (need 1)'; break; }
            body = body.replace(from, to);
        }
        if (U32_WHY === '' && count(body, 'new Int32Array(') !== 1) U32_WHY = 'ixColumns should keep exactly the count Int32Array(32)';
        if (U32_WHY === '') {
            U32 = join(TMP, 'u32', 'Arena.js');
            mkdirSync(dirname(U32), { recursive: true });
            writeFileSync(join(TMP, 'u32', 'package.json'), '{ "type": "module" }\n');
            writeFileSync(U32, src.slice(0, a) + body + src.slice(b));
        }
    }
}

// ---- fe8d7d5 materialized once (skip, with the reason, when the object is missing)
let BEFORE = null, BEFORE_WHY = '';
try {
    execFileSync('git', ['cat-file', '-e', BEFORE_SHA + ':Arena.js'], { cwd: ROOT, stdio: 'ignore' });
    const src = execFileSync('git', ['show', BEFORE_SHA + ':Arena.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
    BEFORE = join(TMP, 'Arena.js');
    writeFileSync(BEFORE, src);
} catch (e) {
    BEFORE_WHY = 'git object ' + BEFORE_SHA + ':Arena.js unavailable (' + (e && e.message) + ')';
}

test('u32 control copy builds from the live Arena.js (3 column lines, each exactly once)', () => {
    assert.equal(U32_WHY, '');
    assert.ok(U32 !== null);
});

test('L2 scan-density --dry-run on the live build exits 0 (walk == row scan on final + u32, no ns, no verdict)', () => {
    assert.ok(U32 !== null, U32_WHY);
    const r = run([SCAN, '--dry-run', '--build', LIVE, '--u32', U32, '--model', 'none']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^# provenance$/m);
    assert.match(r.stdout, /^model: skipped$/m);
    for (const b of [LIVE, U32]) assert.ok(r.stdout.includes('  ' + b), 'sha line for ' + b);
    assert.match(r.stdout, /^precondition before timing: walk == row scan \(count \+ FNV\) on final \+ u32 for r0\.0001:\d+ r0\.001:\d+ r0\.01:\d+ r0\.1:\d+ r0\.25:\d+ r0\.5:\d+ odd:\d+ even:\d+$/m);
    assert.match(r.stdout, /^precondition after timing: walk == row scan/m);
    assert.match(r.stdout, /^configs ran: 16 \(2 builds x 8 patterns\)/m);
    assert.match(r.stdout, /^DRY-RUN \(no timing verdict\)$/m);
    assert.doesNotMatch(r.stdout, /ns\/match|^VERDICT /m);
});

test('L2 scan-density --dry-run --build <fe8d7d5> exits 2 (no indexed API)', (t) => {
    if (BEFORE === null) { t.skip(BEFORE_WHY); return; }
    assert.ok(U32 !== null, U32_WHY);
    const r = run([SCAN, '--dry-run', '--build', BEFORE, '--u32', U32, '--model', 'none']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /^NO-VERDICT: final .*no indexed API/m);
});

test('L2 scan-density fails closed (exit 2) when the u32 control is not a Uint32Array-column build', () => {
    const r = run([SCAN, '--dry-run', '--build', LIVE, '--u32', LIVE, '--model', 'none']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /^NO-VERDICT: u32 control columns are not Uint32Array/m);
});

test('L4b workload: sink, checks and >= 10^5 calls per target on the live build (no trace)', async () => {
    const { Arena } = await import(pathToFileURL(LIVE).href);
    const w = await import(pathToFileURL(join(ROOT, 'bench/f2/inline-indexed/workload.mjs')).href);
    const s1 = w.run(Arena);           // throws if a walk / count / hint disagrees with its brute-force scan
    assert.ok(Number.isInteger(s1) && s1 === (s1 | 0), 'sink ' + s1);
    const calls = { ...w.CALLS };
    const s2 = w.run(Arena);
    assert.equal(s2, s1, 'workload sink is deterministic');
    const pub = ['setFlags', 'clearFlags', 'setFlagsHi', 'clearFlagsHi', 'despawn', 'firstFlagged', 'nextFlagged',
        'firstFlaggedHi', 'nextFlaggedHi', 'flagCount', 'flagCountHi', 'joinN'];
    for (const m of pub) assert.ok(calls[m] >= 100000, m + ' calls ' + calls[m]);
});

test('L4b run.sh refuses the live Arena.js as BEFORE (exit 2, before any trace)', (t) => {
    if (process.platform === 'win32') { t.skip('bash script'); return; }
    const r = spawnSync('bash', [RUNSH, LIVE], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /BEFORE is the live Arena\.js/);
});
