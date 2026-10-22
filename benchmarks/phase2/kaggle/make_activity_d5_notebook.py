"""Build the self-contained D5 readiness notebook from the current dirty source.

Reads source and writes notebook/manifests locally only. It does not execute
cells, connect to a DB, install services or run benchmarks.
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
TARGET = REPO / 'benchmarks/phase2/clinic-activity-d5-kaggle.ipynb'
FORMAT = 'clinic-activity-d5-readiness-source-v1'
EXTRA = (
    'benchmarks/phase2/kaggle/activity_native.py',
    'benchmarks/phase2/kaggle/activity_d5_native.py',
    'benchmarks/phase2/kaggle/make_activity_d5_notebook.py',
    'benchmarks/phase2/kaggle/test_activity_d5.py',
    'tools/phase2/cqrs/activity/kaggleD5.mjs',
    'tools/phase2/cqrs/activity/kaggleD5Generator.mjs',
    'tools/phase2/cqrs/activity/bench/generator.mjs',
    'tools/phase2/cqrs/activity/bench/collector.mjs',
    'tools/phase2/cqrs/activity/bench/evaluator.mjs',
    'phase2-plan/cqrs/clinic-activity/acceptance.frozen.json',
)
# Imports the controller needs at runtime; the build fails closed if absent.
REQUIRED = ('tools/phase2/p7-cutover.mjs', 'tools/phase2/p7-environment.mjs', 'tools/phase2/p7-manifest.mjs',
            'tools/phase2/p7-migration.mjs', 'tools/phase2/test-project.mjs', 'tools/phase2/cqrs/activity/fixture.mjs',
            'services/notification/package.json', 'backend/package.json', 'package-lock.json')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def safe_source_path(name):
    if not isinstance(name, str):
        raise ValueError('UNSAFE_D5_SOURCE_PATH')
    p = PurePosixPath(name)
    if ('\\' in name or ':' in name or p.is_absolute() or str(p) != name or '..' in p.parts or not p.parts
            or any(part in ('.git', 'node_modules', 'dist', 'generated', '.aws', '.codex') for part in p.parts)
            or p.name == '.env' or p.name.startswith('.env.') and not p.name.endswith('.example')
            or p.suffix in ('.pem', '.key', '.ipynb', '.zip')):
        raise ValueError('UNSAFE_D5_SOURCE_PATH')
    return p


def source_bundle():
    original = REPO / 'phase2-plan/cqrs/clinic-activity/evidence/d4-development-manifest.json'
    previous = json.loads(original.read_text(encoding='utf-8'))
    names = sorted(set([row['path'] for row in previous['files']] + list(EXTRA)))
    missing = [r for r in REQUIRED if r not in names]
    if missing:
        raise ValueError('D5_REQUIRED_SOURCE_MISSING:' + ','.join(missing))
    files, payload = [], {}
    for name in names:
        safe_source_path(name)
        path = REPO / name
        if path.is_symlink() or not path.resolve().is_relative_to(REPO) or not path.is_file():
            raise ValueError('UNSAFE_D5_SOURCE_FILE:' + name)
        value = path.read_bytes()
        if len(value) > 5_000_000:
            raise ValueError('D5_SOURCE_FILE_TOO_LARGE')
        files.append({'path': name, 'bytes': len(value), 'sha256': digest(value)})
        payload['source/' + name] = value
    if sum(len(v) for v in payload.values()) > 25_000_000:
        raise ValueError('D5_SOURCE_BUNDLE_TOO_LARGE')
    policy = REPO / 'phase2-plan/cqrs/clinic-activity/acceptance.frozen.json'
    manifest = {
        'format': FORMAT,
        'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
        'branch': subprocess.check_output(['git', 'branch', '--show-current'], cwd=REPO, text=True).strip(),
        'dirtyWorkingCopyIncluded': True, 'files': files, 'harnessRevision': 1,
        'scope': ['fresh-shared-envelope-profile', 'identity-grants-p7-runtime', '100k-fixture-v2-rebuild', 'full-process-composition-nginx',
                  'pid-role-ledger-cpu-collector', 'generator-calibration-2x-noop', 'scp-smoke-through-gateway'],
        'sourceTreeSha256': digest(json.dumps(files, separators=(',', ':')).encode()),
        'priorDevelopmentManifestSha256': digest(original.read_bytes()),
        'policyAtBuildSha256': digest(policy.read_bytes()),
        'performanceMeasurementsAllowed': False, 'fixtureRows': 100000, 'seed': 20261020, 'businessDate': '2030-10-20',
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
        raise ValueError('D5_BUNDLE_HASH_MISMATCH')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        if len(infos) > 1500 or len({i.filename for i in infos}) != len(infos):
            raise ValueError('D5_BUNDLE_DUPLICATE_OR_TOO_MANY')
        if sum(i.file_size for i in infos) > 26_000_000:
            raise ValueError('D5_BUNDLE_TOO_LARGE')
        for info in infos:
            if info.filename != 'bundle-manifest.json':
                if not info.filename.startswith('source/'):
                    raise ValueError('D5_BUNDLE_UNEXPECTED_MEMBER')
                safe_source_path(info.filename.removeprefix('source/'))
            if stat.S_ISLNK(info.external_attr >> 16) or info.is_dir():
                raise ValueError('D5_BUNDLE_LINK_OR_DIRECTORY')
        manifest = json.loads(archive.read('bundle-manifest.json'))
        if manifest['format'] != FORMAT or manifest['performanceMeasurementsAllowed'] is not False:
            raise ValueError('D5_BUNDLE_SCOPE')
        files = manifest['files']
        if digest(json.dumps(files, separators=(',', ':')).encode()) != manifest['sourceTreeSha256']:
            raise ValueError('D5_SOURCE_TREE_HASH')
        if set(i.filename for i in infos) != {'bundle-manifest.json', *('source/' + r['path'] for r in files)} or len({r['path'] for r in files}) != len(files):
            raise ValueError('D5_BUNDLE_INVENTORY')
        values = {}
        for row in files:
            safe_source_path(row['path'])
            value = archive.read('source/' + row['path'])
            if len(value) != row['bytes'] or digest(value) != row['sha256']:
                raise ValueError('D5_SOURCE_HASH')
            values[row['path']] = value
        return manifest, values


def build(target=TARGET):
    raw, source = source_bundle()
    expected = digest(raw)
    verified_members(raw, expected)
    cells = []

    def cell(kind, text):
        item = {'cell_type': kind, 'id': 'activity-d5-' + str(len(cells)), 'metadata': {}, 'source': text.strip().splitlines(keepends=True)}
        if kind == 'code':
            item.update(execution_count=None, outputs=[])
        cells.append(item)
    cell('markdown', '''# Clinic activity D5 — readiness trên Kaggle shared envelope

Import vào **Kaggle CPU / Internet On**, rồi **Run All** (khoảng 40–70 phút). Source dirty đã nhúng và hash; không cần repo/commit/push, không chạy notebook cũ.

Notebook đo **profile môi trường mới** (CPU/affinity/cgroup/memory), dựng PostgreSQL16/RabbitMQ/Redis riêng, role không superuser theo component, build Linux + migrations, seed 100.000 lịch, rebuild V2, chạy đủ Core/Clinic/Notification + workers + relay + read worker V2 + Nginx; ghi ledger PID/vai trò, collector CPU, calibration generator 2× vào sink no-op và smoke S/C/P qua gateway.

**Không phải benchmark:** policy v9 chưa đóng băng (`performanceMeasurementsAllowed=false`); số thời gian là quan sát chức năng. Không claim cô lập tài nguyên. Secrets/URL/log ở `/tmp`, export chỉ allowlist.''')
    cell('code', '''RUN_TRIAL = True
RUN_BENCHMARK = False
assert RUN_TRIAL is True and RUN_BENCHMARK is False, 'Notebook này chỉ hỗ trợ readiness D5.'
import base64, hashlib, importlib.util, io, json, os, platform, uuid
from pathlib import Path, PurePosixPath
from zipfile import ZipFile
assert platform.system() == 'Linux' and Path('/kaggle/working').is_dir(), 'Chạy trong notebook Kaggle.'
assert os.geteuid() == 0, 'Setup native cần quyền root trong kernel trial.'
''' + '\nSOURCE_SHA256 = ' + repr(expected) + '\nSOURCE_BASE64 = ' + repr(base64.b64encode(raw).decode()) + '''
raw = base64.b64decode(SOURCE_BASE64, validate=True)
assert hashlib.sha256(raw).hexdigest() == SOURCE_SHA256, 'Source archive hash mismatch'
with ZipFile(io.BytesIO(raw)) as z:
    validator = z.read('source/benchmarks/phase2/kaggle/make_activity_d5_notebook.py')
namespace = {'__name__': 'activity_d5_bundle_validator', '__file__': '/tmp/activity-d5-validator/benchmarks/phase2/kaggle/make_activity_d5_notebook.py'}
exec(compile(validator, '<verified-activity-d5-validator>', 'exec'), namespace)
source_manifest, values = namespace['verified_members'](raw, SOURCE_SHA256)
RUN = str(uuid.uuid4())
PRIVATE = Path('/tmp') / ('clinic-activity-d5-' + RUN)
OUTPUT = Path('/kaggle/working') / ('clinic-activity-d5-' + RUN)
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
spec = importlib.util.spec_from_file_location('activity_d5_native', ROOT/'benchmarks/phase2/kaggle/activity_d5_native.py')
runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
print({'run': RUN, 'source_verified': True, 'source_archive_sha256': SOURCE_SHA256, 'benchmark': False})
''')
    cell('markdown', '## Chạy readiness\nMỗi stage in tiến độ. Lỗi thì dừng và vẫn export ZIP báo stage lỗi; log riêng giữ trong `/tmp`, không copy log/context/token vào chat.')
    cell('code', '''summary = runner.run_trial(ROOT, PRIVATE, OUTPUT, RUN, SOURCE_SHA256)
print(json.dumps({k: v for k, v in summary.items() if k != 'download'}, indent=2))
from IPython.display import display, FileLink
display(FileLink(summary['download']))
''')
    cell('markdown', '## Gửi ZIP kết quả\nTải file `.zip` ở link trên rồi gửi lại để review. Readiness chỉ là đầu vào cho việc đóng băng policy/profile; chưa có kết quả hiệu năng.')
    notebook = {'cells': cells, 'metadata': {'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
                'language_info': {'name': 'python'}, 'kaggle': {'accelerator': 'none', 'isInternetEnabled': True, 'language': 'python', 'sourceType': 'notebook'},
                'clinic_activity_source_sha256': expected, 'performance_measurements_allowed': False}, 'nbformat': 4, 'nbformat_minor': 5}
    target = Path(target).resolve()
    if not target.is_relative_to(REPO):
        raise ValueError('D5_NOTEBOOK_TARGET_OUTSIDE_WORKSPACE')
    if target.exists():
        raise ValueError('D5_NOTEBOOK_ALREADY_EXISTS_CHOOSE_NEW_TARGET')
    value = (json.dumps(notebook, ensure_ascii=False, indent=2) + '\n').encode()
    target.write_bytes(value)
    record = {'format': 'clinic-activity-d5-notebook-artifact-v1', 'notebook': target.relative_to(REPO).as_posix(),
              'notebookSha256': digest(value), 'sourceArchiveSha256': expected, 'sourceManifest': source,
              'notebookExecution': 'NOT_RUN', 'performance': 'NOT_RUN'}
    target.with_suffix('.manifest.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    target.with_suffix('.sha256').write_text(digest(value) + '  ' + target.name + '\n', encoding='utf-8')
    return record


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, default=TARGET)
    record = build(parser.parse_args().target)
    print(json.dumps({k: v for k, v in record.items() if k != 'sourceManifest'}, indent=2))
