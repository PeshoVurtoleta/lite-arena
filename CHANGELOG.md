# Changelog

All notable changes to `@zakkster/lite-arena` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-07-27

### Added

- `test/torture.mjs` -- a standalone gate wired to the real `Arena.js` entry.
  `node --expose-gc test/torture.mjs` prints exactly `ok` (exit 0) on pass and
  exits non-zero on failure. It gates two independent properties:
  - **Retention (Phase A).** 4096 create/dispose cycles: spawn entities, attach
    three components, despawn all. A pass requires both `arena.activeCount` and
    an external `@zakkster/lite-leak` `tracker.size()` to return to 0. Each
    tracked resource is keyed by the raw 32-bit slot (a primitive) with a
    no-op release, so the FinalizationRegistry held value never pins its target.
  - **GC budget (Phase B).** Pre-spawn to capacity outside the loop, then run a
    hot tick over `dense[0..count)` (typed-array reads/writes only, no `idx()`
    safety, no allocation) for >= 200k iterations. The window is measured by
    `@zakkster/lite-gc-profiler` and gated with
    `checkNoGc(summary, { maxMajor: 0, maxPauseMs: 4 })`. The summary is read
    only after an awaited `settle()` tick, so the gate never passes on an empty
    observation window.
- Leaky control: `ARENA_TORTURE_LEAK=1 node --expose-gc test/torture.mjs` skips
  every despawn, leaving the retention oracles non-zero and forcing a non-zero
  exit -- proof that the gate can fail, so a pass means something.
- `@zakkster/lite-gc-profiler` and `@zakkster/lite-leak` as **devDependencies**.
  `Arena.js` keeps zero runtime dependencies.
- `npm run torture` script; `npm run verify` now also runs the torture gate.

### Changed

- `npm test` now scopes to `test/*.test.js` so the standalone torture gate,
  which requires `--expose-gc` and calls `process.exit`, is not swept into the
  default `node --test` discovery. Run it via `npm run torture`.

## [1.0.2]

- Initial published ECS: generational handles, SoA sparse sets, swap-and-pop,
  zero-allocation hot paths.
