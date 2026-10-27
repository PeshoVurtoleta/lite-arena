/**
 * @zakkster/lite-arena -- SparseSet.remove() GC budget + retention (Group E,
 * PLAN-E A1 + A4). Spawns test/remove-alloc-probe.mjs with --trace-gc and a
 * 1 MB semi-space (the probe exits 2 without those flags), then COUNTS the
 * `Scavenge` lines between each lane's start/end markers (500,000 ops per lane).
 * A count is robust where a byte meter is not: a profiler reads 0 B/op when a
 * scavenge lands in its window, which hid a ~310 B/op mutant.
 *
 * A1: oneCol / fourCol / tag <= noop + 1 scavenges; the must-fail `box` lane
 *   (one {a: i} per op) >= 15, proving the counter sees allocation. The sixKind
 *   lane (6 TypedArray kinds, decision M-19) is REPORTED, never asserted.
 * A4: column refs held by the set do not retain replaced columns: after
 *   reserve / transfer / rebind on 64 live sets, tracker.size() is 0, and 0 again
 *   once the arenas are dropped. A4r: reserve-only cycles (no rebind) release
 *   the pre-growth columns and a later swapping remove moves the payload in the
 *   NEW columns (catches a _grow that forgets to re-sync the column cache).
 *
 * Run: `node --test test/remove-alloc.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/remove-alloc.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const probe = fileURLToPath(new URL('./remove-alloc-probe.mjs', import.meta.url));
const run = spawnSync(process.execPath, [
    '--expose-gc', '--trace-gc', '--min-semi-space-size=1', '--max-semi-space-size=1', probe,
], {
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 64 * 1024 * 1024,
});

const counts = {};
let r = null;
if (run.status === 0) {
    let lane = null;
    const lines = run.stdout.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (ln.startsWith('LANE-START ')) { lane = ln.slice(11).trim(); counts[lane] = 0; }
        else if (ln.startsWith('LANE-END ')) lane = null;
        else if (lane !== null && ln.includes('Scavenge')) counts[lane]++;
        else if (ln.startsWith('{')) r = JSON.parse(ln);
    }
}

test('probe ran (exit 0)', (t) => {
    assert.equal(run.status, 0, run.stderr);
    t.diagnostic('scavenges per 500k ops: ' + JSON.stringify(counts));
});

// Gates are relative to the noop control; "+ 1" absorbs one stray scavenge.
test('A1: swapping remove does not allocate (1-col)', () => {
    assert.ok(counts.oneCol <= counts.noop + 1, 'oneCol ' + counts.oneCol + ' noop ' + counts.noop);
});
test('A1: swapping remove does not allocate (4-col)', () => {
    assert.ok(counts.fourCol <= counts.noop + 1, 'fourCol ' + counts.fourCol + ' noop ' + counts.noop);
});
test('A1: swapping remove does not allocate (tag)', () => {
    assert.ok(counts.tag <= counts.noop + 1, 'tag ' + counts.tag + ' noop ' + counts.noop);
});
test('A1: must-fail lane (one object per op) is seen by the counter', () => {
    assert.ok(counts.box >= 15, 'box ' + counts.box);
});
// REPORTED only (M-19): never asserted.
test('A1 (reported): six TypedArray kinds', (t) => {
    t.diagnostic('sixKind scavenges = ' + counts.sixKind + ' (noop ' + counts.noop + ')');
    console.log('REPORTED sixKind scavenges per 500k ops: ' + counts.sixKind + ' (noop ' + counts.noop + ')');
});

// A4 is a regression pin (passes on before-E, which holds no column cache).
test('A4: replaced/detached columns are not retained (64 live sets)', () => {
    assert.equal(r.a4AliveSets, 64);
    assert.equal(r.a4Alive, 0);
});
test('A4: nothing tracked after the arenas are dropped', () => {
    assert.equal(r.a4Dropped, 0);
});
test('A4r: reserve-only cycle releases pre-growth columns and swaps in the new ones', () => {
    assert.equal(r.a4rSets, 64);
    assert.equal(r.a4rBad, 0);
    assert.equal(r.a4rAlive, 0);
});
