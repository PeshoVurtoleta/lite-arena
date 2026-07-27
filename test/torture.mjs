/**
 * @zakkster/lite-arena -- torture gate.
 *
 * The suite DONE-WHEN is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints "ok", exit 0
 *
 * It gates two independent properties of the real Arena.js entry:
 *
 *   Phase A (retention) -- 4096 create/dispose cycles. Every spawned entity is
 *     given three components and an associated JS resource tracked by lite-leak.
 *     On dispose the resource is released and the entity despawned. A pass
 *     requires BOTH oracles to return to zero: the arena's own activeCount and
 *     an external lite-leak tracker.size(). Two independent witnesses, so a
 *     bug in one does not hide behind the other.
 *
 *   Phase B (GC budget) -- pre-spawn to capacity OUTSIDE the loop, then run a
 *     hot tick over dense[0..count) doing typed-array reads/writes only. The
 *     window is measured by lite-gc-profiler and gated at maxMajor:0 /
 *     maxPauseMs:4. The summary is read only after an awaited settle tick, so
 *     the gate never passes on an empty observation window.
 *
 * A pass means something only if the gate can fail. Run
 *
 *     ARENA_TORTURE_LEAK=1 node --expose-gc test/torture.mjs
 *
 * to skip every despawn: the retention oracles stay non-zero and the process
 * exits non-zero. That is the control -- see CHANGELOG.md and the DONE-WHEN.
 *
 * Peers are devDependencies, never runtime deps: Arena.js has zero deps.
 *
 * @license MIT
 */

import { Arena } from '../Arena.js';
import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

// --- config -----------------------------------------------------------------

const CAP = 4096;            // arena capacity (== 2^12, so dense[i] via i & MASK)
const CYCLES = 4096;         // Phase A create/dispose cycles
const N = 64;                // entities spawned per cycle
const HOT_OPS_MIN = 200000;  // Phase B: minimum typed-array iterations
const RULES = { maxMajor: 0, maxPauseMs: 4 };

// Low 20 bits of a handle are the slot index -- a primitive. Must match the
// INDEX_MASK in Arena.js. We derive the slot from the raw 32-bit handle rather
// than decomposing anything the arena hands us structurally.
const INDEX_MASK = 0xFFFFF;

// Skip every despawn -- the deliberately leaky control. See file header.
const LEAK = process.env.ARENA_TORTURE_LEAK === '1';

// Shared no-op release. Passed as the lite-leak cleanup so the tracked record
// closes over NOTHING: no entity object, no per-entity closure. The record is
// keyed by the raw slot (a primitive tag), which is the whole point -- a held
// value that referenced its target would pin it forever and the finalizer
// could never fire. See @zakkster/lite-cleanup's held-value contract.
const NOOP = function () {};

// --- helpers -----------------------------------------------------------------

function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg + '\n');
    process.exit(1);
}

// --- Phase A: retention ------------------------------------------------------

function phaseA() {
    const arena = new Arena(CAP);
    const cx = arena.registerComponent({ x: Float32Array });
    const cy = arena.registerComponent({ y: Float32Array });
    const cz = arena.registerComponent({ z: Float32Array });
    const tracker = createLeakTracker({ name: 'arena-retention' });

    // Bookkeeping allocated ONCE, outside the cycle loop. leakHandles[slot]
    // holds the lite-leak handle (an object) for the entity currently in that
    // slot, or null. Indexed by the raw slot primitive -- never a closure over
    // the entity or its resource.
    const leakHandles = new Array(CAP).fill(null);
    const live = new Uint32Array(N); // handles spawned this cycle

    for (let cycle = 0; cycle < CYCLES; cycle++) {
        for (let i = 0; i < N; i++) {
            // In the leaky variant nothing is ever despawned, so the arena fills
            // and stays full. Stop before OOM so the failure is the gate, not a
            // thrown spawn(). The clean variant despawns each cycle and never
            // approaches capacity, so this guard never trips there.
            if (arena.activeCount >= CAP) break;

            const e = arena.spawn();
            live[i] = e;
            cx.add(e);
            cy.add(e);
            cz.add(e);

            const slot = e & INDEX_MASK; // primitive
            // The tracked resource models the classic ECS leak: a JS object
            // associated with an entity that outlives it if never released.
            const resource = { slot };
            leakHandles[slot] = tracker.track(resource, NOOP, slot);
        }

        if (LEAK) continue; // control: skip dispose entirely.

        for (let i = 0; i < N; i++) {
            const e = live[i];
            const slot = e & INDEX_MASK;
            tracker.untrack(leakHandles[slot]);
            leakHandles[slot] = null;
            arena.despawn(e);
        }
    }

    return { activeCount: arena.activeCount, trackerSize: tracker.size() };
}

// --- Phase B: GC budget ------------------------------------------------------

async function phaseB() {
    const arena = new Arena(CAP);
    const pos = arena.registerComponent({
        x: Float32Array, y: Float32Array,
        vx: Float32Array, vy: Float32Array,
    });

    // Pre-spawn to capacity OUTSIDE the measured loop.
    for (let i = 0; i < CAP; i++) pos.add(arena.spawn());

    const count = pos.count; // === CAP
    const X = pos.data.x, Y = pos.data.y, VX = pos.data.vx, VY = pos.data.vy;
    for (let i = 0; i < count; i++) {
        X[i] = i * 0.5; Y[i] = -i; VX[i] = 1.0; VY[i] = 0.25;
    }

    // How many full ticks over dense[0..count) reach the >=200k floor.
    const ticks = Math.ceil(HOT_OPS_MIN / count);

    // Clear Phase A garbage BEFORE the observation window opens, so a scavenge
    // of it inside the window cannot be misread as this phase allocating.
    globalThis.gc();
    globalThis.gc();

    const gc = new GcProfiler(256, { heap: true }).start();
    gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);

    // HOT PATH: dense[0..count) typed-array reads/writes only. No idx() safety,
    // no allocation, no property chains inside the loop. `acc` is read after so
    // V8 cannot dead-code the body.
    let acc = 0;
    for (let t = 0; t < ticks; t++) {
        for (let i = 0; i < count; i++) {
            X[i] = X[i] + VX[i];
            Y[i] = Y[i] + VY[i];
            acc = acc + X[i] - Y[i];
        }
    }

    const mu = process.memoryUsage();
    gc.sampleHeap(performance.now(), mu.heapUsed, mu);

    // Read the summary only after an awaited settle tick: drains the observer
    // queue so no GC entry from the window is still in flight.
    await gc.settle();
    const summary = gc.summary();
    gc.stop();

    if (!Number.isFinite(acc)) die('hot tick produced a non-finite accumulator');

    return { report: checkNoGc(summary, RULES), summary, ticks, count };
}

// --- gate --------------------------------------------------------------------

async function main() {
    if (typeof globalThis.gc !== 'function') {
        die('run with --expose-gc:  node --expose-gc test/torture.mjs');
    }

    const a = phaseA();
    const b = await phaseB();

    const retentionOk = a.activeCount === 0 && a.trackerSize === 0;
    const budgetOk = b.report.ok;

    if (retentionOk && budgetOk) {
        process.stdout.write('ok\n');
        process.exit(0);
    }

    // Diagnostics on failure only -- stdout stays exactly "ok" on pass.
    if (!retentionOk) {
        process.stderr.write(
            'torture: retention -- activeCount=' + a.activeCount +
            ' trackerSize=' + a.trackerSize + ' (both must be 0)\n');
    }
    if (!budgetOk) {
        const g = b.summary.gc;
        process.stderr.write(
            'torture: budget -- verdict=' + b.report.verdict +
            ' source=' + b.summary.source +
            ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
            ' (rules ' + JSON.stringify(RULES) + ')\n');
    }
    die('gate rejected' + (LEAK ? ' (leaky control -- expected)' : ''));
}

main();
