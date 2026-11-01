// Inlining-trial workload (1.10.0 API). Split into small hot functions so TurboFan compiles each
// caller and every target method shows up in the trace (one big run() only OSRs in Maglev).
// Every build runs byte-identical driver code; only the imported Arena.js differs.
function spawnAll(arena, Pos, Vel, Tag, a, ents, N) {
  for (let i = 0; i < N; i++) {
    const e = arena.spawn();
    ents[i] = e;
    Pos.add(e);
    if ((i & 1) === 0) Vel.add(e);
    if ((i & 3) === 0) Tag.add(e);
    if ((i % 3) === 0) arena.setFlags(e, a);
  }
}
function query(arena, req, exc, a, b) {
  const p = arena.joinN(req, exc, a, b);
  const d = p.driver, c = p.count, os = p.others, no = p.othersCount, ex = p.excl, nx = p.exclCount;
  const row = p.flags, im = arena.indexMask, rq = p.reqMask, xm = p.excMask;
  let s = 0;
  for (let i = 0; i < c; i++) {
    const e = d.dense[i];
    const w = row[e & im];
    if ((w & rq) !== rq || (w & xm) !== 0) continue;
    let ok = true;
    for (let k = 0; k < no; k++) if (!os[k].has(e)) { ok = false; break; }
    if (ok) for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
    if (ok) s++;
  }
  return s;
}
function pairs(arena, Pos, Vel) {
  const j = arena.join(Pos, Vel);
  const drv = j.driver, oth = j.other, m = j.count;
  let s = 0;
  for (let i = 0; i < m; i++) if (oth.has(drv.dense[i])) s += Pos.idx(drv.dense[i]);
  return s;
}
function churn(arena, Vel, a, ents, N) {
  let s = 0;
  for (let i = 0; i < N; i += 5) if (arena.hasFlags(ents[i], a)) arena.clearFlags(ents[i], a);
  for (let i = 0; i < N; i += 3) Vel.remove(ents[i]);
  for (let i = 0; i < N; i++) {
    const e = ents[i];
    if (arena.isAlive(e)) s += arena.despawn(e) ? 1 : 0;
    s += arena.isAlive(e) ? 1 : 0;
  }
  return s;
}
export function run(Arena) {
  const N = 1024;
  const arena = new Arena(N);
  const Pos = arena.registerComponent({ x: Float32Array, y: Float32Array });
  const Vel = arena.registerComponent({ vx: Float32Array, vy: Float32Array });
  const Tag = arena.registerTag();
  const F = arena.registerFlags(['a', 'b']);
  const ents = new Int32Array(N);
  const req = [Pos, Vel], exc = [Tag];
  let sink = 0;
  for (let round = 0; round < 1500; round++) {
    spawnAll(arena, Pos, Vel, Tag, F.a, ents, N);
    sink += pairs(arena, Pos, Vel);
    for (let q = 0; q < 16; q++) sink += query(arena, req, exc, F.a, F.b);
    sink += churn(arena, Vel, F.a, ents, N);
  }
  return sink;
}
