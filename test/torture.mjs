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
 *     It also runs a liveness CENSUS -- aliveCount(arena) === activeCount, where
 *     aliveCount brute-forces isAlive((g << 20) | i) over every slot i and every
 *     generation g in [0, 4095] -- at start, after the prelude, after each
 *     retirement, after clear() and after the post-clear refill. A free slot
 *     that answers to its next handle (the pre-ADR-0009 build: a fresh slot
 *     stores generation 1, so handle (1 << 20) | i was alive before any spawn)
 *     fails it as "phaseF: census at start". Its own control: the frozen pre-fix
 *     build exits 1 there.
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
 *   Phase I (joinN zero-alloc + oracle) -- the S7 (1.9.0) gate. Calls
 *     joinN(REQ, EXC) HOT_OPS_MIN times over a fixed population and runs the
 *     canonical k-way + exclusion match loop each call. joinN is a cold planner
 *     that hands back a REUSED scratch (result object + two grow-once arrays), so
 *     the window must be zero-major, gated at RULES (maxMajor:0) exactly like
 *     Phase C guards join(). Correctness rides along: the per-call match count is
 *     asserted against a brute-force oracle computed once, and the driver must
 *     always be the globally rarest required set. Its control is
 *     ARENA_TORTURE_JLEAK=1 (below).
 *
 *   Phase J (lifecycle churn zero-GC) -- the free-slot (ADR 0009) gate.
 *     200,000 iterations of spawn + component add + tag add + despawn on
 *     Arena(4096), recycling a 2048-handle ring, gated at RULES_J (maxMajor:0,
 *     maxMinor:0) under the same settle rules as B/C/D/I. About 100 cycles per
 *     slot, far under the 4094 that would retire one, so it measures churn, not
 *     retirement (retiredCount must stay 0). Since 1.10.0 a swapping remove()
 *     walks an indexed column cache (no for-in) and allocates nothing for <= 4
 *     column kinds, so the lifecycle path is gated at ZERO scavenges, not just
 *     zero majors. The wall-clock pause is REPORTED (one stderr line), never
 *     gated: counts are deterministic, a pause is host noise. The pre-1.10.0
 *     for-in build fails here on maxMinor. Its control is ARENA_TORTURE_SLEAK=1
 *     (below).
 *
 *   Phase K (flag row zero-GC + oracle) -- the 1.10.0 entity-flags gate.
 *     Arena(4096) full, registerFlags() with 32 names (bit 31 = -2147483648).
 *     64 frames x (4096 hoisted row reads `row[e & m]` + 4096 hasFlags() + 64
 *     despawn/spawn/setFlags) = 528,384 ops, gated at RULES_K (maxMajor:0,
 *     maxMinor:0). Every frame the row-read count and the hasFlags() count must
 *     equal an oracle count taken from the harness's own Int32Array mirror of
 *     the flag words. A retention leg then runs 4096 cycles x 64 spawn /
 *     setFlags(e, -1) / lite-leak track, untrack / despawn: tracker.size(),
 *     activeCount and the sum of every flag word must all return to 0. Its
 *     control is ARENA_TORTURE_FLEAK=1 (below).
 *
 *   Phase L (masked joinN zero-GC + oracle) -- the 1.10.0 flag-mask gate.
 *     Phase I's population on an arena with 32 registered flags, planned with
 *     joinN(REQ, EXC, f0|f31, f5) HOT_OPS_MIN times; each call runs the masked
 *     loop (has() checks + ONE hoisted row read `row[e & m]` per candidate) and
 *     its match count must equal a brute-force hasFlags() oracle (itself checked
 *     against the harness's own flag words; non-degenerate: 0 < masked <
 *     unmasked). Gated at RULES_L (maxMajor:0, maxMinor:0). A retention leg runs
 *     4096 cycles x 64 spawn / setFlags / lite-leak track / masked joinN, then
 *     untrack / despawn: tracker.size(), activeCount and the flag-word sum must
 *     return to 0. Then reserve(8192): after two awaited gc() passes a WeakRef to
 *     the old flag row must deref to undefined (the joinN scratch drops it) and a
 *     fresh plan's p.flags must be the new arena.flags. Its control is
 *     ARENA_TORTURE_MLEAK=1 (below).
 *
 *   Phase M (Hi flag word zero-GC + mirror oracle) -- the F1 second-word gate,
 *     Phase K and Phase L's twin for arena.flagsHi. Arena(4096) full with 32 + 32
 *     registered flags: 64 frames x (4096 two-row reads `row[e & m]` +
 *     `rowHi[e & m]` against all four masks + 4096 hasFlagsHi() + 64 despawn /
 *     spawn / setFlags / setFlagsHi) = 528,384 ops; then Phase L's population with
 *     a Hi word per entity, planned with joinN(REQ, EXC, reqMask, excMask,
 *     reqMaskHi, excMaskHi) HOT_OPS_MIN times (Hi bit 31 in reqMaskHi). Both
 *     windows are gated at RULES_M (maxMajor:0, maxMinor:0); every count must
 *     equal a mirror oracle built from the harness's own bookkeeping (never an
 *     arena read), with 0 < masked < unmasked. A retention leg runs 4096 cycles x
 *     64 spawn / setFlagsHi(e, -1) / lite-leak track / two-word joinN, then
 *     untrack / despawn: tracker.size(), activeCount and the OR of BOTH flag rows
 *     must return to 0. Then reserve(8192): a WeakRef to the old Hi row must deref
 *     to undefined after two awaited gc() passes. Its control is
 *     ARENA_TORTURE_WLEAK=1 (below).
 *
 *   Phase N (indexed flags + joinN hint zero-GC + mirror oracle) -- the F2 gate.
 *     registerFlags(names, { indexed }) / registerFlagsHi likewise: 4 indexed + 4
 *     plain word-0 flags (indexed f31 = bit 31) and 2 indexed + 2 plain Hi flags
 *     (indexed h31 = Hi bit 31). Five windows, each gated at RULES_N (maxMajor:0,
 *     maxMinor:0). N1: Arena(4096) full, 64 frames x 4096 seeded ops (setFlags /
 *     clearFlags / despawn+spawn / setFlagsHi / clearFlagsHi; op, slot and mask
 *     from three independent xorshift32 streams) = 262,144 ops, clearFlagAll +
 *     clearFlagAllHi in frame 7 of every 16, one firstFlagged / nextFlagged sweep
 *     per frame despawning every 8th visit (M-39), then an allocation-free oracle
 *     over the harness's own Int32Array mirrors: both rows == the mirrors, every
 *     flagCount == the mirror count, every walk == the mirror's live handles
 *     ascending (count + FNV-1a). N2: reserve(8192), fill the 4096 new slots, 16
 *     frames whose walks must visit a slot >= 4096. N3: clear() -> all 6
 *     flagCount 0 and firstFlagged -1, then refill + 16 frames inside the window.
 *     N4: a { checked: true } arena on the same stream (16 frames), then a
 *     non-int32 setFlags / setFlagsHi whose `| 0` is an indexed bit must throw
 *     with the row, count and walk unchanged. N5: Phase I's population with
 *     indexed f0 (a) and f31 (z); joinN(REQ, EXC, z|a) HOT_OPS_MIN times:
 *     driverFlag === z and, every call, the flag-driven loop count == the driver
 *     loop count == a brute-force count from index arithmetic. N6 (retention):
 *     4096 cycles x 64 spawn / setFlags / setFlagsHi / lite-leak track, untrack /
 *     despawn: tracker.size(), activeCount, every flagCount, every firstFlagged
 *     (-1) and the OR of both rows return to 0. An oracle mismatch dies after its
 *     window ("phaseN: column != row" when a count or walk disagrees with the
 *     rows). Its controls are ARENA_TORTURE_NLEAK=1, ARENA_TORTURE_NLEAK=hint and
 *     ARENA_TORTURE_NDESYNC=1 (below).
 *
 * A pass means something only if the gate can fail. Run
 *
 *     ARENA_TORTURE_LEAK=1 node --expose-gc test/torture.mjs    (Phase A/retention)
 *     ARENA_TORTURE_HLEAK=1 node --expose-gc test/torture.mjs   (Phase H/transfer)
 *     ARENA_TORTURE_JLEAK=1 node --expose-gc test/torture.mjs   (Phase I/joinN)
 *     ARENA_TORTURE_SLEAK=1 node --expose-gc test/torture.mjs   (Phase J/churn)
 *     ARENA_TORTURE_FLEAK=1 node --expose-gc test/torture.mjs   (Phase K/flags)
 *     ARENA_TORTURE_MLEAK=1 node --expose-gc test/torture.mjs   (Phase L/masked joinN)
 *     ARENA_TORTURE_WLEAK=1 node --expose-gc test/torture.mjs   (Phase M/two-word joinN)
 *     ARENA_TORTURE_NLEAK=1 node --expose-gc test/torture.mjs   (Phase N/N1 indexed ops)
 *     ARENA_TORTURE_NLEAK=hint node --expose-gc test/torture.mjs   (Phase N/N5 joinN hint)
 *     ARENA_TORTURE_NDESYNC=1 node --expose-gc test/torture.mjs   (Phase N/row-column desync)
 *
 * ARENA_TORTURE_LEAK skips every despawn: the retention oracles stay non-zero and
 * the process exits non-zero (Phase A, and the Phase K / Phase L / Phase M
 * retention legs and Phase N's N6).
 * ARENA_TORTURE_HLEAK injects a retained per-frame
 * allocation into Phase H's hand-off loop, tripping maxArrayBuffersGrowth.
 * ARENA_TORTURE_JLEAK retains a per-call allocation in Phase I's join loop,
 * tripping maxMajor. ARENA_TORTURE_SLEAK retains a per-iteration allocation in
 * Phase J's churn loop, tripping maxMajor. ARENA_TORTURE_FLEAK retains 4,096
 * Float64Array(4096) inside Phase K's window, tripping RULES_K. ARENA_TORTURE_MLEAK
 * retains a per-call allocation in Phase L's masked joinN loop, tripping RULES_L.
 * ARENA_TORTURE_WLEAK retains a per-call allocation in Phase M's two-word masked
 * joinN loop, tripping RULES_M.
 * ARENA_TORTURE_NLEAK=1 overwrites one sink slot with a fresh Int32Array(1) per
 * N1 op -- a TRANSIENT allocation, never retained -- and trips RULES_N's
 * maxMinor in N1 at the default 262,144-op window (14 scavenges on a solo run,
 * 28 with 6 runs in parallel; measured 2026-11-05, Node v26.8.2; semi-space not
 * pinned, so the count varies but is never 0; no enlargement needed).
 * ARENA_TORTURE_NLEAK=hint does the same once per N5 joinN call (200,000 calls;
 * 10 solo / 21 parallel scavenges, same runs).
 * ARENA_TORTURE_NDESYNC=1 ORs the indexed f0 bit straight into arena.flags
 * (bypassing setFlags; UNSUPPORTED, M-39) on one live slot at N1 frame 32 and
 * mirrors it, so the rows still equal the mirror and the run dies with
 * "phaseN: column != row".
 * Each is a control -- see CHANGELOG.md and the DONE-WHEN.
 *
 * Phase F runs FIRST, before Phase A, so its liveness census sees a fresh
 * process (no earlier phase's code warmed or shaped the arena paths it probes).
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

// Liveness census (the free-slot gate, ADR 0009). Counts every (slot, generation)
// pair the arena calls alive by brute force: i in [0, capacity), g in [0, 4095],
// handle (g << 20) | i. The oracle is the TRUE definition of "alive" -- it asks
// isAlive() about every handle that can exist, not just the ones spawn() issued
// -- so a free slot that still answers to its next generation counts as alive
// and breaks the equality with activeCount. O(capacity x 4096): keep CAP_F small.
function aliveCount(arena) {
    const cap = arena.capacity;
    let n = 0;
    for (let i = 0; i < cap; i++) {
        for (let g = 0; g <= 4095; g++) {
            if (arena.isAlive((g << 20) | i)) n++;
        }
    }
    return n;
}

function assertCensus(arena, where) {
    const alive = aliveCount(arena);
    if (alive !== arena.activeCount) {
        die('phaseF: census ' + where + ' -- aliveCount=' + alive +
            ' activeCount=' + arena.activeCount + ' (must be equal)');
    }
}

function phaseF() {
    const CAP_F = 6;
    const arena = new Arena(CAP_F);
    const comp = arena.registerComponent({ x: Float32Array });
    const tag = arena.registerTag();

    assertCensus(arena, 'at start');
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
    assertCensus(arena, 'after prelude');

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
        assertCensus(arena, 'after retirement ' + retiredSoFar);
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
    assertCensus(arena, 'after clear');
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
    assertCensus(arena, 'after post-clear refill');

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

// --- Phase I: joinN zero-alloc + oracle (the S7 / 1.9.0 gate) -----------------

// joinN() is the k-way generalization of join(): a cold planner that hands back
// a REUSED scratch (the result object plus two grow-once arrays), so calling it
// in a hot loop must allocate nothing once the scratch is at its high-water
// mark. This phase calls joinN(REQ, EXC) HOT_OPS_MIN times, runs the blessed
// match loop on every call, and gates the window at maxMajor:0 -- if joinN ever
// regressed to allocating per call (building the others/excl arrays fresh, say),
// this window would light up, exactly like Phase C guards join(). It also proves
// CORRECTNESS against a brute-force oracle computed ONCE: the per-call match
// count must equal the oracle on every iteration, and the driver must always be
// the globally rarest required set.
//
// Control: ARENA_TORTURE_JLEAK=1 retains a Float64Array per call into jSink; the
// growing heap forces a major GC and maxMajor:0 trips -- proving the phase is
// load-bearing, exactly as LEAK proves Phase A and HLEAK proves Phase H.
const JLEAK = process.env.ARENA_TORTURE_JLEAK === '1';
const jSink = [];         // retains the control's per-call allocations

async function phaseI() {
    const arena = new Arena(CAP);
    const A = arena.registerComponent({ x: Float32Array }); // required, largest
    const B = arena.registerTag();                          // required, half
    const C = arena.registerTag();                          // required, rarest -> driver
    const D = arena.registerTag();                          // excluded

    for (let i = 0; i < CAP; i++) {
        const e = arena.spawn();
        A.add(e);                        // A: every entity
        if ((i & 1) === 0) B.add(e);     // B: half
        if ((i & 63) === 0) C.add(e);    // C: sparse -> the consistent driver
        if ((i & 127) === 0) D.add(e);   // D: sparser still, excluded
    }

    const REQ = [A, B, C];   // hoisted ONCE, as a real system would
    const EXC = [D];

    // Brute-force oracle, computed ONCE outside the measured loop: walk the
    // rarest required set and count those in every required set and no excluded.
    let expected = 0;
    for (let i = 0; i < C.count; i++) {
        const e = C.dense[i];
        if (A.has(e) && B.has(e) && !D.has(e)) expected++;
    }

    globalThis.gc();
    globalThis.gc();

    const gc = new GcProfiler(256, { heap: true }).start();
    gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);

    // HOT-ish loop: plan with joinN and run the canonical k-way + exclusion match
    // every call. joinN hands back reused scratch, so this must allocate nothing.
    let acc = 0;
    let driverAlwaysRare = true;
    for (let n = 0; n < HOT_OPS_MIN; n++) {
        const p = arena.joinN(REQ, EXC);
        if (p.driver !== C) driverAlwaysRare = false;
        const drv = p.driver, cnt = p.count;
        const oth = p.others, no = p.othersCount;
        const ex = p.excl, nx = p.exclCount;
        let matched = 0;
        for (let i = 0; i < cnt; i++) {
            const e = drv.dense[i];
            let ok = true;
            for (let k = 0; k < no; k++) if (!oth[k].has(e)) { ok = false; break; }
            if (ok) for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
            if (ok) matched++;
        }
        acc = acc + matched;
        if (JLEAK) jSink.push(new Float64Array(4096)); // control: retained per-call alloc
    }

    const mu = process.memoryUsage();
    gc.sampleHeap(performance.now(), mu.heapUsed, mu);

    await gc.settle();
    const summary = gc.summary();
    gc.stop();

    if (!driverAlwaysRare) die('phaseI: joinN did not drive the globally rarest required set');
    if (acc !== expected * HOT_OPS_MIN) {
        die('phaseI: joinN match miscounted (acc=' + acc +
            ' expected=' + (expected * HOT_OPS_MIN) + ')');
    }

    return { report: checkNoGc(summary, RULES), summary };
}

// --- Phase J: spawn/add/despawn churn is zero-major (the free-slot gate) -------

// The free-slot flag (ADR 0009) puts one XOR + one store in spawn() and an OR in
// despawn()'s relink. This phase gates the lifecycle path itself -- not just the
// dense tick -- at zero GC: J_OPS iterations of spawn + component add + tag add +
// despawn on Arena(CAP), gated at RULES_J (maxMajor:0, maxMinor:0). Since 1.10.0
// the swap branch of remove() walks an indexed column cache (`_cols`) and
// allocates nothing for <= 4 column kinds, so not one scavenge is allowed. The
// wall-clock maxPauseMs is REPORTED on stderr, never gated (see file header).
// A ring of J_RING live handles (Int32Array, power-of-2 mask) is recycled
// oldest-first, so the LIFO free list rotates J_RING + 1 slots:
// each slot sees about (J_OPS + J_WARM) / (J_RING + 1) ~= 100 cycles, far under
// the 4094 that would retire it -- the phase measures churn, not retirement, and
// asserts retiredCount stays 0.
//
// Control: ARENA_TORTURE_SLEAK=1 retains a per-iteration allocation inside the
// window (sSink); the growing heap forces a major GC and maxMajor:0 trips.
const SLEAK = process.env.ARENA_TORTURE_SLEAK === '1';
const J_OPS = 200000;     // measured spawn+add+despawn iterations (>= HOT_OPS_MIN)
const J_WARM = 4096;      // unmeasured warm-up iterations, same body
const J_RING = 2048;      // live handles held while churning (power of 2)
const J_MASK = J_RING - 1;
const sSink = [];         // retains the control's per-iteration allocations
// Counts only: GC events in the window are deterministic for a zero-alloc body.
// No maxPauseMs here -- a wall-clock pause is host noise; it is reported instead.
const RULES_J = { maxMajor: 0, maxMinor: 0 };

// One churn run of `ops` iterations. ring/st are caller-owned typed arrays: st[0]
// is the ring head, st[1] counts despawns that returned false (must stay 0).
// Returns the bitwise OR of every add() result (so V8 cannot dead-code them):
// an add() returns a dense index >= 0 or -1, so the OR is negative iff some add()
// returned -1.
function jChurn(arena, comp, tag, ring, st, ops, leak) {
    let acc = 0;
    let head = st[0];
    for (let n = 0; n < ops; n++) {
        const e = arena.spawn();
        acc = acc | comp.add(e) | tag.add(e);
        if (!arena.despawn(ring[head])) st[1] = st[1] + 1;
        ring[head] = e;
        head = (head + 1) & J_MASK;
        if (leak) sSink.push(new Array(32)); // control: retained per-iteration alloc
    }
    st[0] = head;
    return acc;
}

async function phaseJ() {
    const arena = new Arena(CAP);
    const comp = arena.registerComponent({ x: Float32Array });
    const tag = arena.registerTag();
    const ring = new Int32Array(J_RING);
    const st = new Int32Array(2);

    for (let i = 0; i < J_RING; i++) {
        const e = arena.spawn();
        comp.add(e); tag.add(e);
        ring[i] = e;
    }
    jChurn(arena, comp, tag, ring, st, J_WARM, false);

    globalThis.gc();
    globalThis.gc();

    const gc = new GcProfiler(256, { heap: true }).start();
    gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);

    const acc = jChurn(arena, comp, tag, ring, st, J_OPS, SLEAK);

    const mu = process.memoryUsage();
    gc.sampleHeap(performance.now(), mu.heapUsed, mu);

    await gc.settle();
    const summary = gc.summary();
    gc.stop();

    if (st[1] !== 0) die('phaseJ: ' + st[1] + ' despawns of a ring handle returned false');
    if (!(acc >= 0)) die('phaseJ: negative add() checksum (an add() returned -1)');
    if (arena.retiredCount !== 0) die('phaseJ: churn retired ' + arena.retiredCount + ' slots');
    if (arena.activeCount !== J_RING) die('phaseJ: activeCount=' + arena.activeCount + ' expected ' + J_RING);
    if (comp.count !== J_RING || tag.count !== J_RING) {
        die('phaseJ: component/tag count drifted (comp=' + comp.count + ' tag=' + tag.count + ')');
    }
    for (let i = 0; i < J_RING; i++) {
        if (!arena.isAlive(ring[i]) || !comp.has(ring[i]) || !tag.has(ring[i])) {
            die('phaseJ: ring handle ' + i + ' not alive and attached after churn');
        }
    }

    return { report: checkNoGc(summary, RULES_J), summary };
}

// --- Phase K: entity flag row is zero-GC and agrees with an oracle (1.10.0) -------

// A full Arena(CAP) with 32 registered flags (bit 31 = -2147483648). Each of
// K_FRAMES frames runs the two documented read forms over every live entity --
// the hoisted row read `row[e & m]` (row = arena.flags, m = arena.indexMask) and
// arena.hasFlags(e, K_REQ, K_EXC) -- plus K_CHURN despawn / spawn / setFlags. The
// match counts of both read forms must equal, EVERY frame, an oracle count over
// the harness's own Int32Array mirror of the flag words (written from the masks
// the harness chose, never read back from the arena). The window is gated at
// RULES_K: zero major AND zero minor GC (the body allocates nothing: every value
// is an int32, which is a Smi on Node).
//
// Retention leg: K_CYCLES cycles x K_CHURN spawn / setFlags(e, -1) / lite-leak
// track, then untrack / despawn. tracker.size(), activeCount and the sum of every
// flag word must return to 0 (despawn zeroes the word). ARENA_TORTURE_LEAK=1
// skips the untrack/despawn here too, so this leg fails with Phase A.
//
// Control: ARENA_TORTURE_FLEAK=1 retains a Float64Array(4096) per churn op
// inside the window (K_FRAMES x K_CHURN = 4,096 of them, 128 MiB); RULES_K trips.
const FLEAK = process.env.ARENA_TORTURE_FLEAK === '1';
const K_FRAMES = 64;
const K_WARM = 8;          // unmeasured warm-up frames, same body
const K_CHURN = 64;        // despawn/spawn/setFlags per frame
const K_CYCLES = 4096;     // retention cycles
const K_REQ = (1 << 31) | (1 << 3);   // bit 31 in the required mask: -2147483640
const K_EXC = 1 << 5;
const K_OPS = K_FRAMES * (CAP + CAP + K_CHURN); // 528,384
const RULES_K = { maxMajor: 0, maxMinor: 0 };
const kSink = [];          // retains the control's per-op allocations

// One frame. hs: live handles (ring of CAP), mir: the oracle's flag mirror
// (slot-indexed), st: [0] churn cursor, [1] LCG state, [2] first mismatching
// frame + 1 (0 = none), [3] last row count, [4] last hasFlags count, [5] last
// oracle count. All state lives in caller-owned Int32Arrays: no allocation.
function kFrame(arena, hs, mir, st, frame, leak) {
    // Churn: replace K_CHURN entities with fresh ones carrying new random masks.
    let cur = st[0];
    let rng = st[1];
    for (let k = 0; k < K_CHURN; k++) {
        const old = hs[cur];
        arena.despawn(old);
        mir[old & INDEX_MASK] = 0;
        const e = arena.spawn();
        rng = (Math.imul(rng, 1664525) + 1013904223) | 0;
        arena.setFlags(e, rng);
        mir[e & INDEX_MASK] = mir[e & INDEX_MASK] | rng;
        hs[cur] = e;
        cur = (cur + 1) & (CAP - 1);
        if (leak) kSink.push(new Float64Array(4096)); // control: retained per-op alloc
    }
    st[0] = cur;
    st[1] = rng;

    // Read form 1: hoisted flag row.
    const row = arena.flags, m = arena.indexMask;
    let rowN = 0;
    for (let i = 0; i < CAP; i++) {
        const w = row[hs[i] & m];
        if ((w & K_REQ) === K_REQ && (w & K_EXC) === 0) rowN++;
    }
    // Read form 2: hasFlags().
    let hasN = 0;
    for (let i = 0; i < CAP; i++) {
        if (arena.hasFlags(hs[i], K_REQ, K_EXC)) hasN++;
    }
    // Oracle: the mirror, by the TRUE definition of a match.
    let orN = 0;
    for (let i = 0; i < CAP; i++) {
        const w = mir[i];
        if ((w & K_REQ) === K_REQ && (w & K_EXC) === 0) orN++;
    }
    if ((rowN !== orN || hasN !== orN) && st[2] === 0) st[2] = frame + 1;
    st[3] = rowN; st[4] = hasN; st[5] = orN;
}

async function phaseK() {
    const arena = new Arena(CAP);
    const names = [];
    for (let i = 0; i < 32; i++) names.push('f' + i);
    const F = arena.registerFlags(names);
    if (F.f31 !== -2147483648) die('phaseK: flag #31 is ' + F.f31 + ', expected -2147483648');
    if (F.f31 !== (1 << 31) || F.f3 !== 8 || F.f5 !== K_EXC) die('phaseK: flag map bits wrong');

    const hs = new Int32Array(CAP);
    const mir = new Int32Array(CAP);
    const st = new Int32Array(6);
    st[1] = 0x2545F491;
    let rng = st[1];
    for (let i = 0; i < CAP; i++) {
        const e = arena.spawn();
        rng = (Math.imul(rng, 1664525) + 1013904223) | 0;
        arena.setFlags(e, rng);
        mir[e & INDEX_MASK] = rng;
        hs[i] = e;
    }
    st[1] = rng;
    if (arena.activeCount !== CAP) die('phaseK: arena not full (' + arena.activeCount + ')');

    for (let f = 0; f < K_WARM; f++) kFrame(arena, hs, mir, st, f, false);
    if (st[2] !== 0) die('phaseK: warm-up frame ' + (st[2] - 1) + ' row/hasFlags/oracle = ' +
        st[3] + '/' + st[4] + '/' + st[5]);

    globalThis.gc();
    globalThis.gc();

    const gc = new GcProfiler(256, { heap: true }).start();
    gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);

    for (let f = 0; f < K_FRAMES; f++) kFrame(arena, hs, mir, st, f, FLEAK);

    const mu = process.memoryUsage();
    gc.sampleHeap(performance.now(), mu.heapUsed, mu);

    await gc.settle();
    const summary = gc.summary();
    gc.stop();

    if (st[2] !== 0) die('phaseK: frame ' + (st[2] - 1) + ' row/hasFlags/oracle counts disagree (last ' +
        st[3] + '/' + st[4] + '/' + st[5] + ')');
    if (!(st[5] > 0) || st[5] === CAP) die('phaseK: degenerate oracle count ' + st[5]);
    if (arena.activeCount !== CAP) die('phaseK: activeCount drifted to ' + arena.activeCount);
    kSink.length = 0;

    // Retention leg (unmeasured): its own empty arena with a flag row.
    const ra = new Arena(CAP);
    ra.registerFlags(['all']);
    const tracker = createLeakTracker({ name: 'arena-flags-retention' });
    const leakHandles = new Array(CAP).fill(null);
    const live = new Int32Array(K_CHURN);
    for (let cycle = 0; cycle < K_CYCLES; cycle++) {
        let n = 0;
        for (let i = 0; i < K_CHURN; i++) {
            if (ra.activeCount >= CAP) break; // LEAK control fills the arena: stop, do not throw
            const e = ra.spawn();
            if (!ra.setFlags(e, -1)) die('phaseK: setFlags false on a live entity');
            const slot = e & INDEX_MASK;
            leakHandles[slot] = tracker.track({ slot }, NOOP, slot);
            live[n++] = e;
        }
        if (LEAK) continue; // control: skip release entirely
        for (let i = 0; i < n; i++) {
            const e = live[i];
            const slot = e & INDEX_MASK;
            tracker.untrack(leakHandles[slot]);
            leakHandles[slot] = null;
            ra.despawn(e);
        }
    }
    let flagSum = 0;
    const rrow = ra.flags;
    for (let i = 0; i < CAP; i++) flagSum += rrow[i];

    return {
        report: checkNoGc(summary, RULES_K), summary,
        ops: K_OPS, trackerSize: tracker.size(), activeCount: ra.activeCount, flagSum,
    };
}

// --- Phase L: masked joinN is zero-GC and agrees with an oracle (1.10.0) ---------

// Phase I's population (same construction) on an arena with 32 registered flags,
// planned with joinN(REQ, EXC, L_RQ, L_XQ) HOT_OPS_MIN times. Every call runs the
// documented masked loop -- the others / excl has() checks plus ONE flag-row read
// `row[e & m]` per candidate (row = p.flags, m = arena.indexMask, rm = p.reqMask,
// xm = p.excMask, hoisted per call) -- and its match count must equal, EVERY call,
// a brute-force oracle taken once outside the window with arena.hasFlags(), itself
// cross-checked against the harness's own flag words (lFlagWord, never read back).
// The window is gated at RULES_L: zero major AND zero minor GC. The flag words
// split the unmasked matches into every (f0, f31, f5) combination, so a loop that
// ignores either mask bit, or the excluded mask, miscounts.
//
// Retention leg: L_CYCLES cycles x L_CHURN spawn / setFlags / lite-leak track /
// masked joinN (count checked against the harness's words), then untrack /
// despawn. tracker.size(), activeCount and the sum of every flag word must return
// to 0. ARENA_TORTURE_LEAK=1 skips the release here too. Then reserve(8192) on that
// arena: after two awaited gc() passes the OLD flag row must be unreachable (a
// WeakRef to it derefs to undefined -- the joinN scratch must not retain it), and a
// fresh plan's p.flags must be the new arena.flags.
//
// Control: ARENA_TORTURE_MLEAK=1 retains a per-call allocation inside the window
// (lSink); RULES_L trips.
const MLEAK = process.env.ARENA_TORTURE_MLEAK === '1';
const L_CYCLES = 4096;     // retention cycles
const L_CHURN = 64;        // entities spawned / tracked / released per cycle
const L_GROW = 8192;       // reserve() target after the retention leg
const L_RQ = 1 | (1 << 31);  // F.f0 | F.f31 (bit 31 = -2147483648): -2147483647
const L_XQ = 1 << 5;         // F.f5
const RULES_L = { maxMajor: 0, maxMinor: 0 };
const lSink = [];          // retains the control's per-call allocations

function lNames() {
    const names = [];
    for (let i = 0; i < 32; i++) names.push('f' + i);
    return names;
}

// The flag word the harness gives population entity i (Phase I's index). f3 on
// odd i is noise; bit 9 of i withholds f0, bit 7 withholds f31, bit 8 adds f5. On
// the C-driven candidates (i = 64j) those are bits 3, 1, 2 of j: independent, so
// of the 32 unmasked matches (j odd) exactly 4 pass both masks.
function lFlagWord(i) {
    let w = 0;
    if (((i >> 9) & 1) === 0) w |= 1;          // f0
    if ((i & 1) !== 0) w |= 1 << 3;            // f3 (noise)
    if (((i >> 7) & 1) === 0) w |= 1 << 31;    // f31
    if (((i >> 8) & 1) !== 0) w |= 1 << 5;     // f5
    return w;
}

// Retention leg + reserve (synchronous, so no local of this frame -- the old row,
// a plan, a hoisted `row` -- survives into the caller's awaited gc passes). Returns
// the WeakRef to the pre-reserve row plus the counts; never a strong row ref.
function lRetention() {
    const ra = new Arena(CAP);
    const rA = ra.registerComponent({ x: Float32Array });
    const rD = ra.registerTag();
    const F = ra.registerFlags(lNames());
    if ((F.f0 | F.f31) !== L_RQ || F.f5 !== L_XQ) die('phaseL: retention flag map bits wrong');
    const REQ = [rA], EXC = [rD];
    const tracker = createLeakTracker({ name: 'arena-masked-join-retention' });
    const leakHandles = new Array(CAP).fill(null);
    const live = new Int32Array(L_CHURN);
    const st = new Int32Array(3); // [0] LCG state, [1] first bad cycle + 1, [2] its count
    st[0] = 0x1F123BB5;
    let rng = st[0];
    let joins = 0;
    for (let cycle = 0; cycle < L_CYCLES; cycle++) {
        let n = 0, want = 0;
        for (let i = 0; i < L_CHURN; i++) {
            if (ra.activeCount >= CAP) break; // LEAK control fills the arena: stop, do not throw
            const e = ra.spawn();
            rA.add(e);
            const excluded = (i & 7) === 0;
            if (excluded) rD.add(e);
            rng = (Math.imul(rng, 1664525) + 1013904223) | 0;
            if (!ra.setFlags(e, rng)) die('phaseL: setFlags false on a live entity');
            if (!excluded && (rng & L_RQ) === L_RQ && (rng & L_XQ) === 0) want++;
            const slot = e & INDEX_MASK;
            leakHandles[slot] = tracker.track({ slot }, NOOP, slot);
            live[n++] = e;
        }
        if (LEAK) continue; // control: skip the plan and the release entirely
        const p = ra.joinN(REQ, EXC, L_RQ, L_XQ);
        const drv = p.driver, cnt = p.count;
        const ex = p.excl, nx = p.exclCount;
        const row = p.flags, m = ra.indexMask, rm = p.reqMask, xm = p.excMask;
        let got = 0;
        for (let i = 0; i < cnt; i++) {
            const e = drv.dense[i];
            let ok = true;
            for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
            if (!ok) continue;
            const w = row[e & m];
            if ((w & rm) !== rm || (w & xm) !== 0) continue;
            got++;
        }
        joins++;
        if (got !== want && st[1] === 0) { st[1] = cycle + 1; st[2] = got - want; }
        for (let i = 0; i < n; i++) {
            const e = live[i];
            const slot = e & INDEX_MASK;
            tracker.untrack(leakHandles[slot]);
            leakHandles[slot] = null;
            ra.despawn(e);
        }
    }
    if (st[1] !== 0) die('phaseL: retention cycle ' + (st[1] - 1) + ' masked joinN count off by ' + st[2]);
    if (!LEAK && joins !== L_CYCLES) die('phaseL: retention ran ' + joins + ' masked plans, expected ' + L_CYCLES);
    let flagOr = 0; // OR, not a signed sum: words cannot cancel to 0
    const rrow = ra.flags;
    for (let i = 0; i < CAP; i++) flagOr |= rrow[i];
    const trackerSize = tracker.size();
    const activeCount = ra.activeCount;

    // reserve() replaces arena.flags; take the WeakRef BEFORE, holding no strong ref.
    const wr = new WeakRef(ra.flags);
    if (!ra.reserve(L_GROW)) die('phaseL: reserve(' + L_GROW + ') failed');
    if (ra.flags.length !== L_GROW) die('phaseL: flag row length ' + ra.flags.length + ' after reserve');
    return { ra, REQ, EXC, wr, trackerSize, activeCount, flagOr };
}

function lTick() {
    return new Promise(function (r) { setTimeout(r, 0); });
}

async function phaseL() {
    const arena = new Arena(CAP);
    const A = arena.registerComponent({ x: Float32Array }); // required, largest
    const B = arena.registerTag();                          // required, half
    const C = arena.registerTag();                          // required, rarest -> driver
    const D = arena.registerTag();                          // excluded
    const F = arena.registerFlags(lNames());
    if ((F.f0 | F.f31) !== L_RQ || F.f5 !== L_XQ) die('phaseL: flag map bits wrong');

    for (let i = 0; i < CAP; i++) {
        const e = arena.spawn();
        A.add(e);                        // A: every entity
        if ((i & 1) === 0) B.add(e);     // B: half
        if ((i & 63) === 0) C.add(e);    // C: sparse -> the consistent driver
        if ((i & 127) === 0) D.add(e);   // D: sparser still, excluded
        if (!arena.setFlags(e, lFlagWord(i))) die('phaseL: setFlags false on a live entity');
    }

    const REQ = [A, B, C];   // hoisted ONCE, as a real system would
    const EXC = [D];

    // Brute-force oracle, ONCE outside the window: the C-driven candidates in A and
    // B and not D (the unmasked count), and of those the ones arena.hasFlags()
    // accepts. Asserted below: some candidate fails each single test (failReq,
    // failExc), is excluded by f5 while holding both req bits (excOnly), and holds
    // exactly one of f0 / f31 (f31NotF0, f0NotF31). The coverage counters read the
    // harness's own word w (slot === i here: a fresh arena hands out slots
    // 0..CAP-1 in order), not arena.hasFlags.
    let unmasked = 0, expected = 0, mirror = 0, failReq = 0, failExc = 0;
    let excOnly = 0, f31NotF0 = 0, f0NotF31 = 0;
    for (let i = 0; i < C.count; i++) {
        const e = C.dense[i];
        if (!(A.has(e) && B.has(e) && !D.has(e))) continue;
        unmasked++;
        if (arena.hasFlags(e, L_RQ, L_XQ)) expected++;
        if (!arena.hasFlags(e, L_RQ, 0)) failReq++;
        if (!arena.hasFlags(e, 0, L_XQ)) failExc++;
        const w = lFlagWord(e & INDEX_MASK);
        if ((w & L_RQ) === L_RQ && (w & L_XQ) !== 0) excOnly++;
        if ((w & L_RQ) === (1 << 31) && (w & L_XQ) === 0) f31NotF0++;
        if ((w & L_RQ) === 1 && (w & L_XQ) === 0) f0NotF31++;
        if ((w & L_RQ) === L_RQ && (w & L_XQ) === 0) mirror++;
    }
    if (expected !== mirror) die('phaseL: hasFlags oracle ' + expected + ' != harness words ' + mirror);
    if (!(excOnly > 0)) die('phaseL: oracle population has no excOnly candidate (both req bits, excluded by f5)');
    if (!(f31NotF0 > 0)) die('phaseL: oracle population has no f31-without-f0 candidate');
    if (!(f0NotF31 > 0)) die('phaseL: oracle population has no f0-without-f31 candidate');
    if (!(expected > 0) || !(expected < unmasked) || !(failReq > 0) || !(failExc > 0)) {
        die('phaseL: degenerate oracle (masked=' + expected + ' unmasked=' + unmasked +
            ' failReq=' + failReq + ' failExc=' + failExc + ')');
    }

    // [0] first call whose driver was not C + 1, [1] first miscounting call + 1,
    // [2] that call's count. Preallocated: the window writes ints only.
    const lst = new Int32Array(3);

    globalThis.gc();
    globalThis.gc();

    const gc = new GcProfiler(256, { heap: true }).start();
    gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);

    let acc = 0;
    for (let n = 0; n < HOT_OPS_MIN; n++) {
        const p = arena.joinN(REQ, EXC, L_RQ, L_XQ);
        if (p.driver !== C && lst[0] === 0) lst[0] = n + 1;
        const drv = p.driver, cnt = p.count;
        const oth = p.others, no = p.othersCount;
        const ex = p.excl, nx = p.exclCount;
        const row = p.flags, m = arena.indexMask, rm = p.reqMask, xm = p.excMask;
        let matched = 0;
        for (let i = 0; i < cnt; i++) {
            const e = drv.dense[i];
            let ok = true;
            for (let k = 0; k < no; k++) if (!oth[k].has(e)) { ok = false; break; }
            if (ok) for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
            if (!ok) continue;
            const w = row[e & m];
            if ((w & rm) !== rm || (w & xm) !== 0) continue;
            matched++;
        }
        if (matched !== expected && lst[1] === 0) { lst[1] = n + 1; lst[2] = matched; }
        acc = acc + matched;
        if (MLEAK) lSink.push(new Array(32)); // control: retained per-call alloc
    }

    const mu = process.memoryUsage();
    gc.sampleHeap(performance.now(), mu.heapUsed, mu);

    await gc.settle();
    const summary = gc.summary();
    gc.stop();

    if (lst[0] !== 0) die('phaseL: masked joinN did not drive C at call ' + (lst[0] - 1));
    if (lst[1] !== 0) {
        die('phaseL: masked joinN match miscounted at call ' + (lst[1] - 1) + ' (got ' + lst[2] +
            ' expected ' + expected + ', unmasked ' + unmasked + ')');
    }
    if (acc !== expected * HOT_OPS_MIN) die('phaseL: masked match total ' + acc + ' != ' + (expected * HOT_OPS_MIN));
    lSink.length = 0;

    // Retention leg + reserve (unmeasured), then the old-row reachability check.
    const r = lRetention();
    await lTick();
    globalThis.gc();
    await lTick();
    globalThis.gc();
    await lTick();
    if (r.wr.deref() !== undefined) {
        die('phaseL: the pre-reserve flag row is still reachable after reserve(' + L_GROW +
            ') + 2 gc passes (the joinN scratch retains it)');
    }
    const q = r.ra.joinN(r.REQ, r.EXC, L_RQ, L_XQ);
    if (q.flags !== r.ra.flags) die('phaseL: a fresh plan after reserve() does not carry arena.flags');

    return {
        report: checkNoGc(summary, RULES_L), summary, ops: HOT_OPS_MIN, expected, unmasked,
        trackerSize: r.trackerSize, activeCount: r.activeCount, flagOr: r.flagOr,
    };
}

// --- Phase M: the Hi flag word is zero-GC and agrees with a mirror oracle (F1) ----

// Phase K + Phase L for the second flag word (bits 32..63, arena.flagsHi). Two
// windows, both gated at RULES_M (zero major AND zero minor GC):
//   frames -- a full Arena(CAP) with 32 + 32 registered flags; M_FRAMES frames x
//     (CAP two-row reads `row[e & m]` + `rowHi[e & m]` against all four masks +
//     CAP hasFlagsHi() + M_CHURN despawn / spawn / setFlags / setFlagsHi). The
//     two-row count and the hasFlagsHi() count must equal, every frame, an oracle
//     over the harness's own Int32Array mirrors of BOTH words (never read back).
//   joinN -- Phase L's population plus a Hi word per entity, planned with
//     joinN(REQ, EXC, L_RQ, L_XQ, M_RH, M_XH) HOT_OPS_MIN times (Hi bit 31 in
//     M_RH); every call runs the two-word masked loop and its match count must
//     equal an oracle computed from plain index arithmetic (set membership and
//     both words derived from i, no arena reads). Non-degenerate: 0 < masked <
//     lo-only masked < unmasked, and the Hi word rejects a candidate on each of
//     its three tests (Hi bit 31 missing, Hi bit 0 missing, Hi excluded bit set).
// A frame-oracle mismatch is gated in main(), not die()d, so a build that leaves
// a stale Hi word on a freed slot also reaches (and trips) the retention OR below.
//
// Retention leg: M_CYCLES cycles x M_CHURN spawn / setFlags / setFlagsHi(e, -1)
// (odd i then clearFlagsHi(e, M_XH)) / lite-leak track / all-four-mask joinN
// (count checked against the harness's words), then untrack / despawn.
// tracker.size(), activeCount and the OR of EACH row (flags, flagsHi) must return
// to 0. ARENA_TORTURE_LEAK=1 skips the plan and the release here too. Then
// reserve(8192): after two awaited gc() passes a WeakRef to the old Hi row must
// deref to undefined, and a fresh plan's p.flagsHi must be the new arena.flagsHi.
//
// Control: ARENA_TORTURE_WLEAK=1 retains a per-call allocation inside the joinN
// window (mSink); RULES_M trips.
const WLEAK = process.env.ARENA_TORTURE_WLEAK === '1';
const M_FRAMES = 64;
const M_WARM = 8;          // unmeasured warm-up frames, same body
const M_CHURN = 64;        // despawn/spawn/setFlags/setFlagsHi per frame; retention batch
const M_CYCLES = 4096;     // retention cycles
const M_GROW = 8192;       // reserve() target after the retention leg
const M_RH = (1 << 31) | 1;  // FH.h31 | FH.h0 (Hi bit 31 = -2147483648): -2147483647
const M_XH = 1 << 2;         // FH.h2
const M_OPS = M_FRAMES * (CAP + CAP + M_CHURN); // 528,384
const RULES_M = { maxMajor: 0, maxMinor: 0 };
const mSink = [];          // retains the control's per-call allocations

function mNamesHi() {
    const names = [];
    for (let i = 0; i < 32; i++) names.push('h' + i);
    return names;
}

// The Hi word the harness gives population entity i. On the C-driven candidates
// (i = 64j) that pass every set test and the word-0 masks (j in {1, 17, 33, 49}),
// j bits 4 / 5 (i bits 10 / 11) pick: 00 -> both req bits (match), 10 -> Hi bit 31
// withheld, 01 -> Hi bit 0 withheld, 11 -> both req bits AND Hi bit 2 (excluded).
// Bit 16 on i bit 6 is noise.
function mFlagWordHi(i) {
    const b10 = (i >> 10) & 1, b11 = (i >> 11) & 1;
    let w = (i & 64) !== 0 ? 1 << 16 : 0;
    if (b10 === 1 && b11 === 1) return w | M_RH | M_XH;
    if (b10 === 0) w |= 1 << 31;
    if (b11 === 0) w |= 1;
    return w;
}

// One frame. hs: live handles (ring of CAP), mir / mirH: the oracle's word-0 / Hi
// mirrors (slot-indexed), st: [0] churn cursor, [1] word-0 LCG, [2] Hi LCG, [3]
// first mismatching frame + 1 (0 = none), [4] last two-row count, [5] last
// hasFlagsHi count, [6] last two-word oracle, [7] last Hi-only oracle.
function mFrame(arena, hs, mir, mirH, st, frame) {
    let cur = st[0], rng = st[1], rngH = st[2];
    for (let k = 0; k < M_CHURN; k++) {
        const old = hs[cur];
        arena.despawn(old);
        mir[old & INDEX_MASK] = 0;
        mirH[old & INDEX_MASK] = 0;
        const e = arena.spawn();
        const s = e & INDEX_MASK;
        rng = (Math.imul(rng, 1664525) + 1013904223) | 0;
        rngH = (Math.imul(rngH, 22695477) + 1) | 0;
        const wh = rngH ^ (rngH >>> 13);
        arena.setFlags(e, rng);
        arena.setFlagsHi(e, wh);
        mir[s] = mir[s] | rng;
        mirH[s] = mirH[s] | wh;
        hs[cur] = e;
        cur = (cur + 1) & (CAP - 1);
    }
    st[0] = cur; st[1] = rng; st[2] = rngH;

    // Read form 1: both hoisted rows, all four masks.
    const row = arena.flags, rowHi = arena.flagsHi, m = arena.indexMask;
    let rowN = 0;
    for (let i = 0; i < CAP; i++) {
        const x = hs[i] & m;
        const w = row[x], wh = rowHi[x];
        if ((w & K_REQ) !== K_REQ || (w & K_EXC) !== 0 || (wh & M_RH) !== M_RH || (wh & M_XH) !== 0) continue;
        rowN++;
    }
    // Read form 2: hasFlagsHi().
    let hasN = 0;
    for (let i = 0; i < CAP; i++) {
        if (arena.hasFlagsHi(hs[i], M_RH, M_XH)) hasN++;
    }
    // Oracle: the mirrors, by the TRUE definition of a match.
    let orN = 0, orH = 0;
    for (let i = 0; i < CAP; i++) {
        const w = mir[i], wh = mirH[i];
        const hiOk = (wh & M_RH) === M_RH && (wh & M_XH) === 0;
        if (hiOk) orH++;
        if (hiOk && (w & K_REQ) === K_REQ && (w & K_EXC) === 0) orN++;
    }
    if ((rowN !== orN || hasN !== orH) && st[3] === 0) st[3] = frame + 1;
    st[4] = rowN; st[5] = hasN; st[6] = orN; st[7] = orH;
}

// Retention leg + reserve (synchronous, as lRetention: no strong ref to the old
// Hi row survives into the caller's awaited gc passes).
function mRetention() {
    const ra = new Arena(CAP);
    const rA = ra.registerComponent({ x: Float32Array });
    const rD = ra.registerTag();
    ra.registerFlags(lNames());
    const FH = ra.registerFlagsHi(mNamesHi());
    if ((FH.h31 | FH.h0) !== M_RH || FH.h2 !== M_XH) die('phaseM: retention Hi flag map bits wrong');
    const REQ = [rA], EXC = [rD];
    const tracker = createLeakTracker({ name: 'arena-flags-hi-retention' });
    const leakHandles = new Array(CAP).fill(null);
    const live = new Int32Array(M_CHURN);
    const st = new Int32Array(3); // [0] LCG state, [1] first bad cycle + 1, [2] its count delta
    st[0] = 0x3C6EF372;
    let rng = st[0];
    let joins = 0;
    for (let cycle = 0; cycle < M_CYCLES; cycle++) {
        let n = 0, want = 0;
        for (let i = 0; i < M_CHURN; i++) {
            if (ra.activeCount >= CAP) break; // LEAK control fills the arena: stop, do not throw
            const e = ra.spawn();
            rA.add(e);
            const excluded = (i & 7) === 0;
            if (excluded) rD.add(e);
            rng = (Math.imul(rng, 1664525) + 1013904223) | 0;
            if (!ra.setFlags(e, rng)) die('phaseM: setFlags false on a live entity');
            if (!ra.setFlagsHi(e, -1)) die('phaseM: setFlagsHi false on a live entity');
            const hiOk = (i & 1) !== 0;
            if (hiOk && !ra.clearFlagsHi(e, M_XH)) die('phaseM: clearFlagsHi false on a live entity');
            if (!excluded && hiOk && (rng & L_RQ) === L_RQ && (rng & L_XQ) === 0) want++;
            const slot = e & INDEX_MASK;
            leakHandles[slot] = tracker.track({ slot }, NOOP, slot);
            live[n++] = e;
        }
        if (LEAK) continue; // control: skip the plan and the release entirely
        const p = ra.joinN(REQ, EXC, L_RQ, L_XQ, M_RH, M_XH);
        const drv = p.driver, cnt = p.count;
        const ex = p.excl, nx = p.exclCount;
        const row = p.flags, rowHi = p.flagsHi, m = ra.indexMask;
        const rm = p.reqMask, xm = p.excMask, rh = p.reqMaskHi, xh = p.excMaskHi;
        let got = 0;
        for (let i = 0; i < cnt; i++) {
            const e = drv.dense[i];
            const w = row[e & m], wh = rowHi[e & m];
            if ((w & rm) !== rm || (w & xm) !== 0 || (wh & rh) !== rh || (wh & xh) !== 0) continue;
            let ok = true;
            for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
            if (!ok) continue;
            got++;
        }
        joins++;
        if (got !== want && st[1] === 0) { st[1] = cycle + 1; st[2] = got - want; }
        for (let i = 0; i < n; i++) {
            const e = live[i];
            const slot = e & INDEX_MASK;
            tracker.untrack(leakHandles[slot]);
            leakHandles[slot] = null;
            ra.despawn(e);
        }
    }
    if (st[1] !== 0) die('phaseM: retention cycle ' + (st[1] - 1) + ' two-word joinN count off by ' + st[2]);
    if (!LEAK && joins !== M_CYCLES) die('phaseM: retention ran ' + joins + ' plans, expected ' + M_CYCLES);
    let flagOr = 0, flagOrHi = 0; // OR, not a signed sum: words cannot cancel to 0
    const rrow = ra.flags, rrowHi = ra.flagsHi;
    for (let i = 0; i < CAP; i++) { flagOr |= rrow[i]; flagOrHi |= rrowHi[i]; }
    const trackerSize = tracker.size();
    const activeCount = ra.activeCount;

    // reserve() replaces arena.flagsHi; take the WeakRef BEFORE, holding no strong ref.
    const wr = new WeakRef(ra.flagsHi);
    if (!ra.reserve(M_GROW)) die('phaseM: reserve(' + M_GROW + ') failed');
    if (ra.flagsHi.length !== M_GROW) die('phaseM: Hi row length ' + ra.flagsHi.length + ' after reserve');
    return { ra, REQ, EXC, wr, trackerSize, activeCount, flagOr, flagOrHi };
}

async function phaseM() {
    // ---- frames window ----
    const fa = new Arena(CAP);
    fa.registerFlags(lNames());
    const FH = fa.registerFlagsHi(mNamesHi());
    if (FH.h31 !== -2147483648) die('phaseM: Hi flag #31 is ' + FH.h31 + ', expected -2147483648');
    if ((FH.h31 | FH.h0) !== M_RH || FH.h2 !== M_XH) die('phaseM: Hi flag map bits wrong');

    const hs = new Int32Array(CAP);
    const mir = new Int32Array(CAP);
    const mirH = new Int32Array(CAP);
    const st = new Int32Array(8);
    let rng = 0x2545F491, rngH = 0x6B43A9B5;
    for (let i = 0; i < CAP; i++) {
        const e = fa.spawn();
        rng = (Math.imul(rng, 1664525) + 1013904223) | 0;
        rngH = (Math.imul(rngH, 22695477) + 1) | 0;
        const wh = rngH ^ (rngH >>> 13);
        fa.setFlags(e, rng);
        fa.setFlagsHi(e, wh);
        mir[e & INDEX_MASK] = rng;
        mirH[e & INDEX_MASK] = wh;
        hs[i] = e;
    }
    st[1] = rng; st[2] = rngH;
    if (fa.activeCount !== CAP) die('phaseM: arena not full (' + fa.activeCount + ')');

    for (let f = 0; f < M_WARM; f++) mFrame(fa, hs, mir, mirH, st, f);
    const warmBad = st[3];
    st[3] = 0;

    globalThis.gc();
    globalThis.gc();

    const gcF = new GcProfiler(256, { heap: true }).start();
    gcF.sampleHeap(performance.now(), process.memoryUsage().heapUsed);

    for (let f = 0; f < M_FRAMES; f++) mFrame(fa, hs, mir, mirH, st, f);

    const muF = process.memoryUsage();
    gcF.sampleHeap(performance.now(), muF.heapUsed, muF);

    await gcF.settle();
    const fSummary = gcF.summary();
    gcF.stop();

    const frameBad = warmBad !== 0 ? -warmBad : st[3]; // < 0: warm-up frame; > 0: window frame
    const fRow = st[4], fHas = st[5], fOr = st[6], fOrH = st[7];
    if (!(fOr > 0) || !(fOr < fOrH) || !(fOrH < CAP)) {
        die('phaseM: degenerate frame oracle (two-word ' + fOr + ', Hi-only ' + fOrH + ')');
    }
    if (fa.activeCount !== CAP) die('phaseM: activeCount drifted to ' + fa.activeCount);

    // ---- joinN window ----
    const arena = new Arena(CAP);
    const A = arena.registerComponent({ x: Float32Array }); // required, largest
    const B = arena.registerTag();                          // required, half
    const C = arena.registerTag();                          // required, rarest -> driver
    const D = arena.registerTag();                          // excluded
    arena.registerFlags(lNames());
    arena.registerFlagsHi(mNamesHi());
    for (let i = 0; i < CAP; i++) {
        const e = arena.spawn();
        if ((e & INDEX_MASK) !== i) die('phaseM: fresh arena handed slot ' + (e & INDEX_MASK) + ' at ' + i);
        A.add(e);
        if ((i & 1) === 0) B.add(e);
        if ((i & 63) === 0) C.add(e);
        if ((i & 127) === 0) D.add(e);
        if (!arena.setFlags(e, lFlagWord(i))) die('phaseM: setFlags false on a live entity');
        if (!arena.setFlagsHi(e, mFlagWordHi(i))) die('phaseM: setFlagsHi false on a live entity');
    }
    const REQ = [A, B, C];
    const EXC = [D];

    // Mirror oracle, ONCE outside the window, from index arithmetic only: the set
    // memberships the loop above chose and the two words lFlagWord / mFlagWordHi.
    let unmasked = 0, loMasked = 0, expected = 0, hiNo31 = 0, hiNo0 = 0, hiExc = 0;
    for (let i = 0; i < CAP; i++) {
        if ((i & 63) !== 0 || (i & 1) !== 0 || (i & 127) === 0) continue;
        unmasked++;
        const w = lFlagWord(i), wh = mFlagWordHi(i);
        if ((w & L_RQ) !== L_RQ || (w & L_XQ) !== 0) continue;
        loMasked++;
        if ((wh & M_XH) !== 0) hiExc++;
        else if ((wh & (1 << 31)) === 0) hiNo31++;
        else if ((wh & 1) === 0) hiNo0++;
        else expected++;
    }
    if (!(expected > 0) || !(expected < loMasked) || !(loMasked < unmasked) ||
        !(hiNo31 > 0) || !(hiNo0 > 0) || !(hiExc > 0)) {
        die('phaseM: degenerate oracle (masked=' + expected + ' loMasked=' + loMasked +
            ' unmasked=' + unmasked + ' hiNo31=' + hiNo31 + ' hiNo0=' + hiNo0 + ' hiExc=' + hiExc + ')');
    }
    const p0 = arena.joinN(REQ, EXC, L_RQ, L_XQ, M_RH, M_XH);
    if (p0.reqMaskHi !== M_RH || p0.excMaskHi !== M_XH || p0.flagsHi !== arena.flagsHi) {
        die('phaseM: plan Hi fields reqMaskHi=' + p0.reqMaskHi + ' excMaskHi=' + p0.excMaskHi +
            ' flagsHi===arena.flagsHi ' + (p0.flagsHi === arena.flagsHi));
    }

    // [0] first call whose driver was not C + 1, [1] first miscounting call + 1,
    // [2] that call's count. Preallocated: the window writes ints only.
    const mst = new Int32Array(3);

    globalThis.gc();
    globalThis.gc();

    const gc = new GcProfiler(256, { heap: true }).start();
    gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);

    let acc = 0;
    for (let n = 0; n < HOT_OPS_MIN; n++) {
        const p = arena.joinN(REQ, EXC, L_RQ, L_XQ, M_RH, M_XH);
        if (p.driver !== C && mst[0] === 0) mst[0] = n + 1;
        const drv = p.driver, cnt = p.count;
        const oth = p.others, no = p.othersCount;
        const ex = p.excl, nx = p.exclCount;
        const row = p.flags, rowHi = p.flagsHi, m = arena.indexMask;
        const rm = p.reqMask, xm = p.excMask, rh = p.reqMaskHi, xh = p.excMaskHi;
        let matched = 0;
        for (let i = 0; i < cnt; i++) {
            const e = drv.dense[i];
            const w = row[e & m], wh = rowHi[e & m];
            if ((w & rm) !== rm || (w & xm) !== 0 || (wh & rh) !== rh || (wh & xh) !== 0) continue;
            let ok = true;
            for (let k = 0; k < no; k++) if (!oth[k].has(e)) { ok = false; break; }
            if (ok) for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
            if (!ok) continue;
            matched++;
        }
        if (matched !== expected && mst[1] === 0) { mst[1] = n + 1; mst[2] = matched; }
        acc = acc + matched;
        if (WLEAK) mSink.push(new Array(32)); // control: retained per-call alloc
    }

    const mu = process.memoryUsage();
    gc.sampleHeap(performance.now(), mu.heapUsed, mu);

    await gc.settle();
    const summary = gc.summary();
    gc.stop();

    if (mst[0] !== 0) die('phaseM: two-word joinN did not drive C at call ' + (mst[0] - 1));
    if (mst[1] !== 0) {
        die('phaseM: two-word joinN match miscounted at call ' + (mst[1] - 1) + ' (got ' + mst[2] +
            ' expected ' + expected + ', lo-only ' + loMasked + ', unmasked ' + unmasked + ')');
    }
    if (acc !== expected * HOT_OPS_MIN) die('phaseM: match total ' + acc + ' != ' + (expected * HOT_OPS_MIN));
    mSink.length = 0;

    // Retention leg + reserve (unmeasured), then the old-Hi-row reachability check.
    const r = mRetention();
    await lTick();
    globalThis.gc();
    await lTick();
    globalThis.gc();
    await lTick();
    if (r.wr.deref() !== undefined) {
        die('phaseM: the pre-reserve Hi flag row is still reachable after reserve(' + M_GROW +
            ') + 2 gc passes (the joinN scratch retains it)');
    }
    const q = r.ra.joinN(r.REQ, r.EXC, L_RQ, L_XQ, M_RH, M_XH);
    if (q.flagsHi !== r.ra.flagsHi) die('phaseM: a fresh plan after reserve() does not carry arena.flagsHi');

    return {
        fReport: checkNoGc(fSummary, RULES_M), fSummary, fOps: M_OPS, frameBad, fRow, fHas, fOr, fOrH,
        report: checkNoGc(summary, RULES_M), summary, ops: HOT_OPS_MIN, expected, loMasked, unmasked,
        trackerSize: r.trackerSize, activeCount: r.activeCount, flagOr: r.flagOr, flagOrHi: r.flagOrHi,
    };
}

// --- Phase N: indexed flags + the joinN driver-flag hint are zero-GC (F2) ------

// Indexed flags (registerFlags(names, { indexed }), registerFlagsHi likewise):
// own setFlags / clearFlags / despawn (+Hi) keep a per-bit column, two summary
// levels and a live count in step with the row; flagCount / firstFlagged /
// nextFlagged / clearFlagAll (+Hi) read them. Five windows, each gated at
// RULES_N (zero major AND zero minor GC), then a retention leg:
//   N1 -- Arena(CAP) full; 4 indexed word-0 flags (f31 = bit 31) + 4 plain, 2
//     indexed Hi flags (h31 = Hi bit 31) + 2 plain. N_FRAMES frames x N_OPS seeded
//     ops: setFlags / clearFlags / despawn+spawn / setFlagsHi / clearFlagsHi, the
//     op, the slot and the mask each from its OWN xorshift32 stream. clearFlagAll +
//     clearFlagAllHi in frame 7 of every 16 (rotating bits); one firstFlagged /
//     nextFlagged sweep per frame (rotating over all 6 indexed bits) despawning
//     every 8th visited entity (M-39), its visit count + FNV-1a checked against
//     the mirror; refill to full. After each frame an allocation-free oracle over
//     the harness MIRROR (never an arena read for the expected side): both rows ==
//     the mirrors, every flagCount == the mirror count, every walk == the mirror's
//     live handles ascending (count + FNV-1a over the handles).
//   N2 -- reserve(N_GROW) on the same arena, fill the new slots (flagged), then
//     N_FRAMES2 frames: some walk must visit a slot >= CAP (the old capacity).
//   N3 -- clear(): all 6 flagCount 0 and firstFlagged -1; then refill + oracle +
//     N_FRAMES3 frames inside the window.
//   N4 -- a { checked: true } arena, the same seeds / stream, N_FRAMES4 frames;
//     then (cold) setFlags(e, 1.5 / 2147483648.5) and setFlagsHi(e, 32.5 /
//     2147483648.5) -- each would set an indexed bit through `| 0` -- must throw,
//     and the row, flagCount and walk must still equal the mirror.
//   N5 -- Phase I's population with indexed f0 (a, common) and f31 (z, rare);
//     joinN(REQ, EXC, z | a) HOT_OPS_MIN times: driverFlag === z with
//     driverFlagCount === the harness's z count, and every call the flag-driven
//     loop (firstFlagged / nextFlagged over z) and the driver loop must both count
//     the brute-force match total (index arithmetic only, no arena reads).
//   N6 -- retention: N_CYCLES x N_CHURN spawn / setFlags (incl. bit 31) /
//     setFlagsHi / lite-leak track, then untrack / despawn: tracker.size(),
//     activeCount, every flagCount, every firstFlagged (-1) and the OR of both rows
//     must return to 0. ARENA_TORTURE_LEAK=1 skips the release here too.
// Oracle / sweep mismatches are recorded in an Int32Array and die() after the
// window ("phaseN: column != row" when a count or walk disagrees with the rows).
//
// Controls: ARENA_TORTURE_NLEAK=1 overwrites ONE sink slot with a fresh
// Int32Array(1) per N1 op (transient, never retained); ARENA_TORTURE_NLEAK=hint
// does the same per N5 joinN call; ARENA_TORTURE_NDESYNC=1 ORs the indexed f0 bit
// straight into arena.flags (bypassing setFlags) on one live slot at N1 frame 32.
const NLEAK = process.env.ARENA_TORTURE_NLEAK === '1';
const NLEAK_HINT = process.env.ARENA_TORTURE_NLEAK === 'hint';
const NDESYNC = process.env.ARENA_TORTURE_NDESYNC === '1';
const N_FRAMES = 64;       // N1 measured frames
const N_WARM = 8;          // unmeasured warm-up frames (numbered 0..7: frame 7 runs clearFlagAll)
const N_OPS = 4096;        // seeded ops per frame
const N_GROW = 8192;       // N2 reserve() target
const N_FRAMES2 = 16;      // N2 measured frames
const N_FRAMES3 = 16;      // N3 measured frames (after the in-window refill)
const N_FRAMES4 = 16;      // N4 measured frames (checked arena)
const N_DESYNC_FRAME = 32; // the NDESYNC control's frame
const N_CYCLES = 4096;     // N6 retention cycles
const N_CHURN = 64;        // N6 entities per cycle
const N_IXN = ['f0', 'f9', 'f22', 'f31'];                      // indexed word 0 (f31 = bit 31)
const N_IXNH = ['h5', 'h31'];                                  // indexed Hi (h31 = Hi bit 31)
const N_IX0 = new Int32Array([1, 1 << 9, 1 << 22, 1 << 31]);
const N_IXH = new Int32Array([1 << 5, 1 << 31]);
const N_OP0 = 1 | (1 << 9) | (1 << 22) | (1 << 31) |           // indexed word-0 bits
    (1 << 3) | (1 << 14) | (1 << 27) | (1 << 30);              // + 4 plain word-0 bits
const N_OPH = (1 << 5) | (1 << 31) | 1 | (1 << 17);            // 2 indexed + 2 plain Hi bits
const N_Z = 1 << 31;       // N5: indexed f31, the rare flag (the expected driverFlag)
const N_A = 1;             // N5: indexed f0, common
const N_FNV = -2128831035; // FNV-1a 32-bit offset basis 0x811C9DC5 as an int32
const RULES_N = { maxMajor: 0, maxMinor: 0 };
const nSink = [null];      // NLEAK: ONE slot, overwritten per op -- transient, never retained

// st (Int32Array(NS_LEN)) slots: three xorshift32 streams, the live capacity, the
// first failure (code, frame, got, want, bit / slot) and the window's counters.
const NS_RO = 0, NS_RK = 1, NS_RV = 2, NS_CAP = 3, NS_FAIL = 4, NS_FFRAME = 5, NS_GOT = 6;
const NS_WANT = 7, NS_BIT = 8, NS_MAXSLOT = 9, NS_VISITS = 10, NS_SWEEPDS = 11, NS_CFA = 12;
const NS_MH = 13, NS_WH = 14, NS_OPS = 15, NS_LEN = 16;

function nFail(st, code, frame, got, want, j) {
    if (st[NS_FAIL] !== 0) return;
    st[NS_FAIL] = code; st[NS_FFRAME] = frame; st[NS_GOT] = got; st[NS_WANT] = want; st[NS_BIT] = j;
}

// FNV-1a over the 4 bytes of an int32 handle. Ints in, int out (Math.imul).
function nFnv(h, x) {
    h = Math.imul(h ^ (x & 255), 16777619);
    h = Math.imul(h ^ ((x >>> 8) & 255), 16777619);
    h = Math.imul(h ^ ((x >>> 16) & 255), 16777619);
    return Math.imul(h ^ (x >>> 24), 16777619);
}

// The mirror's side of one indexed bit: count + FNV-1a (into st[NS_MH]) of the
// live handles whose mirror word carries `bit`, slots ascending.
function nMirror(mw, hs, cap, bit, st) {
    let n = 0, h = N_FNV;
    for (let s = 0; s < cap; s++) {
        if ((mw[s] & bit) !== 0) { n++; h = nFnv(h, hs[s]); }
    }
    st[NS_MH] = h;
    return n;
}

// The arena's side: a firstFlagged / nextFlagged walk, count + FNV-1a into
// st[NS_WH]; tracks the highest slot visited. Bounded by capacity (a walk that
// fails to advance reads as a mismatch, not a hang).
function nWalk(a, hi, bit, st) {
    const cap = st[NS_CAP];
    let n = 0, h = N_FNV, mx = st[NS_MAXSLOT];
    let e = hi ? a.firstFlaggedHi(bit) : a.firstFlagged(bit);
    while (e !== -1 && n <= cap) {
        n++;
        h = nFnv(h, e);
        const s = e & INDEX_MASK;
        if (s > mx) mx = s;
        e = hi ? a.nextFlaggedHi(bit, e) : a.nextFlagged(bit, e);
    }
    st[NS_WH] = h; st[NS_MAXSLOT] = mx;
    return n;
}

// The oracle: rows == mirrors, then per indexed bit flagCount == mirror count and
// walk == mirror handles (count + FNV-1a). Records the first failure only.
function nOracle(a, hs, mir, mirH, st, frame) {
    const cap = st[NS_CAP], row = a.flags, rowH = a.flagsHi;
    for (let s = 0; s < cap; s++) {
        if (row[s] !== mir[s]) { nFail(st, 1, frame, row[s], mir[s], s); break; }
        if (rowH[s] !== mirH[s]) { nFail(st, 7, frame, rowH[s], mirH[s], s); break; }
    }
    for (let j = 0; j < 6; j++) {
        const hi = j >= 4, bit = hi ? N_IXH[j - 4] : N_IX0[j];
        const want = nMirror(hi ? mirH : mir, hs, cap, bit, st);
        const cnt = hi ? a.flagCountHi(bit) : a.flagCount(bit);
        const got = nWalk(a, hi, bit, st);
        if (cnt !== want) nFail(st, 2, frame, cnt, want, j);
        else if (got !== want || st[NS_WH] !== st[NS_MH]) nFail(st, 3, frame, got, want, j);
        st[NS_VISITS] += got;
    }
}

// Spawn to capacity; each new entity gets a seeded word-0 and Hi mask (stream rv).
// Returns the number spawned.
function nFill(a, hs, mir, mirH, st) {
    const cap = st[NS_CAP];
    let rv = st[NS_RV], n = 0;
    while (a.activeCount < cap) {
        const e = a.spawn(), s = e & INDEX_MASK;
        rv ^= rv << 13; rv ^= rv >>> 17; rv ^= rv << 5;
        const m = rv & N_OP0;
        rv ^= rv << 13; rv ^= rv >>> 17; rv ^= rv << 5;
        const mh = rv & N_OPH;
        if (!a.setFlags(e, m) || !a.setFlagsHi(e, mh)) nFail(st, 5, -1, s, 0, -1);
        hs[s] = e; mir[s] = m; mirH[s] = mh;
        n++;
    }
    st[NS_RV] = rv;
    return n;
}

// One sweep over indexed bit (frame % 6), despawning every 8th visit (M-39: the
// walk continues from the despawned entity's slot). It must visit exactly the
// mirror's live handles for that bit, ascending (count + FNV-1a).
function nSweep(a, hs, mir, mirH, st, frame) {
    const cap = st[NS_CAP], j = frame % 6, hi = j >= 4, bit = hi ? N_IXH[j - 4] : N_IX0[j];
    const want = nMirror(hi ? mirH : mir, hs, cap, bit, st);
    let n = 0, d = 0, h = N_FNV, mx = st[NS_MAXSLOT];
    let e = hi ? a.firstFlaggedHi(bit) : a.firstFlagged(bit);
    while (e !== -1 && n <= cap) {
        n++;
        h = nFnv(h, e);
        const s = e & INDEX_MASK;
        if (s > mx) mx = s;
        if ((n & 7) === 0) {
            a.despawn(e);
            mir[s] = 0; mirH[s] = 0; hs[s] = -1;
            d++;
        }
        e = hi ? a.nextFlaggedHi(bit, e) : a.nextFlagged(bit, e);
    }
    if (n !== want || h !== st[NS_MH]) nFail(st, 4, frame, n, want, j);
    st[NS_MAXSLOT] = mx; st[NS_VISITS] += n; st[NS_SWEEPDS] += d;
}

// One frame: N_OPS seeded ops, clearFlagAll(+Hi) in frame 7 of every 16, the NDESYNC
// poke (control only), one despawning sweep, refill to capacity, the oracle.
function nFrame(a, hs, mir, mirH, st, frame, leak, desync) {
    const cap = st[NS_CAP], km = cap - 1;
    let ro = st[NS_RO], rk = st[NS_RK], rv = st[NS_RV];
    for (let n = 0; n < N_OPS; n++) {
        ro ^= ro << 13; ro ^= ro >>> 17; ro ^= ro << 5;
        rk ^= rk << 13; rk ^= rk >>> 17; rk ^= rk << 5;
        rv ^= rv << 13; rv ^= rv >>> 17; rv ^= rv << 5;
        const s = rk & km, e = hs[s], op = ro >>> 29;
        let ok = true;
        if (op < 3) {
            const m = rv & N_OP0;
            ok = a.setFlags(e, m);
            mir[s] = mir[s] | m;
        } else if (op < 5) {
            const m = rv & N_OP0;
            ok = a.clearFlags(e, m);
            mir[s] = mir[s] & ~m;
        } else if (op === 5) {
            ok = a.despawn(e);
            mir[s] = 0; mirH[s] = 0;
            const f = a.spawn();
            if ((f & INDEX_MASK) !== s) nFail(st, 6, frame, f & INDEX_MASK, s, -1);
            hs[s] = f;
        } else if (op === 6) {
            const m = rv & N_OPH;
            ok = a.setFlagsHi(e, m);
            mirH[s] = mirH[s] | m;
        } else {
            const m = rv & N_OPH;
            ok = a.clearFlagsHi(e, m);
            mirH[s] = mirH[s] & ~m;
        }
        if (!ok) nFail(st, 5, frame, s, op, -1);
        if (leak) nSink[0] = new Int32Array(1); // control: transient per-op alloc
    }
    st[NS_RO] = ro; st[NS_RK] = rk; st[NS_RV] = rv; st[NS_OPS] += N_OPS;
    if ((frame & 15) === 7) {
        const b0 = N_IX0[(frame >> 4) & 3], bh = N_IXH[(frame >> 4) & 1];
        a.clearFlagAll(b0);
        a.clearFlagAllHi(bh);
        for (let s = 0; s < cap; s++) { mir[s] = mir[s] & ~b0; mirH[s] = mirH[s] & ~bh; }
        st[NS_CFA] += 2;
    }
    nSweep(a, hs, mir, mirH, st, frame);
    for (let x = 0; a.activeCount < cap && x < cap; x++) {
        const f = a.spawn();
        hs[f & INDEX_MASK] = f;
    }
    if (desync) {
        // Control: an indexed bit written straight into the row (UNSUPPORTED, M-39).
        // The mirror models the row, so rows == mirror still holds and only the
        // column-vs-row comparison can catch it.
        const row = a.flags, b = N_IX0[0];
        for (let s = 0; s < cap; s++) {
            if (hs[s] !== -1 && (mir[s] & b) === 0) { row[s] |= b; mir[s] = mir[s] | b; break; }
        }
    }
    nOracle(a, hs, mir, mirH, st, frame);
}

function nArena(checked) {
    const a = checked ? new Arena(CAP, { checked: true }) : new Arena(CAP);
    const F = a.registerFlags(lNames(), { indexed: N_IXN });
    const FH = a.registerFlagsHi(mNamesHi(), { indexed: N_IXNH });
    if (F.f31 !== -2147483648 || FH.h31 !== -2147483648) die('phaseN: flag #31 is not -2147483648');
    for (let j = 0; j < 4; j++) if (F[N_IXN[j]] !== N_IX0[j]) die('phaseN: indexed flag ' + N_IXN[j] + ' bit wrong');
    for (let j = 0; j < 2; j++) if (FH[N_IXNH[j]] !== N_IXH[j]) die('phaseN: indexed flag ' + N_IXNH[j] + ' bit wrong');
    if ((F.f3 | F.f14 | F.f27 | F.f30 | F.f0 | F.f9 | F.f22 | F.f31) !== N_OP0 ||
        (FH.h0 | FH.h17 | FH.h5 | FH.h31) !== N_OPH) die('phaseN: flag map bits wrong');
    return a;
}

function nSeed(st, cap) {
    st.fill(0);
    st[NS_RO] = 0x2545F491; st[NS_RK] = 0x6B43A9B5; st[NS_RV] = 0x1F123BB5; st[NS_CAP] = cap;
}

function nZero(st) {
    st[NS_OPS] = 0; st[NS_VISITS] = 0; st[NS_SWEEPDS] = 0; st[NS_CFA] = 0; st[NS_MAXSLOT] = 0;
}

// COLD, after a window: die() on the first recorded oracle failure.
function nCheck(st, where) {
    const c = st[NS_FAIL];
    if (c === 0) return;
    const j = st[NS_BIT], got = st[NS_GOT], want = st[NS_WANT];
    const at = ' (' + where + ' frame ' + st[NS_FFRAME];
    const name = j >= 4 && j < 6 ? N_IXNH[j - 4] : j >= 0 && j < 4 ? N_IXN[j] : '?';
    if (c === 1 || c === 7) {
        die('phaseN: row != mirror' + at + ', ' + (c === 7 ? 'Hi ' : '') + 'slot ' + j + ': row 0x' +
            (got >>> 0).toString(16) + ' vs mirror 0x' + (want >>> 0).toString(16) + ')');
    }
    if (c === 2) {
        die('phaseN: column != row' + at + ', flag ' + name + ': flagCount ' + got + ' vs row/mirror ' + want + ')');
    }
    if (c === 3) {
        die('phaseN: column != row' + at + ', flag ' + name + ': walk visited ' + got +
            ' vs row/mirror ' + want + ', count or FNV-1a over handles differs)');
    }
    if (c === 4) {
        die('phaseN: despawning sweep != mirror' + at + ', flag ' + name + ': visited ' + got + ' vs ' + want +
            ', count or FNV-1a differs; M-39)');
    }
    if (c === 5) die('phaseN: a write on a live handle returned false' + at + ', slot ' + got + ', op ' + want + ')');
    die('phaseN: spawn after despawn landed on slot ' + got + ', expected ' + want + at + ')');
}

// COLD: every indexed bit populated but not saturated (a non-degenerate oracle).
function nNonDegenerate(hs, mir, mirH, st, where) {
    const cap = st[NS_CAP];
    for (let j = 0; j < 6; j++) {
        const hi = j >= 4, bit = hi ? N_IXH[j - 4] : N_IX0[j];
        const n = nMirror(hi ? mirH : mir, hs, cap, bit, st);
        if (!(n > 0) || !(n < cap)) {
            die('phaseN: degenerate ' + where + ' mirror count ' + n + ' for ' + (hi ? N_IXNH[j - 4] : N_IXN[j]));
        }
    }
    if (!(st[NS_SWEEPDS] > 0) || !(st[NS_CFA] > 0)) {
        die('phaseN: ' + where + ' coverage: sweepDespawns ' + st[NS_SWEEPDS] + ', clearFlagAll ' + st[NS_CFA]);
    }
}

function nOpen() {
    globalThis.gc();
    globalThis.gc();
    const g = new GcProfiler(256, { heap: true }).start();
    g.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    return g;
}

async function nClose(g) {
    const mu = process.memoryUsage();
    g.sampleHeap(performance.now(), mu.heapUsed, mu);
    await g.settle();
    const s = g.summary();
    g.stop();
    return s;
}

function nWin(name, summary, st, extra) {
    return {
        name, summary, report: checkNoGc(summary, RULES_N), ops: st[NS_OPS], visits: st[NS_VISITS],
        sweepDespawns: st[NS_SWEEPDS], clearFlagAll: st[NS_CFA], maxSlot: st[NS_MAXSLOT], extra,
    };
}

// N5: joinN(REQ, EXC, z | a) on Phase I's population; returns the window record.
async function nHint() {
    const ja = new Arena(CAP);
    const A = ja.registerComponent({ x: Float32Array }); // required, largest
    const B = ja.registerTag();                          // required, half
    const C = ja.registerTag();                          // required, rarest set -> driver
    const D = ja.registerTag();                          // excluded
    const JF = ja.registerFlags(lNames(), { indexed: ['f0', 'f31'] });
    if (JF.f31 !== N_Z || JF.f0 !== N_A) die('phaseN: N5 flag map bits wrong');
    // z (f31): 16 entities on C (i = 64 + 256k) + 4 odd ones off B; a (f0): i % 3 !== 0.
    let zc = 0, brute = 0;
    for (let i = 0; i < CAP; i++) {
        const e = ja.spawn();
        if ((e & INDEX_MASK) !== i) die('phaseN: N5 fresh arena handed slot ' + (e & INDEX_MASK) + ' at ' + i);
        A.add(e);
        if ((i & 1) === 0) B.add(e);
        if ((i & 63) === 0) C.add(e);
        if ((i & 127) === 0) D.add(e);
        const z = (i & 255) === 64 || (i & 1023) === 7;
        const af = i % 3 !== 0;
        if (z) zc++;
        if (!ja.setFlags(e, (z ? N_Z : 0) | (af ? N_A : 0))) die('phaseN: N5 setFlags false on a live entity');
        // Brute force from index arithmetic: in A, B, C, not D, carrying z and a.
        if ((i & 1) === 0 && (i & 63) === 0 && (i & 127) !== 0 && z && af) brute++;
    }
    const REQ = [A, B, C];
    const EXC = [D];
    const ZA = N_Z | N_A;
    if (!(brute > 0) || !(brute < zc) || !(zc < C.count)) {
        die('phaseN: N5 degenerate (brute=' + brute + ' zCount=' + zc + ' C.count=' + C.count + ')');
    }
    const p0 = ja.joinN(REQ, EXC, ZA);
    if (p0.driver !== C || p0.driverFlag !== N_Z || p0.driverFlagCount !== zc) {
        die('phaseN: N5 hint driverFlag=' + p0.driverFlag + ' driverFlagCount=' + p0.driverFlagCount +
            ' (expected ' + N_Z + ' / ' + zc + ', driver C ' + (p0.driver === C) + ')');
    }
    // [0] first call with a wrong hint + 1, [1] first miscounting call + 1, [2] its
    // driver-loop count, [3] its flag-driven count.
    const hst = new Int32Array(4);

    const g = nOpen();
    let acc = 0, accF = 0;
    for (let n = 0; n < HOT_OPS_MIN; n++) {
        const p = ja.joinN(REQ, EXC, ZA);
        const zf = p.driverFlag;
        if ((zf !== N_Z || p.driverFlagCount !== zc || p.driver !== C) && hst[0] === 0) hst[0] = n + 1;
        const drv = p.driver, cnt = p.count;
        const oth = p.others, no = p.othersCount;
        const ex = p.excl, nx = p.exclCount;
        const row = p.flags, m = ja.indexMask, rm = p.reqMask, xm = p.excMask;
        // Driver loop: the rarest required set, masked.
        let matched = 0;
        for (let i = 0; i < cnt; i++) {
            const e = drv.dense[i];
            const w = row[e & m];
            if ((w & rm) !== rm || (w & xm) !== 0) continue;
            let ok = true;
            for (let k = 0; k < no; k++) if (!oth[k].has(e)) { ok = false; break; }
            if (ok) for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
            if (ok) matched++;
        }
        // Flag-driven loop: walk the hinted indexed flag, test every set + the mask.
        let fm = 0;
        for (let e = ja.firstFlagged(zf); e !== -1; e = ja.nextFlagged(zf, e)) {
            const w = row[e & m];
            if ((w & rm) !== rm || (w & xm) !== 0 || !drv.has(e)) continue;
            let ok = true;
            for (let k = 0; k < no; k++) if (!oth[k].has(e)) { ok = false; break; }
            if (ok) for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
            if (ok) fm++;
        }
        if ((matched !== brute || fm !== brute) && hst[1] === 0) { hst[1] = n + 1; hst[2] = matched; hst[3] = fm; }
        acc = acc + matched;
        accF = accF + fm;
        if (NLEAK_HINT) nSink[0] = new Int32Array(1); // control: transient per-call alloc
    }
    const summary = await nClose(g);
    nSink[0] = null;

    if (hst[0] !== 0) die('phaseN: N5 joinN hint wrong at call ' + (hst[0] - 1));
    if (hst[1] !== 0) {
        die('phaseN: N5 counts disagree at call ' + (hst[1] - 1) + ' (driver loop ' + hst[2] +
            ', flag-driven ' + hst[3] + ', brute force ' + brute + ')');
    }
    if (acc !== brute * HOT_OPS_MIN || accF !== brute * HOT_OPS_MIN) die('phaseN: N5 match totals off');
    return {
        name: 'N5', summary, report: checkNoGc(summary, RULES_N), ops: HOT_OPS_MIN,
        hint: p0.driverFlag, hintCount: p0.driverFlagCount, drvCount: p0.count, brute,
    };
}

// N6: retention (unmeasured), Phase K's shape on an indexed arena.
function nRetention() {
    const ra = new Arena(CAP);
    ra.registerFlags(lNames(), { indexed: N_IXN });
    ra.registerFlagsHi(mNamesHi(), { indexed: N_IXNH });
    const tracker = createLeakTracker({ name: 'arena-indexed-flags-retention' });
    const leakHandles = new Array(CAP).fill(null);
    const live = new Int32Array(N_CHURN);
    for (let cycle = 0; cycle < N_CYCLES; cycle++) {
        let n = 0;
        for (let i = 0; i < N_CHURN; i++) {
            if (ra.activeCount >= CAP) break; // LEAK control fills the arena: stop, do not throw
            const e = ra.spawn();
            if (!ra.setFlags(e, N_OP0) || !ra.setFlagsHi(e, N_OPH)) die('phaseN: N6 setFlags false on a live entity');
            const slot = e & INDEX_MASK;
            leakHandles[slot] = tracker.track({ slot }, NOOP, slot);
            live[n++] = e;
        }
        if (LEAK) continue; // control: skip release entirely
        for (let i = 0; i < n; i++) {
            const e = live[i];
            const slot = e & INDEX_MASK;
            tracker.untrack(leakHandles[slot]);
            leakHandles[slot] = null;
            ra.despawn(e);
        }
    }
    let countOr = 0, firstLive = 0, rowOr = 0;
    for (let j = 0; j < 4; j++) {
        countOr |= ra.flagCount(N_IX0[j]);
        if (ra.firstFlagged(N_IX0[j]) !== -1) firstLive++;
    }
    for (let j = 0; j < 2; j++) {
        countOr |= ra.flagCountHi(N_IXH[j]);
        if (ra.firstFlaggedHi(N_IXH[j]) !== -1) firstLive++;
    }
    const row = ra.flags, rowH = ra.flagsHi;
    for (let i = 0; i < CAP; i++) rowOr |= row[i] | rowH[i];
    return { trackerSize: tracker.size(), activeCount: ra.activeCount, countOr, firstLive, rowOr };
}

async function phaseN() {
    const hs = new Int32Array(N_GROW).fill(-1);
    const mir = new Int32Array(N_GROW);
    const mirH = new Int32Array(N_GROW);
    const st = new Int32Array(NS_LEN);

    // ---- N1: full Arena(CAP), seeded op stream ----
    const a = nArena(false);
    nSeed(st, CAP);
    nFill(a, hs, mir, mirH, st);
    if (a.activeCount !== CAP) die('phaseN: N1 arena not full (' + a.activeCount + ')');
    nOracle(a, hs, mir, mirH, st, -1);
    nCheck(st, 'N1 fill');
    for (let f = 0; f < N_WARM; f++) nFrame(a, hs, mir, mirH, st, f, false, false);
    nCheck(st, 'N1 warm-up');
    nZero(st);
    const g1 = nOpen();
    for (let f = 0; f < N_FRAMES; f++) nFrame(a, hs, mir, mirH, st, f, NLEAK, NDESYNC && f === N_DESYNC_FRAME);
    const s1 = await nClose(g1);
    nSink[0] = null;
    nCheck(st, 'N1');
    nNonDegenerate(hs, mir, mirH, st, 'N1');
    if (a.activeCount !== CAP) die('phaseN: N1 activeCount drifted to ' + a.activeCount);
    const n1 = nWin('N1', s1, st, 0);

    // ---- N2: reserve(N_GROW), fill the new slots, frames reach slots >= CAP ----
    if (!a.reserve(N_GROW) || a.capacity !== N_GROW) die('phaseN: N2 reserve(' + N_GROW + ') failed');
    st[NS_CAP] = N_GROW;
    const grown = nFill(a, hs, mir, mirH, st);
    if (grown < CAP) die('phaseN: N2 filled only ' + grown + ' new slots');
    nOracle(a, hs, mir, mirH, st, -1);
    nCheck(st, 'N2 fill');
    nZero(st);
    const g2 = nOpen();
    for (let f = 0; f < N_FRAMES2; f++) nFrame(a, hs, mir, mirH, st, f, false, false);
    const s2 = await nClose(g2);
    nCheck(st, 'N2');
    nNonDegenerate(hs, mir, mirH, st, 'N2');
    if (st[NS_MAXSLOT] < CAP) die('phaseN: N2 walks never visited a slot >= ' + CAP + ' (max ' + st[NS_MAXSLOT] + ')');
    const n2 = nWin('N2', s2, st, grown);

    // ---- N3: clear() empties every column; refill inside the window ----
    a.clear();
    if (a.activeCount !== 0) die('phaseN: N3 activeCount ' + a.activeCount + ' after clear()');
    for (let j = 0; j < 4; j++) {
        if (a.flagCount(N_IX0[j]) !== 0 || a.firstFlagged(N_IX0[j]) !== -1) {
            die('phaseN: N3 ' + N_IXN[j] + ' flagCount ' + a.flagCount(N_IX0[j]) + ' / firstFlagged ' +
                a.firstFlagged(N_IX0[j]) + ' after clear() (expected 0 / -1)');
        }
    }
    for (let j = 0; j < 2; j++) {
        if (a.flagCountHi(N_IXH[j]) !== 0 || a.firstFlaggedHi(N_IXH[j]) !== -1) {
            die('phaseN: N3 ' + N_IXNH[j] + ' flagCountHi ' + a.flagCountHi(N_IXH[j]) + ' / firstFlaggedHi ' +
                a.firstFlaggedHi(N_IXH[j]) + ' after clear() (expected 0 / -1)');
        }
    }
    hs.fill(-1); mir.fill(0); mirH.fill(0);
    nZero(st);
    const g3 = nOpen();
    const refilled = nFill(a, hs, mir, mirH, st);
    nOracle(a, hs, mir, mirH, st, -1);
    for (let f = 0; f < N_FRAMES3; f++) nFrame(a, hs, mir, mirH, st, f, false, false);
    const s3 = await nClose(g3);
    nCheck(st, 'N3');
    if (refilled !== N_GROW) die('phaseN: N3 refilled ' + refilled + ', expected ' + N_GROW);
    nNonDegenerate(hs, mir, mirH, st, 'N3');
    const n3 = nWin('N3', s3, st, refilled);

    // ---- N4: checked arena, the same seeds and stream ----
    const c = nArena(true);
    hs.fill(-1); mir.fill(0); mirH.fill(0);
    nSeed(st, CAP);
    nFill(c, hs, mir, mirH, st);
    nOracle(c, hs, mir, mirH, st, -1);
    nCheck(st, 'N4 fill');
    for (let f = 0; f < N_WARM; f++) nFrame(c, hs, mir, mirH, st, f, false, false);
    nCheck(st, 'N4 warm-up');
    nZero(st);
    const g4 = nOpen();
    for (let f = 0; f < N_FRAMES4; f++) nFrame(c, hs, mir, mirH, st, f, false, false);
    const s4 = await nClose(g4);
    nCheck(st, 'N4');
    nNonDegenerate(hs, mir, mirH, st, 'N4');
    const n4 = nWin('N4', s4, st, 0);
    // Cold: a non-int32 mask whose `| 0` is an indexed bit must throw (M-18), and
    // leave the row, the count and the walk equal to the (untouched) mirror.
    let ts = -1;
    for (let s = 0; s < CAP; s++) {
        if ((mir[s] & (N_IX0[0] | N_IX0[3])) === 0 && (mirH[s] & (N_IXH[0] | N_IXH[1])) === 0) { ts = s; break; }
    }
    if (ts < 0) die('phaseN: N4 found no slot clear of f0 / f31 / h5 / h31');
    const te = hs[ts];
    let threw = 0;
    try { c.setFlags(te, 1.5); } catch (err) { if (/32-bit integer/.test(err.message)) threw++; }
    try { c.setFlags(te, 2147483648.5); } catch (err) { if (/32-bit integer/.test(err.message)) threw++; }
    try { c.setFlagsHi(te, 32.5); } catch (err) { if (/32-bit integer/.test(err.message)) threw++; }
    try { c.setFlagsHi(te, 2147483648.5); } catch (err) { if (/32-bit integer/.test(err.message)) threw++; }
    if (threw !== 4) die('phaseN: N4 checked setFlags / setFlagsHi accepted a non-int32 mask (' + threw + '/4 threw)');
    nOracle(c, hs, mir, mirH, st, -1);
    nCheck(st, 'N4 after the non-int32 throws');

    // ---- N5: the joinN driver-flag hint ----
    const n5 = await nHint();

    // ---- N6: retention ----
    const r = nRetention();

    return { win: [n1, n2, n3, n4, n5], ...r };
}

// COLD: Phase N's part of the one-line run log (stderr).
function nSummary(nR) {
    let s = '';
    for (const w of nR.win) {
        const g = w.summary.gc;
        s += w.name + ' ops=' + w.ops + ' major=' + g.major + ' minor=' + g.minor;
        if (w.name === 'N5') {
            s += ' hint=' + w.hint + '/' + w.hintCount + ' drvCount=' + w.drvCount + ' matches=' + w.brute;
        } else {
            s += ' visits=' + w.visits + ' sweepDespawns=' + w.sweepDespawns + ' clearFlagAll=' + w.clearFlagAll +
                ' maxSlot=' + w.maxSlot + (w.extra > 0 ? ' filled=' + w.extra : '');
        }
        s += ' ';
    }
    return s + 'N6 tracker=' + nR.trackerSize + ' active=' + nR.activeCount + ' countOr=' + nR.countOr +
        ' rowOr=' + nR.rowOr;
}

// --- gate --------------------------------------------------------------------

async function main() {
    if (typeof globalThis.gc !== 'function') {
        die('run with --expose-gc:  node --expose-gc test/torture.mjs');
    }

    // Phase F first: its liveness census must see a fresh process. Phases E and F
    // self-report via die() on any failure, so reaching the gate below means the
    // retirement soak and the handle-space sweep both passed. Included in the
    // gate for symmetry.
    const f = phaseF();
    const a = phaseA();
    const b = await phaseB();
    const c = await phaseC();
    const d = await phaseD();
    const e = phaseE();
    const g = phaseG();
    const h = phaseH();
    const iRes = await phaseI();
    const j = await phaseJ();
    const k = await phaseK();
    const l = await phaseL();
    const mR = await phaseM();
    const nR = await phaseN();

    // REPORTED, never gated: Phase J's wall-clock pause (host noise), plus the
    // Phase J / K / L / M / N counts for the run log. stderr, so stdout stays exactly "ok".
    process.stderr.write(
        'torture: phaseJ major=' + j.summary.gc.major + ' minor=' + j.summary.gc.minor +
        ' maxPauseMs=' + j.summary.gc.maxMs.toFixed(3) + ' (pause reported, not gated)' +
        ' | phaseK ops=' + k.ops + ' major=' + k.summary.gc.major +
        ' minor=' + k.summary.gc.minor + ' maxPauseMs=' + k.summary.gc.maxMs.toFixed(3) +
        ' | phaseL ops=' + l.ops + ' major=' + l.summary.gc.major +
        ' minor=' + l.summary.gc.minor + ' maxPauseMs=' + l.summary.gc.maxMs.toFixed(3) +
        ' | phaseM frames ops=' + mR.fOps + ' major=' + mR.fSummary.gc.major +
        ' minor=' + mR.fSummary.gc.minor + ' row/hasHi=' + mR.fRow + '/' + mR.fHas +
        ' oracle=' + mR.fOr + '/' + mR.fOrH +
        ' joinN ops=' + mR.ops + ' major=' + mR.summary.gc.major + ' minor=' + mR.summary.gc.minor +
        ' masked/lo/unmasked=' + mR.expected + '/' + mR.loMasked + '/' + mR.unmasked +
        ' retention or=' + mR.flagOr + ' orHi=' + mR.flagOrHi +
        ' | phaseN ' + nSummary(nR) + '\n');

    const retentionOk = a.activeCount === 0 && a.trackerSize === 0;
    const budgetOk = b.report.ok;
    const joinOk = c.report.ok;
    const reserveOk = d.report.ok;
    const sweepOk = e.ok;
    const conservationOk = f.ok;
    const sabOk = g.ok;
    const transferOk = h.ok;
    const joinNOk = iRes.report.ok;
    const churnOk = j.report.ok;
    const flagsOk = k.report.ok;
    const flagsRetentionOk = k.trackerSize === 0 && k.activeCount === 0 && k.flagSum === 0;
    const maskedOk = l.report.ok;
    const maskedRetentionOk = l.trackerSize === 0 && l.activeCount === 0 && l.flagOr === 0;
    const hiFramesOk = mR.fReport.ok;
    const hiFrameOracleOk = mR.frameBad === 0;
    const hiJoinOk = mR.report.ok;
    const hiRetentionOk = mR.trackerSize === 0 && mR.activeCount === 0 &&
        mR.flagOr === 0 && mR.flagOrHi === 0;
    let indexedOk = true;
    for (const w of nR.win) if (!w.report.ok) indexedOk = false;
    const indexedRetentionOk = nR.trackerSize === 0 && nR.activeCount === 0 && nR.countOr === 0 &&
        nR.firstLive === 0 && nR.rowOr === 0;

    if (retentionOk && budgetOk && joinOk && reserveOk && sweepOk && conservationOk && sabOk && transferOk &&
        joinNOk && churnOk && flagsOk && flagsRetentionOk && maskedOk && maskedRetentionOk &&
        hiFramesOk && hiFrameOracleOk && hiJoinOk && hiRetentionOk && indexedOk && indexedRetentionOk) {
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
    if (!joinNOk) {
        const gc = iRes.summary.gc;
        process.stderr.write(
            'torture: joinN -- verdict=' + iRes.report.verdict +
            ' source=' + iRes.summary.source +
            ' major=' + gc.major + ' maxMs=' + gc.maxMs.toFixed(3) +
            ' (rules ' + JSON.stringify(RULES) + ')\n');
    }
    if (!churnOk) {
        const gc = j.summary.gc;
        process.stderr.write(
            'torture: churn -- verdict=' + j.report.verdict +
            ' source=' + j.summary.source +
            ' major=' + gc.major + ' maxMs=' + gc.maxMs.toFixed(3) +
            ' minor=' + gc.minor +
            ' (rules ' + JSON.stringify(RULES_J) + ')\n');
    }
    if (!flagsOk) {
        const gc = k.summary.gc;
        process.stderr.write(
            'torture: flags -- verdict=' + k.report.verdict +
            ' source=' + k.summary.source +
            ' major=' + gc.major + ' minor=' + gc.minor + ' maxMs=' + gc.maxMs.toFixed(3) +
            ' (rules ' + JSON.stringify(RULES_K) + ')\n');
    }
    if (!flagsRetentionOk) {
        process.stderr.write(
            'torture: flags-retention -- trackerSize=' + k.trackerSize +
            ' activeCount=' + k.activeCount + ' flagSum=' + k.flagSum + ' (all must be 0)\n');
    }
    if (!maskedOk) {
        const gc = l.summary.gc;
        process.stderr.write(
            'torture: masked-joinN (phaseL) -- verdict=' + l.report.verdict +
            ' source=' + l.summary.source +
            ' major=' + gc.major + ' minor=' + gc.minor + ' maxMs=' + gc.maxMs.toFixed(3) +
            ' (rules ' + JSON.stringify(RULES_L) + ')\n');
    }
    if (!maskedRetentionOk) {
        process.stderr.write(
            'torture: masked-joinN-retention (phaseL) -- trackerSize=' + l.trackerSize +
            ' activeCount=' + l.activeCount + ' flagOr=' + l.flagOr + ' (all must be 0)\n');
    }
    if (!hiFramesOk) {
        const gc = mR.fSummary.gc;
        process.stderr.write(
            'torture: flags-hi frames (phaseM) -- verdict=' + mR.fReport.verdict +
            ' source=' + mR.fSummary.source +
            ' major=' + gc.major + ' minor=' + gc.minor + ' maxMs=' + gc.maxMs.toFixed(3) +
            ' (rules ' + JSON.stringify(RULES_M) + ')\n');
    }
    if (!hiFrameOracleOk) {
        process.stderr.write(
            'torture: flags-hi frame oracle (phaseM) -- ' + (mR.frameBad < 0 ? 'warm-up ' : '') +
            'frame ' + (Math.abs(mR.frameBad) - 1) + ' two-row/hasFlagsHi disagree with the mirror (last ' +
            mR.fRow + '/' + mR.fHas + ' vs ' + mR.fOr + '/' + mR.fOrH + ')\n');
    }
    if (!hiJoinOk) {
        const gc = mR.summary.gc;
        process.stderr.write(
            'torture: two-word joinN (phaseM) -- verdict=' + mR.report.verdict +
            ' source=' + mR.summary.source +
            ' major=' + gc.major + ' minor=' + gc.minor + ' maxMs=' + gc.maxMs.toFixed(3) +
            ' (rules ' + JSON.stringify(RULES_M) + ')\n');
    }
    if (!hiRetentionOk) {
        process.stderr.write(
            'torture: flags-hi-retention (phaseM) -- trackerSize=' + mR.trackerSize +
            ' activeCount=' + mR.activeCount + ' flagOr=' + mR.flagOr + ' flagOrHi=' + mR.flagOrHi +
            ' (all must be 0)\n');
    }
    for (const w of nR.win) {
        if (w.report.ok) continue;
        const gc = w.summary.gc;
        process.stderr.write(
            'torture: indexed-flags ' + w.name + ' (phaseN) -- verdict=' + w.report.verdict +
            ' source=' + w.summary.source +
            ' major=' + gc.major + ' minor=' + gc.minor + ' maxMs=' + gc.maxMs.toFixed(3) +
            ' ops=' + w.ops +
            ' (rules ' + JSON.stringify(RULES_N) + ')\n');
    }
    if (!indexedRetentionOk) {
        process.stderr.write(
            'torture: indexed-flags-retention N6 (phaseN) -- trackerSize=' + nR.trackerSize +
            ' activeCount=' + nR.activeCount + ' flagCountOr=' + nR.countOr +
            ' firstFlaggedLive=' + nR.firstLive + ' rowOr=' + nR.rowOr + ' (all must be 0)\n');
    }
    die('gate rejected' + (LEAK || HLEAK || JLEAK || SLEAK || FLEAK || MLEAK || WLEAK ||
        NLEAK || NLEAK_HINT || NDESYNC
        ? ' (leaky control -- expected)' : ''));
}

main();
