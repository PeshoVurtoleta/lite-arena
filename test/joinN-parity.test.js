/**
 * @zakkster/lite-arena -- joinN() no-mask parity (Group D2, TASK 8 / A8).
 *
 * Adding flag masks to joinN must not move one unmasked observable. The golden
 * test/golden/joinN-nomask.json was cut from the PRE-PROGRAM build (ce3f63c,
 * sha256 5428e778...) by .handoff/evidence/D2-cut.mjs, which never imports the
 * live Arena.js. Every record (driver position incl. forced T1/T2 ties, count,
 * others / excl positions, match count, FNV-1a-32 of the matched handles) and
 * both "required" error strings must equal the golden.
 *
 * Run: `node --test test/joinN-parity.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/joinN-parity.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { run } from './golden/joinN-workload.mjs';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');

const golden = JSON.parse(readFileSync(new URL('./golden/joinN-nomask.json', import.meta.url), 'utf8'));

test('joinN parity: golden is the expected pre-program cut', () => {
    assert.equal(golden.provenance.sha256.slice(0, 8), '5428e778');
    assert.equal(golden.records.length, 1200);
    assert.equal(golden.provenance.records, 1200);
});

test('joinN parity: every record equals the ce3f63c golden', () => {
    const out = run(mod.Arena);
    assert.equal(out.records.length, golden.records.length);
    for (let i = 0; i < golden.records.length; i++) {
        assert.deepEqual(out.records[i], golden.records[i], 'record #' + i);
    }
});

test('joinN parity: both required-set error strings are byte-identical', () => {
    const out = run(mod.Arena);
    assert.equal(out.errNull, golden.errNull);
    assert.equal(out.errEmpty, golden.errEmpty);
});

test('joinN parity: the workload has teeth (ties, repeats, matches)', () => {
    let ties = 0, matched = 0, repeat = 0;
    for (const r of golden.records) {
        matched += r[6];
        if (r[1] === 3 && r[3] > 0) ties++;
        if (r[1] === 1 && r[4].length === 2) repeat++;
    }
    assert.ok(ties >= 50, 'non-empty T1/T2 tie snapshots ' + ties);
    assert.ok(repeat >= 50, '[C,C,A] snapshots keeping the repeat in others ' + repeat);
    assert.ok(matched >= 1000, 'total matches ' + matched);
});
