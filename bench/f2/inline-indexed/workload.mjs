// L4b inlining-trial workload (F2 indexed API; G3 T5). Small hot user functions on ONE indexed
// arena (word 0 indexes a and z = bit 31, the Hi word indexes h) so TurboFan compiles each caller
// and every target shows up in the trace: the 14 F2 exact-pin functions (ixSetFlags, ixClearFlags,
// ixSetFlagsHi, ixClearFlagsHi, ixDespawn, ixSet, ixUnset, ixWordFrom, nextFlagged, nextFlaggedHi,
// flagCount, flagCountHi, firstFlagged, firstFlaggedHi) + joinN + pickFlagDriver, each >= 10^5 calls
// (toggle() re-sets the flagged entities 8x per round so ixSet / ixUnset also pass 10^5).
// Flags sit on every 67th slot from slot 40, so walks cross empty words (ixWordFrom) and word 0
// is empty (firstFlagged takes its ixWordFrom branch). Every build runs byte-identical driver code;
// only the imported Arena.js differs. run() throws if a walk, count or hint disagrees with a
// brute-force row scan (the workload's own checks); it returns an int sink.
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>

export const ROUNDS = 200;
export const N = 4096;
export const STEP = 67, FROM = 40;
const SINK = new Int32Array(1);

function spawnAll(arena, Pos, Vel, ents) {
  for (let i = 0; i < N; i++) {
    const e = arena.spawn();
    ents[i] = e;
    Pos.add(e);
    if ((i & 1) === 0) Vel.add(e);
  }
}
function mark(arena, ents, a, b, z, h, k) {
  for (let i = 0; i < N; i++) {
    const on = i % STEP === FROM;
    arena.setFlags(ents[i], on ? a | z : b);
    arena.setFlagsHi(ents[i], on ? h : k);
  }
}
function walk(arena, f) {
  let c = 0, s = 0;
  for (let e = arena.firstFlagged(f); e !== -1; e = arena.nextFlagged(f, e)) { c++; s = (s + e) | 0; }
  SINK[0] ^= s;
  return c;
}
function walkHi(arena, f) {
  let c = 0, s = 0;
  for (let e = arena.firstFlaggedHi(f); e !== -1; e = arena.nextFlaggedHi(f, e)) { c++; s = (s + e) | 0; }
  SINK[0] ^= s;
  return c;
}
function firsts(arena, a, h, n) {
  let s = 0;
  for (let j = 0; j < n; j++) s = (s + arena.firstFlagged(a) + arena.firstFlaggedHi(h)) | 0;
  return s;
}
function counts(arena, a, h, n) {
  let s = 0;
  for (let j = 0; j < n; j++) s = (s + arena.flagCount(a) + arena.flagCountHi(h)) | 0;
  return s;
}
function query(arena, req, exc, rq) {
  const p = arena.joinN(req, exc, rq, 0);
  const df = p.driverFlag, row = p.flags, im = arena.indexMask, d = p.driver, o = p.others[0];
  if (df === 0 || p.othersCount !== 1) return -1;
  let s = 0;
  // the hint replaces the driver loop, so the driver set is a membership test too
  for (let e = arena.firstFlagged(df); e !== -1; e = arena.nextFlagged(df, e)) {
    if ((row[e & im] & rq) === rq && d.has(e) && o.has(e)) s++;
  }
  return s;
}
function toggle(arena, ents, idx, m) {
  let s = 0;
  for (let t = 0; t < 8; t++) {
    for (let j = 0; j < idx.length; j++) {
      if (arena.clearFlags(ents[idx[j]], m)) s++;
      if (arena.setFlags(ents[idx[j]], m)) s++;
    }
  }
  return s;
}
function churn(arena, Vel, ents, a, b, z, h, k) {
  let s = 0;
  for (let i = 0; i < N; i += 2) {
    arena.clearFlags(ents[i], (i & 3) === 0 ? a | b : z | b);
    arena.clearFlagsHi(ents[i], h | k);
  }
  for (let i = 0; i < N; i += 4) Vel.remove(ents[i]);
  for (let i = 0; i < N; i++) s += arena.despawn(ents[i]) ? 1 : 0;
  return s;
}

/** Calls per public method of the last run() (counted from the loop shapes, not inside the hot bodies). */
export const CALLS = {};

export function run(Arena) {
  const arena = new Arena(N);
  const Pos = arena.registerComponent({ x: Float32Array });
  const Vel = arena.registerComponent({ vx: Float32Array });
  const F = arena.registerFlags(['a', 'b', 'c', 'z'], { indexed: ['a', 'z'] });
  const H = arena.registerFlagsHi(['h', 'k'], { indexed: ['h'] });
  const ents = new Int32Array(N);
  const req = [Pos, Vel], exc = [];
  const rq = F.a | F.z;
  let ni = 0;
  for (let i = 0; i < N; i++) if (i % STEP === FROM) ni++;
  const IDX = new Int32Array(ni);
  for (let i = 0, j = 0; i < N; i++) if (i % STEP === FROM) IDX[j++] = i;
  for (const m of ['setFlags', 'clearFlags', 'setFlagsHi', 'clearFlagsHi', 'despawn', 'firstFlagged', 'nextFlagged',
    'firstFlaggedHi', 'nextFlaggedHi', 'flagCount', 'flagCountHi', 'joinN']) CALLS[m] = 0;
  SINK[0] = 0;
  let sink = 0;
  for (let round = 0; round < ROUNDS; round++) {
    spawnAll(arena, Pos, Vel, ents);
    mark(arena, ents, F.a, F.b, F.z, H.h, H.k);
    const n = arena.flagCount(F.a);
    sink = (sink + toggle(arena, ents, IDX, rq)) | 0;
    // brute force (cold, once per round): flagged a and in Vel (even slots)
    let want = 0, wantVel = 0;
    for (let i = 0; i < N; i++) if (i % STEP === FROM) { want++; if ((i & 1) === 0) wantVel++; }
    if (n !== want || arena.flagCount(F.z) !== want || arena.flagCountHi(H.h) !== want) throw new Error('workload: flagCount != brute force at round ' + round);
    for (let w = 0; w < 16; w++) {
      if (walk(arena, F.a) !== want || walk(arena, F.z) !== want || walkHi(arena, H.h) !== want) throw new Error('workload: walk != brute force at round ' + round);
    }
    sink = (sink + firsts(arena, F.a, H.h, 512) + counts(arena, F.a, H.h, 512)) | 0;
    for (let q = 0; q < 512; q++) {
      const c = query(arena, req, exc, rq);
      if (c !== wantVel) throw new Error('workload: hint-driven joinN count ' + c + ' != ' + wantVel + ' at round ' + round);
      sink = (sink + c) | 0;
    }
    const d = churn(arena, Vel, ents, F.a, F.b, F.z, H.h, H.k);
    if (d !== N || arena.activeCount !== 0 || arena.flagCount(F.a) !== 0 || arena.flagCountHi(H.h) !== 0) throw new Error('workload: churn left state at round ' + round);
    sink = (sink + d) | 0;
    CALLS.setFlags += N + 8 * want; CALLS.setFlagsHi += N;
    CALLS.clearFlags += N / 2 + 8 * want; CALLS.clearFlagsHi += N / 2; CALLS.despawn += N;
    CALLS.firstFlagged += 32 + 512 + 512; CALLS.firstFlaggedHi += 16 + 512;
    CALLS.nextFlagged += 32 * (want + 1) + 512 * (wantVel === 0 ? 0 : want + 1); CALLS.nextFlaggedHi += 16 * (want + 1);
    CALLS.flagCount += 512; CALLS.flagCountHi += 512; CALLS.joinN += 512;
  }
  return (sink ^ SINK[0]) | 0;
}
