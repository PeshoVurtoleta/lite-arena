/**
 * @zakkster/lite-arena -- bench/bytecode-budget.sh gate (decision M-30). The script is vendored from LiteUtils
 * (51cc7a6 root copy, sha256/8 c3dc7772), byte-identical to lite-signal's bench copy; groups (a)-(c) are
 * lite-signal test/106 adapted (async spawns, rows run concurrently: one --self-test takes ~12 s).
 * (a) the script's own --self-test (canned text + a fake node; no V8 bytecode spawn);
 * (b) must-fail script mutants (each patched copy must turn the self-test red);
 * (c) real report / gate runs of THIS node on a tiny driver (properties that hold on every node major; exact
 *     lengths pinned only on v26.8.2, the LiteUtils fixture census);
 * (d) the Arena gate: EXACT pins of the hot methods' bytecode lengths plus the fixed joinN ceiling (M-28: 460 B,
 *     the TurboFan single-inline limit), node v26.8.2 only. Growth is OVER until a reviewed diff raises a pin;
 *     the ceiling never moves. Must-fail rows: padded copies of Arena.js trip a pin and the ceiling.
 * Control: LITE_ARENA_PATH=/abs/path/Arena.js node --test test/bytecode-budget.test.js gates (d) on that build.
 * DETERMINISTIC tier: bytecode length is a function of the source and the node binary, not of timing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'bench', 'bytecode-budget.sh');
const ARENA = process.env.LITE_ARENA_PATH || join(ROOT, 'Arena.js');
const CHECKS = 49;   // every ok line of --self-test without --fixtures; a new check moves this literal

const skip = process.platform === 'win32' ? 'bash script: POSIX hosts only' : false;
const PIN_NODE = 'v26.8.2';
const pinSkip = skip || (process.version !== PIN_NODE ? `lengths pinned for node ${PIN_NODE} only, this is ${process.version}` : false);

function run(path, args) {
    return new Promise((resolve, reject) => {
        const child = spawn('bash', [path, ...args]);
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 300000);   // hang guard only, not a budget
        timer.unref();
        child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
        child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
}
function okCount(out) { return (out.match(/^ok {3}/gm) || []).length; }

// A copy of `src` in `dir`, with ONE exact edit (must match exactly once, else the row is invalid).
function patched(src, dir, file, from, to, mode) {
    const n = src.split(from).length - 1;
    assert.equal(n, 1, `${file}: anchor must match exactly once, matched ${n}`);
    const p = join(dir, file);
    writeFileSync(p, src.replace(from, () => to));
    if (mode) chmodSync(p, mode);
    return p;
}
function variant(dir, name, from, to) {
    return patched(readFileSync(SCRIPT, 'utf8'), dir, `${name}.sh`, from, to, 0o755);
}
async function inTmp(prefix, fn) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- (a) self-test + (b) must-fail mutants of the self-test ----
const MUTANTS = [
    ['gt-to-ge', '(( l > max ))', '(( l >= max ))', 'gate: a length equal to the max is WITHIN'],
    ['version-check-off', 'if [[ -n "$WANT_VER" && "$GOT_VER" != "$WANT_VER" ]]; then', 'if false; then',
        'node version mismatch -> exit 2 before any probe'],
    ['null-control-off', 'if [[ "$line" != "$first" ]]; then JWHY="null control', 'if false; then JWHY="null control',
        'null control: run 2 with a changed length -> NO-VERDICT'],
    ['worst-order-swapped', 'for a in NO-VERDICT OVER;', 'for a in OVER NO-VERDICT;', 'worst: NO-VERDICT > OVER > WITHIN'],
    ['exact-name-to-prefix', 'want = (s == fn); n += want', 'want = (index(s, fn) == 1); n += want', 'count: exact name'],
    ['bad-header-ignored', 'bad = n - good;', 'bad = 0;', "not followed by 'Bytecode length: N' is counted bad"],
    ['cap-off', ' && length($3) <= 9 {', ' {', 'a length has 1..9 digits'],
    ['fn-regex-allows-dot', "FN_RE='^[A-Za-z_$][A-Za-z0-9_$]*(", "FN_RE='^[A-Za-z_$][A-Za-z0-9_$.]*(", 'fn names: '],
];

describe('bytecode-budget --self-test', { concurrency: true }, () => {
    test('every check passes', { skip }, async () => {
        const r = await run(SCRIPT, ['--self-test']);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /^self-test: all checks passed$/m);
        assert.doesNotMatch(r.stdout, /^FAIL /m);
        assert.equal(okCount(r.stdout), CHECKS);
    });

    test('an unmodified copy outside the repo passes (baseline for the mutants)', { skip }, () => inTmp('bb-base-', async (dir) => {
        const r = await run(variant(dir, 'baseline', '#!/usr/bin/env bash\n', '#!/usr/bin/env bash\n'), ['--self-test']);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal(okCount(r.stdout), CHECKS);
    }));

    for (const [name, from, to, failing] of MUTANTS) {
        test(`MUST FAIL on mutant ${name}`, { skip }, () => inTmp(`bb-${name}-`, async (dir) => {
            const r = await run(variant(dir, name, from, to), ['--self-test']);
            assert.equal(r.status, 1, `mutant ${name} survived: ${r.stdout}${r.stderr}`);
            assert.match(r.stdout, /^self-test: \d+ check\(s\) FAILED$/m);
            assert.ok(r.stdout.split('\n').some((l) => l.startsWith('FAIL ') && l.includes(failing)),
                `mutant ${name}: expected a FAIL line naming "${failing}"\n${r.stdout}`);
        }));
    }
});

// ---- (c) real runs of this node on a tiny driver ----
// bbAdd: one function; bbTwin: two distinct functions of one name (both gated); bbLazy: defined, never called.
const DRIVER_SRC = [
    'function bbAdd(a, b) { return a + b; }',
    'const bbTwinA = (function () { function bbTwin(x) { return x + 1; } return bbTwin; })();',
    'const bbTwinB = (function () { function bbTwin(x) { let y = x; y = y * 2; y = y + 3; return y - x; } return bbTwin; })();',
    'function bbLazy(x) { return x + 42; }',
    'let acc = 0;',
    'for (let r = 0; r < 3; r++) acc += bbAdd(r, 1) + bbTwinA(r) + bbTwinB(r);',
    'if (acc === -1) console.log(bbLazy(acc));',
    '',
].join('\n');

function withDriver(src, fn) {
    return inTmp('bb-real-', (dir) => {
        const drv = join(dir, 'driver.mjs');
        writeFileSync(drv, src);
        return fn(dir, drv);
    });
}
function lens(out, fn) {
    const m = out.match(new RegExp('^  ' + fn + ': (\\d+) match\\(es\\): ([0-9,]+)$', 'm'));
    assert.ok(m, `no match line for ${fn}\n${out}`);
    return { n: Number(m[1]), lens: m[2].split(',').map(Number) };
}
function report(script, drv, fns = 'bbAdd,bbTwin') {
    return run(script, ['--node', process.execPath, '--fn', fns, drv]);
}
function gate(script, drv, max, ver = process.version) {
    return run(script, ['--node', process.execPath, '--max', max, '--node-version', ver, drv]);
}

describe('bytecode-budget real runs (tiny driver)', { concurrency: true }, () => {
    test('report: bbAdd 1 match, bbTwin 2 distinct matches, both REPORTED (exit 0)', { skip }, () => withDriver(DRIVER_SRC, async (dir, drv) => {
        const r = await report(SCRIPT, drv);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /^VERDICT REPORTED$/m);
        assert.match(r.stdout, /^  bbAdd: REPORTED -- 1 match\(es\), not gated$/m);
        assert.match(r.stdout, /^  bbTwin: REPORTED -- 2 match\(es\), not gated$/m);
        const a = lens(r.stdout, 'bbAdd'), t = lens(r.stdout, 'bbTwin');
        assert.equal(a.n, 1); assert.equal(a.lens.length, 1);
        assert.equal(t.n, 2); assert.equal(t.lens.length, 2);
        assert.ok(t.lens[0] < t.lens[1], `bbTwin lengths in compile order, the short body first: ${t.lens}`);
        assert.ok(a.lens[0] > 0);
    }));

    test(`report on node ${PIN_NODE}: exact lengths bbAdd 6, bbTwin 6,19 (LiteUtils fixture census)`, { skip: pinSkip },
        () => withDriver(DRIVER_SRC, async (dir, drv) => {
            const r = await report(SCRIPT, drv);
            assert.equal(r.status, 0, r.stdout + r.stderr);
            assert.deepEqual(lens(r.stdout, 'bbAdd').lens, [6]);
            assert.deepEqual(lens(r.stdout, 'bbTwin').lens, [6, 19]);
        }));

    test('gate: max = the measured length is WITHIN (exit 0), max - 1 is OVER (exit 1)', { skip }, () => withDriver(DRIVER_SRC, async (dir, drv) => {
        const r0 = await report(SCRIPT, drv);
        assert.equal(r0.status, 0, r0.stdout + r0.stderr);
        const L = lens(r0.stdout, 'bbAdd').lens[0], T = Math.max(...lens(r0.stdout, 'bbTwin').lens);
        const w = await gate(SCRIPT, drv, `bbAdd=${L},bbTwin=${T}`);
        assert.equal(w.status, 0, w.stdout + w.stderr);
        assert.match(w.stdout, /^VERDICT WITHIN$/m);
        assert.ok(w.stdout.includes(`  bbAdd: WITHIN -- every length <= max ${L}\n`), w.stdout);
        assert.ok(w.stdout.includes(`  bbTwin: WITHIN -- every length <= max ${T}\n`), w.stdout);
        const o = await gate(SCRIPT, drv, `bbAdd=${L},bbTwin=${T - 1}`);
        assert.equal(o.status, 1, o.stdout + o.stderr);
        assert.match(o.stdout, /^VERDICT OVER$/m);
        assert.ok(o.stdout.includes(`  bbTwin: OVER -- length(s) ${T} > max ${T - 1}\n`), o.stdout);
    }));

    test('gate: a node-version mismatch and a never-compiled fn are NO-VERDICT (exit 2)', { skip }, () => withDriver(DRIVER_SRC, async (dir, drv) => {
        const v = await gate(SCRIPT, drv, 'bbAdd=999', 'v0.0.0');
        assert.equal(v.status, 2, v.stdout + v.stderr);
        // <bin> is the script's own absolute resolution of --node, so only its shape is pinned
        assert.ok(v.stdout.split('\n').some((l) => /^  bbAdd: NO-VERDICT -- node version mismatch: \/\S+ --version is /.test(l)
            && l.endsWith(` --version is ${process.version}, the maxima are for v0.0.0`)), v.stdout);
        assert.doesNotMatch(v.stdout, /match\(es\)/);   // refused before any probe
        const z = await gate(SCRIPT, drv, 'bbLazy=999');
        assert.equal(z.status, 2, z.stdout + z.stderr);
        assert.match(z.stdout, /^  bbLazy: NO-VERDICT -- no function named 'bbLazy' in run 1 /m);
    }));

    // The real gate rows have teeth: a script mutant flips each of their verdicts.
    test('gate MUST FAIL on mutant gt-to-ge (max = measured length reads OVER, exit 1)', { skip }, () => withDriver(DRIVER_SRC, async (dir, drv) => {
        const r0 = await report(SCRIPT, drv);
        assert.equal(r0.status, 0, r0.stdout + r0.stderr);
        const L = lens(r0.stdout, 'bbAdd').lens[0];
        const r = await gate(variant(dir, 'gt-to-ge', '(( l > max ))', '(( l >= max ))'), drv, `bbAdd=${L}`);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /^VERDICT OVER$/m);
    }));

    test('gate MUST FAIL on mutant version-check-off (v0.0.0 maxima gate instead of NO-VERDICT)', { skip }, () => withDriver(DRIVER_SRC, async (dir, drv) => {
        const p = variant(dir, 'version-check-off', 'if [[ -n "$WANT_VER" && "$GOT_VER" != "$WANT_VER" ]]; then', 'if false; then');
        const r = await gate(p, drv, 'bbAdd=999', 'v0.0.0');
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /^VERDICT WITHIN$/m);
    }));
});

// ---- (d) the Arena gate (M-30) ----
// EXACT pins, node v26.8.2. A diff that grows one of these methods raises its pin in the same reviewed diff.
// F1 (M-26): despawn 199 -> 215 (nested Hi-row zero, <= +24 B), joinN 423 -> 420 (Hi masks; checked-plan
// stamp moved cold, M-28); the Hi methods are pinned EQUAL to their word-0 twins.
// M-33 ("convert first"): setFlags 45 -> 48, clearFlags 47 -> 50, hasFlags 65 -> 68 (the mask conversion moved
// before isAlive(); has converts required / excluded once each), Hi twins alike; nothing else moves.
// F2 (M-36 / M-41): IX_PINS = the 14 indexed-flag hot functions, measured on the B1 build 27c22d70, node v26.8.2
// (.handoff/evidence/F2/bytecode-after-B1.log, re-measured through arenaDriver). The ix* write bodies are OWN
// methods of an indexed arena only, so the plain arena keeps compiling the prototype twins pinned in PINS.
// F2 (M-38 / M-44): joinN 420 -> 435 (one cold pickFlagDriver(this, r) call under `if (this._ixMask)`, the
// joinN driver hint; ceiling 460 unchanged).
const PINS = {
    despawn: 215, joinN: 435, isAlive: 40, spawn: 93, setFlags: 48, hasFlags: 68, clearFlags: 50,
    setFlagsHi: 48, hasFlagsHi: 68, clearFlagsHi: 50,
    add: 113, has: 66, remove: 140, idx: 16,
};
const IX_PINS = {
    ixSetFlags: 178, ixClearFlags: 178, ixSetFlagsHi: 178, ixClearFlagsHi: 178, ixDespawn: 319,
    ixSet: 97, ixUnset: 116, ixWordFrom: 209,
    nextFlagged: 209, nextFlaggedHi: 209, flagCount: 90, flagCountHi: 90, firstFlagged: 215, firstFlaggedHi: 215,
};
const ALL_PINS = { ...PINS, ...IX_PINS };   // every gate row below reads ALL_PINS; the two tables are disjoint
const JOINN_CEILING = 460;   // M-28: the TurboFan single-inline limit; joinN must stay inlinable. Never moves.
const maxList = (m) => Object.entries(m).map(([k, v]) => `${k}=${v}`).join(',');

// Compiles every pinned method once (bytecode is generated on the first call), from any Arena.js copy.
// `a` is a plain arena (prototype setFlags / clearFlags / despawn); `b` indexes word 0 AND the Hi word (ix* own
// methods, the column helpers, and flagCount / firstFlagged / nextFlagged per word: prototype-only on an
// unchecked arena, so one match each).
// indexed = false drops `b` (the joinN-ceiling rows gate joinN only, so they also run on a pre-F2 build).
function arenaDriver(arenaPath, indexed = true) {
    const lines = [
        `import { Arena } from ${JSON.stringify(pathToFileURL(arenaPath).href)};`,
        'const a = new Arena(8);',
        'const P = a.registerComponent({ x: Float32Array });',
        'const F = a.registerFlags([\'f\']);',
        'const H = a.registerFlagsHi([\'h\']);',
        'const e = a.spawn();',
        'P.add(e); P.has(e); P.idx(e); a.isAlive(e);',
        'a.setFlags(e, F.f); a.hasFlags(e, F.f); a.clearFlags(e, F.f);',
        'a.setFlagsHi(e, H.h); a.hasFlagsHi(e, H.h); a.clearFlagsHi(e, H.h);',
        'a.joinN([P], null, F.f, 0, H.h, 0);',
        'P.remove(e); a.despawn(e);',
    ];
    if (indexed) lines.push(
        'const b = new Arena(8);',
        'const G = b.registerFlags([\'f\', \'g\'], { indexed: [\'f\'] });',
        'const K = b.registerFlagsHi([\'h\', \'k\'], { indexed: [\'h\'] });',
        'const u = b.spawn(), v = b.spawn();',
        'b.setFlags(u, G.f); b.setFlags(v, G.f); b.flagCount(G.f);',
        'for (let x = b.firstFlagged(G.f); x !== -1; x = b.nextFlagged(G.f, x)) {}',
        'b.setFlagsHi(u, K.h); b.flagCountHi(K.h);',
        'for (let x = b.firstFlaggedHi(K.h); x !== -1; x = b.nextFlaggedHi(K.h, x)) {}',
        'b.clearFlags(u, G.f); b.clearFlagsHi(u, K.h);',
        'b.setFlags(u, G.f); b.setFlagsHi(u, K.h);',
        'b.despawn(u);',
    );
    lines.push('');
    return lines.join('\n');
}
// A copy of Arena.js whose `method` header is followed by `n` dead stores behind an impossible branch.
function paddedArena(dir, header, n) {
    let pad = '        if (arguments.length === -1) {\n';
    for (let i = 1; i <= n; i++) pad += `            this.activeCount = (this.activeCount + ${i}) | 0;\n`;
    pad += '        }\n';
    return patched(readFileSync(ARENA, 'utf8'), dir, 'Arena.js', header, header + pad);
}

describe('Arena bytecode gate (M-30)', { concurrency: true }, () => {
    test('the joinN pin sits under the fixed ceiling (M-28)', () => {
        assert.ok(PINS.joinN <= JOINN_CEILING, `joinN pin ${PINS.joinN} > ceiling ${JOINN_CEILING}`);
    });

    test('PINS and IX_PINS are disjoint (14 F2 pins, none shadows a HEAD pin)', () => {
        assert.equal(Object.keys(IX_PINS).length, 14);
        for (const fn of Object.keys(IX_PINS)) assert.ok(!(fn in PINS), fn);
    });

    test(`live Arena.js: every hot method WITHIN its exact pin on ${PIN_NODE} (HEAD pins + the 14 F2 pins)`, { skip: pinSkip },
        () => withDriver(arenaDriver(ARENA), async (dir, drv) => {
            const r = await gate(SCRIPT, drv, maxList(ALL_PINS), PIN_NODE);
            assert.equal(r.status, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /^VERDICT WITHIN$/m);
            for (const [fn, max] of Object.entries(ALL_PINS)) {
                assert.ok(r.stdout.includes(`  ${fn}: WITHIN -- every length <= max ${max}\n`), `${fn}\n${r.stdout}`);
                assert.deepEqual(lens(r.stdout, fn).lens, [max], `${fn}: exactly one function, length == pin`);
            }
        }));

    test(`live Arena.js: joinN WITHIN the fixed ceiling ${JOINN_CEILING} on ${PIN_NODE}`, { skip: pinSkip },
        () => withDriver(arenaDriver(ARENA, false), async (dir, drv) => {
            const r = await gate(SCRIPT, drv, `joinN=${JOINN_CEILING}`, PIN_NODE);
            assert.equal(r.status, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /^VERDICT WITHIN$/m);
        }));

    test('MUST FAIL: a despawn grown by a few bytes is OVER its pin, every other method WITHIN', { skip: pinSkip },
        () => inTmp('bb-arena-despawn-', async (dir) => {
            const copy = paddedArena(dir, '    despawn(entity) {\n', 1);
            const drv = join(dir, 'driver.mjs');
            writeFileSync(drv, arenaDriver(copy));
            const r = await gate(SCRIPT, drv, maxList(ALL_PINS), PIN_NODE);
            assert.equal(r.status, 1, r.stdout + r.stderr);
            assert.match(r.stdout, /^VERDICT OVER$/m);
            assert.match(r.stdout, new RegExp(`^ {2}despawn: OVER -- length\\(s\\) \\d+ > max ${PINS.despawn}$`, 'm'));
            for (const fn of Object.keys(ALL_PINS)) if (fn !== 'despawn') assert.match(r.stdout, new RegExp(`^  ${fn}: WITHIN `, 'm'));
        }));

    test('MUST FAIL: an ixSetFlags grown by a few bytes is OVER its pin, every other method WITHIN (F2)', { skip: pinSkip },
        () => inTmp('bb-arena-ixSetFlags-', async (dir) => {
            const copy = paddedArena(dir, 'function ixSetFlags(entity, mask) {\n', 1);
            const drv = join(dir, 'driver.mjs');
            writeFileSync(drv, arenaDriver(copy));
            const r = await gate(SCRIPT, drv, maxList(ALL_PINS), PIN_NODE);
            assert.equal(r.status, 1, r.stdout + r.stderr);
            assert.match(r.stdout, /^VERDICT OVER$/m);
            assert.match(r.stdout, new RegExp(`^ {2}ixSetFlags: OVER -- length\\(s\\) \\d+ > max ${IX_PINS.ixSetFlags}$`, 'm'));
            for (const fn of Object.keys(ALL_PINS)) if (fn !== 'ixSetFlags') assert.match(r.stdout, new RegExp(`^  ${fn}: WITHIN `, 'm'));
        }));

    test(`MUST FAIL: a joinN grown past ${JOINN_CEILING} B is OVER the fixed ceiling`, { skip: pinSkip },
        () => inTmp('bb-arena-joinN-', async (dir) => {
            const copy = paddedArena(dir, '    joinN(required, excluded, reqMask, excMask, reqMaskHi, excMaskHi) {\n', 2);   // 435 -> ~481 B (expected)
            const drv = join(dir, 'driver.mjs');
            writeFileSync(drv, arenaDriver(copy, false));
            const r = await gate(SCRIPT, drv, `joinN=${JOINN_CEILING}`, PIN_NODE);
            assert.equal(r.status, 1, r.stdout + r.stderr);
            assert.match(r.stdout, /^ {2}joinN: OVER -- length\(s\) \d+ > max 460$/m);
        }));
});
