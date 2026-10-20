"""Build an unexecuted Q6 notebook with a verified, self-contained source ZIP."""
import argparse
import base64
import json
from pathlib import Path

from cqrs_source import REPO, digest, read_bundle


def build(archive, sha, target):
    _, manifest, actual = read_bundle(archive, sha)
    baseline = json.loads((REPO / 'benchmarks/phase2/cqrs-q0-query-heavy.ipynb').read_text(encoding='utf-8'))
    setup = ''.join(baseline['cells'][3]['source'])
    for line in ("setup_command(['git','diff','--exit-code','HEAD','--'],cwd=ROOT)\n",
                 "setup_command(['npm','ci'],cwd=ROOT)\n",
                 "setup_command(['npm','run','phase2:build'],cwd=ROOT)\n"):
        assert line in setup
        setup = setup.replace(line, '')
    setup += "\n(OUTPUT/'setup-versions.json').write_text(json.dumps({'versions':VERSIONS,'node_archive_sha256':expected},indent=2))\n"
    cells = []
    def cell(kind, text):
        row = {'cell_type': kind, 'id': f'cqrs-q6-{len(cells):02d}', 'metadata': {},
               'source': text.strip().splitlines(keepends=True)}
        if kind == 'code': row.update(execution_count=None, outputs=[])
        cells.append(row)
    cell('markdown', '''# CQRS Q6 v9 — aggregate range indexes và smoke O/A/B

Upload notebook → Kaggle CPU / Internet On → Run All. Source nhúng sẵn,
không cần commit/push hoặc upload repo riêng. **Mặc định chỉ smoke O/A/B cho
query-heavy và PCN; chưa chạy benchmark dài.** V8 vẫn lỗi native counts
cache-miss; giữ kết quả FAIL và không coi kiểm local là native acceptance.

V9 chia aggregate rộng theo các khoảng tối đa40k appointment nguồn, lấy ranh giới
bằng khóa chính nguồn trong cùng RepeatableRead snapshot. Mỗi phần vẫn JOIN nguồn
và kiểm owner/pet; không cấp quyền từ projection hoặc trả tổng chưa hoàn tất.
List/filter/calendar dùng chung aggregate theo trạng thái/ngày/loại; cache
vẫn kiểm transactional epochs cho source ACL/projection/directory mỗi lần đọc.
Search giữ predicate đầy đủ và cũng chia khoảng; Owner/unbilled giữ scope cũ.
Range scans chạy serial trong snapshot để tránh parallel fan-out cùng freshness.
Admission trước transaction có tối đa16 waiter, vẫn một transaction active;
giữ deadline1250ms/RYW500ms, SQL200ms/maxWait50ms,
pool/rate và freshness full audit/broker probe/lag guards. Một migration thêm
hai index không unique hỗ trợ source ACL và aggregate range, chỉ apply vào
trial UUID của notebook. Không INCLUDE serviceName/notes. Chi phí cập nhật
index phải tính vào full benchmark; không triển khai DB đang dùng.

Đã kiểm local PostgreSQL, nhưng local PASS không thay native/full acceptance.
Giữ mọi FAIL; đối soát smoke mới trước khi chạy full. Không retry nguyên v8.
Diagnostics phân biệt boundary lookup/aggregate đầu/aggregate tiếp theo.
Wrapper Python đã sửa nhận collector version2 và xuất đủ mọi phần query plan.

O là Git blob tại `3e88d7e57fbf4f74da363d320f286244237a4389`. A/B dùng cùng
snapshot source CQRS chưa commit, khác selector authoritative/projection;
producer/projector bật cả A/B, shadow tắt. Mỗi lượt tạo trial UUID riêng,
đúng ba DB; không dùng DB ngoài. B phải qua HTTP preflight đúng generation.
Query-heavy còn kiểm nguồn đọc từng request; unbilled luôn authoritative.

A/B bật diagnostics, O giữ source gốc. ZIP có `read-diagnostics.jsonl` đã lọc
stage/reason/Prisma code/SQLSTATE và ID nối với raw query-heavy request.
Tối đa512 event/process rồi1 marker giới hạn; lỗi collector/thiếu log được ghi
trong report. Không xuất log riêng, token, query params hoặc thông báo lỗi thô.
`elapsedMs`/`stageMs` là thời gian chẩn đoán có overhead, không phải số đo NFR.
Sau khi B dừng tải, thu thêm `query-plans.json` cho counts/calendar bằng chính
SQL của projected reader, trong transaction READ ONLY có budget riêng.
Collector v2 ghi mọi phần aggregate trong `statements`, không coi một phần là
query hoàn chỉnh. EXPLAIN không tính chi phí tìm ranh giới hoặc cache hit.
Plan đã lọc bỏ filter/params/SQL text; chỉ giữ loại node và số liệu.
Đây là plan sau tải, không phải phép đo dưới cùng concurrency; lỗi thu plan
được ghi UNAVAILABLE/PARTIAL và không đổi kết quả smoke.

Giữ `RUN_FULL=False` để kiểm smoke trước (dự kiến15–30 phút kể cả setup).
Sau khi xem ZIP smoke, chọn `True` trong một phiên mới để đo dài: mỗi workload
smoke O/A/B → O×3 → AB,BA,AB. PCN100 users/1800s, query-heavy100k rows,
rate12/s/warmup120s/steady800s. Cả hai workload đầy đủ khoảng7–9 giờ kể cả setup;
thời gian thực tùy máy. Không retry, giảm tải, tăng quota hoặc bỏ mẫu lỗi.

**Không nghiệm thu hiệu năng/capacity từ notebook này.** Host Kaggle dùng chung,
chưa cưỡng chế ngân sách tổng bằng nhau; report giữ `INCONCLUSIVE`, default
authoritative. Có raw HTTP/errors/CPU/DB/lag/fallback để đánh giá sau; chưa có
bộ chốt gate Q6 tự động. Không tự bật projection ở môi trường đang dùng.
''')
    cell('code', """RUN_FULL = False
WORKLOADS = ['query-heavy', 'pcn']
import base64, hashlib, importlib.util, io, json, os, platform, subprocess, sys, urllib.request, uuid
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from IPython.display import display, FileLink
assert platform.system() == 'Linux' and Path('/kaggle/working').is_dir(), 'Chạy trong Kaggle CPU notebook'
assert WORKLOADS and len(set(WORKLOADS)) == len(WORKLOADS) and set(WORKLOADS) <= {'query-heavy','pcn'}
OUTPUT = Path('/kaggle/working') / ('cqrs-q6-' + str(uuid.uuid4()))
OUTPUT.mkdir()
RESULTS = []
""" + '\nSOURCE_SHA256 = ' + repr(actual) + '\nSOURCE_BASE64 = ' + repr(base64.b64encode(Path(archive).read_bytes()).decode()) + """
source_bytes = base64.b64decode(SOURCE_BASE64, validate=True)
assert hashlib.sha256(source_bytes).hexdigest() == SOURCE_SHA256
BOOT = Path('/tmp') / ('pet-cqrs-q6-bootstrap-' + str(uuid.uuid4()))
BOOT.mkdir(mode=0o700)
SOURCE_ZIP = BOOT / 'source.zip'
SOURCE_ZIP.write_bytes(source_bytes)
# Only bootstrap the verifier after the entire archive hash matches. It then
# checks every member/path/hash before extracting; never use extractall.
with ZipFile(io.BytesIO(source_bytes)) as archive:
    verifier = archive.read('harness/benchmarks/phase2/kaggle/cqrs_source.py')
verifier_path = BOOT / 'benchmarks/phase2/kaggle/cqrs_source.py'
verifier_path.parent.mkdir(parents=True)
verifier_path.write_bytes(verifier)
spec = importlib.util.spec_from_file_location('q6_bootstrap_verifier', verifier_path)
verifier_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier_module)
verifier_module.extract_bundle(SOURCE_ZIP, BOOT/'verified', SOURCE_SHA256)
sys.path.insert(0, str(BOOT/'verified/harness/benchmarks/phase2/kaggle'))
from cqrs_benchmark import run
print({'source_archive_sha256':SOURCE_SHA256,'source_verified':True,'run_full':RUN_FULL,'capacity_accepted':False})
""")
    cell('markdown', '## Cài công cụ thử\nTái sử dụng setup Node24.16.0/Locust2.44.4 và stack native của Q0. Log/DB/credentials nằm trong `/tmp`; không đưa vào ZIP kết quả.')
    cell('code', setup)
    cell('markdown', '## Chạy tuần tự\nDừng ngay khi workload lỗi; giữ kết quả lỗi. Không suy smoke thành nghiệm thu PCN hoặc Q6.')
    cell('code', """for workload in WORKLOADS:
    result = run(SOURCE_ZIP, SOURCE_SHA256, OUTPUT/workload, workload=workload, full=RUN_FULL)
    RESULTS.append({'workload':workload, **result})
    print({'workload':workload,'status':result['status'],'decision':result.get('decision','INCONCLUSIVE')})
    if result['status'] not in ('SMOKE_ONLY','MEASUREMENTS_RECORDED'):
        break
(OUTPUT/'summary.json').write_text(json.dumps({'results':RESULTS,'run_full':RUN_FULL,'capacity_accepted':False,'decision':'INCONCLUSIVE'},indent=2))
for result in RESULTS:
    for trial in result.get('trials',[]):
        print({k:trial.get(k) for k in ('workload','name','configuration','phase','status')})
""")
    cell('markdown', '## Tải ZIP kết quả\nGửi ZIP để đối soát raw/hash/các gate. Chỉ export allowlist; không chứa source, context, token, fixture, log riêng hoặc DB. Cả FAIL/STOPPED đều được giữ.')
    cell('code', """allowed = ['summary.json','setup-versions.json']
trial_names = ['smoke-O','smoke-A','smoke-B','O-1','O-2','O-3','pair-1-A','pair-1-B','pair-2-B','pair-2-A','pair-3-A','pair-3-B']
for workload in WORKLOADS:
    allowed += [workload+'/'+name for name in ('environment.json','run.json','trials/workflow.json')]
    for trial in trial_names:
        allowed += [workload+'/trials/'+trial+'/'+name for name in (
            'report.json','requests.jsonl','resources.jsonl','database.jsonl','cqrs.jsonl','read-diagnostics.jsonl','query-plans.json',
            'manifest.json','pcn-report.json','http.csv','http-summary.json',
            'load-final.json','generator.json','reconciliation.json')]
files = []
for name in allowed:
    path = OUTPUT/name
    if path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(OUTPUT.resolve()):
        files.append({'path':name,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
(OUTPUT/'result-manifest.json').write_text(json.dumps({'source_archive_sha256':SOURCE_SHA256,'files':files,'decision':'INCONCLUSIVE','capacity_accepted':False},indent=2))
archive_out = OUTPUT.with_suffix('.zip')
with ZipFile(archive_out,'x',ZIP_DEFLATED) as archive:
    for item in files:
        archive.write(OUTPUT/item['path'],item['path'])
    archive.write(OUTPUT/'result-manifest.json','result-manifest.json')
display(FileLink(str(archive_out)))
print({'download':str(archive_out),'capacity_accepted':False})
""")
    notebook = {'cells': cells, 'metadata': {'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
        'language_info': {'name': 'python'}, 'cqrs_source_archive_sha256': actual,
        'cqrs_source_manifest_sha256': manifest['sha256']}, 'nbformat': 4, 'nbformat_minor': 5}
    target = Path(target)
    with target.open('x', encoding='utf-8') as handle:
        json.dump(notebook, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    return {'notebook': str(target), 'sha256': digest(target.read_bytes()), 'source_archive_sha256': actual,
            'executed': False, 'default_full': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.bundle, args.sha256, args.output)))
