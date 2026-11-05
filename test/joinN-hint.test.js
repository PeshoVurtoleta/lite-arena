/**
 * @zakkster/lite-arena -- F2 joinN() driver-flag hint oracle (PLAN-F2 S6, TASK T13, assertions A8-A11; M-38 / M-43 / M-44).
 *
 * Every joinN plan gains `driverFlag` and `driverFlagCount` at the END of its key order. Non-indexed and Hi-only-indexed
 * arenas keep 0 / -1. On a word-0 indexed arena: over (reqMask & indexedMask) the rarest bit b with flagCount(b) < plan.count
 * (strict; lowest bit wins ties) -> driverFlag = 1 << b (bit 31 = -2147483648), driverFlagCount = that count; else 0 / -1.
 * plan.count and every other field are unchanged. Checked plans expose both through _live() getters.
 *
 *  A8  golden replay: test/golden/joinN-f2-fe8d7d5.json (cut from fe8d7d5 / 08e04bab by .handoff/evidence/F2/joinN-cut.mjs).
 *      Replays nomask, mask, hiProduction, hiChecked through test/golden/joinN-hi-workload.mjs (capturePlans / runHi);
 *      non-indexed lanes plus the two Hi lanes with Hi-only indexed flags: keys = golden's 12 + 2 new, the 12 old values
 *      deepEqual the golden, the new ones are 0 / -1.
 *  A9  hand-built arena: counts a=3, b=7, z(bit31)=2, plain p=1, driver set count 10; ties, strict '<', clearFlagAll.
 *  A10 no stale hint on the reused scratch plan (a non-indexed query after a hinted one reads 0 / -1).
 *  A11 1,000 seeded ops on twin arenas (plain / indexed / indexed+checked) with a brute-force mirror oracle.
 *
 * Expected values come from the spec rule and hand arithmetic (counts of entities flagged), never from the build under test.
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/joinN-hint.test.js
 *
 * Must-fail mutants:
 *   - "write only when found" (pickFlagDriver skips the 0 / -1 write): A10 and the A11 differential catch it (stale hint).
 *   - `r.count = bc` (flag count written into plan.count): A9 (count === 10) and the A11 old-fields-identical check catch it.
 *   - non-strict '<=' : A9 tie-with-driver case (10 vs 10 must give 0 / -1).
 *   - highest-bit-wins ties: A9 tie case.
 * On the frozen fe8d7d5 / HEAD build everything here fails (no driverFlag keys; no `indexed` option).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;
const W1 = await import('./golden/joinN-workload.mjs');
const W2 = await import('./golden/joinN-mask-workload.mjs');
const { capturePlans, runHi } = await import('./golden/joinN-hi-workload.mjs');
const golden = JSON.parse(readFileSync(new URL('./golden/joinN-f2-fe8d7d5.json', import.meta.url), 'utf8'));

const NAMES = Array.from({ length: 32 }, (_, i) => 'n' + i);
const HNAMES = Array.from({ length: 32 }, (_, i) => 'h' + i);
const BIT31 = -2147483648;

// mulberry32: seeded 32-bit-exact PRNG (Math.imul / >>> 0 only).
function mulberry32(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (t ^ (t >>> 14)) >>> 0;
    };
}

// ---- A8 ----------------------------------------------------------------------------------------
function replay(laneName, sink) {
    const g = golden.sources[laneName];
    assert.equal(sink.records.length, g.records.length, laneName + ' plan count');
    assert.equal(sink.records.length, golden.planCounts[laneName], laneName + ' golden plan count');
    const oldKeys = golden.productionKeys;
    for (let i = 0; i < g.records.length; i++) {
        const gr = g.records[i], nr = sink.records[i];
        assert.equal(nr[0], gr[0], laneName + '#' + i + ' checked flag');
        const gKeys = g.keyLists[gr[1]];
        assert.deepEqual(gKeys, oldKeys, 'golden key list sanity');
        assert.deepEqual(sink.keyLists[nr[1]], gKeys.concat(['driverFlag', 'driverFlagCount']),
            laneName + '#' + i + ' read key order');
        assert.equal(nr.length, gr.length + 2, laneName + '#' + i + ' record length');
        assert.deepEqual(nr.slice(3, gr.length), gr.slice(3), laneName + '#' + i + ' old 12 values');
        assert.equal(nr[gr.length], 0, laneName + '#' + i + ' driverFlag');
        assert.equal(nr[gr.length + 1], -1, laneName + '#' + i + ' driverFlagCount');
    }
    return g.records.length;
}

test('A8 non-indexed arenas: 12 old keys + driverFlag 0 / driverFlagCount -1 (nomask, mask, hiProduction, hiChecked)', () => {
    let n = 0;
    n += replay('nomask', capturePlans(Arena, (Spy) => W1.run(Spy)).sink);
    n += replay('mask', capturePlans(Arena, (Spy) => W2.run(Spy)).sink);
    n += replay('hiProduction', capturePlans(Arena, (Spy) => runHi(Spy, { checked: false })).sink);
    n += replay('hiChecked', capturePlans(Arena, (Spy) => runHi(Spy, { checked: true })).sink);
    assert.equal(n, 1200 + 627 + 200 + 200);
});

test('A8 Hi-only-indexed arenas keep 0 / -1 (hiProduction, hiChecked with registerFlagsHi indexed)', () => {
    const hiOptions = { indexed: ['h0', 'h1', 'h2', 'h31'] };
    let n = 0;
    n += replay('hiProduction', capturePlans(Arena, (Spy) => runHi(Spy, { checked: false, hiOptions })).sink);
    n += replay('hiChecked', capturePlans(Arena, (Spy) => runHi(Spy, { checked: true, hiOptions })).sink);
    assert.equal(n, 400);
});

// ---- A9 / A10 ----------------------------------------------------------------------------------
// Entities 1..10 live in the driver set S (count 10).
function mkHand(checked, indexed) {
    const a = checked ? new Arena(64, { checked: true }) : new Arena(64);
    const F = a.registerFlags(NAMES, { indexed });
    const S = a.registerTag();
    const es = [];
    for (let i = 0; i < 10; i++) { const e = a.spawn(); S.add(e); es.push(e); }
    return { a, F, S, es };
}

for (const checked of [false, true]) {
    const tag = checked ? ' (checked)' : '';

    test('A9 hand counts a=3 b=7 z=2 p=1, driver 10' + tag, () => {
        const { a, F, S, es } = mkHand(checked, ['n0', 'n1', 'n31']);
        const A = F.n0, B = F.n1, Z = F.n31, P = F.n2; // P is registered but not indexed
        assert.equal(Z, BIT31);
        for (let i = 0; i < 3; i++) a.setFlags(es[i], A);
        for (let i = 0; i < 7; i++) a.setFlags(es[i], B);
        for (let i = 0; i < 2; i++) a.setFlags(es[i + 4], Z);
        a.setFlags(es[9], P);
        let p = a.joinN([S], null, A | B | Z | P);
        assert.equal(p.count, 10);
        assert.equal(p.driverFlag, BIT31);
        assert.equal(p.driverFlagCount, 2);
        p = a.joinN([S], null, A | B | P); // a (3) rarer than b (7); p is not indexed (1 ignored)
        assert.equal(p.count, 10);
        assert.equal(p.driverFlag, A);
        assert.equal(p.driverFlagCount, 3);
        p = a.joinN([S], null, B | P);
        assert.equal(p.driverFlag, B);
        assert.equal(p.driverFlagCount, 7);
        p = a.joinN([S], null, P); // not indexed
        assert.equal(p.driverFlag, 0);
        assert.equal(p.driverFlagCount, -1);
        p = a.joinN([S], null, 0);
        assert.equal(p.driverFlag, 0);
        assert.equal(p.driverFlagCount, -1);
        p = a.joinN([S], null);
        assert.equal(p.driverFlag, 0);
        assert.equal(p.driverFlagCount, -1);
        // clearFlagAll(z): z count 0 (0 < 10, rarest)
        a.clearFlagAll(Z);
        p = a.joinN([S], null, A | B | Z | P);
        assert.equal(p.count, 10);
        assert.equal(p.driverFlag, BIT31);
        assert.equal(p.driverFlagCount, 0);
        // without z in the mask: back to a
        p = a.joinN([S], null, A | B);
        assert.equal(p.driverFlag, A);
        assert.equal(p.driverFlagCount, 3);
    });

    test('A9 strict < and lowest-bit tie-break' + tag, () => {
        const { a, F, S, es } = mkHand(checked, ['n0', 'n1', 'n2', 'n3', 'n4']);
        const out = [a.spawn(), a.spawn()]; // outside S
        for (let i = 0; i < 10; i++) a.setFlags(es[i], F.n0); // 10 == driver count: tie with driver
        for (let i = 0; i < 4; i++) { a.setFlags(es[i], F.n1); a.setFlags(es[i + 4], F.n2); } // n1 = n2 = 4
        for (let i = 0; i < 6; i++) a.setFlags(es[i], F.n3); // 6
        for (let i = 0; i < 10; i++) a.setFlags(es[i], F.n4);
        a.setFlags(out[0], F.n4); a.setFlags(out[1], F.n4); // n4 = 12 > 10
        let p = a.joinN([S], null, F.n0);
        assert.equal(p.count, 10);
        assert.equal(p.driverFlag, 0); assert.equal(p.driverFlagCount, -1);
        p = a.joinN([S], null, F.n4);
        assert.equal(p.driverFlag, 0); assert.equal(p.driverFlagCount, -1);
        p = a.joinN([S], null, F.n0 | F.n4);
        assert.equal(p.driverFlag, 0); assert.equal(p.driverFlagCount, -1);
        p = a.joinN([S], null, F.n1 | F.n2); // tie 4 / 4: lowest bit
        assert.equal(p.driverFlag, F.n1); assert.equal(p.driverFlagCount, 4);
        p = a.joinN([S], null, F.n2 | F.n1 | F.n3 | F.n0);
        assert.equal(p.driverFlag, F.n1); assert.equal(p.driverFlagCount, 4);
        p = a.joinN([S], null, F.n2 | F.n3);
        assert.equal(p.driverFlag, F.n2); assert.equal(p.driverFlagCount, 4);
        p = a.joinN([S], null, F.n0 | F.n3 | F.n4); // n0 and n4 not < 10; n3 = 6
        assert.equal(p.driverFlag, F.n3); assert.equal(p.driverFlagCount, 6);
        assert.equal(p.count, 10);
    });

    test('A10 no stale hint on the reused scratch' + tag, () => {
        const { a, F, S, es } = mkHand(checked, ['n0', 'n1', 'n31']);
        for (let i = 0; i < 3; i++) a.setFlags(es[i], F.n0);
        a.setFlags(es[0], F.n2);
        // Must-fail mutant: "write only when found" leaves the previous hint behind here.
        const p1 = a.joinN([S], null, F.n0 | F.n2);
        assert.equal(p1.driverFlag, F.n0);
        assert.equal(p1.driverFlagCount, 3);
        const p2 = a.joinN([S], null, F.n2); // n2 not indexed
        if (!checked) assert.equal(p2, p1, 'production plan is the reused scratch');
        assert.equal(p2.driverFlag, 0);
        assert.equal(p2.driverFlagCount, -1);
        const p3 = a.joinN([S], null, F.n0);
        assert.equal(p3.driverFlag, F.n0);
        const p4 = a.joinN([S], null, 0); // no mask at all
        assert.equal(p4.driverFlag, 0);
        assert.equal(p4.driverFlagCount, -1);
        const p5 = a.joinN([S], null, F.n0);
        assert.equal(p5.driverFlagCount, 3);
    });
}

// ---- A11 ---------------------------------------------------------------------------------------
const POOL = [0, 1, 2, 3, 5, 31]; // flag bits used by the churn
const IXB = [0, 1, 2, 5, 31]; // indexed bits (bit 3 stays plain)
const bitOf = (b) => (1 << b) | 0;

function twin(kind) {
    const a = kind === 'checked' ? new Arena(64, { checked: true }) : new Arena(64);
    const F = kind === 'plain'
        ? a.registerFlags(NAMES)
        : a.registerFlags(NAMES, { indexed: IXB.map((b) => NAMES[b]) });
    const sets = [a.registerTag(), a.registerTag(), a.registerTag()];
    return { a, F, sets, ents: [] };
}

// Old fields, encoded independent of arena identity (sets by index in `req`).
function oldFields(t, req, exc, p) {
    const idx = (set) => req.indexOf(set);
    const o = [idx(p.driver), p.count, [], p.othersCount, [], p.exclCount, p.reqMask, p.excMask,
        p.flags === t.a.flags, p.reqMaskHi, p.excMaskHi, p.flagsHi === t.a.flagsHi];
    for (let i = 0; i < p.othersCount; i++) o[2].push(idx(p.others[i]));
    for (let i = 0; i < p.exclCount; i++) o[4].push(exc.indexOf(p.excl[i]));
    return o;
}

test('A11 differential: plain / indexed / checked twins vs brute-force mirror (1,000 seeded ops)', () => {
    const T = [twin('plain'), twin('indexed'), twin('checked')];
    const opR = mulberry32(0xA11CE5ED); // op stream
    const keyR = mulberry32(0x5EED0B17); // query-shape stream (independent)
    const live = []; // mirror: { h: [h0, h1, h2], fl: int32, sm: bitmask of set membership }
    let joins = 0, hinted = 0, unhinted = 0, tiesLikeZero = 0, staleChecks = 0, clearAlls = 0;
    const seenBits = new Set();
    let prevChecked = null;

    const forAll = (fn) => { for (let k = 0; k < 3; k++) fn(T[k], k); };

    for (let step = 1; step <= 1000; step++) {
        const op = opR() % 12;
        if (live.length === 0 || op <= 1) {
            if (live.length < 40) {
                const m = { h: [], fl: 0, sm: 0 };
                forAll((t) => m.h.push(t.a.spawn()));
                live.push(m);
            }
        } else if (op === 2) {
            const i = opR() % live.length;
            forAll((t, k) => t.a.despawn(live[i].h[k]));
            live[i] = live[live.length - 1]; live.pop();
        } else if (op === 3 || op === 4 || op === 5) {
            const m = live[opR() % live.length], s = opR() % 3;
            if (op === 4) { forAll((t, k) => t.sets[s].remove(m.h[k])); m.sm &= ~(1 << s); }
            else { forAll((t, k) => t.sets[s].add(m.h[k])); m.sm |= 1 << s; }
        } else if (op === 6 || op === 7) {
            const m = live[opR() % live.length];
            const mk = bitOf(POOL[opR() % POOL.length]) | (opR() % 3 === 0 ? bitOf(POOL[opR() % POOL.length]) : 0);
            forAll((t, k) => t.a.setFlags(m.h[k], mk));
            m.fl |= mk;
        } else if (op === 8 || op === 9) {
            const m = live[opR() % live.length];
            const mk = bitOf(POOL[opR() % POOL.length]);
            forAll((t, k) => t.a.clearFlags(m.h[k], mk));
            m.fl &= ~mk;
        } else if (op === 10) {
            if (opR() % 3 === 0) {
                const mk = bitOf(IXB[opR() % IXB.length]); // clearFlagAll needs an indexed bit
                forAll((t, k) => {
                    if (k === 0) { for (const m of live) t.a.clearFlags(m.h[0], mk); } // plain twin: per-entity
                    else t.a.clearFlagAll(mk);
                });
                for (const m of live) m.fl &= ~mk;
                clearAlls++;
            }
        } else {
            // flag-heavy burst: give a random entity a random subset of the pool
            const m = live[opR() % live.length];
            let mk = 0;
            for (const b of POOL) if (opR() & 1) mk |= bitOf(b);
            forAll((t, k) => t.a.setFlags(m.h[k], mk));
            m.fl |= mk;
        }

        if (step % 5 !== 0) continue;
        // ---- query: shape from keyR only
        const nreq = 1 + (keyR() % 3);
        const reqIdx = [];
        for (let i = 0; i < nreq; i++) reqIdx.push(keyR() % 3);
        let reqMask = 0;
        for (const b of POOL) if (keyR() % 3 === 0) reqMask |= bitOf(b);
        if (keyR() % 5 === 0) reqMask |= bitOf(4 + (keyR() % 20) * 1); // maybe a non-pool bit (never flagged)
        let excMask = 0;
        if (keyR() % 3 === 0) { const b = bitOf(POOL[keyR() % POOL.length]); if ((b & reqMask) === 0) excMask = b; }
        let exclSets = null; // an excluded set must not also be required (checked mode throws)
        if (keyR() % 4 === 0) { const e = keyR() % 3; if (!reqIdx.includes(e)) exclSets = [e]; }
        // mirror oracle
        const cnt = (b) => { let c = 0; for (const m of live) if ((m.fl >>> b) & 1) c++; return c; };
        let driverCount = Infinity;
        for (const i of reqIdx) {
            let c = 0;
            for (const m of live) if ((m.sm >>> i) & 1) c++;
            if (c < driverCount) driverCount = c;
        }
        let expFlag = 0, expCnt = -1;
        for (let b = 0; b < 32; b++) {
            if (!IXB.includes(b) || ((reqMask >>> b) & 1) === 0) continue;
            const c = cnt(b);
            if (c < driverCount && (expCnt === -1 || c < expCnt)) { expFlag = bitOf(b); expCnt = c; }
        }
        if (expCnt !== -1) { hinted++; seenBits.add(expFlag); } else if ((reqMask & IXB.reduce((x, b) => x | bitOf(b), 0)) !== 0) tiesLikeZero++; else unhinted++;

        const olds = [], hints = [];
        forAll((t, k) => {
            const req = reqIdx.map((i) => t.sets[i]);
            const exc = exclSets === null ? null : exclSets.map((i) => t.sets[i]);
            const p = t.a.joinN(req, exc, reqMask, excMask);
            olds.push(oldFields(t, req, exc || [], p));
            hints.push([p.driverFlag, p.driverFlagCount]);
            if (k === 2) {
                // stale check: the previous checked plan must now throw on both getters
                if (prevChecked !== null) {
                    assert.throws(() => prevChecked.driverFlag, /stale joinN\(\) plan/);
                    assert.throws(() => prevChecked.driverFlagCount, /stale joinN\(\) plan/);
                    staleChecks++;
                }
                prevChecked = p;
            }
        });
        joins++;
        assert.equal(olds[0][1], driverCount, 'step ' + step + ' plan.count vs mirror');
        assert.deepEqual(olds[1], olds[0], 'step ' + step + ' old fields indexed vs plain');
        assert.deepEqual(olds[2], olds[0], 'step ' + step + ' old fields checked vs plain');
        assert.deepEqual(hints[0], [0, -1], 'step ' + step + ' plain twin hint');
        assert.deepEqual(hints[1], [expFlag, expCnt], 'step ' + step + ' indexed hint vs mirror');
        assert.deepEqual(hints[2], [expFlag, expCnt], 'step ' + step + ' checked hint vs mirror');
    }
    // coverage floors (designed: ~200 joins, 6 pool bits with 5 indexed)
    assert.equal(joins, 200);
    assert.ok(hinted >= 40, 'hinted joins ' + hinted);
    assert.ok(unhinted + tiesLikeZero >= 20, 'unhinted joins ' + (unhinted + tiesLikeZero));
    assert.ok(seenBits.size >= 3, 'distinct hint bits ' + seenBits.size);
    assert.ok(clearAlls >= 10, 'clearFlagAll ops ' + clearAlls);
    assert.ok(staleChecks >= 150, 'stale checks ' + staleChecks);
});
