/**
 * @zakkster/lite-arena -- second flag word (M-26) parity pins (PLAN-F1 A4).
 * MUST PASS on the 1.10.0 build AND on the F1 build: nothing the Hi word adds may
 * move one word-0 / no-mask observable.
 *
 *  (1) test/golden/joinN-mask.json (600 word-0-masked joinN records + 43 error
 *      rows, cut from the frozen 2c7af47 / e53d0573 build by .handoff/evidence/
 *      F1-cut.mjs, which never imports the live Arena.js): every data record and
 *      every error row byte-for-byte; for rows labelled 'v8:' (engine TypeError
 *      wording) only the constructor name.
 *  (2) the 1,200-record no-mask golden is gated 1:1 by test/joinN-parity.test.js;
 *      here only a single whole-array cross-check.
 *  (3) toString sha256 of the 11 hot methods the Hi word must leave byte-identical
 *      (hard-coded; cut from the frozen build, F1-baseline.txt (a)).
 * Bytecode twins are covered by test/bytecode-budget.test.js, not here.
 *
 * Run: `node --test test/flags-hi-parity.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/flags-hi-parity.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { run as runMask } from './golden/joinN-mask-workload.mjs';
import { run as runNoMask } from './golden/joinN-workload.mjs';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena, SparseSet } = mod;

const golden = JSON.parse(readFileSync(new URL('./golden/joinN-mask.json', import.meta.url), 'utf8'));
const goldenNo = JSON.parse(readFileSync(new URL('./golden/joinN-nomask.json', import.meta.url), 'utf8'));

test('A4 golden is the expected 2c7af47 word-0-masked cut', () => {
    assert.equal(golden.sha, 'e53d0573');
    assert.equal(golden.cutFrom, '2c7af47');
    assert.equal(golden.records, 600);
    assert.equal(golden.data.length, 600);
    assert.equal(golden.errors.length, 43);
    assert.equal(golden.flagMap.length, 32);
});

test('A4 every word-0-masked joinN record equals the golden', () => {
    const out = runMask(Arena);
    assert.equal(out.records.length, golden.data.length);
    for (let i = 0; i < golden.data.length; i++) {
        assert.deepEqual(out.records[i], golden.data[i], 'record #' + i);
    }
    assert.deepEqual(out.flagMap, golden.flagMap);
});

test('A4 every error row is byte-identical (v8: rows by constructor name only)', () => {
    const out = runMask(Arena);
    assert.equal(out.errors.length, golden.errors.length);
    for (let i = 0; i < golden.errors.length; i++) {
        const g = golden.errors[i], o = out.errors[i];
        assert.equal(o[0], g[0], 'label #' + i);
        if (g[0].startsWith('v8:')) {
            assert.equal(o[1], g[1], 'ctor ' + g[0]);
        } else {
            assert.deepEqual(o, g, 'row ' + g[0]);
        }
    }
});

test('A4 no-mask golden cross-check (full record gate: test/joinN-parity.test.js)', () => {
    const out = runNoMask(Arena);
    assert.equal(out.records.length, 1200);
    assert.equal(JSON.stringify(out.records), JSON.stringify(goldenNo.records));
    assert.equal(out.errNull, goldenNo.errNull);
    assert.equal(out.errEmpty, goldenNo.errEmpty);
});

// sha256 of Function.prototype.toString, cut from the frozen 1.10.0 build
// (.handoff/evidence/F1-baseline.txt (a)).
const SHA = [
    ['Arena', 'spawn', '9e59359a266fa0dc33fa4532b6a3c745f6ecd524f4dd094a2ed471427ca87916'],
    ['Arena', 'isAlive', '89c0703573d5870fe948eceaaf4ebc8af97f427973b7805df9476895a01668fc'],
    ['Arena', 'setFlags', '71c32d5b84c363f81d554768e1f7ecf4cac4a7615f82e31cadd031bb9ecb3474'],
    ['Arena', 'clearFlags', 'd943bbcebca6847c276b52d03b9c24e8e2fff42bd0b895db856e04694e8b1a98'],
    ['Arena', 'hasFlags', '500a974d092591dc668ce2f27910b2852e787518638661aaebfada0af841c4a2'],
    ['Arena', 'join', '9f7c41254fec0dc6fe23827f21ebdf8de352b3897d76c223adf803d37e4bcc30'],
    ['Arena', 'registerTag', '266dbf8aa7c401b0cdea0c533d0a8d6035db59cadcac5fa64cb204ac210d66dc'],
    ['SparseSet', 'add', '6ba34630a15ed362828be9ca51398f905f10677d409835f576f600b88de15345'],
    ['SparseSet', 'has', '78cf22f0d38a5a51e3f24dc4afd1e2dbbdd4b8bef4621fbc62752b821db1111f'],
    ['SparseSet', 'remove', 'ece59d46fea2eed737e6ac76cae425210894626422efa9875bd2cae22ca31556'],
    ['SparseSet', 'idx', 'f1bd7441aa1dc84703dbb2bdb598ae7de7d82dd53c74a29ea61d377d5ca354dc'],
];

for (const [cls, name, sha] of SHA) {
    test(`A4 toString sha256 pin: ${cls}.prototype.${name} is byte-identical to 1.10.0`, () => {
        const proto = cls === 'Arena' ? Arena.prototype : SparseSet.prototype;
        const text = proto[name].toString();
        assert.equal(createHash('sha256').update(text).digest('hex'), sha);
    });
}

test('A4 SparseSet is the registerTag() prototype (the pins cover the real class)', () => {
    assert.equal(Object.getPrototypeOf(new Arena(4).registerTag()), SparseSet.prototype);
});

// NIT: the golden's coverage is pinned (hard-coded from the 2c7af47 cut header) and recomputed
// from the run on the build under test, so a recut cannot silently lower coverage.
// Definitions follow .handoff/evidence/F1-cut.mjs: masked = reqMask|excMask != 0,
// bit31 = (reqMask|excMask) has bit 31, emptyByMask = reqMask & excMask != 0.
test('A4 golden coverage counts are pinned and match the run on the build under test', () => {
    const want = { masked: 507, bit31: 276, emptyByMask: 91 };
    const t = golden.provenance.totals;
    assert.equal(t.masked, want.masked);
    assert.equal(t.bit31, want.bit31);
    assert.equal(t.emptyByMask, want.emptyByMask);
    const got = { masked: 0, bit31: 0, emptyByMask: 0 };
    for (const r of runMask(Arena).records) {
        if ((r[2] | r[3]) !== 0) got.masked++;
        if (((r[2] | r[3]) & 0x80000000) !== 0) got.bit31++;
        if ((r[2] & r[3]) !== 0) got.emptyByMask++;
    }
    assert.deepEqual(got, want);
});
