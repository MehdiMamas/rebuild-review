#!/usr/bin/env bash
# Runs a rebuild review with no one at the keyboard (claude -p), start to finish.
# Usage: unattended.sh <target> --max-usd N [--base url@ref|none|keep] [--run-dir dir] [--watch [port]] [-- extra claude flags]
# --watch starts the watch page (scripts/watch.mjs) in the background and needs --run-dir; the page ends by itself 30 minutes after the run.
# Example: unattended.sh ~/work/app --max-usd 300 -- --dangerously-skip-permissions
# Without CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0, claude -p stops the background workflow
# 10 minutes after its last turn; this script sets it.
set -euo pipefail

usage() { echo "usage: $0 <target> --max-usd N [--base url@ref|none|keep] [--run-dir dir] [--watch [port]] [-- extra claude flags]" >&2; exit 2; }

[ $# -ge 1 ] || usage
target=$1; shift
max_usd='' base=keep run_dir='' watch='' watch_port=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-usd) [ $# -ge 2 ] || usage; max_usd=$2; shift 2 ;;
    --base) [ $# -ge 2 ] || usage; base=$2; shift 2 ;;
    --run-dir) [ $# -ge 2 ] || usage; run_dir=$2; shift 2 ;;
    --watch)
      watch=1; shift
      if [ $# -gt 0 ] && case "$1" in ''|*[!0-9]*) false ;; *) true ;; esac; then watch_port=$1; shift; fi ;;
    --) shift; break ;;
    *) usage ;;
  esac
done

[ -d "$target" ] || { echo "not a directory: $target" >&2; exit 2; }
case "$max_usd" in
  '') echo "--max-usd is required: the most the run may cost (nothing was spent)" >&2; exit 2 ;;
  *[!0-9.]*|.|*.*.*) echo "--max-usd must be a number of dollars, got: $max_usd" >&2; exit 2 ;;
esac
case "$base" in *' '*) echo "--base must not contain spaces" >&2; exit 2 ;; esac
target=$(cd "$target" && pwd)
prompt="/rebuild-review:rebuild-review $target maxUsd=$max_usd base=$base unattended=1"
if [ -n "$run_dir" ]; then
  [ -d "$run_dir" ] || { echo "run folder not found: $run_dir" >&2; exit 2; }
  prompt="$prompt runDir=$(cd "$run_dir" && pwd)"
fi

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
exec claude -p "$prompt" "$@"
