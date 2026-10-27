/**
 * Generation-stream replay harness (test helper, not a test file).
 * replay(ArenaCtor) drives three deterministic scenarios and returns hashes of
 * every handle / result observed. Used to PIN that the free-slot flag does not
 * change the generation sequence. Seeded 32-bit PRNG, Math.imul only.
 */

const FNV_OFFSET = 0x811C9DC5 | 0;
const FNV_PRIME = 0x01000193;

function mix(h, v) {
    h = Math.imul(h ^ (v & 0xFF), FNV_PRIME);
    h = Math.imul(h ^ ((v >>> 8) & 0xFF), FNV_PRIME);
    h = Math.imul(h ^ ((v >>> 16) & 0xFF), FNV_PRIME);
    h = Math.imul(h ^ ((v >>> 24) & 0xFF), FNV_PRIME);
    return h;
}

function xorshift32(state) {
    let x = state | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x | 0;
}

function s1(Arena) {
    // LIFO grind on Arena(4) until spawn throws.
    const a = new Arena(4);
    const held = [0, 0, 0, 0];
    let h = FNV_OFFSET, spawns = 0, done = false;
    while (!done) {
        let n = 0;
        for (let k = 0; k < 4; k++) {
            let e;
            try { e = a.spawn(); } catch (err) { done = true; break; }
            held[n++] = e;
            spawns++;
            h = mix(h, e);
        }
        for (let k = n - 1; k >= 0; k--) a.despawn(held[k]);
    }
    return { spawns, hash: h >>> 0, retiredCount: a.retiredCount };
}

function s2(Arena) {
    const a = new Arena(3);
    const tag = a.registerTag();
    const held = new Array(8).fill(0);
    let nHeld = 0, lastDead = 0;
    let opS = 0x9E3779B9 | 0;          // op stream
    let keyS = (0x9E3779B9 ^ 0x85EBCA6B) | 0; // independent key stream
    let h = FNV_OFFSET;
    const cov = { spawnOk: 0, spawnFull: 0, despawnTrue: 0, despawnFalse: 0, tagAdd: 0, alive: 0 };
    for (let op = 0; op < 40000; op++) {
        if (op === 20000) a.reserve(5);
        if (op === 13000 || op === 30000) { a.clear(); nHeld = 0; }
        opS = xorshift32(opS);
        keyS = xorshift32(keyS);
        const kind = (opS >>> 0) % 5;
        const pick = nHeld > 0 ? (keyS >>> 0) % nHeld : 0;
        if (kind === 0 || kind === 1) {
            let e = -1;
            try { e = a.spawn(); cov.spawnOk++; if (nHeld < 8) held[nHeld++] = e; } catch (err) { cov.spawnFull++; }
            h = mix(h, e);
        } else if (kind === 2 && nHeld > 0) {
            const e = held[pick];
            const r = a.despawn(e);
            r ? cov.despawnTrue++ : cov.despawnFalse++;
            held[pick] = held[--nHeld];
            lastDead = e;
            h = mix(h, r ? e : 0);
        } else if (kind === 3 && nHeld > 0) {
            const e = held[pick];
            h = mix(h, tag.add(e) + 1); cov.tagAdd++;
        } else {
            // stale-handle probe: a previously despawned handle (its generation is
            // behind the slot's). NEVER a free slot's next handle -- HEAD wrongly
            // accepts that (the bug under test) and would change the stream.
            const probe = lastDead;
            const r = a.despawn(probe);
            r ? cov.despawnTrue++ : cov.despawnFalse++;
            if (r) { const i = held.indexOf(probe); if (i >= 0 && i < nHeld) held[i] = held[--nHeld]; }
            h = mix(h, (a.isAlive(probe) ? 1 : 0) | (r ? 2 : 0));
            cov.alive++;
        }
    }
    h = mix(h, a.activeCount); h = mix(h, a.retiredCount); h = mix(h, a.capacity);
    return { hash: h >>> 0, activeCount: a.activeCount, retiredCount: a.retiredCount, cov };
}

function s3(Arena) {
    const a = new Arena(1);
    for (let k = 0; k < 4094; k++) a.despawn(a.spawn());
    a.clear();
    const first = a.spawn();
    return { first, retiredCount: a.retiredCount };
}

export function replay(Arena) {
    return { S1: s1(Arena), S2: s2(Arena), S3: s3(Arena) };
}
