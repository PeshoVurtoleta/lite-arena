/**
 * @zakkster/lite-arena -- F2 non-indexed parity (PLAN-F2 TASK T1 / A7).
 * MUST PASS on the 1.11.0 build AND on every F2 build: indexed flags must not move one
 * observable of an arena that never asked for them (plain and checked, word 0 and Hi).
 *
 *  (1) test/golden/f2-plain.json: 2,000 records (ops bursts, joinN plans read by an explicit
 *      1.11.0 field list, checked throws, registerFlags / registerFlagsHi option and name
 *      errors minus the M-40 unknown-key family), each ending in an FNV-1a-32, cut from the
 *      frozen fe8d7d5 / 08e04bab build by .handoff/evidence/F2/f2-cut.mjs, which never imports
 *      the live Arena.js. Every record must deepEqual the golden.
 *  (2) MUST-FAIL: the fe8d7d5 source, read from git history (`git show fe8d7d5:Arena.js`, sha256
 *      08e04bab... asserted; no dependency on the gitignored .handoff/ freeze), is written into an
 *      os.tmpdir() dir twice: unpatched (Base.js, must reproduce the golden) and with ONE
 *      count-checked patch (setFlags ORs `m & ~1`; despawn keeps the Hi row), which must produce
 *      a different record stream.
 *
 * Run: `node --test test/flags-f2-parity.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/flags-f2-parity.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './golden/f2-plain-workload.mjs';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');

const golden = JSON.parse(readFileSync(new URL('./golden/f2-plain.json', import.meta.url), 'utf8'));
const FROZEN_SHA256 = '08e04babdc1abb5054273e807983c6bcb960b0b4469a0a90cb3756fac2028cae';

function fnvStr(h, s) {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h = Math.imul(h ^ (c & 0xFF), 16777619);
        h = Math.imul(h ^ (c >>> 8), 16777619);
    }
    return h;
}

// The first record index where `records` departs from the golden, or -1.
function firstDiff(records) {
    const n = Math.max(records.length, golden.data.length);
    for (let i = 0; i < n; i++) {
        if (JSON.stringify(records[i]) !== JSON.stringify(golden.data[i])) return i;
    }
    return -1;
}

test('A7 golden is the expected fe8d7d5 / 08e04bab cut', () => {
    assert.equal(golden.cutFrom, 'fe8d7d5');
    assert.equal(golden.sha, '08e04bab');
    assert.equal(golden.provenance.sha256, FROZEN_SHA256);
    assert.equal(golden.provenance.node, 'v26.8.2');
    assert.equal(golden.records, 2000);
    assert.equal(golden.data.length, 2000);
    assert.equal(fnvStr(0x811C9DC5 | 0, JSON.stringify(golden.data)) >>> 0, golden.provenance.recordsFnv1a32);
});

test('A7 the golden has teeth and holds no M-40 (unknown options key) row', () => {
    // Pinned from the fe8d7d5 cut, so a recut cannot silently lower coverage.
    const t = golden.provenance.totals;
    assert.deepEqual(t, {
        ops: 1416, plan: 413, planT: 55, err: 116, errThrow: 88, opThrows: 423,
        matched: 5163, bit31Plans: 74, hiMaskedPlans: 154,
    });
    for (const r of golden.data) {
        const tail = r[r.length - 1];
        assert.ok(Number.isInteger(tail) && tail >= 0 && tail <= 0xFFFFFFFF, 'fnv1a32 tail ' + JSON.stringify(r));
        if (r[0] === 'err') assert.ok(!r[4].includes('takes no options'), 'M-40 row ' + r[2]);
    }
});

test('A7 every one of the 2,000 records equals the golden (non-indexed arenas)', () => {
    const out = run(mod.Arena);
    assert.equal(out.records.length, golden.data.length);
    assert.equal(out.errorRows, golden.provenance.totals.err);
    for (let i = 0; i < golden.data.length; i++) {
        assert.deepEqual(out.records[i], golden.data[i], 'record #' + i);
    }
});

// Each row: ONE patch of the frozen build (anchor must match exactly once, else the row is invalid).
const MUTANTS = [
    ['setFlags ORs mask & ~1', '        this.flags[entity & INDEX_MASK] |= m;\n',
        '        this.flags[entity & INDEX_MASK] |= m & ~1;\n'],
    ['despawn keeps the Hi row', '            if (this.flagsHi !== null) this.flagsHi[index] = 0;\n', ''],
];

for (const [name, from, to] of MUTANTS) {
    test(`A7 MUST FAIL: the workload detects the mutant "${name}" of the frozen build`, async () => {
        const src = execFileSync('git', ['show', 'fe8d7d5:Arena.js'],
            { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
        assert.equal(createHash('sha256').update(src).digest('hex'), FROZEN_SHA256, 'frozen build sha256');
        const n = src.split(from).length - 1;
        assert.equal(n, 1, `anchor must match exactly once, matched ${n}`);
        const dir = mkdtempSync(join(tmpdir(), 'arena-f2-parity-'));
        try {
            const p = join(dir, 'Arena.js');
            writeFileSync(p, src.replace(from, () => to));
            const m = await import(pathToFileURL(p).href);
            // The unpatched frozen build reproduces the golden (the control for this row).
            const bp = join(dir, 'Base.js');
            writeFileSync(bp, src);
            const base = await import(pathToFileURL(bp).href);
            assert.equal(firstDiff(run(base.Arena).records), -1, 'frozen build must reproduce the golden');
            const at = firstDiff(run(m.Arena).records);
            assert.notEqual(at, -1, `mutant "${name}" survived all 2,000 records`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
}
