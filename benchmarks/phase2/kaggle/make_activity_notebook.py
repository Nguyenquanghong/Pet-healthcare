"""Build the self-contained D1 functional notebook from current dirty source.

This generator only reads source and writes notebook/manifests locally. It does
not execute notebook cells, connect to a DB, install services or run benchmarks.
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
TARGET = REPO / 'benchmarks/phase2/clinic-activity-d1-kaggle.ipynb'
EXTRA = (
    'benchmarks/phase2/kaggle/activity_native.py',
    'benchmarks/phase2/kaggle/make_activity_notebook.py',
    'benchmarks/phase2/kaggle/test_activity_notebook.py',
    'tools/phase2/cqrs/activity/trial.mjs',
    'tools/phase2/cqrs/activity/trialGuards.mjs',
    'tools/phase2/cqrs/activity/trialGuards.test.mjs',
    'tools/phase2/cqrs/activity/trialCoverage.mjs',
    'tools/phase2/cqrs/activity/trialCoverage.test.mjs',
    'tools/phase2/cqrs/activity/trialBrowser.mjs',
)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def safe_source_path(name):
    if not isinstance(name, str):
        raise ValueError('UNSAFE_ACTIVITY_SOURCE_PATH')
    p = PurePosixPath(name)
    if ('\\' in name or ':' in name or p.is_absolute()
            or str(p) != name or '..' in p.parts or not p.parts
            or any(part in ('.git', 'node_modules', 'dist', 'generated', '.aws', '.codex') for part in p.parts)
            or p.name == '.env' or p.name.startswith('.env.') and not p.name.endswith('.example')
            or p.suffix in ('.pem', '.key', '.ipynb', '.zip')):
        raise ValueError('UNSAFE_ACTIVITY_SOURCE_PATH')
    return p


def source_bundle():
    original = REPO / 'phase2-plan/cqrs/clinic-activity/evidence/d1-development-manifest.json'
    previous = json.loads(original.read_text(encoding='utf-8'))
    names = sorted(set([row['path'] for row in previous['files']] + list(EXTRA)))
    files, payload = [], {}
    for name in names:
        safe_source_path(name)
        path = REPO / name
        if path.is_symlink() or not path.resolve().is_relative_to(REPO) or not path.is_file():
            raise ValueError('UNSAFE_ACTIVITY_SOURCE_FILE')
        value = path.read_bytes()
        if len(value) > 5_000_000:
            raise ValueError('ACTIVITY_SOURCE_FILE_TOO_LARGE')
        files.append({'path': name, 'bytes': len(value), 'sha256': digest(value)})
        payload['source/' + name] = value
    if sum(len(v) for v in payload.values()) > 25_000_000:
        raise ValueError('ACTIVITY_SOURCE_BUNDLE_TOO_LARGE')
    policy = REPO / 'phase2-plan/cqrs/clinic-activity/acceptance.frozen.json'
    manifest = {
        'format': 'clinic-activity-d1-functional-source-v1',
        'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
        'branch': subprocess.check_output(['git', 'branch', '--show-current'], cwd=REPO, text=True).strip(),
        'dirtyWorkingCopyIncluded': True, 'files': files,
        'harnessRevision': 3,
        'functionalCoverage': ['pg-parity-18', 'plain-explain-9-without-analyze',
                               'live-warm-cache-role-revocation', 'real-gateway-browser-source-and-cached'],
        'sourceTreeSha256': digest(json.dumps(files, separators=(',', ':')).encode()),
        'priorDevelopmentManifestSha256': digest(original.read_bytes()),
        'policyAtBuildSha256': digest(policy.read_bytes()),
        'performanceMeasurementsAllowed': False, 'fixtureRows': 10000,
        'seed': 20261020, 'businessDate': '2030-10-20',
    }
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
    """Pure validator shared by local tests; no extraction or source execution."""
    if digest(raw) != expected:
        raise ValueError('ACTIVITY_BUNDLE_HASH_MISMATCH')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        if len(infos) > 1200 or len({i.filename for i in infos}) != len(infos):
            raise ValueError('ACTIVITY_BUNDLE_DUPLICATE_OR_TOO_MANY')
        if sum(i.file_size for i in infos) > 26_000_000:
            raise ValueError('ACTIVITY_BUNDLE_TOO_LARGE')
        for info in infos:
            if info.filename != 'bundle-manifest.json':
                if not info.filename.startswith('source/'):
                    raise ValueError('ACTIVITY_BUNDLE_UNEXPECTED_MEMBER')
                safe_source_path(info.filename.removeprefix('source/'))
            if stat.S_ISLNK(info.external_attr >> 16) or info.is_dir():
                raise ValueError('ACTIVITY_BUNDLE_LINK_OR_DIRECTORY')
        manifest = json.loads(archive.read('bundle-manifest.json'))
        if manifest['format'] != 'clinic-activity-d1-functional-source-v1' or manifest['performanceMeasurementsAllowed'] is not False:
            raise ValueError('ACTIVITY_BUNDLE_SCOPE')
        files = manifest['files']
        if digest(json.dumps(files, separators=(',', ':')).encode()) != manifest['sourceTreeSha256']:
            raise ValueError('ACTIVITY_SOURCE_TREE_HASH')
        if set(i.filename for i in infos) != {'bundle-manifest.json', *('source/' + r['path'] for r in files)} or len({r['path'] for r in files}) != len(files):
            raise ValueError('ACTIVITY_BUNDLE_INVENTORY')
        values = {}
        for row in files:
            safe_source_path(row['path'])
            value = archive.read('source/' + row['path'])
            if len(value) != row['bytes'] or digest(value) != row['sha256']:
                raise ValueError('ACTIVITY_SOURCE_HASH')
            values[row['path']] = value
        return manifest, values


def build(target=TARGET):
    raw, source = source_bundle()
    expected = digest(raw)
    verified_members(raw, expected)
    cells = []
    def cell(kind, text):
        item = {'cell_type': kind, 'id': 'activity-d1-' + str(len(cells)), 'metadata': {}, 'source': text.strip().splitlines(keepends=True)}
        if kind == 'code':
            item.update(execution_count=None, outputs=[])
        cells.append(item)
    cell('markdown', '''# Clinic activity D1 — functional trial tự chứa

Import notebook này vào **Kaggle CPU / Internet On**, rồi **Run All**. Không cần upload repo, commit/push hoặc chạy notebook Q6 cũ. Source D1 dirty overlay đã nhúng và hash; mỗi lượt tạo trial riêng.

Notebook v3 kiểm/cài prerequisite thiếu, dùng Node24.16/PostgreSQL16/Nginx/Chromium, tạo DB/roles/schema mới có guard, áp migration hiện có, seed10.000 lịch giả. Kiểm18 PG parity/timezone cases,9 plain EXPLAIN không ANALYZE, HTTP qua Nginx→Core→Clinic với DB thật, revoke admin trong cache còn hạn và browser đăng nhập/filter/drilldown/role/logout qua frontend cùng Nginx. Không giả lập API hoặc tiêm session/token vào browser.

**Không benchmark hoặc summary V2.** Core/Clinic composition chức năng dùng DB thật nhưng không chạy background broker/Redis/worker; không là full deployment hoặc D0 environment PASS. Chưa chứng minh quota riêng stack/generator. Secrets/DB/logs/browser cache ở `/tmp`, ZIP kết quả chỉ chứa allowlist báo cáo và stage receipts. Run lỗi vẫn xuất báo cáo FAIL; không tự retry/reset hay dùng DB có sẵn. Source/harness mới cần trial mới; giữ nguyên v2 và ZIP đã chạy làm evidence lịch sử.''')
    cell('code', '''RUN_TRIAL = True
RUN_BENCHMARK = False
assert RUN_TRIAL is True and RUN_BENCHMARK is False, 'Notebook này chỉ hỗ trợ functional D1.'
import base64, hashlib, importlib.util, io, json, os, platform, stat, uuid
from pathlib import Path, PurePosixPath
from zipfile import ZipFile
assert platform.system() == 'Linux' and Path('/kaggle/working').is_dir(), 'Chạy trong notebook Kaggle định dùng.'
assert os.geteuid() == 0, 'Setup native cần quyền root trong kernel trial.'
''' + '\nSOURCE_SHA256 = ' + repr(expected) + '\nSOURCE_BASE64 = ' + repr(base64.b64encode(raw).decode()) + '''
raw = base64.b64decode(SOURCE_BASE64, validate=True)
assert hashlib.sha256(raw).hexdigest() == SOURCE_SHA256, 'Source archive hash mismatch'
# Bootstrap only the validator from the globally hash-verified archive; no cell
# or dependency from a previous notebook is imported.
with ZipFile(io.BytesIO(raw)) as z:
    validator = z.read('source/benchmarks/phase2/kaggle/make_activity_notebook.py')
namespace = {'__name__': 'activity_bundle_validator', '__file__': '/tmp/activity-validator/benchmarks/phase2/kaggle/make_activity_notebook.py'}
exec(compile(validator, '<verified-activity-validator>', 'exec'), namespace)
source_manifest, values = namespace['verified_members'](raw, SOURCE_SHA256)
RUN = str(uuid.uuid4())
PRIVATE = Path('/tmp') / ('clinic-activity-d1-' + RUN)
OUTPUT = Path('/kaggle/working') / ('clinic-activity-d1-' + RUN)
PRIVATE.mkdir(mode=0o700); OUTPUT.mkdir(mode=0o700)
with (PRIVATE/'source.zip').open('xb') as handle:
    handle.write(raw)
ROOT = PRIVATE / 'source'; ROOT.mkdir(mode=0o700)
for name, value in values.items():
    destination = ROOT.joinpath(*PurePosixPath(name).parts)
    assert destination.resolve().is_relative_to(ROOT.resolve())
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open('xb') as handle:
        handle.write(value)
spec = importlib.util.spec_from_file_location('activity_native', ROOT/'benchmarks/phase2/kaggle/activity_native.py')
runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
print({'run': RUN, 'source_verified': True, 'source_archive_sha256': SOURCE_SHA256, 'benchmark': False})
''')
    cell('markdown', '## Chạy functional trial\nMỗi stage báo tiến độ. Dừng khi lỗi; private logs giữ trong `/tmp`, không copy log/context/token vào chat. Cleanup chỉ dừng process của trial mới; không xóa dữ liệu hoặc stop dịch vụ cũ.')
    cell('code', '''summary = runner.run_trial(ROOT, PRIVATE, OUTPUT, RUN, SOURCE_SHA256)
print(json.dumps(summary, indent=2))
from IPython.display import display, FileLink
display(FileLink(summary['download']))
''')
    cell('markdown', '## Gửi ZIP kết quả\nTải file `.zip` ở link trên rồi gửi để kiểm evidence. PASS_IN_FUNCTIONAL_SCOPE chỉ cho các ca đã chạy; performance vẫn NOT_RUN và D0 vẫn PARTIAL. Không gửi file context/credentials/DB/log riêng. Nếu FAIL, giữ ZIP lỗi để chẩn đoán trước khi chạy trial mới.')
    notebook = {'cells': cells, 'metadata': {'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
                'language_info': {'name': 'python'}, 'kaggle': {'accelerator': 'none', 'isInternetEnabled': True, 'language': 'python', 'sourceType': 'notebook'},
                'clinic_activity_source_sha256': expected, 'performance_measurements_allowed': False}, 'nbformat': 4, 'nbformat_minor': 5}
    target = Path(target).resolve()
    if not target.is_relative_to(REPO):
        raise ValueError('ACTIVITY_NOTEBOOK_TARGET_OUTSIDE_WORKSPACE')
    if target.exists():
        raise ValueError('ACTIVITY_NOTEBOOK_ALREADY_EXISTS_CHOOSE_NEW_TARGET')
    value = (json.dumps(notebook, ensure_ascii=False, indent=2) + '\n').encode()
    target.write_bytes(value)
    record = {'format': 'clinic-activity-d1-notebook-artifact-v1', 'notebook': target.relative_to(REPO).as_posix(),
              'notebookSha256': digest(value), 'sourceArchiveSha256': expected, 'sourceManifest': source,
              'notebookExecution': 'NOT_RUN', 'performance': 'NOT_RUN', 'd0': 'PARTIAL_ENVIRONMENT'}
    manifest = target.with_suffix('.manifest.json')
    manifest.write_text(json.dumps(record, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    target.with_suffix('.sha256').write_text(digest(value)+'  '+target.name+'\n', encoding='utf-8')
    return record


if __name__ == '__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target',type=Path,default=TARGET)
    record = build(parser.parse_args().target)
    print(json.dumps({k:v for k,v in record.items() if k != 'sourceManifest'}, indent=2))
