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
 *   Phase C (join zero-alloc) -- call arena.join(a, b) HOT_OPS_MIN times in a
 *     loop and prove it allocates nothing. join() is a cold-path planner that
 *     hands back a reused scratch object (not an iterator, not a fresh object),
 *     so a tight loop over it must show zero major GC under the same rules. If
 *     join() ever regressed to allocating per call, this window would light up.
 *
 *   Phase D (reserve, then hot) -- fill to capacity, call arena.reserve() to
 *     grow the universe BETWEEN frames (a cold op that itself allocates new
 *     backing buffers -- that is fine), then spawn into the grown region and run
 *     the same hot tick. reserve() must leave the arena in a state where the hot
 *     path still allocates nothing: the measured window opens AFTER the grow, so
 *     a pass proves growth is a one-time cold cost and never leaks into the loop.
 *
 *   Phase E (handle-space sweep) -- the AR-01 corruption gate. A handle is
 *     `(gen << 20) | index`, a SIGNED int that goes NEGATIVE at generation 2048,
 *     so `dense` must be an Int32Array or every SparseSet compare (`dense[i] ===
 *     entity`) silently goes false past that boundary. For generations bracketing
 *     the sign bit -- {1, 2047, 2048, 2049, 4094, 4095} -- drive a slot to that
 *     exact generation and assert the FULL SparseSet contract (add is stable and
 *     idempotent, has is true, idx matches, remove detaches, count returns to 0,
 *     and despawn cascades across three registered components). Swept over many
 *     slot indices, not just slot 0. This phase FAILS (exits non-zero) if `dense`
 *     is ever reverted to Uint32Array -- it is its own control, no env flag
 *     needed. (Named Phase E, not D: Phase D is the pre-existing reserve gate
 *     shipped in 1.4.0; renaming it would falsify that CHANGELOG entry.)
 *
 *   Phase F (retirement soak) -- the AR-05 observability gate. Retire every slot
 *     of a small arena by churning one slot at a time to generation exhaustion,
 *     then clear() it. After EVERY spawn and despawn it asserts the conservation
 *     law `activeCount + retiredCount + freeListLength === capacity` (free length
 *     walked independently from the head) and that `remainingCapacity()` equals
 *     that walked length exactly -- so remainingCapacity() cannot drift from the
 *     real free count. It also asserts the exhaustion throw NAMES retirement when
 *     the arena is empty-but-retired, and that clear() revives every retired slot
 *     back to full capacity. Self-controlling: any off-by-one in remainingCapacity
 *     /retirement/clear trips a die(). (Named Phase F: E is the handle sweep above
 *     and D is the reserve gate, both already shipped under those names.)
 *
 *   Phase G (caller-supplied buffers) -- the S5 (1.7.0) gate. Runs the Phase B
 *     hot tick over a 4-field component TWICE: once own-allocated, once backed by
 *     caller-supplied SharedArrayBuffers via registerComponent(schema,{buffers}).
 *     Both are gated at maxMajor:0 / maxPauseMs:4 AND maxArrayBuffersGrowth:0
 *     (measureOps with stabilize:'deep', which is what the profiler's external
 *     arrayBuffers channel needs to be gateable). It proves two things: the
 *     caller-backed hot path allocates nothing -- not on the heap, and not a
 *     single new backing buffer -- and the SAB path is byte-for-byte as quiet as
 *     own-allocation. The gate can see SAB: process.memoryUsage().arrayBuffers
 *     counts a SharedArrayBuffer identically to an ArrayBuffer, so a per-frame
 *     buffer allocation on the shared path would light up growthBytes.
 *
 *   Phase H (transfer round-trip) -- the S6 (1.8.0) gate. Simulates the arena
 *     side of a transferable-ArrayBuffer ping-pong: each of H_FRAMES frames calls
 *     detach(['x']) (the send leg) then rebind({ x }) re-viewing the same buffer
 *     (the return leg), with no worker and no copy. The property gated is
 *     ZERO-COPY: rebind views the EXISTING buffer, allocating no new backing
 *     buffer, so process arrayBuffers must not grow. Gated at RULES_SAB
 *     (maxArrayBuffersGrowth:0) with stabilize:'deep' -- the same synchronously
 *     readable channel as Phase G (a GC-event count reads 0 inside a sync
 *     measureOps window, so the arrayBuffers channel, not maxMajor, is the
 *     load-bearing rule). Its control is ARENA_TORTURE_HLEAK=1 (below).
 *
 * A pass means something only if the gate can fail. Run
 *
 *     ARENA_TORTURE_LEAK=1 node --expose-gc test/torture.mjs    (Phase A/retention)
 *     ARENA_TORTURE_HLEAK=1 node --expose-gc test/torture.mjs   (Phase H/transfer)
 *
 * ARENA_TORTURE_LEAK skips every despawn: the retention oracles stay non-zero and
 * the process exits non-zero. ARENA_TORTURE_HLEAK injects a retained per-frame
 * allocation into Phase H's hand-off loop, tripping maxMajor. Either is the
 * control -- see CHANGELOG.md and the DONE-WHEN.
 *
 * Peers are devDependencies, never runtime deps: Arena.js has zero deps.
 *
 * @license MIT
 */

import { Arena } from '../Arena.js';
import { GcProfiler, checkNoGc, measureOps } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

// --- config -----------------------------------------------------------------

const CAP = 4096;            // arena capacity (== 2^12, so dense[i] via i & MASK)
const CYCLES = 4096;         // Phase A create/dispose cycles
const N = 64;                // entities spawned per cycle
const HOT_OPS_MIN = 200000;  // Phase B: minimum typed-array iterations
const RULES = { maxMajor: 0, maxPauseMs: 4 };

// Low 20 bits of a handle are the slot index -- a primitive. Must match the
// INDEX_MASK in Arena.js. We derive the slot from the raw 32-bit handle rather
// than decomposing anything the arena hands us structurally. INDEX_MASK also
// doubles as the free-list terminator sentinel (see Arena.js).
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

// --- Phase C: join zero-alloc ------------------------------------------------

async function phaseC() {
    const arena = new Arena(CAP);
    const big = arena.registerComponent({ x: Float32Array }); // larger count
    const rare = arena.registerTag();                         // smaller count

    // Pre-populate OUTSIDE the measured loop: big gets every entity, rare a
    // sparse subset, so join() must consistently pick `rare` as the driver.
    for (let i = 0; i < CAP; i++) {
        const e = arena.spawn();
        big.add(e);
        if ((i & 63) === 0) rare.add(e);
    }

    globalThis.gc();
    globalThis.gc();

    const gc = new GcProfiler(256, { heap: true }).start();
    gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);

    // HOT-ish loop: call the cold planner HOT_OPS_MIN times. It hands back a
    // reused scratch, so this must allocate nothing. Read fields into `acc` so
    // V8 cannot dead-code the calls, and assert the driver is always the rarer.
    let acc = 0;
    let driverAlwaysRare = true;
    for (let i = 0; i < HOT_OPS_MIN; i++) {
        const j = arena.join(big, rare);
        if (j.driver !== rare) driverAlwaysRare = false;
        acc = acc + j.count;
    }

    const mu = process.memoryUsage();
    gc.sampleHeap(performance.now(), mu.heapUsed, mu);

    await gc.settle();
    const summary = gc.summary();
    gc.stop();

    if (acc !== HOT_OPS_MIN * rare.count) die('join loop miscounted (acc=' + acc + ')');
    if (!driverAlwaysRare) die('join picked the larger component as driver');

    return { report: checkNoGc(summary, RULES), summary };
}

// --- Phase D: reserve is cold, the tick after it is still zero-major ----------

async function phaseD() {
    // Start at HALF the working capacity so reserve() has room to double.
    const startCap = CAP >> 1;
    const arena = new Arena(startCap);
    const pos = arena.registerComponent({
        x: Float32Array, y: Float32Array,
        vx: Float32Array, vy: Float32Array,
    });

    // Fill to the OLD capacity, then grow explicitly BETWEEN "frames". reserve()
    // reallocates every backing buffer -- a legitimate cold-path allocation.
    for (let i = 0; i < startCap; i++) pos.add(arena.spawn());
    if (!arena.reserve(CAP)) die('reserve failed to grow the arena');
    if (arena.capacity !== CAP) die('reserve left capacity=' + arena.capacity);
    if (pos.count !== startCap) die('reserve changed component count');

    // Spawn into the freshly reserved slots so the hot tick exercises the grown
    // region, not just the copied prefix.
    for (let i = 0; i < CAP - startCap; i++) pos.add(arena.spawn());
    const count = pos.count; // === CAP

    // Re-hoist AFTER reserve: the pre-grow refs are stale by design.
    const X = pos.data.x, Y = pos.data.y, VX = pos.data.vx, VY = pos.data.vy;
    for (let i = 0; i < count; i++) {
        X[i] = i * 0.5; Y[i] = -i; VX[i] = 1.0; VY[i] = 0.25;
    }

    const ticks = Math.ceil(HOT_OPS_MIN / count);

    // Clear the reserve()/spawn garbage BEFORE opening the window, so freeing it
    // inside the window cannot be misread as the hot tick allocating.
    globalThis.gc();
    globalThis.gc();

    const gc = new GcProfiler(256, { heap: true }).start();
    gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);

    // HOT PATH over the grown arrays -- identical shape to Phase B.
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

    await gc.settle();
    const summary = gc.summary();
    gc.stop();

    if (!Number.isFinite(acc)) die('post-reserve hot tick produced a non-finite accumulator');

    return { report: checkNoGc(summary, RULES), summary };
}

// --- Phase E: handle-space sweep (the AR-01 corruption gate) ------------------

// Drive `slot` to exactly `targetGen` on a fresh arena, then prove the full
// SparseSet contract holds over the resulting handle -- which is NEGATIVE for
// gen >= 2048. Fails (via die) the instant a compare over a signed handle goes
// wrong, i.e. the instant `dense` is not an Int32Array.
function sweepSlotAtGen(slot, targetGen, slots) {
    const arena = new Arena(slots + 2);
    const a = arena.registerComponent({ x: Float32Array });
    const b = arena.registerComponent({ y: Float32Array });
    const tag = arena.registerTag();

    // Occupy slots 0..slot-1 so the next spawn lands on `slot`. The free list is
    // LIFO, so once `slot` is in play, despawn+spawn churns THAT slot in place
    // (the held slots stay put), advancing only its generation.
    for (let j = 0; j < slot; j++) arena.spawn();

    let h = arena.spawn(); // `slot`, generation 1
    if ((h & INDEX_MASK) !== slot) {
        die('phaseE: expected slot ' + slot + ', got ' + (h & INDEX_MASK));
    }
    for (let gen = 1; gen < targetGen; gen++) {
        arena.despawn(h);  // returns `slot` to the free head, bumps its generation
        h = arena.spawn(); // pops `slot` again (LIFO)
    }

    // Sign-bit expectation: the handle is negative iff generation >= 2048.
    const shouldBeNeg = targetGen >= 2048;
    if ((h < 0) !== shouldBeNeg) {
        die('phaseE: slot ' + slot + ' gen ' + targetGen + ' sign wrong (handle=' + h + ')');
    }
    if (!arena.isAlive(h)) {
        die('phaseE: slot ' + slot + ' gen ' + targetGen + ' not alive');
    }

    // The full SparseSet contract over this (possibly negative) handle.
    const di = a.add(h);
    if (di < 0)           die('phaseE: add() returned -1 at slot ' + slot + ' gen ' + targetGen);
    if (!a.has(h))        die('phaseE: has() false for a live member at slot ' + slot + ' gen ' + targetGen);
    if (a.idx(h) !== di)  die('phaseE: idx() mismatch at slot ' + slot + ' gen ' + targetGen);
    if (a.add(h) !== di)  die('phaseE: add() not idempotent at slot ' + slot + ' gen ' + targetGen);
    if (a.count !== 1)    die('phaseE: duplicate appended at slot ' + slot + ' gen ' + targetGen);

    b.add(h); tag.add(h);
    if (!b.has(h) || !tag.has(h)) {
        die('phaseE: multi-component attach failed at slot ' + slot + ' gen ' + targetGen);
    }

    // join() over sets built from a high-gen (negative) handle: counts drive the
    // planner, and a broken has/add would have corrupted them. driver.dense[0]
    // must round-trip the signed handle.
    const jr = arena.join(a, b);
    if (jr.count !== 1 || jr.driver.dense[0] !== h) {
        die('phaseE: join() wrong over a high-gen handle at slot ' + slot + ' gen ' + targetGen);
    }

    if (!a.remove(h))     die('phaseE: remove() false at slot ' + slot + ' gen ' + targetGen);
    if (a.count !== 0)    die('phaseE: count != 0 after remove at slot ' + slot + ' gen ' + targetGen);
    if (a.has(h))         die('phaseE: has() true after remove at slot ' + slot + ' gen ' + targetGen);

    // despawn() must cascade across every registered component. Re-attach first.
    a.add(h);
    if (!arena.despawn(h)) die('phaseE: despawn() false at slot ' + slot + ' gen ' + targetGen);
    if (a.count !== 0 || b.count !== 0 || tag.count !== 0) {
        die('phaseE: despawn cascade left a component non-empty at slot ' + slot + ' gen ' + targetGen);
    }
}

function phaseE() {
    // Generations bracketing the sign-bit boundary (2048): below, on, just past,
    // and the top of the live range.
    const GENS = [1, 2047, 2048, 2049, 4094, 4095];
    const SLOTS = 8; // sweep several distinct slot indices, not just slot 0

    for (let slot = 0; slot < SLOTS; slot++) {
        for (let g = 0; g < GENS.length; g++) {
            sweepSlotAtGen(slot, GENS[g], SLOTS);
        }
    }
    return { ok: true };
}

// --- Phase F: retirement soak + conservation law (the AR-05 observability gate) ---

// Independently recomputed free-list length: walk the implicit free list from
// the head to the INDEX_MASK sentinel. O(capacity). This is the third term of
// the conservation law and is derived WITHOUT trusting remainingCapacity() -- so
// the two can be cross-checked against each other.
function freeListLength(arena) {
    let len = 0;
    let node = arena.freeHead;
    const cap = arena.capacity;
    while (node !== INDEX_MASK) {
        len++;
        if (len > cap) die('phaseF: free list exceeds capacity -- cycle detected');
        node = arena.freeList[node];
    }
    return len;
}

// The invariant every slot obeys: it is in exactly one of three states, so
// active + retired + free === capacity, always. And remainingCapacity() (a field
// computation) must equal the independently-walked free-list length.
function assertConservation(arena, where) {
    const free = freeListLength(arena);
    const sum = arena.activeCount + arena.retiredCount + free;
    if (sum !== arena.capacity) {
        die('phaseF: conservation broken ' + where + ' -- active=' + arena.activeCount +
            ' retired=' + arena.retiredCount + ' free=' + free + ' cap=' + arena.capacity +
            ' (sum=' + sum + ')');
    }
    if (arena.remainingCapacity() !== free) {
        die('phaseF: remainingCapacity=' + arena.remainingCapacity() +
            ' != freeListLength=' + free + ' ' + where);
    }
}

function phaseF() {
    const CAP_F = 6;
    const arena = new Arena(CAP_F);
    const comp = arena.registerComponent({ x: Float32Array });
    const tag = arena.registerTag();

    assertConservation(arena, 'at start');
    if (arena.remainingCapacity() !== CAP_F) die('phaseF: fresh remainingCapacity != capacity');

    // (1) Mixed spawn/despawn prelude -- the conservation law holds on the
    // ordinary (non-retiring) path too, checked after every single op.
    const held = [];
    for (let i = 0; i < CAP_F; i++) {
        const e = arena.spawn();
        comp.add(e); tag.add(e);
        held.push(e);
        assertConservation(arena, 'prelude spawn ' + i);
    }
    while (held.length) {
        arena.despawn(held.pop());
        assertConservation(arena, 'prelude despawn');
    }
    if (arena.remainingCapacity() !== CAP_F) die('phaseF: prelude did not fully drain');

    // (2) Retirement grind -- retire EVERY slot, checking conservation and
    // remainingCapacity() after every spawn and every despawn. LIFO churn hammers
    // one head slot at a time until the despawn that exhausts its generations
    // retires it (gen-agnostic: we watch retiredCount rather than counting cycles,
    // so a slot entering at any generation is handled). remainingCapacity() must
    // tick down by exactly one per retirement even though activeCount returns to 0.
    let retiredSoFar = 0;
    while (arena.remainingCapacity() > 0) {
        let h = arena.spawn();
        comp.add(h);
        assertConservation(arena, 'grind spawn');
        for (;;) {
            const before = arena.retiredCount;
            arena.despawn(h);
            assertConservation(arena, 'grind despawn');
            if (arena.retiredCount > before) break; // that despawn retired the slot
            h = arena.spawn();                       // LIFO: the very same slot again
            comp.add(h);
            assertConservation(arena, 'grind respawn');
        }
        retiredSoFar++;
        if (arena.retiredCount !== retiredSoFar) {
            die('phaseF: retiredCount=' + arena.retiredCount + ' expected ' + retiredSoFar);
        }
        if (arena.remainingCapacity() !== CAP_F - retiredSoFar) {
            die('phaseF: remainingCapacity=' + arena.remainingCapacity() +
                ' expected ' + (CAP_F - retiredSoFar) + ' after ' + retiredSoFar + ' retirements');
        }
    }

    // (3) Fully retired: empty yet exhausted, and the throw must NAME retirement.
    if (arena.activeCount !== 0) die('phaseF: activeCount != 0 after full retirement');
    if (arena.retiredCount !== CAP_F) die('phaseF: retiredCount != capacity after full retirement');
    if (arena.remainingCapacity() !== 0) die('phaseF: remainingCapacity != 0 after full retirement');
    let msg = '';
    try { arena.spawn(); } catch (err) { msg = err.message; }
    if (!/out of memory/.test(msg) || !/retired/i.test(msg)) {
        die('phaseF: exhaustion throw did not name retirement: ' + JSON.stringify(msg));
    }

    // (4) clear() restores the arena to full capacity and re-opens every slot,
    // reviving the retired ones -- the conservation law holds again afterward.
    arena.clear();
    assertConservation(arena, 'after clear');
    if (arena.activeCount !== 0)             die('phaseF: clear left activeCount != 0');
    if (arena.retiredCount !== 0)            die('phaseF: clear did not revive retired slots');
    if (arena.remainingCapacity() !== CAP_F) die('phaseF: clear did not restore full capacity');
    if (comp.count !== 0 || tag.count !== 0) die('phaseF: clear did not empty components');
    for (let i = 0; i < CAP_F; i++) {
        const e = arena.spawn();
        if (!arena.isAlive(e)) die('phaseF: slot not spawnable after clear');
        assertConservation(arena, 'post-clear spawn ' + i);
    }
    if (arena.remainingCapacity() !== 0) die('phaseF: arena not full after respawning all slots post-clear');

    return { ok: true };
}

// --- Phase G: caller-supplied buffers (the S5 / 1.7.0 gate) -------------------

const RULES_SAB = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

// Build a filled 4-field component whose payload is either own-allocated or
// backed by four caller-supplied SharedArrayBuffers -- the ONLY difference is the
// { buffers } option, which is exactly the point. Returns the hoisted typed-array
// refs so the measured tick touches no property chains.
function buildTickWorkload(useSab) {
    const arena = new Arena(CAP);
    const schema = { x: Float32Array, y: Float32Array, vx: Float32Array, vy: Float32Array };
    let comp;
    if (useSab) {
        const bpe = Float32Array.BYTES_PER_ELEMENT;
        comp = arena.registerComponent(schema, {
            buffers: {
                x: new SharedArrayBuffer(CAP * bpe),
                y: new SharedArrayBuffer(CAP * bpe),
                vx: new SharedArrayBuffer(CAP * bpe),
                vy: new SharedArrayBuffer(CAP * bpe),
            },
        });
        if (!comp._callerBacked) die('phaseG: SAB component is not flagged caller-backed');
        if (!(comp.data.x.buffer instanceof SharedArrayBuffer)) {
            die('phaseG: SAB component data.x does not view a SharedArrayBuffer');
        }
    } else {
        comp = arena.registerComponent(schema);
    }
    for (let i = 0; i < CAP; i++) comp.add(arena.spawn());
    const count = comp.count;
    const X = comp.data.x, Y = comp.data.y, VX = comp.data.vx, VY = comp.data.vy;
    for (let i = 0; i < count; i++) { X[i] = i * 0.5; Y[i] = -i; VX[i] = 1.0; VY[i] = 0.25; }
    return { count, X, Y, VX, VY };
}

// Measure one variant's hot tick and gate it. measureOps(stabilize:'deep')
// forces the double settle the external arrayBuffers channel needs to report a
// gateable growthBytes; source:'gc' reads process.memoryUsage() (where SAB is
// counted). acc is read after so V8 cannot dead-code the body.
function measureTickVariant(useSab) {
    const w = buildTickWorkload(useSab);
    const count = w.count, X = w.X, Y = w.Y, VX = w.VX, VY = w.VY;
    let acc = 0;
    const res = measureOps(function () {
        for (let i = 0; i < count; i++) {
            X[i] = X[i] + VX[i];
            Y[i] = Y[i] + VY[i];
            acc = acc + X[i] - Y[i];
        }
    }, { ops: Math.ceil(HOT_OPS_MIN / count), warmup: 8, source: 'gc', stabilize: 'deep' });
    if (!Number.isFinite(acc)) die('phaseG: non-finite accumulator (useSab=' + useSab + ')');
    return checkNoGc(res.summary, RULES_SAB);
}

function phaseG() {
    const own = measureTickVariant(false); // own-allocated payload
    const sab = measureTickVariant(true);  // caller-supplied SAB payload
    return { ok: own.ok && sab.ok, own, sab };
}

// --- Phase H: transferable round-trip hand-off (the S6 / 1.8.0 gate) ----------

// The arena-side cost of ONE ping-pong frame, with NO worker: detach(['x'])
// collects the field buffer (the send leg) and rebind({ x }) re-views the same
// buffer (the return leg). The property that matters is ZERO-COPY: rebind builds
// a length-bounded view over the EXISTING buffer, allocating no new backing
// buffer, so the process arrayBuffers total must not grow across many frames.
// That is what this phase gates -- RULES_SAB (maxArrayBuffersGrowth:0), the same
// synchronously-readable channel Phase G uses (a GC-event count is delivered
// async and reads 0 inside a sync measureOps window, so maxMajor cannot be the
// load-bearing rule here; the arrayBuffers channel can). stabilize:'deep' forces
// the double settle that channel needs to report a gateable growthBytes.
//
// Control: ARENA_TORTURE_HLEAK=1 injects a RETAINED Float64Array per frame; its
// backing buffer counts in arrayBuffers, so the total grows and
// maxArrayBuffersGrowth:0 trips -- proving the phase is load-bearing (exactly how
// Phase G was proven with an injected per-op ArrayBuffer).
const HLEAK = process.env.ARENA_TORTURE_HLEAK === '1';
const H_FRAMES = 20000;   // simulated frames of detach+rebind hand-off
const hSink = [];         // retains the control's per-frame allocations

function phaseH() {
    const arena = new Arena(CAP);
    const comp = arena.registerComponent({ x: Float32Array });
    for (let i = 0; i < CAP; i++) comp.add(arena.spawn());
    const count = comp.count;
    const X0 = comp.data.x;
    for (let i = 0; i < count; i++) X0[i] = i * 0.5;

    let sum = 0;
    const res = measureOps(function () {
        // One frame's hand-off: send leg (detach) + return leg (rebind), the same
        // buffer round-tripped in place -- no structuredClone, so this measures the
        // ARENA's per-frame cost, not the platform's copy.
        const bufs = comp.detach(['x']);
        comp.rebind({ x: bufs[0] });
        // Touch the rebound view so V8 cannot dead-code the rebind away.
        const x = comp.data.x;
        sum = sum + x[0] + x[count - 1];
        if (HLEAK) hSink.push(new Float64Array(4096)); // control: retained per-frame alloc
    }, { ops: H_FRAMES, warmup: 8, source: 'gc', stabilize: 'deep' });

    if (!Number.isFinite(sum)) die('phaseH: non-finite accumulator');
    // The invariant the phase leans on: after a detach + rebind of the same
    // buffer, the field is live (not detached) and its data survived untouched.
    if (comp.isDetached('x')) die('phaseH: field left detached after rebind');
    if (comp.data.x[count - 1] !== (count - 1) * 0.5) die('phaseH: rebind corrupted payload');
    return checkNoGc(res.summary, RULES_SAB);
}

// --- gate --------------------------------------------------------------------

async function main() {
    if (typeof globalThis.gc !== 'function') {
        die('run with --expose-gc:  node --expose-gc test/torture.mjs');
    }

    const a = phaseA();
    const b = await phaseB();
    const c = await phaseC();
    const d = await phaseD();
    // Phases E and F self-report via die() on any failure, so reaching here means
    // the handle-space sweep and the retirement soak both passed. Included in the
    // gate for symmetry.
    const e = phaseE();
    const f = phaseF();
    const g = phaseG();
    const h = phaseH();

    const retentionOk = a.activeCount === 0 && a.trackerSize === 0;
    const budgetOk = b.report.ok;
    const joinOk = c.report.ok;
    const reserveOk = d.report.ok;
    const sweepOk = e.ok;
    const conservationOk = f.ok;
    const sabOk = g.ok;
    const transferOk = h.ok;

    if (retentionOk && budgetOk && joinOk && reserveOk && sweepOk && conservationOk && sabOk && transferOk) {
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
    if (!joinOk) {
        const g = c.summary.gc;
        process.stderr.write(
            'torture: join -- verdict=' + c.report.verdict +
            ' source=' + c.summary.source +
            ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
            ' (rules ' + JSON.stringify(RULES) + ')\n');
    }
    if (!reserveOk) {
        const gc = d.summary.gc;
        process.stderr.write(
            'torture: reserve -- verdict=' + d.report.verdict +
            ' source=' + d.summary.source +
            ' major=' + gc.major + ' maxMs=' + gc.maxMs.toFixed(3) +
            ' (rules ' + JSON.stringify(RULES) + ')\n');
    }
    if (!sabOk) {
        process.stderr.write(
            'torture: caller-buffers -- own verdict=' + g.own.verdict +
            ' checked=' + JSON.stringify(g.own.checked) +
            '; sab verdict=' + g.sab.verdict +
            ' checked=' + JSON.stringify(g.sab.checked) +
            ' (rules ' + JSON.stringify(RULES_SAB) + ')\n');
    }
    if (!transferOk) {
        process.stderr.write(
            'torture: transfer-roundtrip -- verdict=' + h.verdict +
            ' checked=' + JSON.stringify(h.checked) +
            ' (rules ' + JSON.stringify(RULES_SAB) + ')\n');
    }
    die('gate rejected' + (LEAK || HLEAK ? ' (leaky control -- expected)' : ''));
}

main();
