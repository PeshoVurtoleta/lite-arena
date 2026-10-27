/**
 * @zakkster/lite-arena -- free-slot flag (Group B) tests.
 *
 * A FREE slot's stored generation carries a flag so isAlive() rejects the
 * handle spawn() would hand out next. Invariant under test: the number of
 * handles for which isAlive() is true equals activeCount, always.
 *
 * Run: `node --test test/free-slot.test.js`
 * Control run against another build:
 *   LITE_ARENA_PATH=/abs/path/Arena.js node --test test/free-slot.test.js
 *
 * Expected values come from the Group B spec (PLAN-B A1/A2), never from the
 * build under test. P1 goldens are a PIN cut from the frozen build.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { replay } from './gen-stream.mjs';

const mod = await import(process.env.LITE_ARENA_PATH
    ? pathToFileURL(process.env.LITE_ARENA_PATH).href
    : '../Arena.js');
const { Arena } = mod;

const FIRST = 1048576; // (gen 1 << 20) | index 0 : first handle of any fresh arena

// Count of (index, generation) handles that isAlive() accepts. Small arenas only.
function aliveCount(arena) {
    let n = 0;
    for (let i = 0; i < arena.capacity; i++) {
        for (let g = 0; g <= 4095; g++) if (arena.isAlive((g << 20) | i)) n++;
    }
    return n;
}

test('T1 fresh arena: no handle is alive; next handle is rejected everywhere', () => {
    const a = new Arena(4);
    assert.equal(aliveCount(a), 0);
    assert.equal(a.isAlive(FIRST), false);
    const tag = a.registerTag();
    assert.equal(tag.add(FIRST), -1);
    assert.equal(tag.has(FIRST), false);
});

test('T2 tag add of a free slot handle is refused and then spawn returns it', () => {
    const a = new Arena(4);
    const tag = a.registerTag();
    assert.equal(tag.add(FIRST), -1);
    assert.equal(tag.count, 0);
    assert.equal(a.spawn(), FIRST);
    assert.equal(tag.has(FIRST), false); // tag absent on the freshly spawned entity
    assert.equal(tag.add(FIRST), 0);
});

test('T3 despawn of a free slot handle is a no-op (no double free)', () => {
    const a = new Arena(4);
    assert.equal(a.despawn(FIRST), false);
    assert.equal(a.activeCount, 0);
    assert.equal(a.remainingCapacity(), 4);
    assert.equal(a.spawn(), FIRST);
    assert.equal(a.activeCount, 1);
    assert.equal(a.remainingCapacity(), 3);
});

test('T4 after despawn the slot is free: its next handle is dead', () => {
    const a = new Arena(4);
    const e0 = a.spawn(), e1 = a.spawn();
    assert.equal(aliveCount(a), a.activeCount);
    assert.equal(a.despawn(e1), true);
    assert.equal(a.isAlive(e1), false);
    assert.equal(a.isAlive(e1 + FIRST), false); // next generation of a free slot
    assert.equal(a.despawn(e1 + FIRST), false);
    assert.equal(aliveCount(a), a.activeCount);
    assert.equal(a.activeCount, 1);
    assert.equal(a.isAlive(e0), true);
    assert.equal(a.remainingCapacity(), 3);
});

test('T5 clear leaves every slot free: nothing alive', () => {
    const a = new Arena(4);
    a.spawn(); a.spawn(); const e = a.spawn();
    a.despawn(e);
    a.clear();
    assert.equal(a.activeCount, 0);
    assert.equal(aliveCount(a), 0);
    a.spawn();
    assert.equal(aliveCount(a), 1);
});

test('T6 reserve: new slots are free, census equals activeCount', () => {
    const a = new Arena(2);
    a.spawn();
    assert.equal(aliveCount(a), 1);
    a.reserve(6);
    assert.equal(a.activeCount, 1);
    assert.equal(aliveCount(a), 1);
    for (let k = 0; k < 5; k++) a.spawn();
    assert.equal(aliveCount(a), 6);
    assert.equal(a.activeCount, 6);
    a.clear();
    assert.equal(aliveCount(a), 0);
});

test('T7 retire then clear revives the slot as free, not alive', () => {
    const a = new Arena(1);
    // A slot gives 4095 spawns (spec: S1 = 4 slots x 4095 = 16380), then retires.
    for (let k = 0; k < 4095; k++) a.despawn(a.spawn());
    assert.equal(a.retiredCount, 1);
    assert.equal(aliveCount(a), 0);
    assert.throws(() => a.spawn(), /retired/);
    a.clear();
    assert.equal(a.retiredCount, 0);
    assert.equal(a.activeCount, 0);
    assert.equal(aliveCount(a), 0);
    a.spawn();
    assert.equal(aliveCount(a), 1);
});

// P1 -- PIN: goldens cut from the frozen build commit ce3f63c, Arena.js sha256
// prefix 5428e778, via replay(). The free-slot fix must not change the
// generation sequence. (Regression pin: passes on old and fixed code.)
test('P1 generation stream is unchanged by the free-slot flag', () => {
    const r = replay(Arena);
    assert.equal(r.S1.spawns, 16380);
    assert.equal(r.S1.retiredCount, 4);
    assert.equal(r.S1.hash, 569529733);
    assert.equal(r.S3.first, FIRST);
    assert.equal(r.S3.retiredCount, 0);
    assert.equal(r.S2.hash, 1100606991);
    assert.equal(r.S2.activeCount, 5);
    assert.equal(r.S2.retiredCount, 0);
    // coverage floors: the S2 stream exercised every op class
    const c = r.S2.cov;
    for (const k of ['spawnOk', 'spawnFull', 'despawnTrue', 'despawnFalse', 'tagAdd', 'alive']) {
        assert.ok(c[k] >= 1000, `S2 coverage ${k}=${c[k]}`);
    }
});
