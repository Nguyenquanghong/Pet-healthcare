"""Pack M and H and write the bridge-m-h-kaggle-v1 notebook (not executed).
(`--vm` instead packs the source bundle of bridge-m-h-vm-v2: M, H1 = 2841d1b and H3 = the commit under test, see pack_vm2;
`--vm --vm-study v1` packs M, H0 and H1 into the bundle of bridge-m-h-vm-v1, see pack_vm.)

M is commit 48d01c3 (the monolith the 29/09 nipopeto run measured) plus one harness
file it predates (pcn_checks.mjs, the phase-1 PCN seed). H is a committed revision
of this repository, pinned to e0e8937 (what the Kaggle run measured; --unpinned for local
experiments); a newer H belongs to the VM study (--vm). The working tree must not differ
from it in any packed path, so H is exactly that commit. Only build/runtime sources and the
benchmark harness are packed: no .git, env files, keys, notebooks, dist or
node_modules. The archive is embedded in the notebook (under Kaggle's 1 MB
Save Version limit), so the user only imports the notebook and runs it.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tarfile
import zipfile

REPO = Path(__file__).resolve().parents[3]
STUDY = 'bridge-m-h-kaggle-v1'
FORMAT = 'bridge-m-h-source-1'
M_COMMIT = '48d01c3c95d136f808b846a66a75fe08aacd92be'
M_PATHS = ('backend', 'benchmarks/kaggle/prepare_fixture.mjs', 'benchmarks/kaggle/fixtureData.mjs',
           'frontend/package.json', 'package.json', 'package-lock.json')
M_OVERLAY = ('benchmarks/kaggle/pcn_checks.mjs',)
HARNESS = tuple('benchmarks/phase2/kaggle/' + name for name in (
    'bridge_study.py', 'bridge_monolith.py', 'bridge_locust.py', 'make_bridge_notebook.py', 'pcn_runner.py', 'pcn_locust.py',
    'pcn_adapter.py', 'pcn_dataset.mjs', 'native_stack.py', 'stack.mjs', 'benchmark.py', 'acceptance.json', 'cqrs_probe.py',
    'cqrs_diagnostics.py')) + tuple('benchmarks/kaggle/' + name for name in (
    'pcn_locustfile.py', 'pcn_contract.py', 'metrics.py', 'pcn_checks.mjs')) + ('benchmarks/phase2/dataset.mjs',)
# phase2:build runs these after tsc (generated Prisma clients into dist).
BUILD_TOOLS = ('tools/phase2/copy-core-client.mjs', 'tools/phase2/copy-client.mjs')
H_PATHS = ('backend', 'services', 'packages', *BUILD_TOOLS, *HARNESS, 'frontend/package.json', 'package.json', 'package-lock.json')
# Builds compile src only; test suites stay out of the archive.
TEST_DIRS = ('tests', 'test')
TARGET = REPO / 'benchmarks/phase2/bridge-m-h-kaggle-v1.ipynb'
LIMIT = 1_000_000
# bridge-m-h-vm-v1: M, H0 (the Kaggle v1 anchor), H1 (commit under test); H2 is H1 run with two Core instances.
VM_STUDY = 'bridge-m-h-vm-v1'
VM_FORMAT = 'bridge-m-h-vm-source-1'
VM_GROUPS = ('M', 'H0', 'H1')
H0_COMMIT = 'e0e8937712d486bb0e4993541cca0255b4993e1e'
V1_H_COMMIT = H0_COMMIT  # the revision bridge-m-h-kaggle-v1 measured; a newer H belongs to the VM study
VM_HARNESS = HARNESS + ('benchmarks/phase2/kaggle/vm_run.sh',)
VM_TARGET = REPO / 'benchmarks/phase2/bridge-m-h-vm-v1.zip'
# bridge-m-h-vm-v2 (K9): M, H1 (2841d1b: what v1 measured last, the phase2 Core worker layout) and H3 (the commit under test, the workers layout). Every tree runs the harness bytes of H3.
VM2_STUDY = 'bridge-m-h-vm-v2'
VM2_FORMAT = 'bridge-m-h-vm-source-2'
VM2_GROUPS = ('M', 'H1', 'H3')
H1_COMMIT = '2841d1b9dd97b700b62baba9cb204735683f134e'
VM2_TARGET = REPO / 'benchmarks/phase2/bridge-m-h-vm-v2.zip'
VM_FORMATS = {VM_FORMAT: VM_GROUPS, VM2_FORMAT: VM2_GROUPS}
# The Core worker layouts stack.mjs knows (CORE_LAYOUTS) and the sources each is built from. A tree has exactly one of them (stack.mjs asserts it on the built tree): H1 the
# layout the workers had before they moved, H3 the layout of today. bridge_study.VM2_CONFIGS names the same layouts (a test keeps the two in step).
CORE_LAYOUT_SOURCES = {'phase2': ('backend/src/phase2/notificationWorker.ts', 'backend/src/phase2/billingWorker.ts'),
                       'workers': ('backend/src/workers/notification.ts', 'backend/src/workers/billing.ts')}
VM2_LAYOUTS = {'H1': 'phase2', 'H3': 'workers'}
# What changes the behaviour of the product in a bundle (H_PATHS without the harness): h3ProductCommit is the last commit that touched it.
PRODUCT_PATHS = ('backend', 'services', 'packages', *BUILD_TOOLS, 'frontend/package.json', 'package.json', 'package-lock.json')
NOT_PRODUCT = (':(exclude,glob)**/tests/**', ':(exclude,glob)**/test/**', ':(exclude,glob)**/*.md')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=REPO)


def safe(name):
    p = PurePosixPath(name)
    if ('\\' in name or ':' in name or p.is_absolute() or str(p) != name or '..' in p.parts
            or any(part in ('.git', 'node_modules', 'dist', 'generated', 'uploads') for part in p.parts)
            or p.name.startswith('.env') or p.suffix in ('.pem', '.key', '.ipynb', '.zip', '.bin')):
        return False
    return True


def tree(commit, paths):
    raw = git('archive', '--format=tar', commit, *paths)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for info in archive.getmembers():
            if info.isfile() and safe(info.name) and not set(PurePosixPath(info.name).parts[:-1]) & set(TEST_DIRS):
                files[info.name] = archive.extractfile(info).read()
            elif info.issym() or info.islnk():
                raise ValueError('BRIDGE_LINK_IN_TREE: ' + info.name)
    return files


def pack(h_commit=V1_H_COMMIT, worktree_harness=False):
    """worktree_harness: local dry runs only; the harness comes from the working tree and the manifest says so."""
    h = git('rev-parse', h_commit).decode().strip()
    # Markdown stays local by repository policy and is never packed.
    dirty = '\n'.join(line for line in git('status', '--porcelain', '--untracked-files=all', '--', *H_PATHS).decode().splitlines()
                      if not line.endswith('.md') and not (worktree_harness and line[3:] in HARNESS))
    if h_commit == 'HEAD' and dirty:
        raise ValueError('BRIDGE_H_WORKTREE_DIFFERS_FROM_HEAD:\n' + dirty)
    m_files, h_files = tree(M_COMMIT, M_PATHS), tree(h, H_PATHS)
    if worktree_harness:
        h_files.update({name: (REPO / name).read_bytes() for name in HARNESS})
    for name in M_OVERLAY:
        if name in m_files:
            raise ValueError('BRIDGE_M_OVERLAY_EXISTS: ' + name)
        m_files[name] = h_files[name]
    payload = {**{'M/' + k: v for k, v in m_files.items()}, **{'H/' + k: v for k, v in h_files.items()}}
    files = [{'path': name, 'bytes': len(value), 'sha256': digest(value)} for name, value in sorted(payload.items())]
    manifest = {'format': FORMAT, 'study': STUDY, 'mCommit': M_COMMIT, 'hCommit': h, 'mOverlay': list(M_OVERLAY),
                'harnessFromWorktree': worktree_harness,
                'files': files, 'treeSha256': digest(json.dumps(files, separators=(',', ':')).encode()),
                'scope': 'Build/runtime sources and benchmark harness only; H is the committed revision, M is 48d01c3 plus the PCN seed.'}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, value in [('bundle-manifest.json', (json.dumps(manifest, indent=2) + '\n').encode()), *sorted(payload.items())]:
            info = zipfile.ZipInfo(name, (2026, 10, 28, 0, 0, 0))
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, value)
    return buffer.getvalue(), manifest


def assemble_vm(m_files, h0_files, h1_files, harness):
    """Group the trees of the VM bundle. Every H tree runs the same harness bytes; M gets the PCN seed it predates."""
    h0, h1, m = {**h0_files, **harness}, {**h1_files, **harness}, dict(m_files)
    for name in M_OVERLAY:
        if name in m:
            raise ValueError('BRIDGE_M_OVERLAY_EXISTS: ' + name)
        m[name] = h1[name]
    payload = {**{'M/' + k: v for k, v in m.items()}, **{'H0/' + k: v for k, v in h0.items()}, **{'H1/' + k: v for k, v in h1.items()}}
    # Scripts run under bash on the VM: LF whatever core.autocrlf did to the checkout or git archive (the repository also has *.sh text eol=lf).
    return {name: value.replace(b'\r\n', b'\n') if name.endswith('.sh') else value for name, value in payload.items()}


def pack_vm(h_commit='HEAD', h0_commit=H0_COMMIT, worktree_harness=False):
    """H1 = h_commit. worktree_harness: the harness (and vm_run.sh) comes from the working tree, for runs before it is committed."""
    h1, h0 = (git('rev-parse', c).decode().strip() for c in (h_commit, h0_commit))
    dirty = '\n'.join(line for line in git('status', '--porcelain', '--untracked-files=all', '--', *H_PATHS, *VM_HARNESS).decode().splitlines()
                      if not line.endswith('.md') and not (worktree_harness and line[3:] in VM_HARNESS))
    if h_commit == 'HEAD' and dirty:
        raise ValueError('BRIDGE_H_WORKTREE_DIFFERS_FROM_HEAD:\n' + dirty)
    try:
        harness = {name: (REPO / name).read_bytes() for name in VM_HARNESS} if worktree_harness else tree(h1, VM_HARNESS)
    except subprocess.CalledProcessError:
        raise ValueError('BRIDGE_VM_HARNESS_NOT_IN_H1: commit the harness and vm_run.sh, or pass --worktree-harness') from None
    payload = assemble_vm(tree(M_COMMIT, M_PATHS), tree(h0, H_PATHS), tree(h1, H_PATHS), harness)
    files = [{'path': name, 'bytes': len(value), 'sha256': digest(value)} for name, value in sorted(payload.items())]
    manifest = {'format': VM_FORMAT, 'study': VM_STUDY, 'mCommit': M_COMMIT, 'h0Commit': h0, 'h1Commit': h1, 'mOverlay': list(M_OVERLAY),
                'harnessFromWorktree': worktree_harness, 'files': files,
                'treeSha256': digest(json.dumps(files, separators=(',', ':')).encode()),
                'scope': 'Build/runtime sources and benchmark harness only. M is 48d01c3 plus the PCN seed; H0 and H1 are committed product '
                         'revisions, both run with the harness bytes of the harness commit (H1 unless taken from the working tree).'}
    return bundle_zip(manifest, payload, (2026, 10, 28, 0, 0, 0)), manifest


def bundle_zip(manifest, payload, moment):
    """The bundle: bundle-manifest.json first, then every file in path order, owner-only regular files, one fixed timestamp (the same inputs give the same bytes)."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, value in [('bundle-manifest.json', (json.dumps(manifest, indent=2) + '\n').encode()), *sorted(payload.items())]:
            info = zipfile.ZipInfo(name, moment)
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, value)
    return buffer.getvalue()


def build_vm(target=VM_TARGET, h_commit='HEAD', h0_commit=H0_COMMIT, worktree_harness=False):
    raw, manifest = pack_vm(h_commit, h0_commit, worktree_harness)
    expected = digest(raw)
    verified_members(raw, expected, VM_GROUPS, VM_FORMAT)
    target = Path(target)
    target.write_bytes(raw)
    record = {'study': VM_STUDY, 'bundle': target.name, 'bundleBytes': len(raw), 'sha256': expected, 'mCommit': M_COMMIT,
              'h0Commit': manifest['h0Commit'], 'h1Commit': manifest['h1Commit'], 'harnessFromWorktree': worktree_harness,
              'files': len(manifest['files']), 'execution': 'NOT_RUN'}
    target.with_suffix('.manifest.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    return record


def core_layouts(paths):
    """The Core worker layouts a tree (its paths, without the group prefix) has the sources of."""
    return sorted(name for name, sources in CORE_LAYOUT_SOURCES.items() if all(source in paths for source in sources))


def check_vm2_layouts(trees):
    """`trees`: group (H1, H3) -> its paths or files. Each tree must have exactly the Core worker layout stack.mjs is told for it (VM2_LAYOUTS), else BRIDGE_VM2_LAYOUT."""
    for group, expected in VM2_LAYOUTS.items():
        found = core_layouts(trees[group])
        if found != [expected]:
            raise ValueError(f'BRIDGE_VM2_LAYOUT: {group} must have the {expected} Core worker layout ({" and ".join(CORE_LAYOUT_SOURCES[expected])}) and no other, found '
                             f'{" and ".join(found) or "none"}')


def assemble_vm2(m_files, h1_files, h3_files, harness):
    """Group the trees of the v2 bundle. Every H tree runs the same harness bytes; M gets the PCN seed it predates."""
    h1, h3, m = {**h1_files, **harness}, {**h3_files, **harness}, dict(m_files)
    for name in M_OVERLAY:
        if name in m:
            raise ValueError('BRIDGE_M_OVERLAY_EXISTS: ' + name)
        m[name] = h3[name]
    payload = {**{'M/' + k: v for k, v in m.items()}, **{'H1/' + k: v for k, v in h1.items()}, **{'H3/' + k: v for k, v in h3.items()}}
    # Scripts run under bash on the VM: LF whatever core.autocrlf did to the checkout or git archive (the repository also has *.sh text eol=lf).
    return {name: value.replace(b'\r\n', b'\n') if name.endswith('.sh') else value for name, value in payload.items()}


def product_commit(commit):
    """The last commit up to `commit` that changed the product the bundle packs (not the harness, tests or Markdown): what the product of H3 is as of."""
    return git('log', '-1', '--format=%H', commit, '--', *PRODUCT_PATHS, *NOT_PRODUCT).decode().strip() or None


def pack_vm2(h3_commit='HEAD', h1_commit=H1_COMMIT, worktree_harness=False):
    """H3 = h3_commit (the commit under test), H1 = h1_commit (2841d1b). worktree_harness: the harness (and vm_run.sh) comes from the working tree, for runs before it is committed.
    Each H tree must have the Core worker layout it is run with (BRIDGE_VM2_LAYOUT)."""
    h3, h1 = (git('rev-parse', c).decode().strip() for c in (h3_commit, h1_commit))
    dirty = '\n'.join(line for line in git('status', '--porcelain', '--untracked-files=all', '--', *H_PATHS, *VM_HARNESS).decode().splitlines()
                      if not line.endswith('.md') and not (worktree_harness and line[3:] in VM_HARNESS))
    if h3_commit == 'HEAD' and dirty:
        raise ValueError('BRIDGE_H_WORKTREE_DIFFERS_FROM_HEAD:\n' + dirty)
    try:
        harness = {name: (REPO / name).read_bytes() for name in VM_HARNESS} if worktree_harness else tree(h3, VM_HARNESS)
    except subprocess.CalledProcessError:
        raise ValueError('BRIDGE_VM_HARNESS_NOT_IN_H3: commit the harness and vm_run.sh, or pass --worktree-harness') from None
    h1_files, h3_files = tree(h1, H_PATHS), tree(h3, H_PATHS)
    check_vm2_layouts({'H1': h1_files, 'H3': h3_files})
    payload = assemble_vm2(tree(M_COMMIT, M_PATHS), h1_files, h3_files, harness)
    files = [{'path': name, 'bytes': len(value), 'sha256': digest(value)} for name, value in sorted(payload.items())]
    manifest = {'format': VM2_FORMAT, 'study': VM2_STUDY, 'mCommit': M_COMMIT, 'h1Commit': h1, 'h3Commit': h3, 'h3ProductCommit': product_commit(h3), 'mOverlay': list(M_OVERLAY),
                'coreLayouts': VM2_LAYOUTS, 'harnessFromWorktree': worktree_harness, 'files': files,
                'treeSha256': digest(json.dumps(files, separators=(',', ':')).encode()),
                'scope': 'Build/runtime sources and benchmark harness only. M is 48d01c3 plus the PCN seed; H1 (2841d1b, the phase2 Core worker layout) and H3 (the commit under test, the '
                         'workers layout) are committed product revisions, all three run with the harness bytes of the H3 commit (unless taken from the working tree).'}
    return bundle_zip(manifest, payload, (2026, 11, 11, 0, 0, 0)), manifest


def build_vm2(target=VM2_TARGET, h3_commit='HEAD', h1_commit=H1_COMMIT, worktree_harness=False):
    raw, manifest = pack_vm2(h3_commit, h1_commit, worktree_harness)
    expected = digest(raw)
    verified_members(raw, expected, VM2_GROUPS, VM2_FORMAT)
    target = Path(target)
    target.write_bytes(raw)
    record = {'study': VM2_STUDY, 'bundle': target.name, 'bundleBytes': len(raw), 'sha256': expected, 'mCommit': M_COMMIT, 'h1Commit': manifest['h1Commit'],
              'h3Commit': manifest['h3Commit'], 'h3ProductCommit': manifest['h3ProductCommit'], 'harnessFromWorktree': worktree_harness,
              'files': len(manifest['files']), 'treeSha256': manifest['treeSha256'], 'execution': 'NOT_RUN'}
    target.with_suffix('.manifest.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    return record


def verified_members(raw, expected, groups=('M', 'H'), fmt=FORMAT):
    """Pure validator, also executed by the notebook before anything is written."""
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('BRIDGE_ARCHIVE_HASH')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        if len(infos) > 3000 or len({i.filename for i in infos}) != len(infos) or sum(i.file_size for i in infos) > 40_000_000:
            raise ValueError('BRIDGE_ARCHIVE_SHAPE')
        for info in infos:
            if info.is_dir() or stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError('BRIDGE_LINK_OR_DIRECTORY')
        manifest = json.loads(archive.read('bundle-manifest.json'))
        files = manifest['files']
        if manifest['format'] != fmt or hashlib.sha256(json.dumps(files, separators=(',', ':')).encode()).hexdigest() != manifest['treeSha256']:
            raise ValueError('BRIDGE_TREE_HASH')
        if {i.filename for i in infos} != {'bundle-manifest.json', *(r['path'] for r in files)}:
            raise ValueError('BRIDGE_INVENTORY')
        values = {}
        for row in files:
            group, _, name = row['path'].partition('/')
            if group not in groups or not safe(name):
                raise ValueError('BRIDGE_UNSAFE_PATH')
            value = archive.read(row['path'])
            if len(value) != row['bytes'] or hashlib.sha256(value).hexdigest() != row['sha256']:
                raise ValueError('BRIDGE_FILE_HASH')
            values[row['path']] = value
        return manifest, values


def verify_tree(root, groups=None, fmt=None):
    """Per-file check of an extracted VM bundle against its bundle-manifest.json: same inventory (nothing added or missing),
    sizes and hashes, safe paths, no links. vm_run.sh runs it before anything in the tree is executed.
    The manifest's `format` says which bundle it is (VM_FORMATS): its groups are the ones allowed, and a v2 bundle must have the Core worker
    layout of each H tree. `fmt` / `groups` pin the expectation when the caller has one (BRIDGE_FORMAT when the bundle is another)."""
    root = Path(root)
    manifest = json.loads((root / 'bundle-manifest.json').read_text(encoding='utf-8'))
    files = manifest['files']
    fmt = fmt or manifest.get('format')
    if manifest.get('format') != fmt or fmt not in VM_FORMATS:
        raise ValueError(f'BRIDGE_FORMAT: {manifest.get("format")!r} is not {fmt!r} or not one of {sorted(VM_FORMATS)}')
    groups = groups or VM_FORMATS[fmt]
    if digest(json.dumps(files, separators=(',', ':')).encode()) != manifest['treeSha256']:
        raise ValueError('BRIDGE_TREE_HASH')
    found = set()
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('BRIDGE_LINK_OR_DIRECTORY')
        if path.is_file():
            found.add(path.relative_to(root).as_posix())
    if found != {'bundle-manifest.json', *(row['path'] for row in files)}:
        raise ValueError('BRIDGE_INVENTORY')
    for row in files:
        group, _, name = row['path'].partition('/')
        if group not in groups or not safe(name):
            raise ValueError('BRIDGE_UNSAFE_PATH')
        value = (root / row['path']).read_bytes()
        if len(value) != row['bytes'] or digest(value) != row['sha256']:
            raise ValueError('BRIDGE_FILE_HASH')
    if fmt == VM2_FORMAT:
        check_vm2_layouts({group: {row['path'].partition('/')[2] for row in files if row['path'].partition('/')[0] == group} for group in VM2_LAYOUTS})
    return manifest


def build(target=TARGET, h_commit=V1_H_COMMIT, worktree_harness=False, unpinned=False):
    """The v1 notebook is e0e8937 with its own harness; anything else (a newer H, a worktree harness) is refused unless unpinned."""
    if not unpinned and (git('rev-parse', h_commit).decode().strip() != V1_H_COMMIT or worktree_harness):
        raise ValueError('BRIDGE_V1_PINNED: bridge-m-h-kaggle-v1 is the e0e8937 study; use --vm for newer revisions (--unpinned for a local experiment)')
    raw, manifest = pack(h_commit, worktree_harness)
    expected = digest(raw)
    verified_members(raw, expected)
    validator = Path(__file__).read_bytes()
    cells = []

    def cell(kind, text):
        item = {'cell_type': kind, 'id': f'bridge-v1-{len(cells)}', 'metadata': {}, 'source': text.strip().splitlines(keepends=True)}
        if kind == 'code':
            item.update(execution_count=None, outputs=[])
        cells.append(item)
    cell('markdown', f'''# Trước tách module (M) so với bản hiện tại (H): `{STUDY}`

Kaggle **CPU / Internet On**, rồi **Save Version → Save & Run All (Commit)** (khoảng 1 giờ; chạy commit để không bị ngắt vì idle).

- **M** = `{M_COMMIT[:7]}`: backend đơn khối, một DB, trước khi tách module.
- **H** = `{manifest['hCommit'][:7]}`: ba service (Core, Clinic, Notification), ba DB, RabbitMQ, Redis, Nginx; CQRS projection tắt (mặc định).
- **Tải:** bài PCN (100 người dùng chờ phản hồi, nghỉ 0,5–1,5 s; GET pets 4, appointments 2, medical 2, hotel 1, invoices 1, notifications 1; POST appointment 2, rescue 1). Lịch đặt theo lưới 30 phút 08:00–17:00, mỗi lần một slot riêng (H từ P10 không nhận giờ lẻ); báo thất lạc mỗi lần một số điện thoại riêng.
- **Thứ tự:** smoke M, smoke H (2 người, 15 s), rồi 4 lượt đo **M, H, H, M**, mỗi lượt warmup 30 s + đo 300 s trên dữ liệu mới. Thứ tự ABBA triệt tiêu độ chậm dần của Kaggle.
- **Khác cấu hình duy nhất:** ngưỡng limiter theo IP và rescue của H được nâng (mọi traffic chung một IP loopback); limiter vẫn chạy. M không có limiter ngoài `/api/auth`.
- **Cách đọc (chốt trước khi chạy):** tỷ lệ p95 H/M cân bằng thứ tự ≤ 0,9 là H nhanh hơn, 0,9–1,1 tương đương, ≥ 1,1 H chậm hơn. Cùng ngưỡng cho CPU server mỗi request thành công.

Không retry, không đổi tải. Gửi lại file ZIP ở cuối để review.''')
    cell('code', '''MODE = 'full'   # 'full' (đo) | 'smoke' (chỉ kiểm cài đặt, khoảng 20 phút)
assert MODE in ('full', 'smoke')
import base64, hashlib, importlib.util, io, json, os, platform, sys, uuid
from pathlib import Path, PurePosixPath
from zipfile import ZipFile
assert platform.system() == 'Linux' and Path('/kaggle/working').is_dir(), 'Chạy trong notebook Kaggle.'
assert os.geteuid() == 0, 'Cần quyền root của kernel.'
''' + '\nSOURCE_SHA256 = ' + repr(expected) + '\nVALIDATOR_BASE64 = ' + repr(base64.b64encode(validator).decode()) +
         '\nSOURCE_BASE64 = ' + repr(base64.b64encode(raw).decode()) + '''
raw = base64.b64decode(SOURCE_BASE64, validate=True)
assert hashlib.sha256(raw).hexdigest() == SOURCE_SHA256, 'Source archive hash mismatch'
namespace = {'__name__': 'bridge_validator', '__file__': '/tmp/bridge-validator/benchmarks/phase2/kaggle/make_bridge_notebook.py'}
exec(compile(base64.b64decode(VALIDATOR_BASE64), '<bridge-validator>', 'exec'), namespace)
manifest, values = namespace['verified_members'](raw, SOURCE_SHA256)
RUN = str(uuid.uuid4())
PRIVATE = Path('/tmp') / ('bridge-' + RUN); PRIVATE.mkdir(mode=0o700)
OUTPUT = Path('/kaggle/working') / ('bridge-' + RUN)
for name, value in values.items():
    destination = PRIVATE.joinpath(*PurePosixPath(name).parts)
    assert destination.resolve().is_relative_to(PRIVATE.resolve())
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open('xb') as handle:
        handle.write(value)
(PRIVATE / 'bundle-manifest.json').write_bytes(json.dumps(manifest, indent=2).encode())
sys.path.insert(0, str(PRIVATE / 'H/benchmarks/phase2/kaggle'))
spec = importlib.util.spec_from_file_location('bridge_study', PRIVATE / 'H/benchmarks/phase2/kaggle/bridge_study.py')
study = importlib.util.module_from_spec(spec); spec.loader.exec_module(study)
print({'run': RUN, 'study': study.STUDY, 'M': manifest['mCommit'][:7], 'H': manifest['hCommit'][:7], 'source_verified': True, 'mode': MODE})
''')
    cell('markdown', '## Chạy\nIn tiến độ mỗi 30 s. Log, DB và token chỉ nằm trong `/tmp`; ZIP chỉ chứa số đo.')
    cell('code', '''from IPython.display import display, FileLink
WORK = PRIVATE / 'work'; WORK.mkdir()
summary = study.run_study(PRIVATE / 'M', PRIVATE / 'H', WORK, OUTPUT, RUN, mode=MODE, progress=lambda text: print(text, flush=True))
comparison = summary.get('comparison', {})
print(json.dumps({k: summary.get(k) for k in ('status', 'smoke', 'error_type', 'error')}, indent=2, ensure_ascii=False))
if comparison.get('decision') == 'COMPARED':
    print(f"{'operation':22} {'p95 M (ms)':>16} {'p95 H (ms)':>16} {'H/M p95':>8} {'H/M p50':>8}  đọc")
    for name, op in comparison['operations'].items():
        m, h = (' / '.join(f'{v:.1f}' for v in op['p95_ms'][k]) for k in ('M', 'H'))
        print(f"{name:22} {m:>16} {h:>16} {op['p95_ratio']:8.2f} {op['p50_ratio']:8.2f}  {op['reading']}")
    print(json.dumps({'overall_ratios_H_over_M': comparison['overall_ratios_H_over_M'],
                      'overall_p95': comparison['overall_p95_reading'], 'cpu_per_success': comparison['cpu_per_success_reading']},
                     indent=2, ensure_ascii=False))
else:
    print(json.dumps(comparison, indent=2, ensure_ascii=False))
display(FileLink(summary['download']))
''')
    cell('markdown', '## Gửi kết quả\nTải file `bridge-<run>.zip` ở trên (hoặc tab Output của bản commit) và gửi lại để review.')
    notebook = {'cells': cells, 'metadata': {'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
                'language_info': {'name': 'python'}, 'kaggle': {'accelerator': 'none', 'isInternetEnabled': True, 'language': 'python',
                'sourceType': 'notebook'}, 'bridge_source_sha256': expected}, 'nbformat': 4, 'nbformat_minor': 5}
    value = (json.dumps(notebook, ensure_ascii=False, indent=1) + '\n').encode()
    if len(value) > LIMIT:
        raise ValueError(f'BRIDGE_NOTEBOOK_TOO_LARGE: {len(value)} bytes')
    target = Path(target)
    target.write_bytes(value)
    record = {'study': STUDY, 'notebook': target.name, 'notebookBytes': len(value), 'notebookSha256': digest(value),
              'sourceArchiveSha256': expected, 'archiveBytes': len(raw), 'mCommit': M_COMMIT, 'hCommit': manifest['hCommit'],
              'files': len(manifest['files']), 'execution': 'NOT_RUN'}
    target.with_suffix('.manifest.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    return record


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--h-commit', help='the notebook H (default and only value for v1: e0e8937, see --unpinned); with --vm: H3, the commit under test (default HEAD); '
                                           'with --vm-study v1: H1 (default HEAD)')
    parser.add_argument('--target', type=Path, help='default: the v1 notebook, or the VM bundle with --vm (bridge-m-h-vm-v2.zip, or the v1 one)')
    parser.add_argument('--worktree-harness', action='store_true', help='harness from the working tree: local dry runs only')
    parser.add_argument('--vm', action='store_true', help=f'pack the {VM2_STUDY} source bundle (M, H1, H3) instead of the notebook')
    parser.add_argument('--vm-study', choices=('v1', 'v2'), help=f'which VM bundle --vm packs (default v2); v1 is the {VM_STUDY} bundle (M, H0, H1), and implies --vm')
    parser.add_argument('--h1-commit', help='with --vm (v2): the H1 revision (default 2841d1b)')
    parser.add_argument('--h0-commit', help='with --vm-study v1: the anchor revision (default e0e8937)')
    parser.add_argument('--unpinned', action='store_true', help='v1 notebook from another H or a worktree harness: local experiments, still named v1')
    parser.add_argument('--verify-extracted', type=Path, metavar='DIR', help='check an extracted VM bundle (v1 or v2, by its format) against its manifest and exit')
    args = parser.parse_args(argv)
    vm_study = args.vm_study or ('v2' if args.vm else None)
    if args.verify_extracted:
        checked = verify_tree(args.verify_extracted)
        result = {'verified': True, 'format': checked['format'], 'files': len(checked['files']),
                  **{key: checked[key] for key in ('mCommit', 'h0Commit', 'h1Commit', 'h3Commit', 'h3ProductCommit') if key in checked}}
    elif vm_study == 'v2':
        if args.h0_commit:
            parser.error('--h0-commit is for --vm-study v1')
        result = build_vm2(args.target or VM2_TARGET, args.h_commit or 'HEAD', args.h1_commit or H1_COMMIT, args.worktree_harness)
    elif vm_study == 'v1':
        if args.h1_commit:
            parser.error('--h1-commit is for the v2 bundle (with --vm-study v1, --h-commit is H1)')
        result = build_vm(args.target or VM_TARGET, args.h_commit or 'HEAD', args.h0_commit or H0_COMMIT, args.worktree_harness)
    else:
        if args.h0_commit or args.h1_commit:
            parser.error('--h0-commit and --h1-commit are for the VM bundles (--vm)')
        result = build(args.target or TARGET, args.h_commit or V1_H_COMMIT, args.worktree_harness, args.unpinned)
    print(json.dumps(result, indent=2))
    return result


if __name__ == '__main__':
    main()
