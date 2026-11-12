#!/usr/bin/env bash
# Runs a rebuild review with no one at the keyboard (claude -p), start to finish.
# Usage: unattended.sh <target> --max-usd N [--base url@ref|none|keep] [--run-dir dir] [--from Parity|Score|Report [--no-build]] [--watch [port]] [-- extra claude flags]
# --from redoes that phase and the later ones on the finished run in --run-dir (scripts/rerun.mjs); with --no-build no build round starts and --max-usd is not needed.
# --watch starts the watch page (scripts/watch.mjs) in the background and needs --run-dir; the page ends by itself 30 minutes after the run.
# Example: unattended.sh ~/work/app --max-usd 300 -- --dangerously-skip-permissions
# Without CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0, claude -p stops the background workflow
# 10 minutes after its last turn; this script sets it. It also sets
# CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1: otherwise, under memory pressure, Claude Code stops
# background shells while the idle main session waits, which ends the run (#101). Cap memory from
# outside instead (e.g. systemd-run --user -p MemoryHigh=... -p MemoryMax=...).
set -euo pipefail

usage() { echo "usage: $0 <target> --max-usd N [--base url@ref|none|keep] [--run-dir dir] [--from Parity|Score|Report [--no-build]] [--watch [port]] [-- extra claude flags]" >&2; exit 2; }

[ $# -ge 1 ] || usage
target=$1; shift
max_usd='' base=keep run_dir='' watch='' watch_port=0 from='' no_build=''
while [ $# -gt 0 ]; do
  case "$1" in
    --max-usd) [ $# -ge 2 ] || usage; max_usd=$2; shift 2 ;;
    --base) [ $# -ge 2 ] || usage; base=$2; shift 2 ;;
    --run-dir) [ $# -ge 2 ] || usage; run_dir=$2; shift 2 ;;
    --from) [ $# -ge 2 ] || usage; from=$2; shift 2 ;;
    --no-build) no_build=1; shift ;;
    --watch)
      watch=1; shift
      if [ $# -gt 0 ] && case "$1" in ''|*[!0-9]*) false ;; *) true ;; esac; then watch_port=$1; shift; fi ;;
    --) shift; break ;;
    *) usage ;;
  esac
done

[ -d "$target" ] || { echo "not a directory: $target" >&2; exit 2; }
case "$from" in ''|Parity|Score|Report) ;; *) echo "--from must be Parity, Score or Report, got: $from" >&2; exit 2 ;; esac
[ -z "$no_build" ] || [ -n "$from" ] || { echo "--no-build needs --from" >&2; exit 2; }
[ -z "$from" ] || [ -n "$run_dir" ] || { echo "--from needs --run-dir: the finished run to redo" >&2; exit 2; }
case "$max_usd" in
  '') [ -n "$no_build" ] || { echo "--max-usd is required: the most the run may cost (nothing was spent)" >&2; exit 2; } ;;
  *[!0-9.]*|.|*.*.*) echo "--max-usd must be a number of dollars, got: $max_usd" >&2; exit 2 ;;
esac
case "$base" in *' '*) echo "--base must not contain spaces" >&2; exit 2 ;; esac
target=$(cd "$target" && pwd)
prompt="/rebuild-review:rebuild-review $target base=$base unattended=1"
[ -z "$max_usd" ] || prompt="$prompt maxUsd=$max_usd"
if [ -n "$run_dir" ]; then
  [ -d "$run_dir" ] || { echo "run folder not found: $run_dir" >&2; exit 2; }
  prompt="$prompt runDir=$(cd "$run_dir" && pwd)"
fi
[ -z "$from" ] || prompt="$prompt from=$from"
[ -z "$no_build" ] || prompt="$prompt noBuild=1"

if [ -n "$watch" ]; then
  [ -n "$run_dir" ] || { echo "--watch needs --run-dir: the run folder must exist before the page can watch it" >&2; exit 2; }
  run_dir=$(cd "$run_dir" && pwd)
  here=$(cd "$(dirname "$0")" && pwd)
  nohup node "$here/watch.mjs" "$run_dir" --port "$watch_port" > "$run_dir/watch.out" 2>&1 &
  echo $! > "$run_dir/watch.pid"
  link=''
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    link=$(head -n 1 "$run_dir/watch.out" 2>/dev/null || true)
    case "$link" in http://127.0.0.1:*) break ;; esac
    link=''; sleep 0.25
  done
  [ -n "$link" ] || { echo "the watch page did not start: $(head -n 3 "$run_dir/watch.out")" >&2; exit 2; }
  port=${link#http://127.0.0.1:}; port=${port%%/*}
  echo "watch page: $link"
  echo "from another machine: ssh -L $port:127.0.0.1:$port <host>, then open the same link"
fi

export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0
export CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1
exec claude -p "$prompt" "$@"
