#!/usr/bin/env bash
# bench/f2/inline-indexed/run.sh -- L4b: TurboFan + Maglev inlining A/B of the F2 indexed-flag bodies (G3 T5).
#
#   bench/f2/inline-indexed/run.sh [--control] [--control-build FILE] [--runs N] [--out DIR] BEFORE_ARENA_JS [AFTER_ARENA_JS]
#
# BEFORE_ARENA_JS  a FROZEN copy (e.g. .handoff/after-F2-180d1268/Arena.js). Refused (exit 2) when it is
#                  the live ./Arena.js (same device:inode) or a git-tracked file.
# AFTER_ARENA_JS   default: the live ./Arena.js.
# --control        must-fail control: AFTER becomes the padded-ix variant (60 dead stores in ixSetFlags
#                  behind an impossible branch; default .handoff/evidence/F2/variants/padded-ix/Arena.js,
#                  or --control-build FILE). The A/B must say DIFF: this prints CONTROL OK and exits 1
#                  (the DIFF exit); anything else prints CONTROL FAILED and exits 2.
# --runs N         runs per side per tier (default 3; run 1 vs runs 2..N is the null control).
# --out DIR        artifact dir (default: a new mktemp -d $TMPDIR/arena-inline-ix-XXXXXX).
#
# Both sides run bench/f2/inline-indexed/workload.mjs (indexed word 0 + Hi arena, small hot user functions,
# each target >= 10^5 calls) through bench/inlining-budget-diff.sh on the 16 targets below: the 14 F2
# exact-pin names of test/bytecode-budget.test.js (IX_PINS) + joinN + pickFlagDriver. Before tracing, both
# builds must return the same workload sink, else exit 2 (not an inlining comparison).
# After the tool: a table of all 16 functions (AFTER bytecode length; Maglev single-inline < 100 B,
# TurboFan single-inline <= 460 B). A target with no bytecode length (too cold) is NO-VERDICT.
# Exit: 0 SAME, 1 DIFF, 2 NO-VERDICT (or a refused input).
#
# Tier: STATISTICAL / REPORTED. Inlining follows tier-up timing: never part of npm test / verify. Run once
# per release under the host quiet lock:
#   node ~/.claude/hooks/quiet-lock.mjs run "lite-arena f2-L4b" -- bench/f2/inline-indexed/run.sh BEFORE.js
#
# MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
TOOL="$ROOT/bench/inlining-budget-diff.sh"
FNS="ixSetFlags,ixClearFlags,ixSetFlagsHi,ixClearFlagsHi,ixDespawn,ixSet,ixUnset,ixWordFrom,nextFlagged,nextFlaggedHi,flagCount,flagCountHi,firstFlagged,firstFlaggedHi,joinN,pickFlagDriver"

die() { printf 'inline-indexed/run.sh: %s\nVERDICT NO-VERDICT\n' "$1" >&2; exit 2; }
# Fail closed: an unplanned exit (a command failing under set -e) becomes 2 NO-VERDICT, never 1 DIFF.
FINAL=""
trap 'rc=$?; [[ $rc -eq 0 || $rc -eq 2 || -n $FINAL ]] || { printf "inline-indexed/run.sh: unexpected failure (exit %s)\nVERDICT NO-VERDICT\n" "$rc" >&2; exit 2; }' EXIT
# realpath (symlinks resolved): a symlink to the live or a tracked file must not pass the frozen-BEFORE checks
abspath() { node -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$1"; }
devino() { if stat -f '%d:%i' "$1" >/dev/null 2>&1; then stat -f '%d:%i' "$1"; else stat -c '%d:%i' "$1"; fi; }

CONTROL=0; CTL_BUILD="$ROOT/.handoff/evidence/F2/variants/padded-ix/Arena.js"; RUNS=3; OUT=""; POS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --control) CONTROL=1; shift ;;
    --control-build) [[ $# -ge 2 ]] || die "--control-build needs a value"; CTL_BUILD="$2"; shift 2 ;;
    --runs) [[ $# -ge 2 ]] || die "--runs needs a value"; RUNS="$2"; shift 2 ;;
    --out) [[ $# -ge 2 ]] || die "--out needs a value"; OUT="$2"; shift 2 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) POS+=("$1"); shift ;;
  esac
done
[[ ${#POS[@]} -ge 1 && ${#POS[@]} -le 2 ]] || die "need BEFORE_ARENA_JS [AFTER_ARENA_JS] (see --help)"
[[ -x "$TOOL" ]] || die "missing $TOOL"

BEFORE="${POS[0]}"; AFTER="${POS[1]:-$ROOT/Arena.js}"
[[ -f "$BEFORE" ]] || die "no such file: $BEFORE"
[[ -f "$AFTER" ]] || die "no such file: $AFTER"
BEFORE="$(abspath "$BEFORE")" || die "cannot resolve $BEFORE"
AFTER="$(abspath "$AFTER")" || die "cannot resolve $AFTER"

# Fail closed: the before build must be frozen, never the live main file or a tracked file.
[[ "$(devino "$BEFORE")" != "$(devino "$ROOT/Arena.js")" ]] || die "BEFORE is the live Arena.js; freeze a copy first"
if git -C "$(dirname "$BEFORE")" ls-files --error-unmatch "$BEFORE" >/dev/null 2>&1; then
  die "BEFORE is git-tracked ($BEFORE); freeze a copy outside the tracked tree"
fi

if [[ $CONTROL -eq 1 ]]; then
  [[ -f "$CTL_BUILD" ]] || die "control build not found: $CTL_BUILD (build it with .handoff/evidence/F2/variants/make-variants.mjs)"
  AFTER="$(abspath "$CTL_BUILD")" || die "cannot resolve $CTL_BUILD"
fi

if [[ -z "$OUT" ]]; then OUT="$(mktemp -d "${TMPDIR:-/tmp}/arena-inline-ix-XXXXXX")" || die "mktemp failed"; fi
mkdir -p "$OUT" || die "cannot create $OUT"
OUT="$(cd "$OUT" && pwd -P)"
WORK="$OUT/drivers"; mkdir -p "$WORK"
cp "$HERE/workload.mjs" "$WORK/workload.mjs"

mkdriver() {   # the import is a file URL built by node (absolute path; spaces and '#' escaped)
  node -e '
    const { pathToFileURL } = require("url");
    const u = JSON.stringify(pathToFileURL(process.argv[1]).href);
    require("fs").writeFileSync(process.argv[2],
      "import { Arena } from " + u + ";\nimport { run } from \"./workload.mjs\";\nconsole.log(\"sink\", run(Arena));\n");
  ' "$2" "$WORK/driver-$1.mjs"
}
mkdriver before "$BEFORE"
mkdriver after "$AFTER"

SB="$(node "$WORK/driver-before.mjs")" || die "before driver failed"
SA="$(node "$WORK/driver-after.mjs")" || die "after driver failed"
[[ "$SB" == "$SA" ]] || die "workload sink differs (before '$SB', after '$SA'): behaviour changed, not an inlining comparison"

printf 'inline-indexed/run.sh  before %s (sha256/8 %s)\n' "$BEFORE" "$(shasum -a 256 "$BEFORE" | cut -c1-8)"
printf '                       after  %s (sha256/8 %s)%s\n' "$AFTER" "$(shasum -a 256 "$AFTER" | cut -c1-8)" \
  "$([[ $CONTROL -eq 1 ]] && printf '  [CONTROL: padded-ix]')"
printf '                       load   %s\n' "$(uptime | sed 's/.*load averages*: *//')"
printf '                       %s\n' "$SA"

set +e
"$TOOL" --fn "$FNS" --runs "$RUNS" --out "$OUT/diff" "$WORK/driver-before.mjs" "$WORK/driver-after.mjs"
RC=$?
set -e
case "$RC" in 0|1|2) ;; *) echo "inline-indexed/run.sh: tool exited $RC (not a verdict)"; RC=2 ;; esac

# The 16-function table (REPORTED), from the tool's bytecode section: "  <fn>: <before> -> <after> bytes ...".
REPORT="$OUT/diff/report.txt"
MISSING=0
echo "=== L4b targets (AFTER bytecode length; Maglev single-inline < 100 B, TurboFan single-inline <= 460 B)"
IFS=',' read -r -a TARGETS <<< "$FNS"
for fn in "${TARGETS[@]}"; do
  line="$(grep -E "^  $fn: [0-9]+ -> [0-9]+ bytes" "$REPORT" 2>/dev/null | head -1 || true)"
  if [[ -z "$line" ]]; then
    printf '  %-16s MISSING (no single bytecode length: too cold, or several functions with this name)\n' "$fn"
    MISSING=$((MISSING + 1)); continue
  fi
  b="$(printf '%s' "$line" | sed -E 's/^  [^:]+: ([0-9]+) -> ([0-9]+) bytes.*/\1/')"
  a="$(printf '%s' "$line" | sed -E 's/^  [^:]+: ([0-9]+) -> ([0-9]+) bytes.*/\2/')"
  printf '  %-16s %4s B (before %4s) | Maglev %s | TurboFan %s\n' "$fn" "$a" "$b" \
    "$([[ $a -lt 100 ]] && echo 'inside  (< 100)' || echo 'OUTSIDE (>= 100)')" \
    "$([[ $a -le 460 ]] && echo 'inside (<= 460)' || echo 'OUTSIDE (> 460)')"
done
FINAL=1
if [[ $MISSING -ne 0 ]]; then echo "inline-indexed/run.sh: $MISSING of ${#TARGETS[@]} targets have no bytecode length"; echo "VERDICT NO-VERDICT"; RC=2; fi

if [[ $CONTROL -eq 1 ]]; then
  if [[ $RC -eq 1 ]]; then echo "CONTROL OK (padded-ix -> DIFF)"; exit 1; fi
  echo "CONTROL FAILED (expected DIFF = exit 1, got exit $RC)"; exit 2
fi
exit "$RC"
