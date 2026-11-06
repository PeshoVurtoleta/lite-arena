/**
 * @zakkster/lite-arena -- docs-drift guard.
 *
 * The README and llms.txt drifted three minor versions behind the code once
 * (finding AR-08): a test runner the package had stopped using, a stale test
 * count, an API missing two public methods, and -- the one that mattered -- a
 * safety property the code no longer had. Prose reconciliation fixed it; this
 * guard keeps it fixed, by failing CI the moment the docs and the code disagree
 * again instead of letting the gap age quietly.
 *
 * It asserts three things, all against the SHIPPED surface (no allowlist to
 * maintain, so the guard itself cannot rot):
 *
 *   1. Forward  -- every public method on Arena.prototype / SparseSet.prototype
 *                  is documented as a call in llms.txt (add a method, you must
 *                  document it).
 *   2. Reverse  -- every method call shown in an llms.txt code block is a real
 *                  public method (no hallucinated signature a sibling package
 *                  could copy: llms.txt is what the pipeline reads for this API).
 *   3. Links    -- every relative link in README.md and llms.txt resolves to a
 *                  file in the repo.
 *
 * @license MIT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { Arena, SparseSet } from '../Arena.js';

const ROOT = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');
const llms = read('llms.txt');

// Public = own prototype methods that are not the constructor and not `_`-prefixed
// (the `_`-prefixed ones are internal: _exhausted, _grow, _joinResult, etc.).
function publicMethods(ctor) {
    return Object.getOwnPropertyNames(ctor.prototype).filter(
        (n) => n !== 'constructor' && !n.startsWith('_') && typeof ctor.prototype[n] === 'function');
}

const arenaMethods = publicMethods(Arena);
const sparseMethods = publicMethods(SparseSet);
const allMethods = new Set([...arenaMethods, ...sparseMethods]);

// Every ```fenced``` code block in llms.txt, concatenated.
function fencedBlocks(text) {
    return [...text.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]);
}

test('docs-drift > every public Arena/SparseSet method is documented as a call in llms.txt', () => {
    // Require the method to appear as an actual call `name(` -- not merely as a
    // prose word -- so a common-word method name (has, add, remove) cannot pass
    // on an unrelated sentence.
    for (const meth of [...arenaMethods, ...sparseMethods]) {
        const shownAsCall = new RegExp('\\b' + meth + '\\s*\\(').test(llms);
        assert.ok(shownAsCall,
            `llms.txt does not document public method "${meth}()" -- the API surface is drifting; ` +
            'add it to llms.txt (and README) or the next sibling package will not know it exists.');
    }
});

test('docs-drift > every method call in llms.txt code blocks is a real public method', () => {
    const called = new Set();
    for (const block of fencedBlocks(llms)) {
        for (const m of block.matchAll(/\.([a-zA-Z_]\w*)\s*\(/g)) called.add(m[1]);
    }
    // No allowlist: today every `.method(` in the API examples is a real Arena /
    // SparseSet method. If a legitimate standard-library call (`.map(`, ...) ever
    // appears in an example, add it here explicitly -- deliberately, not silently.
    const ALLOW = new Set([]);
    for (const name of called) {
        if (ALLOW.has(name)) continue;
        assert.ok(allMethods.has(name),
            `llms.txt code block calls ".${name}()", which is not a public Arena/SparseSet method. ` +
            'Either the example is wrong or the method was renamed/removed -- reconcile llms.txt with the code.');
    }
});

test('docs-drift > every relative link in README and llms.txt resolves to a repo file', () => {
    for (const rel of ['README.md', 'llms.txt']) {
        const text = read(rel);
        for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
            let href = m[1].trim().split('#')[0].trim(); // drop any #anchor
            if (!href) continue;                          // pure in-page anchor
            if (/^(https?:|mailto:)/i.test(href)) continue; // external
            assert.ok(existsSync(new URL(href, ROOT)),
                `${rel} links to "${href}", which does not exist in the repo -- fix the path or the link.`);
        }
    }
});

// =====================================================================================
// F2 (indexed flags) doc-claim rows, U10 batch D3. Written FROM PLAN-F2 ASSERTIONS A1-A3, A7 and the
// rulings M-39 / M-52, never from the doc text. Every check is a PURE function of the text(s) it is
// given and returns a list of error strings, so a must-fail CONTROL can feed it a mutated copy of a
// synthesized good document (independent of the live docs, so a control stays meaningful even while
// the live docs are red). Fragments / names below are the spec; the docs must match them.
// =====================================================================================

const readme = read('README.md');
const dts = read('Arena.d.ts');

// ---- A1: the 8 F2 names + RegisterFlagsOptions + driverFlag fields -------------------
const F2_NAMES = ['flagCount', 'flagCountHi', 'firstFlagged', 'firstFlaggedHi',
    'nextFlagged', 'nextFlaggedHi', 'clearFlagAll', 'clearFlagAllHi'];
const callRe = (n) => new RegExp('(?:^|[^\\w$])' + n + '\\(');

// docs = { 'Arena.d.ts': text, 'README.md': text, 'llms.txt': text }
function checkA1(docs) {
    const errs = [];
    for (const [file, text] of Object.entries(docs)) {
        for (const n of F2_NAMES) if (!callRe(n).test(text)) errs.push(`${file}: missing "${n}("`);
    }
    const d = docs['Arena.d.ts'];
    if (!/registerFlags\([^)]*RegisterFlagsOptions/.test(d)) errs.push('Arena.d.ts: registerFlags( lacks RegisterFlagsOptions');
    if (!/registerFlagsHi\([^)]*RegisterFlagsOptions/.test(d)) errs.push('Arena.d.ts: registerFlagsHi( lacks RegisterFlagsOptions');
    const m = /interface\s+JoinNPlan\s*\{([\s\S]*?)\n\}/.exec(d);
    if (!m) errs.push('Arena.d.ts: no interface JoinNPlan block');
    else {
        if (!/\bdriverFlag\s*:\s*number\b/.test(m[1])) errs.push('JoinNPlan: missing "driverFlag: number"');
        if (!/\bdriverFlagCount\s*:\s*number\b/.test(m[1])) errs.push('JoinNPlan: missing "driverFlagCount: number"');
    }
    return errs;
}

// ---- A2: exact runtime message fragments, also in .d.ts and README --------------------
const A2_FRAGMENTS = [
    'options accept only "indexed"',
    'options.indexed must be an array of flag names',
    'is not one of the names, or a duplicate',
    'with { indexed: [...] } first',
    'needs exactly one indexed flag bit',
];
function checkA2(docs) {
    const errs = [];
    for (const file of ['Arena.d.ts', 'README.md']) {
        for (const f of A2_FRAGMENTS) if (!docs[file].includes(f)) errs.push(`${file}: missing message fragment ${JSON.stringify(f)}`);
    }
    return errs;
}

// ---- A3: banned stale phrasing --------------------------------------------------------
const A3_BANNED = ['any options key', 'Record<string, never>', 'NO own keys', 'takes no options',
    'sketch, not an API', 'caller-owned recipe'];
function checkA3(docs) {
    const errs = [];
    for (const [file, text] of Object.entries(docs)) {
        for (const p of A3_BANNED) if (text.toLowerCase().includes(p.toLowerCase())) errs.push(`${file}: stale phrase ${JSON.stringify(p)}`);
    }
    return errs;
}

// ---- M-52: the walk passes only a handle firstFlagged / nextFlagged returned ----------
// FRAGMENT (after stripping backticks / asterisks and collapsing whitespace, case-insensitive):
//   "only a handle that firstFlagged / nextFlagged returned"   ("that" and "Hi" optional; "/" may be "or"/"and")
const M52_RE = /only a handle (?:that )?firstflagged(?:hi)? ?(?:\/|or|and) ?nextflagged(?:hi)? returned/i;
const flat = (s) => s.replace(/[`*]/g, '').replace(/\s+/g, ' ');
function checkM52(docs) {
    const errs = [];
    for (const [file, text] of Object.entries(docs)) {
        if (!M52_RE.test(flat(text))) errs.push(`${file}: no "only a handle (that) firstFlagged / nextFlagged returned"`);
    }
    return errs;
}

// ---- A7 (doc-text parts) --------------------------------------------------------------
// README Phase N text says "zero major and zero minor GC" (RULES_N maxMajor 0 / maxMinor 0).
function checkA7Readme(text) {
    const t = flat(text);
    const errs = [];
    let ok = false, seen = false;
    for (let i = t.indexOf('Phase N'); i !== -1; i = t.indexOf('Phase N', i + 1)) {
        seen = true;
        if (t.slice(i, i + 700).includes('zero major and zero minor GC')) { ok = true; break; }
    }
    if (!seen) errs.push('README: no "Phase N"');
    else if (!ok) errs.push('README: Phase N text lacks "zero major and zero minor GC"');
    return errs;
}

// ADR 0011 pin table == the pins in test/bytecode-budget.test.js (source text parsed, not imported).
// The 14 IX_PINS and joinN (the one HEAD pin F2 changed, 420 -> 435) must each appear on a line naming the
// function with the exact number as a whole token. (Other HEAD pins are not required in the ADR table.)
function parsePins(src, table) {
    const m = new RegExp('const ' + table + ' = \\{([\\s\\S]*?)\\};').exec(src);
    const out = {};
    if (m) for (const e of m[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) out[e[1]] = Number(e[2]);
    return out;
}
function checkA7Adr(adr, pins) {
    const errs = [];
    const lines = adr.split('\n');
    for (const [fn, n] of Object.entries(pins)) {
        const nameRe = new RegExp('(?:^|[^\\w$])' + fn + '(?:$|[^\\w$])');
        const numRe = new RegExp('(?:^|[^\\d.,])' + n + '(?:$|[^\\d.,])');
        if (!lines.some((l) => nameRe.test(l) && numRe.test(l))) errs.push(`ADR 0011: no line with ${fn} and pin ${n}`);
    }
    if (Object.keys(pins).length < 15) errs.push('parsePins found fewer than 15 pins (parser drift)');
    return errs;
}

// Added lines (a unified diff) must carry 0 non-ASCII chars except U+00D7 and U+00B5.
function checkAddedAscii(diff) {
    const errs = [];
    for (const l of diff.split('\n')) {
        if (!l.startsWith('+') || l.startsWith('+++')) continue;
        for (const ch of l) if (ch.codePointAt(0) > 127 && ch !== '\u00D7' && ch !== '\u00B5') {
            errs.push(`non-ASCII U+${ch.codePointAt(0).toString(16).toUpperCase()} in added line: ${l.slice(0, 60)}`);
            break;
        }
    }
    return errs;
}

const liveDocs3 = { 'Arena.d.ts': dts, 'README.md': readme, 'llms.txt': llms };

test('F2 docs > A1: 8 new names shown as name( in .d.ts / README / llms; RegisterFlagsOptions; JoinNPlan driverFlag fields', () => {
    for (const n of F2_NAMES) assert.equal(typeof Arena.prototype[n], 'function', n + ' is a prototype function');
    assert.deepEqual(checkA1(liveDocs3), []);
});

test('F2 docs > A2: runtime message fragments are real and appear in .d.ts and README', () => {
    // The fragments are triggered at runtime (so they cannot drift from the code), then checked in the docs.
    const thrown = [];
    const grab = (fn) => { try { fn(); } catch (e) { thrown.push(e.message); } };
    grab(() => new Arena(8).registerFlags(['a'], { k: 1 }));
    grab(() => new Arena(8).registerFlags(['a'], { indexed: 'a' }));
    grab(() => new Arena(8).registerFlags(['a'], { indexed: ['zz'] }));
    grab(() => new Arena(8).flagCount(1));
    grab(() => { const a = new Arena(8); a.registerFlags(['a', 'b'], { indexed: ['a'] }); a.flagCount(3); });
    assert.equal(thrown.length, 5);
    A2_FRAGMENTS.forEach((f, i) => assert.ok(thrown[i].includes(f), `runtime message ${i} lacks ${JSON.stringify(f)}: ${thrown[i]}`));
    assert.deepEqual(checkA2(liveDocs3), []);
});

test('F2 docs > A3: no stale "no options" phrasing in README / llms.txt / Arena.d.ts', () => {
    assert.deepEqual(checkA3(liveDocs3), []);
});

test('F2 docs > M-52: README and llms.txt state the walk passes only a handle firstFlagged / nextFlagged returned', () => {
    assert.deepEqual(checkM52({ 'README.md': readme, 'llms.txt': llms }), []);
});

test('F2 docs > A7: README Phase N says "zero major and zero minor GC"', () => {
    assert.deepEqual(checkA7Readme(readme), []);
});

test('F2 docs > A7: ADR 0011 pin table == pins in test/bytecode-budget.test.js (14 ix pins + joinN)', () => {
    const src = read('test/bytecode-budget.test.js');
    const ix = parsePins(src, 'IX_PINS');
    const base = parsePins(src, 'PINS');
    assert.equal(Object.keys(ix).length, 14);
    assert.equal(base.joinN, 435);
    assert.ok(existsSync(new URL('decisions/0011-indexed-flags.md', ROOT)), 'decisions/0011-indexed-flags.md exists');
    const adr = read('decisions/0011-indexed-flags.md');
    assert.deepEqual(checkA7Adr(adr, { ...ix, joinN: base.joinN }), []);
});

// Per-file non-ASCII CEILINGS (U+00D7 and U+00B5 excepted): the docs may not gain non-ASCII chars.
// Ceilings are the measured counts after the F2 docs edits (README/llms/d.ts carry pre-F2 legacy chars).
const A7_CEIL = { 'README.md': 88, 'llms.txt': 4, 'Arena.d.ts': 2, 'CHANGELOG.md': 0,
    'decisions/0010-flags.md': 0, 'decisions/0011-indexed-flags.md': 0 };
function checkAsciiCeiling(name, text, ceiling) {
    let n = 0;
    for (const ch of text) if (ch.codePointAt(0) > 127 && ch !== '\u00D7' && ch !== '\u00B5') n++;
    return n > ceiling ? [`${name}: ${n} non-ASCII chars exceed ceiling ${ceiling}`] : [];
}
test('F2 docs > A7: non-ASCII char counts stay within the per-file ceilings', () => {
    for (const [name, ceil] of Object.entries(A7_CEIL)) assert.deepEqual(checkAsciiCeiling(name, read(name), ceil), []);
});

// ---- must-fail controls: a synthesized GOOD document passes, one mutation reports >= 1 error ----
const goodDts = F2_NAMES.map((n) => `    ${n}(flag: number): number;`).join('\n') +
    '\n    registerFlags(names?: readonly string[], options?: RegisterFlagsOptions | null): X;' +
    '\n    registerFlagsHi(names?: readonly string[], options?: RegisterFlagsOptions | null): X;' +
    '\nexport interface JoinNPlan {\n    driverFlag: number;\n    driverFlagCount: number;\n}\n' +
    A2_FRAGMENTS.join('\n') + '\n';
const goodMd = F2_NAMES.map((n) => `${n}(F.a)`).join('\n') + '\n' + A2_FRAGMENTS.join('\n') +
    '\nThe walk passes only a handle that `firstFlagged` / `nextFlagged` returned.\n' +
    'Phase N: 200,000 calls at zero major and zero minor GC.\n';
const goodDocs = () => ({ 'Arena.d.ts': goodDts, 'README.md': goodMd, 'llms.txt': goodMd });

test('F2 docs control > the synthesized good docs pass every check', () => {
    const d = goodDocs();
    assert.deepEqual([...checkA1(d), ...checkA2(d), ...checkA3(d), ...checkM52({ a: goodMd, b: goodMd }), ...checkA7Readme(goodMd)], []);
});

test('F2 docs control > A1: removing flagCount( from the .d.ts reports exactly 1 error', () => {
    const d = goodDocs();
    d['Arena.d.ts'] = d['Arena.d.ts'].replace('    flagCount(flag: number): number;\n', '');
    assert.equal(checkA1(d).length, 1);
});
test('F2 docs control > A1: dropping RegisterFlagsOptions or driverFlagCount reports errors', () => {
    let d = goodDocs();
    d['Arena.d.ts'] = d['Arena.d.ts'].replace('RegisterFlagsOptions', 'Record<string, never>');
    assert.ok(checkA1(d).length >= 1);
    d = goodDocs();
    d['Arena.d.ts'] = d['Arena.d.ts'].replace('driverFlagCount: number', 'driverFlagCount: string');
    assert.ok(checkA1(d).length >= 1);
});
test('F2 docs control > A2: a missing message fragment in README reports >= 1 error', () => {
    const d = goodDocs();
    d['README.md'] = d['README.md'].replace('needs exactly one indexed flag bit', 'needs one bit');
    assert.ok(checkA2(d).length >= 1);
});
test('F2 docs control > A3: each banned phrase injected into each file reports >= 1 error', () => {
    for (const file of Object.keys(goodDocs())) for (const p of A3_BANNED) {
        const d = goodDocs();
        d[file] += '\n' + p + '\n';
        assert.ok(checkA3(d).length >= 1, file + ' / ' + p);
    }
});
test('F2 docs control > M-52: removing the walk-handle sentence from llms.txt reports >= 1 error', () => {
    assert.ok(checkM52({ 'README.md': goodMd, 'llms.txt': goodMd.replace('only a handle', 'any handle') }).length >= 1);
});
test('F2 docs control > A7: Phase N without the zero-GC wording, an ADR pin off by one, a non-ASCII added line', () => {
    assert.ok(checkA7Readme(goodMd.replace('zero major and zero minor GC', 'zero major GC')).length >= 1);
    const pins = { joinN: 435, ixSetFlags: 178 };
    const adr = '| joinN | 435 |\n| ixSetFlags | 178 |\n';
    assert.ok(checkA7Adr(adr, pins).some((e) => e.startsWith('ADR')) === false);
    assert.ok(checkA7Adr(adr.replace('178', '179'), pins).some((e) => e.startsWith('ADR')));
    assert.ok(checkAsciiCeiling('README.md', readme + '\u2014', A7_CEIL['README.md']).length === 1); // control
    assert.ok(checkAddedAscii('+ plain\n+ dash \u2014 here\n').length === 1);
    assert.equal(checkAddedAscii('+ times \u00D7 micro \u00B5\n- old \u2014\n+++ b/x\n').length, 0);
});
