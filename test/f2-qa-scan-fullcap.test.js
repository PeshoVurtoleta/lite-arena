/**
 * @zakkster/lite-arena -- F2 U8 qa: G3-A5 at FULL capacity (PLAN-F2-G3 A5, the DETERMINISTIC part).
 * test/f2-bench-b.test.js gates `scan-density --dry-run` at its dry-run capacity 4095 only; at 4095 the
 * S2 summary has ONE word, so a walk that never leaves S2 word 0 still equals the row scan there. This
 * row runs the same precondition at capacity 1048575 (2^20 - 1, 32 S2 words) on the build under test and
 * its u32 control (built from that build into a tmpdir; no .handoff reads, so the research model is
 * not run here -- the model lane stays REPORTED evidence).
 *
 * Run: `node --test test/f2-qa-scan-fullcap.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/f2-qa-scan-fullcap.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = process.env.LITE_ARENA_PATH ? resolve(process.env.LITE_ARENA_PATH) : join(ROOT, 'Arena.js');
const SCAN = join(ROOT, 'bench/f2/scan-density.mjs');
const count = (hay, needle) => hay.split(needle).length - 1;

const TMP = mkdtempSync(join(tmpdir(), 'lite-arena-f2qa-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir */ } });

// u32 control from the build under test: ixColumns' 3 column lines, each exactly once (PLAN-F2 A12).
function u32Of(path) {
    const src = readFileSync(path, 'utf8');
    const head = '\nfunction ixColumns(';
    assert.equal(count(src, head), 1, 'ixColumns header');
    const a = src.indexOf(head) + 1;
    const b = src.indexOf('\n}\n', a) + 3;
    let body = src.slice(a, b);
    for (const v of ['nw', 'n1', 'n2']) {
        const from = '.push(on ? new Int32Array(' + v + ') : null);';
        assert.equal(count(body, from), 1, 'ixColumns ' + v + ' line');
        body = body.replace(from, '.push(on ? new Uint32Array(' + v + ') : null);');
    }
    const out = join(TMP, 'u32', 'Arena.js');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(join(TMP, 'u32', 'package.json'), '{ "type": "module" }\n');
    writeFileSync(out, src.slice(0, a) + body + src.slice(b));
    return out;
}

test('G3-A5 full cap: scan-density --dry-run --cap 1048575 -> walk == row scan on final + u32, 8 patterns', (t) => {
    t.diagnostic('build ' + BUILD);
    const U32 = u32Of(BUILD);
    const r = spawnSync(process.execPath,
        [SCAN, '--dry-run', '--cap', '1048575', '--build', BUILD, '--u32', U32, '--model', 'none'],
        { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^capacity: 1048575 /m);
    assert.match(r.stdout, /^model: skipped$/m);
    const m = r.stdout.match(/^precondition before timing: walk == row scan \(count \+ FNV\) on final \+ u32 for (.+)$/m);
    assert.ok(m, 'precondition line\n' + r.stdout);
    const pats = Object.fromEntries(m[1].split(' ').map((kv) => kv.split(':')).map(([k, v]) => [k, +v]));
    assert.deepEqual(Object.keys(pats), ['r0.0001', 'r0.001', 'r0.01', 'r0.1', 'r0.25', 'r0.5', 'odd', 'even']);
    // the harness's own pick counts at 2^20 - 1 slots: odd / even are exact, the densities are ~p x cap
    assert.equal(pats.odd, 524287);
    assert.equal(pats.even, 524288);
    for (const [k, p] of [['r0.001', 0.001], ['r0.01', 0.01], ['r0.1', 0.1], ['r0.25', 0.25], ['r0.5', 0.5]]) {
        assert.ok(Math.abs(pats[k] - p * 1048575) < 0.1 * p * 1048575 + 50, k + ' = ' + pats[k]);
    }
    assert.match(r.stdout, /^precondition after timing: walk == row scan/m);
    assert.match(r.stdout, /^configs ran: 16 \(2 builds x 8 patterns\)/m);
    assert.match(r.stdout, /^DRY-RUN \(no timing verdict\)$/m);
    assert.doesNotMatch(r.stdout, /ns\/match|^VERDICT /m);
});
