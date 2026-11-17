/**
 * @zakkster/lite-arena -- docs tier-marker drift row (M-64).
 *
 * LEDGER law 7: every claim has one verification tier. #30 outcome: a docs-drift
 * row requires a tier marker next to every ms / x figure. This test reads only
 * README.md and llms.txt (no git, no .handoff, no timing).
 *
 * FIGURE: a number directly followed by a time unit (ms ns us \u00b5s) or a ratio
 *   sign (x or \u00d7, no space before it, not followed by a letter / digit).
 * MARK:   REPORTED | NOMINAL | illustrative | PRELIMINARY | DETERMINISTIC |
 *   derived | arithmetic (case-insensitive, word boundary) in the figure's SCOPE.
 * SCOPE:  its blank-line-delimited block (heading line = own block; fenced block
 *   = one block; each list item, incl. its continuation lines, is its own block),
 *   plus the nearest preceding non-blank block when the figure's block is a table
 *   or a fenced block (the caption).
 * BANNED: per-line match (M-72); a phrase hard-wrapped across two lines is not seen (FILLER 53).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const TIME_RE = /(\d[\d,]*(?:\.\d+)?)\s?(ms|ns|us|\u00b5s)\b/g;
const RATIO_RE = /\d[\d,]*(?:\.\d+)?(?:x|\u00d7)(?![A-Za-z0-9])/g;
const MARK_RE = /\b(REPORTED|NOMINAL|illustrative|PRELIMINARY|DETERMINISTIC|derived|arithmetic)\b/i;

/** Split text into blocks: { start (1-based line), lines[], kind }. */
export function splitBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let cur = null;
  let inFence = false;
  const flush = () => { if (cur) { blocks.push(cur); cur = null; } };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const isFence = /^\s*(```|~~~)/.test(ln);
    if (inFence) {
      cur.lines.push(ln);
      if (isFence) { inFence = false; flush(); }
      continue;
    }
    if (isFence) {
      flush();
      cur = { start: i + 1, lines: [ln], kind: 'fence' };
      inFence = true;
      continue;
    }
    if (ln.trim() === '') { flush(); continue; }
    if (/^#{1,6}\s/.test(ln)) {
      flush();
      blocks.push({ start: i + 1, lines: [ln], kind: 'heading' });
      continue;
    }
    if (cur && /^([-*+]|\d+[.)])\s/.test(ln)) flush();
    if (!cur) cur = { start: i + 1, lines: [], kind: /^\s*\|/.test(ln) ? 'table' : 'para' };
    cur.lines.push(ln);
  }
  flush();
  return blocks;
}

function figuresOf(line) {
  const out = [];
  for (const m of line.matchAll(TIME_RE)) out.push(m[0]);
  for (const m of line.matchAll(RATIO_RE)) out.push(m[0]);
  return out;
}

/** Returns the list of `file:line: <figure> (no tier marker in scope)` strings. */
export function findUnmarked(text, file) {
  const blocks = splitBlocks(text);
  const bad = [];
  for (let b = 0; b < blocks.length; b++) {
    const blk = blocks[b];
    let scope = blk.lines.join('\n');
    if ((blk.kind === 'table' || blk.kind === 'fence') && b > 0) {
      scope = blocks[b - 1].lines.join('\n') + '\n' + scope;
    }
    if (MARK_RE.test(scope)) continue;
    for (let i = 0; i < blk.lines.length; i++) {
      for (const f of figuresOf(blk.lines[i])) {
        bad.push(`${file}:${blk.start + i}: ${f} (no tier marker in scope)`);
      }
    }
  }
  return bad;
}

/** Number of figures in a text (marked or not). */
export function countFigures(text) {
  let n = 0;
  for (const ln of text.split('\n')) n += figuresOf(ln).length;
  return n;
}

// M-71 (DECISIONS.md 2026-11-17): banned law phrasing in README.md + llms.txt.
export const BANNED = [
  /\bholds? across machines\b/i,
  /\byou should see\b/i,
  /\bnever take a GC pause\b/i,
  /\bstable across V8\b/i,
  /\bratios are the portable\b/i,
];

/** Returns `file:line: "<match>" (banned law phrasing, M-71)` strings. */
export function findBanned(text, file) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const re of BANNED) {
      const m = re.exec(lines[i]);
      if (m) out.push(`${file}:${i + 1}: "${m[0]}" (banned law phrasing, M-71)`);
    }
  }
  return out;
}

const README = readFileSync(new URL('README.md', ROOT), 'utf8');
const LLMS = readFileSync(new URL('llms.txt', ROOT), 'utf8');

test('docs-tier: README.md has no unmarked ms / x figure', () => {
  assert.deepEqual(findUnmarked(README, 'README.md'), []);
});

test('docs-tier: llms.txt has no unmarked ms / x figure', () => {
  assert.deepEqual(findUnmarked(LLMS, 'llms.txt'), []);
});

test('docs-tier: the docs carry figures at all (coverage floor)', () => {
  // Floor, not a pin: the rule must be looking at something. Counts at C2 are
  // recorded in the evidence log; a floor of 40 guards against a regex that
  // silently matches nothing.
  assert.ok(countFigures(README) >= 40, 'README figures: ' + countFigures(README));
  assert.ok(countFigures(LLMS) >= 12, 'llms figures: ' + countFigures(LLMS));
});

test('docs-tier control (b): deleting REPORTED from the headline caption reds exactly its scope', () => {
  const lines = README.split('\n');
  const capIdx = lines.findIndex((l) => /^REPORTED figures, measured on/.test(l));
  assert.ok(capIdx >= 0, 'headline caption found');
  // Expected = figures of the caption paragraph + the fenced block after it,
  // counted independently by plain line ranges (not by the scope machinery).
  let fenceOpen = -1;
  for (let i = capIdx + 1; i < lines.length; i++) if (lines[i].startsWith('```')) { fenceOpen = i; break; }
  let fenceClose = -1;
  for (let i = fenceOpen + 1; i < lines.length; i++) if (lines[i].startsWith('```')) { fenceClose = i; break; }
  assert.ok(fenceOpen > capIdx && fenceClose > fenceOpen);
  const expected = [];
  for (let i = capIdx; i <= fenceClose; i++) {
    for (const f of figuresOf(lines[i])) expected.push(`README.md:${i + 1}: ${f} (no tier marker in scope)`);
  }
  // The caption paragraph must hold no other tier word after the deletion.
  lines[capIdx] = lines[capIdx].replace(/REPORTED/g, '');
  assert.ok(!MARK_RE.test(lines[capIdx]), 'caption line has no other marker');
  assert.ok(expected.length >= 30, 'the 4 workload blocks hold >= 30 figures');
  assert.deepEqual(findUnmarked(lines.join('\n'), 'README.md'), expected);
});

test('docs-tier control (c): an injected unmarked bullet reports exactly 1', () => {
  const doc = 'Intro paragraph.\n\n- iteration ~1.9x faster\n';
  assert.deepEqual(findUnmarked(doc, 'x.md'), ['x.md:3: 1.9x (no tier marker in scope)']);
  assert.equal(findUnmarked(README + '\n\n- iteration ~1.9x faster\n', 'README.md').length, 1);
});

test('docs-tier control (d): "capacity x 4095" and "4 x (W + S1)" are not figures', () => {
  assert.deepEqual(findUnmarked('- budget is capacity x 4095 and 4 x (W + S1)\n', 'x.md'), []);
  assert.equal(countFigures('capacity x 4095; 4 x (W + S1); 0x1F; 2x2'), 0);
  // Positives: 1.9x, 10.8\u00d7, 2-4x, 0.5 ms, 12ms each count once.
  assert.equal(countFigures('1.9x 10.8\u00d7 2-4x 0.5 ms 12ms'), 5);
});

test('docs-tier control (e): caption above the table marks it; 2 blocks above does not', () => {
  const table = '| a | b |\n|---|---|\n| 1.5x | 2 ms |\n';
  const ok = 'REPORTED, one run.\n\n' + table;
  const far = 'REPORTED, one run.\n\nSome other paragraph.\n\n' + table;
  assert.deepEqual(findUnmarked(ok, 'x.md'), []);
  // Table row is line 7; time figures are listed before ratio figures per line.
  assert.deepEqual(findUnmarked(far, 'x.md'), [
    'x.md:7: 2 ms (no tier marker in scope)',
    'x.md:7: 1.5x (no tier marker in scope)',
  ]);
});

test('docs-tier control (f): a list item is its own block (a marked bullet does not mark the next)', () => {
  assert.deepEqual(findUnmarked('Intro.\n\n- REPORTED: a 1.2x\n- iteration ~1.9x faster\n', 'x.md'),
    ['x.md:4: 1.9x (no tier marker in scope)']);
});

test('docs-tier control (g): comma figures print whole', () => {
  assert.deepEqual(findUnmarked('- a 10.8x\n', 'x.md'), ['x.md:1: 10.8x (no tier marker in scope)']);
  assert.deepEqual(findUnmarked('- a 1,000x\n', 'x.md'), ['x.md:1: 1,000x (no tier marker in scope)']);
});

test('docs-tier control (h): llms.txt caption without REPORTED reds exactly its 8 table figures', () => {
  const lines = LLMS.split('\n');
  const capIdx = lines.findIndex((l) => l.includes('(README Workload 2; REPORTED:'));
  assert.ok(capIdx >= 0, 'llms caption found');
  // Expected: figures on the lines from the caption to the end of its table
  // (first blank line after the table starts), by plain line ranges.
  let i = capIdx;
  while (i < lines.length && lines[i].trim() !== '') i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  const tStart = i;
  while (i < lines.length && lines[i].trim() !== '') i++;
  const expected = [];
  for (let k = capIdx; k < i; k++) {
    for (const f of figuresOf(lines[k])) expected.push(`llms.txt:${k + 1}: ${f} (no tier marker in scope)`);
  }
  assert.ok(tStart > capIdx, 'table follows caption');
  lines[capIdx] = lines[capIdx].replace('REPORTED', '');
  assert.ok(!MARK_RE.test(lines[capIdx]), 'caption line has no other marker');
  assert.equal(expected.length, 8);
  assert.deepEqual(findUnmarked(lines.join('\n'), 'llms.txt'), expected);
});

test('docs-banned: README.md and llms.txt carry no banned law phrasing (M-71)', () => {
  assert.deepEqual(findBanned(README, 'README.md'), []);
  assert.deepEqual(findBanned(LLMS, 'llms.txt'), []);
});

test('docs-banned controls: each phrase bites even next to a tier word', () => {
  const cases = [
    ['REPORTED: the numbers hold across machines (~3x).', 'hold across machines'],
    ['REPORTED: the result holds across machines (~3x).', 'holds across machines'],
    ['REPORTED: on this host you should see ~3x.', 'you should see'],
    ['REPORTED: it will never take a GC pause (~3x).', 'never take a GC pause'],
    ['REPORTED: timing is stable across V8 releases (~3x).', 'stable across V8'],
    ['REPORTED: the ratios are the portable part (~3x).', 'ratios are the portable'],
  ];
  for (const [t, m] of cases) {
    assert.deepEqual(findBanned(t, 'x.md'), ['x.md:1: "' + m + '" (banned law phrasing, M-71)'], t);
    assert.deepEqual(findUnmarked(t, 'x.md'), [], 'marker rule cannot see it: ' + t);
  }
  assert.equal(BANNED.length, 5);
});

test('docs-banned control: M1a sentence on the README headline caption is caught only by findBanned', () => {
  const lines = README.split('\n');
  const capIdx = lines.findIndex((l) => /^REPORTED figures, measured on/.test(l));
  assert.ok(capIdx >= 0);
  lines[capIdx] += ' the ratios are what to compare, and they hold across machines (~3x),';
  const doc = lines.join('\n');
  assert.equal(countFigures(doc), countFigures(README) + 1);
  assert.deepEqual(findUnmarked(doc, 'README.md'), []);
  assert.deepEqual(findBanned(doc, 'README.md'),
    ['README.md:' + (capIdx + 1) + ': "hold across machines" (banned law phrasing, M-71)']);
});

// CLI guard for the revert-check script: node test/docs-tier.test.js <file...>
// prints one line per unmarked figure and `<file>: <n> unmarked`, then one line per
// banned phrase and `<file>: <n> banned`.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.length > 2) {
  for (const p of process.argv.slice(2)) {
    const bad = findUnmarked(readFileSync(p, 'utf8'), p);
    for (const l of bad) console.log(l);
    console.log(p + ': ' + bad.length + ' unmarked, ' + countFigures(readFileSync(p, 'utf8')) + ' figures');
    const ban = findBanned(readFileSync(p, 'utf8'), p);
    for (const l of ban) console.log(l);
    console.log(p + ': ' + ban.length + ' banned');
  }
}
