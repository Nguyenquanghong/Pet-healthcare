#!/usr/bin/env bash
# bridge-m-h-vm-v2 (or v1) on a plain Ubuntu 24.04 VM (8 vCPU, 16 GB): prerequisites, smoke gate, the measured members, result archive.
#
#   sudo bash vm_run.sh --bundle bridge-m-h-vm-v2.zip --sha256 <sha256 of the bundle> [--mode full|smoke|local] [--out DIR] [--allow-small]
#                       [--study auto|v1|v2] [--cut x2-200] [--cut burst-short]
#
# The study is the one the bundle was built for (its bundle-manifest.json `format`): v2 needs the trees M, H1, H3, v1 the trees M, H0, H1.
# --study only states what you expect and stops the run when the bundle is the other one. Results go to bridge-vm-v2-<UTC>(.tar.gz) for v2
# and to bridge-vm-<UTC> for v1.
#
# v2 (bridge-m-h-vm-v2, K9; the harness prints its own estimate at the start):
#   smoke  the eight smoke members M,H1,H3,H3c,H3x2,H3p8,H3x2cl2,H3bnw2 (2 users, 15 s; the last one fires a burst of 200 events), about 20 min after setup
#   local  smoke, then a dry run of every kind of block with 60 s windows: not a result (about 55 min after setup)
#   full   smoke, then Part 1, the burst block, the steps of 200, 400 and 800 users and, when H3 is saturated by its pool, the pool block (about 5 h
#          after setup; with the local dry run before it the VM is on about 6.2 h). --cut x2-200 and --cut burst-short (full only, in this order) take
#          about 16 and 8 minutes off when that passes 6 h.
# v1:
#   full   smoke of M,H0,H1,H2 (2 users, 15 s), then M,H0,H1,H2,H2,H1,H0,M with 30 s warmup + 300 s each (about 70 min after setup)
#   smoke  the smoke gate only (about 20 min after setup)
#   local  like full with 10 s warmup + 60 s windows: a dry run of the harness, not a result
#
# The bundle (make_bridge_notebook.py --vm) holds source and harness only. This script reads and writes no secret: every
# member generates its own synthetic credentials under /tmp. This copy must be byte for byte the one in the bundle (v2: it stops otherwise).
# Run it under tmux or nohup so an SSH drop does not stop it, and power the VM off or delete it afterwards: it bills while it exists.
set -Eeuo pipefail
trap 'echo "vm_run.sh failed at line $LINENO" >&2' ERR

BUNDLE=''; SHA=''; MODE=full; OUT=''; ALLOW_SMALL=0; STUDY=auto; CUTS=()
usage() { echo "usage: sudo bash vm_run.sh --bundle FILE.zip --sha256 HEX [--mode full|smoke|local] [--out DIR] [--allow-small] [--study auto|v1|v2] [--cut x2-200] [--cut burst-short]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) [ $# -ge 2 ] || usage; BUNDLE=$2; shift 2;;
    --sha256) [ $# -ge 2 ] || usage; SHA=$2; shift 2;;
    --mode) [ $# -ge 2 ] || usage; MODE=$2; shift 2;;
    --out) [ $# -ge 2 ] || usage; OUT=$2; shift 2;;
    --study) [ $# -ge 2 ] || usage; STUDY=$2; shift 2;;
    --cut) [ $# -ge 2 ] || usage; CUTS+=("$2"); shift 2;;
    --allow-small) ALLOW_SMALL=1; shift;;
    *) usage;;
  esac
done
[ -f "$BUNDLE" ] || usage
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || usage
case "$MODE" in full|smoke|local) ;; *) usage;; esac
case "$STUDY" in auto|v1|v2) ;; *) usage;; esac
# The cuts of the v2 study (bridge_study.CUTS), checked here so that a typo costs nothing: apt and the builds come after.
for cut in ${CUTS[@]+"${CUTS[@]}"}; do
  case "$cut" in x2-200|burst-short) ;; *) echo "unknown --cut $cut (x2-200 or burst-short)" >&2; usage;; esac
done
if [ ${#CUTS[@]} -gt 0 ]; then
  [ "$MODE" = full ] || { echo "--cut is for --mode full" >&2; usage; }
  [ "$STUDY" != v1 ] || { echo "--cut is for the v2 study" >&2; usage; }
fi
[ -f "$0" ] || { echo "run it as a file (sudo bash vm_run.sh ...), not from a pipe: the copy in the bundle is compared with it" >&2; exit 2; }
BUNDLE=$(readlink -f "$BUNDLE")
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
[ -z "$OUT" ] || OUT=$(readlink -m "$OUT")
if [ "$(id -u)" -ne 0 ]; then
  ARGS=(--bundle "$BUNDLE" --sha256 "$SHA" --mode "$MODE" --study "$STUDY")
  [ -z "$OUT" ] || ARGS+=(--out "$OUT")
  [ "$ALLOW_SMALL" = 0 ] || ARGS+=(--allow-small)
  for cut in ${CUTS[@]+"${CUTS[@]}"}; do ARGS+=(--cut "$cut"); done
  exec sudo bash "$(readlink -f "$0")" "${ARGS[@]}"
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
# procps (sysctl) and iproute2 (ss) are in the VM image but not in a minimal container: vm-info.txt records the network settings.
apt-get install -y -qq --no-install-recommends python3 python3-venv python3-pip unzip util-linux ca-certificates curl procps iproute2

mkdir -p "$WORK/src"
unzip -q "$WORK/bundle.zip" -d "$WORK/src"
[ -f "$WORK/src/bundle-manifest.json" ] || { echo "bundle lacks bundle-manifest.json" >&2; exit 1; }
# Which study the bundle is for: its format (the manifest is covered by the bundle hash checked above; the per-file check below needs the tree of the study).
FORMAT=$(python3 -I -c 'import json, sys; print(json.loads(open(sys.argv[1], encoding="utf-8").read()).get("format", ""))' "$WORK/src/bundle-manifest.json")
case "$FORMAT" in
  bridge-m-h-vm-source-1) BUNDLE_STUDY=v1; TREES=(M H0 H1); HARNESS_TREE=H1; PREFIX=bridge-vm;;
  bridge-m-h-vm-source-2) BUNDLE_STUDY=v2; TREES=(M H1 H3); HARNESS_TREE=H3; PREFIX=bridge-vm-v2;;
  *) echo "unknown bundle format: ${FORMAT:-none}" >&2; exit 1;;
esac
[ "$STUDY" = auto ] || [ "$STUDY" = "$BUNDLE_STUDY" ] || { echo "--study $STUDY, but the bundle is the $BUNDLE_STUDY study ($FORMAT)" >&2; exit 1; }
[ ${#CUTS[@]} -eq 0 ] || [ "$BUNDLE_STUDY" = v2 ] || { echo "--cut is for the v2 study; the bundle is $BUNDLE_STUDY" >&2; exit 1; }
for part in "${TREES[@]}"; do [ -d "$WORK/src/$part" ] || { echo "bundle lacks $part (the $BUNDLE_STUDY study needs ${TREES[*]})" >&2; exit 1; }; done
OUT=$(readlink -m "${OUT:-$PWD/$PREFIX-$STAMP}")
mkdir -p "$OUT"
# Per-file check of the extracted tree against the bundle manifest (inventory, sizes, hashes, no links, v2: the Core worker layout of each H tree); stdlib only, isolated mode.
python3 -I "$WORK/src/$HARNESS_TREE/benchmarks/phase2/kaggle/make_bridge_notebook.py" --verify-extracted "$WORK/src" > "$OUT/bundle-verification.json"
# The script that runs is the one recorded in the bundle. v1 bundles built before this check carry an older copy: noted, not refused.
SCRIPT_MATCH=yes
cmp -s "$0" "$WORK/src/$HARNESS_TREE/benchmarks/phase2/kaggle/vm_run.sh" || SCRIPT_MATCH=no
if [ "$SCRIPT_MATCH" = no ] && [ "$BUNDLE_STUDY" = v2 ]; then
  echo "$0 is not the vm_run.sh in the bundle ($HARNESS_TREE/benchmarks/phase2/kaggle/vm_run.sh): copy the one that was built into the bundle" >&2; exit 1
fi
python3 -m venv "$WORK/venv"
PY=$WORK/venv/bin/python

{
  echo "started_utc=$STAMP mode=$MODE study=$BUNDLE_STUDY cuts=${CUTS[*]:-none} bundle_sha256=$SHA"
  echo "vm_run_sh_is_the_bundled_copy=$SCRIPT_MATCH"
  uname -a; cat /etc/os-release; lscpu; free -m; df -h /tmp /var/tmp; uptime
  systemd-detect-virt || true
  cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || true
  echo "cpu0 thread_siblings_list: $(cat /sys/devices/system/cpu/cpu0/topology/thread_siblings_list 2>/dev/null || echo unavailable)"
  # Ports and TIME_WAIT: every request of the study crosses loopback (gateway, Core, Clinic), so the ephemeral port range and tcp_tw_reuse matter at 800 users.
  sysctl net.ipv4.tcp_tw_reuse net.ipv4.ip_local_port_range || true
  echo "ss -s before the study:"; ss -s || true
} > "$OUT/vm-info.txt" 2>&1 || true

# Readable by the postgres user the members run initdb/pg_ctl as; every path below is absolute.
cd "$WORK"
# v1 bundles carry a bridge_study.py that has no --study (v1 is its only study): the flag is passed for v2 only.
STUDY_ARGS=()
if [ "$BUNDLE_STUDY" = v2 ]; then
  STUDY_ARGS=(--study v2)
  for cut in ${CUTS[@]+"${CUTS[@]}"}; do STUDY_ARGS+=(--cut "$cut"); done
fi
set +e
"$PY" "$WORK/src/$HARNESS_TREE/benchmarks/phase2/kaggle/bridge_study.py" --platform vm --root "$WORK/src" --private "$WORK/private" \
  --results "$OUT/results" --mode "$MODE" "${STUDY_ARGS[@]}" 2>&1 | tee "$OUT/vm_run.log"
STATUS=${PIPESTATUS[0]}
set -e

{ echo "ss -s after the study:"; ss -s || true; } >> "$OUT/vm-info.txt" 2>&1 || true
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
