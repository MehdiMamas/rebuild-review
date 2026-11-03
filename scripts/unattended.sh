#!/usr/bin/env bash
# Runs a rebuild review with no one at the keyboard (claude -p), start to finish.
# Usage: unattended.sh <target> --max-usd N [--base url@ref|none|keep] [--run-dir dir] [-- extra claude flags]
# Example: unattended.sh ~/work/app --max-usd 300 -- --dangerously-skip-permissions
# Without CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0, claude -p stops the background workflow
# 10 minutes after its last turn; this script sets it.
set -euo pipefail

usage() { echo "usage: $0 <target> --max-usd N [--base url@ref|none|keep] [--run-dir dir] [-- extra claude flags]" >&2; exit 2; }

[ $# -ge 1 ] || usage
target=$1; shift
max_usd='' base=keep run_dir=''
while [ $# -gt 0 ]; do
  case "$1" in
    --max-usd) [ $# -ge 2 ] || usage; max_usd=$2; shift 2 ;;
    --base) [ $# -ge 2 ] || usage; base=$2; shift 2 ;;
    --run-dir) [ $# -ge 2 ] || usage; run_dir=$2; shift 2 ;;
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

export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0
exec claude -p "$prompt" "$@"
