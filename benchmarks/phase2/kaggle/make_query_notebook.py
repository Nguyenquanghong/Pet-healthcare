"""Build a self-contained uploadable Q0 HTTP query-heavy notebook."""
import hashlib
import json
from pathlib import Path
from make_pcn_notebook import build as build_base, HERE, REPO

BASELINE = '3e88d7e57fbf4f74da363d320f286244237a4389'
TARGET = HERE.parent / 'cqrs-q0-query-heavy.ipynb'


def build(target=TARGET):
    target = build_base(base_commit=BASELINE, target=target, extra_files=[
        'benchmarks/phase2/kaggle/query_dataset.mjs', 'benchmarks/phase2/kaggle/query_heavy.py'])
    notebook = json.loads(target.read_text(encoding='utf-8'))
    assert len(notebook['cells']) == 12
    def replace(index, source):
        notebook['cells'][index]['source'] = source.strip().splitlines(keepends=True)
        notebook['cells'][index]['id'] = f'cqrs-query-{index:02d}'
    replace(5, ''.join(notebook['cells'][5]['source']).replace("('pcn_runner','pcn_adapter'", "('query_heavy','pcn_runner','pcn_adapter'"))
    replace(0, '''# CQRS Q0 — query-heavy qua HTTP, baseline O

**Upload notebook → CPU / Internet On → Run All.** Không cần commit/push, Docker hoặc upload source.
Notebook clone ứng dụng tại SHA `3e88d7e57fbf4f74da363d320f286244237a4389` (O trước CQRS),
build nguyên source rồi mới chép helper benchmark được nhúng kèm. Local Q1/projection không được đo.

Mỗi trial tạo PostgreSQL riêng dưới `/tmp` với đúng 3 DB, marker UUID/role được kiểm trước migrate/fixture.
100 owners, 100 pets, **100.000 appointment**, 5.900 reservation và 100 bệnh án; nhiều ngày/status/type.
Chạy API Core/Clinic/Notification, JWT/Core authorization/directory thật; limiter và PBKDF2 giữ nguyên.
Login nằm ngoài cửa sổ đo. Không có request ghi nghiệp vụ trong workload đo.

Smoke dùng cùng fixture và rate: 5s warmup + 70s đo, đi qua cửa sổ limiter 60s. Smoke đạt mới chạy **3 trial UUID độc lập**;
mỗi trial **120s warmup + 800s đo**, **12 arrivals/s**, tối đa 16 request đang chạy, 1 Clinic/pool 4.
8 nhóm: owner list, admin list, search, unbilled, owner/admin calendar, filter, page sâu.
Dự kiến **1.200 mẫu/nhóm/lượt**, tổng thời gian khoảng **50–60 phút sau cài đặt**.

**Protocol v2:** lượt v1 ở 24 arrivals/s đã gặp960 HTTP429 trong warmup vì một Admin nhận1.080 reads/phút,
vượt limiter gốc600 reads/phút. V2 chọn12 arrivals/s: Admin nhận540 reads/phút, kéo dài cửa sổ đo để đủ mẫu.
Giữ kết quả v1 FAIL; không nâng quota hoặc thêm Admin để tránh limiter. V2 chưa có kết quả Kaggle.
Không tự giảm rate, retry hoặc bỏ mẫu lỗi. Smoke/warmup/measurement có lỗi/drop/contract sai thì dừng,
giữ raw data. Các ngưỡng NFR hiện có (read p95≤750ms, p99≤1500ms, ≥1.000 success/operation)
được báo riêng; gate không-lỗi ở đây chặt hơn NFR. Generator p95 lag phải ≤50ms.

Kết quả chỉ là baseline O. **Không nghiệm thu capacity, không so O/A/B, không kết luận CQRS nhanh hơn.**
CPU/RAM chung với generator; chưa áp quota tương đương pha 1. Có CPU/RSS, sampled DB locks/I/O/disk;
chưa có pure Prisma pool-wait. Không thay bài PCN 100 users/30 phút đã đo trước đó.
''')
    replace(6, '## Chạy smoke rồi ba lượt\nGiữ `RUN_FULL=True` để đủ protocol. `False` chỉ kiểm smoke, không nghiệm thu baseline đầy đủ. Mỗi lượt dùng trial mới; lỗi được giữ và dừng, không chạy lại tự động.')
    policy_bytes = (REPO / 'phase2-plan/cqrs/acceptance.json').read_bytes()
    replace(7, '''RUN_FULL=True
OUTPUT=Path('/kaggle/working')/('cqrs-q0-query-heavy-'+str(uuid.uuid4()))
OUTPUT.mkdir()
''' + 'CQRS_POLICY = ' + repr(json.loads(policy_bytes)) + '\nCQRS_POLICY_SHA256 = ' + repr(hashlib.sha256(policy_bytes).hexdigest()) + '''
from query_heavy import run_workflow, CONFIG, PROTOCOL, OPERATIONS
assert CQRS_POLICY['benchmark']['queryHeavy']['appointments']==100000
assert CONFIG['warmup']>=CQRS_POLICY['benchmark']['queryHeavy']['warmupSecondsMin']
assert CONFIG['seconds']>=CQRS_POLICY['benchmark']['queryHeavy']['steadySecondsMin']
assert CONFIG['rate']*CONFIG['seconds']//len(OPERATIONS)>=CQRS_POLICY['benchmark']['queryHeavy']['samplesPerOperationPerRunMin']
assert CONFIG['runs']==3
(OUTPUT/'environment.json').write_text(json.dumps({'application_git_commit':commit,
    'base_source_hash':source_hash,'benchmark_overlay_hash':overlay_hash,'overlay_files':overlay_entries,
    'versions':VERSIONS,'configuration':'O','clinic_replicas':1,'run_full':RUN_FULL,
    'protocol':PROTOCOL,'settings':CONFIG,'cqrs_policy':CQRS_POLICY,'cqrs_policy_sha256':CQRS_POLICY_SHA256,
    'note':'Original application built before helper overlay. No local Q1 code. Shared resources; no capacity claim.'},indent=2))
workflow=run_workflow(ROOT,OUTPUT/'trials',full=RUN_FULL,progress=lambda value:print(value,flush=True))
print(workflow)
''')
    replace(8, '## Kết quả từng lượt\nĐọc cả workflow, report và raw requests. FAIL/STOPPED không đổi thành PASS chỉ vì có p95 thấp; lỗi trả nhanh vẫn là lỗi. CPU là các khoảng sampling đã quan sát, có coverage_seconds; RSS cộng có thể đếm trùng trang nhớ.')
    replace(9, '''rows=[]
for trial in ('smoke','run-1','run-2','run-3'):
    path=OUTPUT/'trials'/trial/'report.json'
    if not path.exists(): continue
    report=json.loads(path.read_text())
    print({'trial':trial,'status':report['status'],'failed_stage':report.get('failed_stage'),
           'reconciliation':report.get('reconciliation',{}).get('status')})
    rows += [{'trial':trial,**item} for item in report.get('measured',{}).get('summary',[])]
    if report.get('cpu_observed'): display(pd.DataFrame(report['cpu_observed']))
frame=pd.DataFrame(rows)
if not frame.empty:
    display(frame)
    import matplotlib.pyplot as plt
    chart=frame.pivot(index='operation',columns='trial',values='p95_success_ms')
    ax=chart.plot.barh(figsize=(12,6))
    ax.axvline(750,color='red',linestyle='--',label='NFR read p95')
    ax.set(xlabel='HTTP p95 success (ms)',ylabel='')
    ax.figure.tight_layout(); ax.figure.savefig(OUTPUT/'query-latency.png',dpi=140); plt.show()
else:
    print('Chưa có measured samples; xem failed_stage. Không suy PASS.')
''')
    replace(10, '## Tải ZIP kết quả\nZIP giữ cả FAIL và raw requests/CPU/DB samples, policy/source/helper hashes. Chỉ export allowlist; không đưa password, JWT, context, fixture, private log hoặc DB vào ZIP. Gửi ZIP này để đối soát đủ ba lượt.')
    replace(11, '''from zipfile import ZipFile, ZIP_DEFLATED
archive_out=OUTPUT.with_suffix('.zip')
allowed=['environment.json','query-latency.png','trials/workflow.json']
for trial in ('smoke','run-1','run-2','run-3'):
    allowed += ['trials/'+trial+'/'+name for name in ('report.json','requests.jsonl','resources.jsonl','database.jsonl')]
with ZipFile(archive_out,'x',ZIP_DEFLATED) as bundle:
    for name in allowed:
        path=OUTPUT/name
        if path.is_file() and not path.is_symlink(): bundle.write(path,name)
display(FileLink(str(archive_out)))
print({'download':str(archive_out),'workflow':workflow['status'],'capacity_accepted':False})
''')
    target.write_text(json.dumps(notebook, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return Path(target)


if __name__ == '__main__':
    print(build())
