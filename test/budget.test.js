/**
 * @zakkster/lite-arena -- Generation budget gate (DETERMINISTIC).
 *
 * Run: `npm test`            (node --test)
 *      or: `node --test test/budget.test.js`
 *
 * Every slot issues live generations 1..4095 and RETIRES (fail-closed) on the
 * despawn that returns generation 4095. So an arena of capacity `cap` has a
 * hard budget of cap x 4095 despawns from construction, after which spawn()
 * throws. This file drives churn workloads through the PUBLIC API only
 * (spawn / despawn / isAlive / activeCount / retiredCount /
 * remainingCapacity / clear / reserve) -- it never reads `arena.generations`
 * and never decodes a handle -- and checks the budget arithmetic.
 *
 * Every assertion is labelled:
 *   FORMULA -- independent arithmetic oracle (cap x 4095, bounds), true for any
 *              correct build.
 *   PIN     -- regression value cut from the frozen build ce3f63c
 *              (sha256 5428e778...) by running this same churn; see
 *              .handoff/evidence/budget-pins-ce3f63c.txt.
 *
 * Untimed: no clock is read, nothing here is a speed claim.
 *
 * LITE_ARENA_PATH=<abs path to an Arena.js> runs the same file against another
 * build (the frozen build, a mutant). Default: the live ../Arena.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

// Live generations per slot (1..4095). Stated here as a number, not imported:
// the oracle must not share the module's constant.
const LIVE_GENS = 4095;

// Deterministic life generator: 32-bit LCG (Numerical Recipes constants).
// Math.imul keeps the product exact; `seed * 1103515245` in doubles would lose
// bits past 2^53. Seed stated: LCG_SEED.
const LCG_SEED = 20261027;
function makeLcgLife(seed, maxLife) {
    let s = seed | 0;
    return () => {
        s = (Math.imul(s, 1103515245) + 12345) | 0;
        return 1 + ((s >>> 16) % maxLife);
    };
}
const one = () => 1;

// PIN values cut from the frozen build ce3f63c (sha256 5428e778) by this
// file's churn; evidence in .handoff/evidence/budget-pins-ce3f63c.txt.
// first = despawn # of the first retirement; retired/active at spawn failure.
const PIN = {
    W2: { D: 24568, first: 24565, retired: 4, active: 4 },
    W3: { D: 30805, first: 30279, retired: 1, active: 7 },
    C2: { D: 3685310, first: 1228201, retired: 710, active: 290 },
    C3: { D: 3115308, first: 1288804, retired: 670, active: 330 },
};

/**
 * Frame-stepped churn. Each frame: first despawn every entity whose life
 * expires this frame (in spawn order), then spawn `perFrame` entities, each
 * living lifeFn() frames (1 = despawned on the next frame). Expiry buckets are
 * Int32Array rings indexed by frame & MASK. Stops at the first spawn() throw.
 *
 * Fails fast (records the reason) on: a despawn of a scheduled entity
 * returning false, a freshly spawned handle that isAlive() rejects, the
 * running-budget invariant (retired in this run) x perSlot <= D breaking
 * (perSlot = 4095 from construction / reserve, 4094 for a slot revived by
 * clear()), activeCount drifting from the churn's own count of live
 * entities, or D passing the hard cap cap x 4095 + cap + 1.
 *
 * Returns { D, active, retired, remaining, err, fault, retireAt } where D is
 * successful despawns in THIS run, retireAt[j] the D at which the j-th
 * retirement of this run happened.
 */
function churn(arena, perFrame, lifeFn, maxLife, perSlot = LIVE_GENS) {
    const cap = arena.capacity;
    let R = 2;
    while (R <= maxLife) R <<= 1;
    const MASK = R - 1;
    const cnt = new Int32Array(R);
    const items = new Int32Array(R * cap);
    const retireAt = new Int32Array(cap + 1);
    const hardCap = cap * LIVE_GENS + cap + 1;
    const retired0 = arena.retiredCount;
    let nRetire = 0;
    let lastRetired = retired0;
    let D = 0;
    let fault = '';
    let err = null;
    let held = arena.activeCount;
    let frame = 0;
    let firstRetireFrame = -1;

    for (frame = 0; ; frame++) {
        const b = frame & MASK;
        const n = cnt[b];
        const base = b * cap;
        for (let i = 0; i < n; i++) {
            if (!arena.despawn(items[base + i])) { fault = 'despawn-false@D=' + D; break; }
            D++;
            held--;
            const r = arena.retiredCount;
            if (r !== lastRetired) {
                if (r !== lastRetired + 1 || nRetire >= cap) { fault = 'retire-jump@D=' + D; break; }
                if (nRetire === 0) firstRetireFrame = frame;
                retireAt[nRetire++] = D;
                lastRetired = r;
            }
            // FORMULA: each slot retired in this run consumed perSlot despawns.
            if ((r - retired0) * perSlot > D) { fault = 'budget-invariant@D=' + D; break; }
        }
        cnt[b] = 0;
        if (fault !== '') break;
        if (D > hardCap) { fault = 'hard-cap@D=' + D; break; }

        for (let s = 0; s < perFrame; s++) {
            let h;
            try {
                h = arena.spawn();
            } catch (e) {
                err = e;
                break;
            }
            held++;
            if (!arena.isAlive(h)) { fault = 'spawn-dead@D=' + D; break; }
            const tb = (frame + lifeFn()) & MASK;
            items[tb * cap + cnt[tb]++] = h;
        }
        if (err !== null || fault !== '') break;
        // FORMULA: activeCount equals the live entities this churn holds
        // (counted independently: +1 per spawn, -1 per successful despawn).
        if (arena.activeCount !== held) {
            fault = 'active-count@D=' + D;
            break;
        }
    }
    return {
        D,
        active: arena.activeCount,
        retired: arena.retiredCount,
        remaining: arena.remainingCapacity(),
        err,
        fault,
        retireAt: retireAt.subarray(0, nRetire),
        nRetire,
        frame,
        firstRetireFrame,
    };
}

// FORMULA checks shared by every workload, at the spawn failure.
// slots = slots this run could consume (capacity minus slots already retired
// when the run began); perSlot = despawns each of them had left.
function checkExhausted(t, name, r, cap, slots = cap, perSlot = LIVE_GENS) {
    t.diagnostic(name + ' D=' + r.D + ' active=' + r.active + ' retired=' + r.retired +
        ' remaining=' + r.remaining + ' firstRetireD=' + (r.nRetire > 0 ? r.retireAt[0] : -1) +
        ' fault=' + (r.fault || 'none'));
    assert.equal(r.fault, '', name + ': churn fault ' + r.fault);
    assert.ok(r.err instanceof Error, name + ': spawn() must throw at exhaustion');
    // FORMULA: the throw is caused by retirement, and says so.
    assert.match(r.err.message, /retired by generation/, name);
    // FORMULA: free list empty -> every non-active slot is retired.
    assert.equal(r.remaining, 0, name + ': remainingCapacity() at failure');
    assert.equal(r.active + r.retired, cap, name + ': active + retired === capacity');
    // FORMULA: (slots - active) x perSlot <= D <= slots x perSlot - active
    // (from construction: (cap - active) x 4095 <= D <= cap x 4095 - active).
    assert.ok((slots - r.active) * perSlot <= r.D, name + ': lower bound');
    assert.ok(r.D <= slots * perSlot - r.active, name + ': upper bound');
}

// -----------------------------------------------------------------
// T-a..T-d: Arena(8)
// -----------------------------------------------------------------

test('budget T-a: W1 single-entity churn on Arena(8) retires one slot per 4095 despawns', (t) => {
    const cap = 8;
    const arena = new Arena(cap);
    const r = churn(arena, 1, one, 1);
    checkExhausted(t, 'W1', r, cap);
    // FORMULA: LIFO reuse churns one slot to death before touching the next,
    // so the k-th retirement lands on despawn #k x 4095 (k = 1..8).
    assert.equal(r.nRetire, cap);
    for (let k = 1; k <= cap; k++) {
        assert.equal(r.retireAt[k - 1], k * LIVE_GENS, 'retirement #' + k);
    }
    // FORMULA: spawn throws after exactly cap x 4095 = 32,760 despawns.
    assert.equal(r.D, 32760);
    assert.equal(r.D, cap * LIVE_GENS);
    assert.equal(r.retired, 8);
    assert.equal(r.active, 0);
    assert.equal(r.remaining, 0);
});

test('budget T-b: W2 (2/frame, 3-frame life) and W3 (LCG life 1..8) on Arena(8)', (t) => {
    const cap = 8;
    const w2 = churn(new Arena(cap), 2, () => 3, 3);
    // W3: 1 spawn/frame, life 1..8 from the LCG (seed LCG_SEED). Max life 8 at
    // 1/frame keeps at most 8 alive, so the arena never fills by occupancy.
    const w3 = churn(new Arena(cap), 1, makeLcgLife(LCG_SEED, 8), 8);
    checkExhausted(t, 'W2', w2, cap);
    checkExhausted(t, 'W3', w3, cap);
    // PIN (frozen ce3f63c).
    assert.equal(w2.D, PIN.W2.D);
    assert.equal(w2.retireAt[0], PIN.W2.first);
    assert.equal(w2.retired, PIN.W2.retired);
    assert.equal(w2.active, PIN.W2.active);

    // PIN (frozen ce3f63c).
    assert.equal(w3.D, PIN.W3.D);
    assert.equal(w3.retireAt[0], PIN.W3.first);
    assert.equal(w3.retired, PIN.W3.retired);
    assert.equal(w3.active, PIN.W3.active);
});

test('budget T-c: 3 cycles of exhaust + clear() on Arena(8) each refill 8 x 4094', (t) => {
    const cap = 8;
    const arena = new Arena(cap);
    const first = churn(arena, 1, one, 1);
    checkExhausted(t, 'T-c cycle 0', first, cap);
    assert.equal(first.D, cap * LIVE_GENS); // FORMULA
    for (let c = 1; c <= 3; c++) {
        arena.clear();
        // FORMULA: clear() revives every retired slot.
        assert.equal(arena.retiredCount, 0, 'cycle ' + c);
        assert.equal(arena.activeCount, 0, 'cycle ' + c);
        assert.equal(arena.remainingCapacity(), cap, 'cycle ' + c);
        const r = churn(arena, 1, one, 1, LIVE_GENS - 1);
        checkExhausted(t, 'T-c cycle ' + c, r, cap, cap, LIVE_GENS - 1);
        // FORMULA: a revived slot restarts at generation 2, so it has 4094
        // despawns left: 8 x 4094 = 32,752.
        assert.equal(r.D, 32752, 'cycle ' + c);
        assert.equal(r.D, cap * (LIVE_GENS - 1), 'cycle ' + c);
        assert.equal(r.retired, cap, 'cycle ' + c);
    }
});

test('budget T-d: reserve(16) on an exhausted Arena(8) adds exactly 8 x 4095 despawns', (t) => {
    const arena = new Arena(8);
    const first = churn(arena, 1, one, 1);
    checkExhausted(t, 'T-d before', first, 8);
    assert.equal(arena.reserve(16), true);
    // FORMULA: the 8 new slots are free, the 8 retired stay retired.
    assert.equal(arena.retiredCount, 8);
    assert.equal(arena.remainingCapacity(), 8);
    const r = churn(arena, 1, one, 1);
    checkExhausted(t, 'T-d after', r, 16, 16 - 8);
    // FORMULA: (16 - 8) x 4095 = 32,760 more despawns, ends with all 16 retired.
    assert.equal(r.D, 32760);
    assert.equal(r.D, (16 - 8) * LIVE_GENS);
    assert.equal(r.retired, 16);
    assert.equal(r.nRetire, 8);
    for (let k = 1; k <= 8; k++) assert.equal(r.retireAt[k - 1], k * LIVE_GENS, 'retirement #' + k);
});

// -----------------------------------------------------------------
// T-e: Arena(1000), game-shaped workloads
// -----------------------------------------------------------------

test('budget T-e: C1/C2/C3 on Arena(1000)', (t) => {
    const cap = 1000;

    // C1: 1 spawn + 1 despawn per frame, 1-frame life.
    const c1 = churn(new Arena(cap), 1, one, 1);
    checkExhausted(t, 'C1', c1, cap);
    // FORMULA: D === 1000 x 4095; first retirement at despawn #4095.
    assert.equal(c1.D, 4095000);
    assert.equal(c1.D, cap * LIVE_GENS);
    assert.equal(c1.retireAt[0], LIVE_GENS);
    assert.equal(c1.active, 0);

    // C2: 10 spawns/frame, 30-frame life (300 alive at steady state).
    const c2 = churn(new Arena(cap), 10, () => 30, 30);
    // C3: 5 spawns/frame, life 1..120 from the LCG (seed LCG_SEED).
    const c3 = churn(new Arena(cap), 5, makeLcgLife(LCG_SEED, 120), 120);
    checkExhausted(t, 'C2', c2, cap);
    checkExhausted(t, 'C3', c3, cap);
    // PIN (frozen ce3f63c).
    assert.equal(c2.D, PIN.C2.D);
    assert.equal(c2.retireAt[0], PIN.C2.first);
    assert.equal(c2.retired, PIN.C2.retired);
    assert.equal(c2.active, PIN.C2.active);

    // PIN (frozen ce3f63c).
    assert.equal(c3.D, PIN.C3.D);
    assert.equal(c3.retireAt[0], PIN.C3.first);
    // first retirement frame (ADR 0001): measured by churn(), not re-derived.
    assert.equal(c3.firstRetireFrame, 257818);
    assert.equal(c3.frame, 623127); // frame of the failing spawn()
    assert.equal(c3.retired, PIN.C3.retired);
    assert.equal(c3.active, PIN.C3.active);
});
