"""D0 cgroup capability/enforcement probe; no application/DB/broker startup.

Only creates a UUID-owned subtree below the collector's verified cgroup. Never
writes the existing parent controls, migrates existing PIDs, remounts or sudoes.
Synthetic pressure is confined to owned helper cgroups. Empty groups are kept.
"""
from pathlib import Path, PurePosixPath
from datetime import datetime, timezone
import errno
import json
import os
import platform
import re
import signal
import subprocess
import sys
import uuid

BUDGET = {'status': 'PROPOSED_NOT_FROZEN', 'stack': {'cpuMax': '200000 100000', 'memoryBytes': 8*1024**3},
          'generator': {'cpuMax': '100000 100000', 'memoryBytes': 2*1024**3},
          'swapMaxBytes': 0, 'ioLimit': None}
CONTROLS = ('cpu.max', 'cpu.stat', 'memory.max', 'memory.current', 'memory.swap.max',
            'memory.events', 'cpuset.cpus.effective', 'io.max', 'cgroup.controllers', 'cgroup.subtree_control')


class Unavailable(RuntimeError):
    pass


def unescape(value):
    return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), value)


def locations(mountinfo, membership):
    """Pure namespace-aware mapping, including a cgroup namespace root '/'."""
    members = [x.split(':', 2)[2] for x in membership.splitlines() if x.startswith('0::')]
    if len(members) != 1 or not members[0].startswith('/') or '..' in PurePosixPath(members[0]).parts:
        raise Unavailable('CGROUP_V2_MEMBERSHIP_UNRESOLVED')
    member = members[0]; result = []
    for line in mountinfo.splitlines():
        left, sep, right = line.partition(' - '); fields = left.split(); fs = right.split()
        if not sep or len(fields) < 6 or len(fs) < 3 or fs[0] != 'cgroup2':
            continue
        root, mount = unescape(fields[3]), unescape(fields[4])
        if not root.startswith('/') or not mount.startswith('/') or '..' in PurePosixPath(root).parts or '..' in PurePosixPath(mount).parts:
            raise Unavailable('CGROUP_MOUNT_PATH_UNSAFE')
        suffix = member[len(root):] if root != '/' and (member == root or member.startswith(root+'/')) else member
        current = str(PurePosixPath(mount) / suffix.lstrip('/'))
        result.append({'mount': mount, 'mountRoot': root, 'current': current,
                       'flags': sorted(set(fields[5].split(',') + fs[2].split(',')))})
    return result


def read(path):
    try:
        value = Path(path).read_text().strip()
        if len(value) > 16384: raise Unavailable('CONTROL_OUTPUT_TOO_LARGE')
        return value
    except OSError as error:
        return {'errno': error.errno}


def counters(path):
    value = read(path)
    if not isinstance(value, str): raise Unavailable('COUNTERS_UNREADABLE')
    return {k: int(v) for k, v in (line.split() for line in value.splitlines())}


def budget_fits(ancestors, affinity):
    cpu = [len(affinity)]; memory = []
    for row in ancestors:
        raw = row['controls']['cpu.max']
        if not isinstance(raw, str): raise Unavailable('ANCESTOR_CPU_LIMIT_UNREADABLE')
        quota, period = raw.split()
        if quota != 'max': cpu.append(int(quota)/int(period))
        raw = row['controls']['memory.max']
        if not isinstance(raw, str): raise Unavailable('ANCESTOR_MEMORY_LIMIT_UNREADABLE')
        if raw != 'max': memory.append(int(raw))
    if not memory: raise Unavailable('FINITE_ANCESTOR_MEMORY_ENVELOPE_NOT_PROVEN')
    if min(cpu) < 3 or min(memory) < 10*1024**3:
        raise Unavailable('PROPOSED_BUDGET_EXCEEDS_OBSERVED_ENVELOPE')
    return {'effectiveCpuUpperBound': min(cpu), 'memoryUpperBoundBytes': min(memory),
            'isReservationOrCoTenantIsolationProof': False}


HELPER = '''import sys,time,json
kind=sys.argv[1]
if sys.stdin.buffer.readline()!=b'run\\n':sys.exit(2)
if kind=='cpu':
    start=time.process_time()
    while time.process_time()-start<0.2:pass
elif kind=='memory':
    data=bytearray(64*1024*1024)
    for i in range(0,len(data),4096):data[i]=1
else:
    print(json.dumps({'membership':open('/proc/self/cgroup').read().strip()}))
'''


def run_probe(budget=None):
    selected = json.loads(json.dumps(BUDGET if budget is None else budget))
    # No parameter can increase the proposed allocation or pressure probe sizes.
    if selected != BUDGET: raise ValueError('UNREGISTERED_ENVIRONMENT_BUDGET')
    run = str(uuid.uuid4()); owned = []; processes = []
    report = {'format': 'clinic-activity-d0-enforcement-probe-v1', 'run': run,
              'capturedAtUtc': datetime.now(timezone.utc).isoformat(), 'status': 'STARTING',
              'd0': 'PARTIAL_ENVIRONMENT', 'performance': 'NOT_RUN', 'budgetProposal': selected,
              'applicationStarted': False, 'databaseConnections': 0, 'existingParentControlsModified': False,
              'resourceEnforcement': 'NOT_PROVEN', 'fullStackPidRolePoolCoverage': 'NOT_RUN',
              'ownedCgroupsRetained': owned, 'probes': []}
    try:
        if platform.system() != 'Linux': raise Unavailable('LINUX_REQUIRED')
        candidates = locations(Path('/proc/self/mountinfo').read_text(), Path('/proc/self/cgroup').read_text())
        matches = [x for x in candidates if str(os.getpid()) in str(read(Path(x['current'])/'cgroup.procs')).splitlines()]
        if len(matches) != 1: raise Unavailable('CURRENT_CGROUP_PID_MAPPING_NOT_UNIQUE')
        location = matches[0]; parent = Path(location['current']); mount = Path(location['mount'])
        if parent.is_symlink() or parent.resolve() != parent or not parent.is_relative_to(mount):
            raise Unavailable('CURRENT_CGROUP_PATH_NOT_CANONICAL')
        report.update(platform=platform.platform(), python=platform.python_version(), uid=os.geteuid(),
                      affinity=sorted(os.sched_getaffinity(0)), cgroupLocation=location)
        ancestors = []; current = parent
        while True:
            ancestors.append({'path': str(current), 'controls': {n: read(current/n) for n in CONTROLS}})
            if current == mount: break
            if current.parent == current or not current.parent.is_relative_to(mount):
                raise Unavailable('ANCESTOR_WALK_INCOMPLETE')
            current = current.parent
        report['ancestors'] = ancestors
        report['observedEnvelope'] = budget_fits(ancestors, report['affinity'])
        root = parent / ('clinic-activity-env-'+run)
        # An actual mkdir attempt distinguishes EROFS/EACCES from os.access hints.
        try: root.mkdir()
        except OSError as error:
            report['ownedChildCreationErrno'] = error.errno
            raise Unavailable('CGROUP_READ_ONLY' if error.errno == errno.EROFS else 'CGROUP_CHILD_CREATION_DENIED')
        owned.append(str(root))
        if not {'cpu', 'memory'} <= set(str(read(parent/'cgroup.subtree_control')).split()):
            raise Unavailable('CPU_MEMORY_NOT_DELEGATED_TO_CHILDREN')
        if read(root/'cgroup.procs') != '': raise Unavailable('NEW_CGROUP_NOT_EMPTY')
        (root/'cgroup.subtree_control').write_text('+cpu +memory')
        leaves = {}
        limits = {'stack': (BUDGET['stack']['cpuMax'], 8*1024**3),
                  'generator': (BUDGET['generator']['cpuMax'], 2*1024**3),
                  'cpu-probe': ('10000 100000', 64*1024**2), 'memory-probe': ('100000 100000', 32*1024**2)}
        for name, (cpu, memory) in limits.items():
            leaf = root/name; leaf.mkdir(); owned.append(str(leaf)); leaves[name] = leaf
            (leaf/'cpu.max').write_text(cpu); (leaf/'memory.max').write_text(str(memory))
            (leaf/'memory.swap.max').write_text('0')
            if read(leaf/'cpu.max') != cpu or read(leaf/'memory.max') != str(memory) or read(leaf/'memory.swap.max') != '0':
                raise Unavailable('CONTROLLER_READBACK_MISMATCH')
        report['configuredGroups'] = {n: {key: read(p/key) for key in ['cpu.max','memory.max','memory.swap.max']} for n,p in leaves.items()}

        def child(name, kind):
            leaf = leaves[name]
            process = subprocess.Popen([sys.executable, '-I', '-S', '-c', HELPER, kind],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                env={'PATH': os.defpath, 'LANG': 'C.UTF-8'}, start_new_session=True)
            processes.append(process)
            if process.poll() is not None: raise Unavailable('HELPER_EXITED_BEFORE_ATTACHMENT')
            (leaf/'cgroup.procs').write_text(str(process.pid))
            if str(process.pid) not in str(read(leaf/'cgroup.procs')).splitlines():
                raise Unavailable('HELPER_NOT_IN_OWNED_GROUP')
            membership = read(Path('/proc')/str(process.pid)/'cgroup')
            if not isinstance(membership,str) or ('clinic-activity-env-'+run+'/'+name) not in membership:
                raise Unavailable('HELPER_MEMBERSHIP_MISMATCH')
            output, _ = process.communicate(b'run\n', timeout=8)
            report['probes'].append({'group': name, 'pid': process.pid, 'membership': membership, 'exitCode': process.returncode})
            return process.returncode, output

        for name in ['stack','generator']:
            code, output = child(name, 'identity')
            if code != 0 or 'membership' not in json.loads(output): raise Unavailable('BUDGET_GROUP_ATTACHMENT_FAILED')
        before = counters(leaves['cpu-probe']/'cpu.stat'); code, _ = child('cpu-probe','cpu')
        after = counters(leaves['cpu-probe']/'cpu.stat')
        if code != 0 or after.get('nr_throttled',0) <= before.get('nr_throttled',0):
            raise Unavailable('CPU_THROTTLING_NOT_PROVEN')
        report['cpuThrottlingObserved'] = True
        before = counters(leaves['memory-probe']/'memory.events'); code, _ = child('memory-probe','memory')
        after = counters(leaves['memory-probe']/'memory.events')
        if code != -signal.SIGKILL or after.get('oom_kill',0) <= before.get('oom_kill',0):
            raise Unavailable('CONFINED_MEMORY_LIMIT_NOT_PROVEN')
        report['confinedHelperOomObserved'] = True
        report.update(status='CAPABILITY_PASS_FULL_TRIAL_PENDING', resourceEnforcement='SYNTHETIC_HELPERS_ONLY',
                      nextAction='RUN_GUARDED_FULL_STACK_PROFILE_UNDER_PROVEN_GROUPS_BEFORE_D0_PASS')
    except Exception as error:
        report.update(status='CAPABILITY_UNAVAILABLE' if isinstance(error,Unavailable) else 'PROBE_FAILED',
                      reason=str(error) if isinstance(error,Unavailable) else type(error).__name__,
                      nextAction='DO_NOT_BOOTSTRAP_OR_BENCHMARK; PROVIDE_A_TRIAL_WITH_REQUIRED_DELEGATION')
        if isinstance(error,OSError): report['errno'] = error.errno
    finally:
        cleanup_errors = []
        for process in processes:
            try:
                if process.poll() is None:
                    try: os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError: pass
                    try: process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        try: os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError: pass
                        process.wait(timeout=2)
            except Exception as error: cleanup_errors.append(type(error).__name__)
        report['ownedHelperProcessesStopped'] = all(p.poll() is not None for p in processes)
        if cleanup_errors:
            report.update(status='PROBE_FAILED', reason='OWNED_HELPER_CLEANUP_FAILED', cleanupErrors=cleanup_errors)
        report['finishedAtUtc'] = datetime.now(timezone.utc).isoformat()
    return report


if __name__ == '__main__':
    print(json.dumps(run_probe(), indent=2))
