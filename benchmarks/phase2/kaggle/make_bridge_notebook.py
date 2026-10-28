"""Pack M and H and write the bridge-m-h-kaggle-v1 notebook (not executed).

M is commit 48d01c3 (the monolith the 29/09 nipopeto run measured) plus one harness
file it predates (pcn_checks.mjs, the phase-1 PCN seed). H is a committed revision
of this repository (default HEAD); the working tree must not differ from it in any
packed path, so H is exactly that commit. Only build/runtime sources and the
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


def pack(h_commit='HEAD', worktree_harness=False):
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


def verified_members(raw, expected):
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
        if manifest['format'] != FORMAT or hashlib.sha256(json.dumps(files, separators=(',', ':')).encode()).hexdigest() != manifest['treeSha256']:
            raise ValueError('BRIDGE_TREE_HASH')
        if {i.filename for i in infos} != {'bundle-manifest.json', *(r['path'] for r in files)}:
            raise ValueError('BRIDGE_INVENTORY')
        values = {}
        for row in files:
            group, _, name = row['path'].partition('/')
            if group not in ('M', 'H') or not safe(name):
                raise ValueError('BRIDGE_UNSAFE_PATH')
            value = archive.read(row['path'])
            if len(value) != row['bytes'] or hashlib.sha256(value).hexdigest() != row['sha256']:
                raise ValueError('BRIDGE_FILE_HASH')
            values[row['path']] = value
        return manifest, values


def build(target=TARGET, h_commit='HEAD', worktree_harness=False):
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


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--h-commit', default='HEAD')
    parser.add_argument('--target', type=Path, default=TARGET)
    parser.add_argument('--worktree-harness', action='store_true', help='local dry runs only')
    args = parser.parse_args()
    print(json.dumps(build(args.target, args.h_commit, args.worktree_harness), indent=2))
