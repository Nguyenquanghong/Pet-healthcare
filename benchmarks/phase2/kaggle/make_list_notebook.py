"""Build the self-contained cqrs-list-matched-kaggle-v1 notebook (not executed).

Embeds, verified by hash: the pinned Q6 v9 source bundle (O + AB sources, Q6
harness, unchanged), the list overlay/controller/evaluator, the shared bench
collector/profile tools and the frozen list policy. Reads files locally only.
"""
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import stat
import subprocess
import zipfile

REPO = Path(__file__).resolve().parents[3]
FORMAT = 'cqrs-list-matched-kaggle-v1-source-1'
BUNDLE = 'test-results/phase2/cqrs/q6-cold-parts-20261019/cqrs-q6-source-v9.zip'
BUNDLE_SHA = '2b3d7c9c3e94980386dec3e5900198f9e6e6fd7c35d80cac9146709b47bb9037'
Q6_HARNESS = ('benchmarks/phase2/dataset.mjs', 'benchmarks/phase2/kaggle/native_stack.py', 'benchmarks/phase2/kaggle/stack.mjs',
              'benchmarks/phase2/kaggle/benchmark.py', 'benchmarks/phase2/kaggle/acceptance.json', 'benchmarks/phase2/kaggle/query_heavy.py',
              'benchmarks/phase2/kaggle/query_dataset.mjs', 'benchmarks/phase2/kaggle/pcn_runner.py', 'benchmarks/phase2/kaggle/pcn_adapter.py',
              'benchmarks/phase2/kaggle/pcn_dataset.mjs', 'benchmarks/phase2/kaggle/pcn_locust.py', 'benchmarks/phase2/kaggle/cqrs_source.py',
              'benchmarks/phase2/kaggle/cqrs_runtime.mjs', 'benchmarks/phase2/kaggle/cqrs_probe.py', 'benchmarks/phase2/kaggle/cqrs_benchmark.py',
              'benchmarks/phase2/kaggle/cqrs_diagnostics.py', 'benchmarks/phase2/kaggle/cqrs_query_plans.mjs', 'benchmarks/kaggle/pcn_locustfile.py',
              'benchmarks/kaggle/pcn_contract.py', 'benchmarks/kaggle/metrics.py')
STUDY_FILES = ('benchmarks/phase2/kaggle/list_study.py', 'benchmarks/phase2/kaggle/list_evaluate.py', 'benchmarks/phase2/kaggle/list_trial.py',
               'benchmarks/phase2/kaggle/list_pcn_locust.py', 'benchmarks/phase2/kaggle/make_list_policy.py',
               'benchmarks/phase2/kaggle/make_list_notebook.py', 'benchmarks/phase2/kaggle/test_list_study.py',
               'benchmarks/phase2/kaggle/activity_d5_native.py', 'benchmarks/phase2/kaggle/activity_native.py',
               'tools/phase2/cqrs/activity/bench/collector.mjs', 'tools/phase2/cqrs/activity/bench/collector-cli.mjs',
               'tools/phase2/cqrs/activity/bench/profile.mjs',
               'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v1.policy.json', 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v1.sha256',
               'phase2-plan/cqrs/clinic-activity/evidence/benchmark-plan-20261021.json',
               'phase2-plan/cqrs/clinic-activity/evidence/benchmark-plan-20261021.sha256')
NAMES = tuple(sorted({*Q6_HARNESS, *STUDY_FILES, BUNDLE}))


def digest(value):
    return hashlib.sha256(value).hexdigest()


def safe_path(name):
    p = PurePosixPath(name)
    if (not isinstance(name, str) or '\\' in name or ':' in name or p.is_absolute() or str(p) != name or '..' in p.parts
            or any(part in ('.git', 'node_modules', 'dist', 'generated') for part in p.parts) or p.name.startswith('.env')
            or p.suffix in ('.pem', '.key', '.ipynb') or (p.suffix == '.zip' and name != BUNDLE)):
        raise ValueError('UNSAFE_LIST_SOURCE_PATH')
    return p


def source_bundle():
    files, payload = [], {}
    for name in NAMES:
        safe_path(name)
        path = REPO / name
        if path.is_symlink() or not path.resolve().is_relative_to(REPO) or not path.is_file():
            raise ValueError('UNSAFE_LIST_SOURCE_FILE:' + name)
        value = path.read_bytes()
        files.append({'path': name, 'bytes': len(value), 'sha256': digest(value)})
        payload['source/' + name] = value
    if digest(payload['source/' + BUNDLE]) != BUNDLE_SHA:
        raise ValueError('LIST_Q6_BUNDLE_HASH')
    manifest = {'format': FORMAT, 'files': files, 'sourceTreeSha256': digest(json.dumps(files, separators=(',', ':')).encode()),
                'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
                'dirtyWorkingCopyIncluded': True, 'q6BundleSha256': BUNDLE_SHA,
                'policySha256': digest((REPO / STUDY_FILES[12]).read_bytes())}
    payload['bundle-manifest.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, value in sorted(payload.items()):
            info = zipfile.ZipInfo(name, (2026, 10, 21, 0, 0, 0))
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, value)
    return buffer.getvalue(), manifest


def verified_members(raw, expected):
    """Pure validator shared by tests and the notebook; no extraction or execution."""
    if digest(raw) != expected:
        raise ValueError('LIST_BUNDLE_HASH_MISMATCH')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        if len(infos) > 200 or len({i.filename for i in infos}) != len(infos) or sum(i.file_size for i in infos) > 30_000_000:
            raise ValueError('LIST_BUNDLE_SHAPE')
        for info in infos:
            if info.filename != 'bundle-manifest.json':
                if not info.filename.startswith('source/'):
                    raise ValueError('LIST_BUNDLE_UNEXPECTED_MEMBER')
                safe_path(info.filename.removeprefix('source/'))
            if stat.S_ISLNK(info.external_attr >> 16) or info.is_dir():
                raise ValueError('LIST_BUNDLE_LINK_OR_DIRECTORY')
        manifest = json.loads(archive.read('bundle-manifest.json'))
        files = manifest['files']
        if manifest['format'] != FORMAT or digest(json.dumps(files, separators=(',', ':')).encode()) != manifest['sourceTreeSha256']:
            raise ValueError('LIST_SOURCE_TREE_HASH')
        if {i.filename for i in infos} != {'bundle-manifest.json', *('source/' + r['path'] for r in files)}:
            raise ValueError('LIST_BUNDLE_INVENTORY')
        values = {}
        for row in files:
            safe_path(row['path'])
            value = archive.read('source/' + row['path'])
            if len(value) != row['bytes'] or digest(value) != row['sha256']:
                raise ValueError('LIST_SOURCE_HASH')
            values[row['path']] = value
        if digest(values[BUNDLE]) != BUNDLE_SHA:
            raise ValueError('LIST_Q6_BUNDLE_HASH')
        return manifest, values


def build(target):
    raw, manifest = source_bundle()
    expected = digest(raw)
    verified_members(raw, expected)
    cells = []

    def cell(kind, text):
        item = {'cell_type': kind, 'id': 'cqrs-list-' + str(len(cells)), 'metadata': {}, 'source': text.strip().splitlines(keepends=True)}
        if kind == 'code':
            item.update(execution_count=None, outputs=[])
        cells.append(item)
    cell('markdown', '''# CQRS danh sách O/A/B — nghiên cứu matched `cqrs-list-matched-kaggle-v1`

Kaggle **CPU / Internet On**. Source đã nhúng và kiểm hash: snapshot O (`3e88d7e`, trước CQRS) và AB (CQRS V1) lấy nguyên từ bundle Q6 v9, cùng harness Q6 không sửa và overlay đo mới (collector theo vai trò, generator validity, block O,A,B / B,O,A / A,B,O). Policy đóng băng trước đo: `phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v1.policy.json`.

**Chọn chế độ ở cell dưới:**
- `MODE='smoke'` (mặc định, khoảng 1–1,5 giờ): readiness. Gồm calibration 120s và một block O,A,B ngắn cho mỗi workload. Không phải phép đo.
- `MODE='full'`: readiness smoke của workload đó, **rồi** các block đã chọn. Đề xuất chia phiên:
  - phiên 1: `WORKLOADS=['query-heavy']`, `BLOCKS=[0,1,2]` (khoảng 4–5 giờ);
  - phiên 2: `WORKLOADS=['pcn']`, `BLOCKS=[0,1,2]` (khoảng 6–7 giờ).

  Chạy full bằng **Save Version → Save & Run All (Commit)** để không bị ngắt vì idle.

Không retry, không giảm tải, không đổi quota. Raw được giữ cả khi FAIL. Kết luận chỉ có sau khi gộp đủ 3 block cùng profileKey của mỗi workload.''')
    cell('code', '''MODE = 'smoke'            # 'smoke' | 'full'
WORKLOADS = ['query-heavy', 'pcn']
BLOCKS = [0, 1, 2]        # only used when MODE == 'full'
assert MODE in ('smoke', 'full') and WORKLOADS and set(WORKLOADS) <= {'query-heavy', 'pcn'} and len(set(WORKLOADS)) == len(WORKLOADS)
assert set(BLOCKS) <= {0, 1, 2} and len(set(BLOCKS)) == len(BLOCKS)
import base64, hashlib, importlib.util, io, json, os, platform, sys, uuid
from pathlib import Path, PurePosixPath
from zipfile import ZipFile
assert platform.system() == 'Linux' and Path('/kaggle/working').is_dir(), 'Chạy trong notebook Kaggle.'
assert os.geteuid() == 0, 'Setup native cần quyền root của kernel.'
''' + '\nSOURCE_SHA256 = ' + repr(expected) + '\nSOURCE_BASE64 = ' + repr(base64.b64encode(raw).decode()) + '''
raw = base64.b64decode(SOURCE_BASE64, validate=True)
assert hashlib.sha256(raw).hexdigest() == SOURCE_SHA256, 'Source archive hash mismatch'
with ZipFile(io.BytesIO(raw)) as z:
    validator = z.read('source/benchmarks/phase2/kaggle/make_list_notebook.py')
namespace = {'__name__': 'list_bundle_validator', '__file__': '/tmp/list-validator/benchmarks/phase2/kaggle/make_list_notebook.py'}
exec(compile(validator, '<verified-list-validator>', 'exec'), namespace)
source_manifest, values = namespace['verified_members'](raw, SOURCE_SHA256)
RUN = str(uuid.uuid4())
PRIVATE = Path('/tmp') / ('cqrs-list-' + RUN); OUTPUT = Path('/kaggle/working') / ('cqrs-list-' + RUN)
PRIVATE.mkdir(mode=0o700); OUTPUT.mkdir(mode=0o700)
ROOT = PRIVATE / 'source'; ROOT.mkdir(mode=0o700)
for name, value in values.items():
    destination = ROOT.joinpath(*PurePosixPath(name).parts)
    assert destination.resolve().is_relative_to(ROOT.resolve())
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open('xb') as handle:
        handle.write(value)
sys.path.insert(0, str(ROOT / 'benchmarks/phase2/kaggle'))
spec = importlib.util.spec_from_file_location('list_study', ROOT / 'benchmarks/phase2/kaggle/list_study.py')
study = importlib.util.module_from_spec(spec); spec.loader.exec_module(study)
print({'run': RUN, 'source_verified': True, 'source_archive_sha256': SOURCE_SHA256, 'mode': MODE, 'workloads': WORKLOADS})
''')
    cell('markdown', '## Chạy\nIn tiến độ mỗi 30s. Khi lỗi vẫn export ZIP ghi rõ stage lỗi. Log, context và token chỉ nằm trong `/tmp`, không đưa ra ngoài.')
    cell('code', '''summary = study.run_study(ROOT, PRIVATE, OUTPUT, RUN, mode=MODE, workloads=WORKLOADS, blocks=BLOCKS if MODE == 'full' else None)
print(json.dumps({k: v for k, v in summary.items() if k != 'download'}, indent=2))
from IPython.display import display, FileLink
display(FileLink(summary['download']))
''')
    cell('markdown', '## Gửi kết quả\nTải file `.zip` ở trên, hoặc lấy ở tab Output của bản commit, rồi gửi lại để review. Mỗi phiên chỉ là một phần; chỉ gộp các block khi chúng cùng profileKey.')
    notebook = {'cells': cells, 'metadata': {'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
                'language_info': {'name': 'python'}, 'kaggle': {'accelerator': 'none', 'isInternetEnabled': True, 'language': 'python', 'sourceType': 'notebook'},
                'cqrs_list_source_sha256': expected}, 'nbformat': 4, 'nbformat_minor': 5}
    target = Path(target).resolve()
    if not target.is_relative_to(REPO):
        raise ValueError('LIST_NOTEBOOK_TARGET_OUTSIDE_WORKSPACE')
    if target.exists():
        raise ValueError('LIST_NOTEBOOK_ALREADY_EXISTS_CHOOSE_NEW_TARGET')
    value = (json.dumps(notebook, ensure_ascii=False, indent=2) + '\n').encode()
    target.write_bytes(value)
    record = {'format': 'cqrs-list-notebook-artifact-v1', 'notebook': target.relative_to(REPO).as_posix(), 'notebookSha256': digest(value),
              'sourceArchiveSha256': expected, 'sourceManifest': manifest, 'notebookExecution': 'NOT_RUN', 'performance': 'NOT_RUN'}
    target.with_suffix('.manifest.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    target.with_suffix('.sha256').write_text(digest(value) + '  ' + target.name + '\n', encoding='utf-8')
    return record


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, default=REPO / 'benchmarks/phase2/cqrs-list-matched-kaggle-v1.ipynb')
    record = build(parser.parse_args().target)
    print(json.dumps({k: v for k, v in record.items() if k != 'sourceManifest'}, indent=2))
