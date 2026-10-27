/**
 * @zakkster/lite-arena -- joinN() no-mask golden workload (Group D2, TASK 8).
 *
 * run(ArenaClass) drives a seeded churn on Arena(256) and records, every 20
 * steps, six joinN() plans: the driver's position in the query's required list,
 * the plan count, the others / excl positions, the match count of the plain
 * (unmasked) joinN loop and an FNV-1a-32 hash of the matched handles in driver
 * order. Tags T1 / T2 are always added and removed together, so [T1, T2] is a
 * forced count tie every snapshot (ties favour the earlier set).
 *
 * Uses ONLY the 1.9.0 surface (spawn / despawn / registerComponent /
 * registerTag / add / remove / has / joinN): the golden is cut from the
 * pre-program build by .handoff/evidence/D2-cut.mjs, which never imports the
 * live Arena.js. This module imports no Arena at all -- the caller passes it.
 *
 * The two error strings come from joinN(null, ...) and joinN([], ...) called
 * WITH masks on an arena without registerFlags(): the required-set check must
 * win over the no-flags check (M-11); a 1.9.0 build ignores the extra args.
 */

const STEPS = 4000;
const EVERY = 20;
const CAP = 256;

function fnvHandle(h, e) {
    h = Math.imul(h ^ (e & 0xFF), 16777619);
    h = Math.imul(h ^ ((e >>> 8) & 0xFF), 16777619);
    h = Math.imul(h ^ ((e >>> 16) & 0xFF), 16777619);
    h = Math.imul(h ^ ((e >>> 24) & 0xFF), 16777619);
    return h;
}

/**
 * @param {Function} ArenaClass - the Arena constructor under test.
 * @returns {{ records: Array<Array>, errNull: string, errEmpty: string }}
 */
export function run(ArenaClass) {
    const arena = new ArenaClass(CAP);
    const A = arena.registerComponent({ v: Float32Array });
    const B = arena.registerComponent({ v: Int32Array });
    const C = arena.registerTag();
    const D = arena.registerComponent({ v: Uint8Array });
    const T1 = arena.registerTag();
    const T2 = arena.registerTag();
    const COMPS = [A, B, C, D];

    const QUERIES = [
        [[A, B, C], [D]],
        [[C, C, A], null],
        [[A], []],
        [[T1, T2], [A]],
        [[A, B], [B]],
        [[D, T1, T2], [A, C]],
    ];

    let s = 0x2545F491 | 0;
    const next = () => {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        s = Math.imul(s, 0x2545F491) | 0;
        return s >>> 0;
    };

    const live = [];
    const pick = () => live[next() % live.length];
    const records = [];

    for (let step = 1; step <= STEPS; step++) {
        const op = next() % 8;
        if (op <= 1 || live.length === 0) {
            if (live.length < CAP - 16) live.push(arena.spawn());
            else {
                const i = next() % live.length;
                arena.despawn(live[i]);
                live[i] = live[live.length - 1];
                live.pop();
            }
        } else if (op === 2) {
            const i = next() % live.length;
            arena.despawn(live[i]);
            live[i] = live[live.length - 1];
            live.pop();
        } else if (op === 3) {
            COMPS[next() & 3].add(pick());
        } else if (op === 4) {
            COMPS[next() & 3].remove(pick());
        } else if (op === 5) {
            const e = pick();
            T1.add(e); T2.add(e);
        } else if (op === 6) {
            const e = pick();
            T1.remove(e); T2.remove(e);
        } else {
            const e = pick();
            COMPS[next() & 3].add(e);
            COMPS[next() & 3].add(e);
        }

        if (step % EVERY !== 0) continue;
        if (T1.count !== T2.count) throw new Error('workload: T1/T2 tie broken at step ' + step);

        for (let q = 0; q < QUERIES.length; q++) {
            const req = QUERIES[q][0], exc = QUERIES[q][1];
            const p = arena.joinN(req, exc);
            const drv = p.driver, n = p.count;
            const oth = p.others, no = p.othersCount;
            const ex = p.excl, nx = p.exclCount;
            const othIdx = [];
            for (let k = 0; k < no; k++) othIdx.push(req.indexOf(oth[k]));
            const exIdx = [];
            for (let k = 0; k < nx; k++) exIdx.push(exc.indexOf(ex[k]));
            let match = 0, h = 0x811C9DC5 | 0;
            for (let i = 0; i < n; i++) {
                const e = drv.dense[i];
                let ok = true;
                for (let k = 0; k < no; k++) if (!oth[k].has(e)) { ok = false; break; }
                if (ok) for (let k = 0; k < nx; k++) if (ex[k].has(e)) { ok = false; break; }
                if (!ok) continue;
                match++;
                h = fnvHandle(h, e);
            }
            records.push([step, q, req.indexOf(drv), n, othIdx, exIdx, match, h >>> 0]);
        }
    }

    let errNull = '', errEmpty = '';
    try { arena.joinN(null, null, 1, 0); } catch (err) { errNull = err.message; }
    try { arena.joinN([], [A], 0, 1); } catch (err) { errEmpty = err.message; }
    return { records, errNull, errEmpty };
}
