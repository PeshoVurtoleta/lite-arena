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
