/**
 * @zakkster/lite-arena -- 1.12.1-A cold-path golden workload (PLAN-1.12.1-A TASK 0).
 *
 * run(mod) drives the cold-path surface that unit 1.12.1-A must leave BYTE-IDENTICAL
 * and returns a plain JSON-able object: option errors of registerFlags / registerFlagsHi
 * (6 inputs each), validateBuffers errors, rebind errors, reserve(CAP*2) errors,
 * Object.getOwnPropertyNames(set) order, and plain-arena reserve results.
 *
 * Cut ONLY from the frozen build (.handoff/builds/before-1.12.1/Arena.js, sha256/8
 * 180d1268 == git show 3eb87a7:Arena.js):
 *   node test/golden/cold-1121a-workload.mjs /abs/path/to/frozen/Arena.js > test/golden/cold-1121a-3eb87a7.json
 * The module is loaded by the path argument; this file never imports the live Arena.js.
 * Every input here is chosen so the 1.12.1-A fixes (aliasing, options bag for
 * registerComponent, reserve no-op order, self-registration) cannot change its output.
 */
import { pathToFileURL } from 'node:url';

const CAP = 8;

function cap(fn) {
    try { const v = fn(); return { ok: true, v: v === undefined ? null : v }; }
    catch (e) { return { threw: (e && e.constructor && e.constructor.name) + ': ' + (e && e.message) }; }
}

class Opts { constructor() { this.indexed = ['a']; } }

function optionInputs() {
    const nonEnum = {}; Object.defineProperty(nonEnum, 'zzz', { value: 1, enumerable: false });
    return [
        ['unknown key', { x: 1 }],
        ['symbol key', { [Symbol('s')]: 1 }],
        ['non-enumerable key', nonEnum],
        ['number', 5],
        ['array', []],
        ['class instance', new Opts()],
    ];
}

export function run(mod) {
    const { Arena, SparseSet } = mod;
    const out = {};

    out.registerFlags = {};
    for (const [name, o] of optionInputs()) out.registerFlags[name] = cap(() => { new Arena(CAP).registerFlags(['a', 'b'], o); });
    out.registerFlagsHi = {};
    for (const [name, o] of optionInputs()) {
        out.registerFlagsHi[name] = cap(() => { const a = new Arena(CAP); a.registerFlags([]); a.registerFlagsHi(['a', 'b'], o); });
    }

    const schema = { x: Float32Array, y: Float32Array };
    const good = () => ({ x: new ArrayBuffer(CAP * 4), y: new ArrayBuffer(CAP * 4) });
    const reg = (b) => () => { new Arena(CAP).registerComponent(schema, { buffers: b }); };
    const direct = (b) => () => { new SparseSet(CAP, schema, new Arena(CAP), b); };
    out.validateBuffers = {
        'missing key': cap(reg({ x: good().x })),
        'unknown key': cap(reg({ ...good(), z: new ArrayBuffer(CAP * 4) })),
        'wrong size': cap(reg({ x: good().x, y: new ArrayBuffer(CAP * 4 + 4) })),
        'wrong type': cap(reg({ x: good().x, y: [1, 2, 3] })),
        'non-object': cap(reg(5)),
        'null buffers value': cap(reg(null)),
        'direct missing key': cap(direct({ x: good().x })),
        'direct wrong size': cap(direct({ x: good().x, y: new ArrayBuffer(4) })),
        'direct non-object': cap(direct('str')),
    };

    const mk = () => {
        const a = new Arena(CAP);
        return a.registerComponent(schema);
    };
    out.rebind = {
        'empty map': cap(() => mk().rebind({})),
        'unknown key': cap(() => mk().rebind({ z: new ArrayBuffer(CAP * 4) })),
        'wrong size': cap(() => mk().rebind({ x: new ArrayBuffer(CAP * 4 - 4) })),
        'wrong type': cap(() => mk().rebind({ x: 7 })),
        'non-object': cap(() => mk().rebind(null)),
    };

    out.reserveErrors = {
        'caller-backed': cap(() => {
            const a = new Arena(CAP);
            a.registerComponent({ x: Float32Array }, { buffers: { x: new ArrayBuffer(CAP * 4) } });
            return a.reserve(CAP * 2);
        }),
        'detached': cap(() => {
            const a = new Arena(CAP);
            const s = a.registerComponent({ x: Float32Array });
            const [b] = s.detach(['x']);
            structuredClone(b, { transfer: [b] });
            return a.reserve(CAP * 2);
        }),
    };

    const names = (s) => Object.getOwnPropertyNames(s);
    out.propertyOrder = {
        'own-allocated': names(new Arena(CAP).registerComponent(schema)),
        'caller-backed': names(new Arena(CAP).registerComponent(schema, { buffers: good() })),
        'tag': names(new Arena(CAP).registerTag()),
        'checked': names(new Arena(CAP, { checked: true }).registerComponent(schema)),
    };

    const p = new Arena(CAP);
    out.reservePlain = {
        'reserve(16)': p.reserve(16), 'capacity after 16': p.capacity,
        'reserve(8)': p.reserve(8), 'reserve(4)': p.reserve(4), 'reserve(0)': p.reserve(0),
        'capacity end': p.capacity,
    };
    return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const target = process.argv[2];
    if (!target || !target.startsWith('/')) { console.error('usage: node cold-1121a-workload.mjs /abs/path/Arena.js'); process.exit(2); }
    const mod = await import(pathToFileURL(target).href);
    process.stdout.write(JSON.stringify(run(mod), null, 2) + '\n');
}
