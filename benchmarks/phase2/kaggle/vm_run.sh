#!/usr/bin/env bash
# bridge-m-h-vm-v1 on a plain Ubuntu 24.04 VM (8 vCPU, 16 GB): prerequisites, smoke gate, the 8 measured members, result archive.
#
#   sudo bash vm_run.sh --bundle bridge-m-h-vm-v1.zip --sha256 <sha256 of the bundle> [--mode full|smoke|local] [--out DIR] [--allow-small]
#
#   full   smoke of M,H0,H1,H2 (2 users, 15 s), then M,H0,H1,H2,H2,H1,H0,M with 30 s warmup + 300 s each (about 70 min after setup)
#   smoke  the smoke gate only (about 20 min after setup)
#   local  like full with 10 s warmup + 60 s windows: a dry run of the harness, not a result
#
# The bundle (make_bridge_notebook.py --vm) holds source and harness only. This script reads and writes no secret: every
# member generates its own synthetic credentials under /tmp. Run it under tmux or nohup so an SSH drop does not stop it,
# and power the VM off or delete it afterwards: it bills while it exists.
set -Eeuo pipefail
trap 'echo "vm_run.sh failed at line $LINENO" >&2' ERR

BUNDLE=''; SHA=''; MODE=full; OUT=''; ALLOW_SMALL=0
usage() { echo "usage: sudo bash vm_run.sh --bundle FILE.zip --sha256 HEX [--mode full|smoke|local] [--out DIR] [--allow-small]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) [ $# -ge 2 ] || usage; BUNDLE=$2; shift 2;;
    --sha256) [ $# -ge 2 ] || usage; SHA=$2; shift 2;;
    --mode) [ $# -ge 2 ] || usage; MODE=$2; shift 2;;
    --out) [ $# -ge 2 ] || usage; OUT=$2; shift 2;;
    --allow-small) ALLOW_SMALL=1; shift;;
    *) usage;;
  esac
done
[ -f "$BUNDLE" ] || usage
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || usage
case "$MODE" in full|smoke|local) ;; *) usage;; esac
BUNDLE=$(readlink -f "$BUNDLE")
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=$(readlink -m "${OUT:-$PWD/bridge-vm-$STAMP}")
if [ "$(id -u)" -ne 0 ]; then
  SMALL=(); if [ "$ALLOW_SMALL" = 1 ]; then SMALL=(--allow-small); fi
  exec sudo bash "$(readlink -f "$0")" --bundle "$BUNDLE" --sha256 "$SHA" --mode "$MODE" --out "$OUT" "${SMALL[@]}"
fi

. /etc/os-release
[ "${ID:-}" = ubuntu ] || { echo "Ubuntu expected, found ${PRETTY_NAME:-unknown}" >&2; exit 1; }
[ "${VERSION_ID:-}" = 24.04 ] || echo "warning: the harness is tested on Ubuntu 24.04, found ${VERSION_ID:-?}" >&2
CPUS=$(nproc --all); MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
mkdir -p /var/tmp /tmp
# Root-owned work directory (atomic mktemp, then readable so the postgres user can use it as cwd). The bundle is copied here first and every
# check and the extraction use that copy, so nobody who can write the original can change it between the hash check and its use.
WORK=$(mktemp -d "/var/tmp/bridge-vm-$STAMP.XXXXXX")
chmod 755 "$WORK"
install -m 0600 "$BUNDLE" "$WORK/bundle.zip"
# Nothing is installed or executed before the copy matches the hash given on the command line.
echo "$SHA  $WORK/bundle.zip" | sha256sum -c - >/dev/null || { echo "bundle sha256 mismatch" >&2; exit 1; }
FREE_GB=$(df -BG --output=avail /var/tmp | tail -1 | tr -dc 0-9)
if [ "$ALLOW_SMALL" != 1 ] && { [ "$CPUS" -lt 8 ] || [ "$MEM_MB" -lt 14000 ]; }; then
  echo "the study is defined for 8 vCPU / 16 GB (generator and controller on CPU 0, servers on the other CPUs but its SMT sibling); found $CPUS vCPU / $MEM_MB MB. --allow-small for a dry run." >&2; exit 1
fi
[ "$FREE_GB" -ge 20 ] || { echo "need 20 GB free under /var/tmp, found ${FREE_GB} GB" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3 python3-venv python3-pip unzip util-linux ca-certificates curl

mkdir -p "$WORK/src" "$OUT"
unzip -q "$WORK/bundle.zip" -d "$WORK/src"
for part in M H0 H1 bundle-manifest.json; do [ -e "$WORK/src/$part" ] || { echo "bundle lacks $part" >&2; exit 1; }; done
# Per-file check of the extracted tree against the bundle manifest (inventory, sizes, hashes, no links); stdlib only, isolated mode.
python3 -I "$WORK/src/H1/benchmarks/phase2/kaggle/make_bridge_notebook.py" --verify-extracted "$WORK/src" > "$OUT/bundle-verification.json"
python3 -m venv "$WORK/venv"
PY=$WORK/venv/bin/python

{
  echo "started_utc=$STAMP mode=$MODE bundle_sha256=$SHA"
  uname -a; cat /etc/os-release; lscpu; free -m; df -h /tmp /var/tmp; uptime
  systemd-detect-virt || true
  cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || true
  echo "cpu0 thread_siblings_list: $(cat /sys/devices/system/cpu/cpu0/topology/thread_siblings_list 2>/dev/null || echo unavailable)"
} > "$OUT/vm-info.txt" 2>&1 || true

# Readable by the postgres user the members run initdb/pg_ctl as; every path below is absolute.
cd "$WORK"
set +e
"$PY" "$WORK/src/H1/benchmarks/phase2/kaggle/bridge_study.py" --platform vm --root "$WORK/src" --private "$WORK/private" \
  --results "$OUT/results" --mode "$MODE" 2>&1 | tee "$OUT/vm_run.log"
STATUS=${PIPESTATUS[0]}
set -e

cp "$WORK/private/commands.log" "$OUT/commands.log" 2>/dev/null || true
TAR=$OUT.tar.gz
tar -czf "$TAR" -C "$(dirname "$OUT")" "$(basename "$OUT")"
(cd "$(dirname "$TAR")" && sha256sum "$(basename "$TAR")" > "$(basename "$TAR").sha256")
[ -z "${SUDO_USER:-}" ] || chown -R "$SUDO_USER" "$OUT" "$TAR" "$TAR.sha256"

echo "study exit status: $STATUS"
echo "results: $TAR (sha256 in $TAR.sha256)"
echo "fetch with: scp USER@VM:$TAR ."
echo "Private logs of the members stay in /tmp (pet-phase2-kaggle-*, bridge-m-*) and $WORK/private for debugging over SSH."
echo "Power the VM off or delete it now."
exit "$STATUS"
