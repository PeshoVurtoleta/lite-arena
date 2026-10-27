/**
 * @zakkster/lite-arena -- SparseSet.remove() parity (Group E, PLAN-E A3).
 *
 * The swap-branch rewrite must not change one observable: a 6,000 + 1,000 op
 * seeded trace (reserve, transfer-while-detached, rebind, caller-backed) hashes
 * to the same sha256 on HEAD e675a64, on before-E and on E. The literal is a PIN
 * cut on the .handoff/head-e675a64 copy (sha256 c08d352e...); the trace itself
 * also checks every payload against a plain-JS model (see remove-trace.mjs).
 *
 * Run: `node --test test/remove-parity.test.js`
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/remove-parity.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { runTrace } from './remove-trace.mjs';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');

const PINNED = '7471e6f18bedda5a9bc662014b51f7c5eddd4458971af61dd377a83a0ac4fe6c';

test('remove parity: trace digest equals the HEAD-cut pin', () => {
    const info = {};
    const digest = runTrace(mod, info);
    assert.equal(digest, PINNED);
    // coverage floors: each region must really exercise swapping removes
    assert.ok(info.swaps >= 2000, 'total swaps ' + info.swaps);
    assert.ok(info.swapsBefore >= 500, 'swaps before reserve ' + info.swapsBefore);
    assert.ok(info.swapsAfterReserve >= 300, 'swaps after reserve ' + info.swapsAfterReserve);
    assert.ok(info.swapsDetached >= 50, 'swaps while detached ' + info.swapsDetached);
    assert.ok(info.swapsAfterRebind >= 500, 'swaps after rebind ' + info.swapsAfterRebind);
    assert.ok(info.swapsCallerBacked >= 200, 'caller-backed swaps ' + info.swapsCallerBacked);
    assert.equal(info.reserveThrew, true);
});

test('remove parity: trace is deterministic (second run, same digest)', () => {
    assert.equal(runTrace(mod), PINNED);
});
