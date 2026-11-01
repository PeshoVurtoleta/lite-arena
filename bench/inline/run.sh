#!/usr/bin/env bash
# bench/inline/run.sh -- TurboFan + Maglev inlining A/B for Arena.js (M-28, M-29).
#
#   bench/inline/run.sh [--control] [--runs N] [--out DIR] BEFORE_ARENA_JS [AFTER_ARENA_JS]
#
# BEFORE_ARENA_JS  a FROZEN copy (e.g. .handoff/before-F1-2c7af47/Arena.js). Refused (exit 2) when it is
#                  the live ./Arena.js (same device:inode) or a git-tracked file.
# AFTER_ARENA_JS   default: the live ./Arena.js.
# --control        must-fail control: AFTER becomes a copy of AFTER whose isAlive() is padded past the
#                  inliner's bytecode limits (60 dead stores behind an impossible branch). The A/B must
#                  say DIFF; then this prints CONTROL OK and exits 0, anything else exits 2.
# --runs N         runs per side per tier (default 3; run 1 vs runs 2..N is the null control).
# --out DIR        artifact dir (default: a new mktemp -d $TMPDIR/arena-inline-XXXXXX).
#
# Both sides run bench/inline/workload.mjs (the 1.10.0 API only) through bench/inlining-budget-diff.sh
# (vendored from LiteUtils 7f0ba7b; see its header) on the target methods below. Before tracing, both
# builds must return the same workload sink, else exit 2 (not an inlining comparison).
# Exit: 0 SAME, 1 DIFF, 2 NO-VERDICT (or a refused input). M-28: a SAME verdict keeps the decision line
# "Inlining joinN into query", so joinN stays TurboFan-inlinable (<= 460 B on node v26.8.2).
#
# Tier: STATISTICAL / REPORTED. Inlining follows tier-up timing: never part of npm test / verify. Run once
# per release under the host quiet lock:
#   node ~/.claude/hooks/quiet-lock.mjs run "lite-arena inline" -- bench/inline/run.sh BEFORE.js

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TOOL="$ROOT/bench/inlining-budget-diff.sh"
FNS="despawn,joinN,isAlive,spawn,setFlags,hasFlags,clearFlags"

die() { printf 'inline/run.sh: %s\nVERDICT NO-VERDICT\n' "$1" >&2; exit 2; }
# Fail closed: an unplanned exit (a command failing under set -e) becomes 2 NO-VERDICT, never 1 DIFF.
FINAL=""
trap 'rc=$?; [[ $rc -eq 0 || $rc -eq 2 || -n $FINAL ]] || { printf "inline/run.sh: unexpected failure (exit %s)\nVERDICT NO-VERDICT\n" "$rc" >&2; exit 2; }' EXIT
# realpath (symlinks resolved): a symlink to the live or a tracked file must not pass the frozen-BEFORE checks
abspath() { node -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$1"; }
devino() { if stat -f '%d:%i' "$1" >/dev/null 2>&1; then stat -f '%d:%i' "$1"; else stat -c '%d:%i' "$1"; fi; }

CONTROL=0; RUNS=3; OUT=""; POS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --control) CONTROL=1; shift ;;
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

if [[ -z "$OUT" ]]; then OUT="$(mktemp -d "${TMPDIR:-/tmp}/arena-inline-XXXXXX")" || die "mktemp failed"; fi
mkdir -p "$OUT" || die "cannot create $OUT"
OUT="$(cd "$OUT" && pwd -P)"
WORK="$OUT/drivers"; mkdir -p "$WORK"
cp "$HERE/workload.mjs" "$WORK/workload.mjs"

if [[ $CONTROL -eq 1 ]]; then
  mkdir -p "$WORK/control"
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8");
    const head = "    isAlive(entity) {\n";
    if (src.split(head).length !== 2) { console.error("control: isAlive header must match exactly once"); process.exit(1); }
    let pad = "        if (entity === 0x7ffffff1) {\n";
    for (let i = 1; i <= 60; i++) pad += "            this.activeCount = (this.activeCount + " + i + ") | 0;\n";
    fs.writeFileSync(process.argv[2], src.replace(head, head + pad + "        }\n"));
  ' "$AFTER" "$WORK/control/Arena.js" || die "control: could not build the padded copy"
  AFTER="$WORK/control/Arena.js"
fi

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

printf 'inline/run.sh  before %s (sha256/8 %s)\n' "$BEFORE" "$(shasum -a 256 "$BEFORE" | cut -c1-8)"
printf '               after  %s (sha256/8 %s)%s\n' "$AFTER" "$(shasum -a 256 "$AFTER" | cut -c1-8)" \
  "$([[ $CONTROL -eq 1 ]] && printf '  [CONTROL: padded isAlive]')"
printf '               load   %s\n' "$(uptime | sed 's/.*load averages*: *//')"

set +e
"$TOOL" --fn "$FNS" --runs "$RUNS" --out "$OUT/diff" "$WORK/driver-before.mjs" "$WORK/driver-after.mjs"
RC=$?
set -e
FINAL=1
case "$RC" in 0|1|2) ;; *) echo "inline/run.sh: tool exited $RC (not a verdict)"; RC=2 ;; esac

if [[ $CONTROL -eq 1 ]]; then
  if [[ $RC -eq 1 ]]; then echo "CONTROL OK (padded isAlive -> DIFF)"; exit 0; fi
  echo "CONTROL FAILED (expected DIFF = exit 1, got exit $RC)"; exit 2
fi
exit "$RC"
