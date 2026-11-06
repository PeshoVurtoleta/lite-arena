/**
 * @zakkster/lite-arena -- F2 doc claims that need a LIVE arena (U10 batch D3; PLAN-F2 ASSERTIONS A4-A6).
 *
 * Every expected value is from the spec, not from running the engine:
 *   A4  memory: per indexed bit, column + 2 summaries = 135,296 B at Arena(1048575)
 *       (W = ceil(1048575/32) = 32768 words = 131072 B; S1 = ceil(32768/32) = 1024 words = 4096 B;
 *        S2 = ceil(1024/32) = 32 words = 128 B; sum 135296), `_ixCnt` = 32 counters x 4 B = 128 B,
 *       and null when nothing is indexed. The README must state the same numbers.
 *   A5  M-42: a subclass despawn / setFlags override runs once on a plain arena, 0 times on an indexed one
 *       (the installed own bodies shadow it), production AND checked.
 *   A6  M-39: a direct `flags[s] |= F.x` leaves flagCount unchanged (UNSUPPORTED write); setFlags gives +1.
 * The README comparison is a pure function so a control can feed it a mutated README.
 *
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Arena } from '../Arena.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const CAP = 1048575;
const WANT_BYTES = 135296;
const WANT_CNT = 128;
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// README must state the per-bit bytes (with thousands commas, as "135,296 B") and the 128 B count table.
function checkReadmeMemory(text, bytes, cnt) {
    const errs = [];
    if (!text.includes(commas(bytes) + ' B')) errs.push(`README: no "${commas(bytes)} B"`);
    if (!/\b128 B\b/.test(text) || cnt !== 128) errs.push('README: no "128 B" count table');
    if (!text.includes(commas(CAP))) errs.push(`README: capacity ${commas(CAP)} not named`);
    return errs;
}

test('A4: Arena(1048575) with one indexed bit: column + summaries = 135,296 B, _ixCnt = 128 B', () => {
    const a = new Arena(CAP);
    a.registerFlags(['a', 'b'], { indexed: ['a'] });
    // Bit 0 -> index 0 of each table (the only indexed bit).
    assert.equal(a._ixW[0].byteLength + a._ixS1[0].byteLength + a._ixS2[0].byteLength, WANT_BYTES);
    assert.equal(a._ixCnt.byteLength, WANT_CNT);
});

test('A4: nothing indexed -> the private column tables are null (0 B)', () => {
    const a = new Arena(1024);
    a.registerFlags(['a']);
    assert.equal(a._ixW, null);
    assert.equal(a._ixS1, null);
    assert.equal(a._ixS2, null);
    assert.equal(a._ixCnt, null);
    const b = new Arena(1024);
    b.registerFlags(['a'], { indexed: [] });
    assert.equal(b._ixCnt, null);
});

test('A4: README states the same memory numbers (135,296 B at 1,048,575; 128 B count table)', () => {
    assert.deepEqual(checkReadmeMemory(readme, WANT_BYTES, WANT_CNT), []);
});

test('A4 control: README +4 (135,300 B), or a dropped count table, reports >= 1 error', () => {
    const good = `At capacity ${commas(CAP)}: ${commas(WANT_BYTES)} B per indexed flag, plus a 128 B count table.`;
    assert.deepEqual(checkReadmeMemory(good, WANT_BYTES, WANT_CNT), []);
    assert.ok(checkReadmeMemory(good.replace('135,296', '135,300'), WANT_BYTES, WANT_CNT).length >= 1);
    assert.ok(checkReadmeMemory(good.replace('128 B', '132 B'), WANT_BYTES, WANT_CNT).length >= 1);
    // the numbers under test move with the live arena: spec-constant control: WANT_BYTES + 4 must be rejected
    assert.ok(checkReadmeMemory(good, WANT_BYTES + 4, WANT_CNT).length >= 1);
});

// ---- A5 (M-42) ----
for (const checked of [false, true]) {
    for (const hi of [false, true]) {
        const mode = checked ? 'checked' : 'production';
        const setName = hi ? 'setFlagsHi' : 'setFlags';
        test(`A5 (M-42, ${mode}): subclass despawn / ${setName} override runs once on a plain arena, 0 times on an indexed one`, () => {
            class Sub extends Arena {
                constructor(c, o) { super(c, o); this.nDespawn = 0; this.nSet = 0; }
                despawn(e) { this.nDespawn++; return super.despawn(e); }
            }
            Sub.prototype[setName] = function (e, m) { this.nSet++; return Arena.prototype[setName].call(this, e, m); };
            const reg = (a, opts) => {
                const F = a.registerFlags(['x', 'y'], hi ? undefined : opts);
                return hi ? a.registerFlagsHi(['x', 'y'], opts) : F;
            };
            for (const indexed of [false, true]) {
                const a = new Sub(64, checked ? { checked: true } : undefined);
                const F = reg(a, indexed ? { indexed: ['x'] } : undefined);
                const h = a.spawn();
                a.nDespawn = 0; a.nSet = 0;
                a[setName](h, F.x);
                a.despawn(h);
                const want = indexed ? 0 : 1;
                assert.equal(a.nSet, want, `${setName} override calls (indexed=${indexed})`);
                assert.equal(a.nDespawn, want, `despawn override calls (indexed=${indexed})`);
            }
        });
    }
}

test('A5 control: the override-counting subclass really counts (a direct call on a plain arena is 1)', () => {
    class Sub extends Arena { despawn(e) { this.n = (this.n | 0) + 1; return super.despawn(e); } }
    const a = new Sub(8);
    a.despawn(a.spawn());
    assert.equal(a.n, 1);
});

// ---- A6 (M-39) ----
for (const checked of [false, true]) {
    test(`A6 (M-39, ${checked ? 'checked' : 'production'}): direct flags[s] |= F.x leaves flagCount unchanged; setFlags gives +1`, () => {
        const a = new Arena(64, checked ? { checked: true } : undefined);
        const F = a.registerFlags(['x', 'y'], { indexed: ['x'] });
        const h1 = a.spawn(), h2 = a.spawn();
        assert.equal(a.flagCount(F.x), 0);
        a.flags[h1 & 0xFFFFF] |= F.x;                       // UNSUPPORTED direct write: column not updated
        assert.equal(a.flagCount(F.x), 0, 'direct write is invisible to the count');
        assert.equal(a.firstFlagged(F.x), -1, 'and to the walk');
        a.setFlags(h2, F.x);                                // control: the API path counts
        assert.equal(a.flagCount(F.x), 1, 'setFlags gives +1');
        assert.equal(a.firstFlagged(F.x), h2);
    });
}
