"""Build a single uploadable PCN load notebook, including its small tool overlay.

Application code is cloned at a pinned public commit. The transparent source
overlay contains benchmark tools only, so no push of local changes is needed.
"""
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
BASE_COMMIT = '58811549225692ec7e765031151ca5f47aed4b56'
FILES = [
    *['benchmarks/phase2/kaggle/' + name for name in (
        'native_stack.py', 'stack.mjs', 'pcn_dataset.mjs', 'pcn_adapter.py',
        'pcn_locust.py', 'pcn_runner.py', 'benchmark.py', 'acceptance.json', 'cqrs_probe.py', 'cqrs_diagnostics.py')],
    *['benchmarks/kaggle/' + name for name in ('pcn_locustfile.py', 'pcn_contract.py', 'metrics.py')],
]


def build(*, base_commit=BASE_COMMIT, target=None, extra_files=()):
    if not re.fullmatch(r'[0-9a-f]{40}', base_commit):
        raise ValueError('A full application commit is required')
    for name in extra_files:
        relative = Path(name)
        if (relative.is_absolute() or '..' in relative.parts
                or not name.startswith(('benchmarks/phase2/kaggle/', 'benchmarks/kaggle/'))
                or relative.suffix not in ('.py', '.mjs', '.json')
                or (REPO / relative).is_symlink()
                or not (REPO / relative).resolve().is_relative_to(REPO.resolve())):
            raise ValueError('Overlay must contain benchmark helper source only')
    base = json.loads((HERE.parent / 'phase2-kaggle.ipynb').read_text(encoding='utf-8'))
    code_cells = [''.join(c['source']) for c in base['cells'] if c['cell_type'] == 'code']
    clone = code_cells[0].split("else:\n    matches = list(Path('/kaggle/input')")[0]
    clone = clone.replace("GIT_REF = 'phase2/service-split-checkpoint-20261012'", f"GIT_REF = '{base_commit}'")
    clone = clone.replace('EXPECTED_COMMIT = None', f"EXPECTED_COMMIT = '{base_commit}'")
    clone = clone.replace("RECEIPT_PATH = None  # chỉ cần cho SOURCE_MODE='archive' nếu có nhiều input\n", '')
    clone = clone.replace("assert SOURCE_MODE in ('git','archive')", "assert SOURCE_MODE == 'git'")
    clone += "\nassert (ROOT/'benchmarks/phase2/kaggle/native_stack.py').is_file()\nprint({'git_commit':commit,'base_source_hash':source_hash})\n"
    setup = code_cells[1]
    start = setup.index("if SOURCE_MODE == 'archive':")
    end = setup.index('VERSIONS = {}')
    setup = setup[:start] + '''setup_command(['git','diff','--exit-code','HEAD','--'],cwd=ROOT)
setup_command(['npm','ci'],cwd=ROOT)
setup_command(['npm','run','phase2:build'],cwd=ROOT)
setup_command([sys.executable,'-m','pip','install','-q','--no-cache-dir','locust==2.44.4','psutil==7.0.0'])
''' + setup[end:]
    setup = setup.replace(", 'policy':POLICY['version']", '').replace(",'policy':POLICY['version']", '')
    cells = []
    def add(kind, value):
        cell = {'cell_type': kind, 'metadata': {}, 'source': value.strip().splitlines(keepends=True),
                'id': f'phase2-pcn-{len(cells):02d}'}
        if kind == 'code': cell.update(execution_count=None, outputs=[])
        cells.append(cell)

    add('markdown', '''# Pha 2 — đo tải theo bài PCN pha 1

**Upload notebook → CPU / Internet On → Run All.** Không cần Docker, Dataset,
token GitHub cho repo public hoặc sửa cell. Setup xong đo khoảng **31 phút**.
Mặc định một Clinic, **100 người dùng**, spawn 10/s; sau đủ người dùng warmup 30s,
đo liên tục 1.800s, mỗi người nghỉ ngẫu nhiên 0,5–1,5s. Timeout HTTP 10s, drain 12s.

Tái sử dụng nguyên task/weights/pacing và policy của `notebook_pcn.ipynb` pha 1:
GET pets:4, appointments:2, medical by pet:2, hotel:1, invoices:1,
notifications:1; POST appointment:2, rescue report:1. Một owner/một pet và
một bản ghi mỗi nhóm dữ liệu đọc, như fixture PCN pha 1.

**PCN01:** p95 từng operation ≤2.000ms và ≥95% thành công trong 2s.
**PCN02:** lỗi ≤1%, đủ 100 users trong toàn bộ 30 phút. 429/503 vẫn là lỗi;
không giảm tải, đổi quota, retry hoặc bỏ mẫu để PASS. Đây là tải người dùng chờ
phản hồi (closed-loop), không phải 100 request/s.

**Phạm vi chỉ PCN01–PCN02.** PCN03–PCN07 (bảo mật/UI/restart/backup) ghi NOT_RUN.
Không suy nghiệm thu toàn bộ hoặc công suất tối đa. Chưa có tổng quota CPU/RAM
bằng pha 1; Kaggle chia sẻ máy với generator. Có thể FAIL do chung IP/limiter.

Ứng dụng clone **commit 5881154**, cùng mốc ZIP tải sâu đã phân tích; chưa gồm
bản sửa Admin local mới hơn. Các helper đo tải được nhúng dạng source rõ ràng
ngay trong notebook, có SHA256 và manifest riêng, chỉ ghi vào bản clone `/tmp`.
Không cần commit/push các thay đổi local để chạy notebook này.

Khác biệt contract được công bố: thêm Idempotency-Key khi tạo lịch, đọc được
`items` phân trang; token RS256 chuẩn bị trước đo. URL/body/weights giữ nguyên.
Phân trang và kích thước response có thể khác pha 1; không gọi là so sánh byte
giống hệt. Muốn kết luận tăng tốc cần kết quả pha 1 cùng môi trường/ngân sách.
''')
    add('code', clone)
    add('markdown', '## Cài stack thử trong Kaggle\nNative PostgreSQL/3 DB, RabbitMQ, Redis, Nginx; Node 24.16.0, `npm ci` theo lockfile. Log và dữ liệu riêng trong `/tmp`, không xuất credentials.')
    add('code', setup)
    payload = {name: {'text': (REPO/name).read_text(encoding='utf-8')} for name in [*FILES, *extra_files]}
    for value in payload.values(): value['sha256'] = hashlib.sha256(value['text'].encode()).hexdigest()
    add('markdown', '## Công cụ đo kèm notebook\nCell này chứa source helper để notebook dùng được ngay cả khi chưa push. Hash base application và hash overlay được ghi tách biệt.')
    add('code', 'BENCHMARK_OVERLAY = ' + repr(payload) + '''
overlay_entries=[]
for name,item in BENCHMARK_OVERLAY.items():
    relative=Path(name)
    assert not relative.is_absolute() and '..' not in relative.parts
    assert name.startswith(('benchmarks/phase2/kaggle/','benchmarks/kaggle/'))
    target=ROOT/relative
    assert target.resolve().is_relative_to(ROOT.resolve()) and not target.is_symlink()
    content=item['text'].encode('utf-8')
    assert hashlib.sha256(content).hexdigest()==item['sha256']
    target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(content)
    overlay_entries.append({'path':name,'sha256':item['sha256'],'bytes':len(content)})
overlay_hash=hashlib.sha256(json.dumps(overlay_entries,sort_keys=True,separators=(',',':')).encode()).hexdigest()
sys.path.insert(0,str(ROOT/'benchmarks/phase2/kaggle'))
for name in ('pcn_runner','pcn_adapter','pcn_contract','metrics','benchmark','native_stack'):
    sys.modules.pop(name,None)
from pcn_runner import run_pcn
from IPython.display import display, FileLink
import pandas as pd
print({'overlay_hash':overlay_hash,'files':len(overlay_entries)})
''')
    add('markdown', '## Chạy bài đối chứng\nMặc định FULL 100 users/30 phút, một Clinic. `MODE="smoke"` chỉ để chẩn đoán 2 users/15s, luôn thiếu điều kiện nghiệm thu; không thay thế kết quả FULL.')
    add('code', '''MODE='full'
CLINIC_REPLICAS=1
OUTPUT=Path('/kaggle/working')/('phase2-pcn-results-'+str(uuid.uuid4()))
OUTPUT.mkdir()
(OUTPUT/'environment.json').write_text(json.dumps({'application_git_commit':commit,
    'base_source_hash':source_hash,'benchmark_overlay_hash':overlay_hash,'overlay_files':overlay_entries,
    'versions':VERSIONS,'mode':MODE,'clinic_replicas':CLINIC_REPLICAS,
    'note':'Application pinned; benchmark overlay applied after build. Local uncommitted product changes are excluded.'},indent=2))
result=run_pcn(ROOT,OUTPUT/'run',mode=MODE,replicas=CLINIC_REPLICAS,progress=lambda value:print(value,flush=True))
print({'load_status':result['load_status'],'overall':result['overall'],'capacity_accepted':False})
display(pd.DataFrame([{'criterion':key,**value} for key,value in result['requirements'].items()]))
''')
    add('markdown', '## Kết quả và biểu đồ\nBáo p95 trên mọi phản hồi như pha 1, đồng thời xét tỷ lệ thành công trong 2 giây. 429 trả nhanh không được tính là thành công. `COMPLETE` trong manifest chỉ nghĩa hoàn tất lượt chạy.')
    add('code', '''load_path=OUTPUT/'run/load-final.json'
if load_path.exists():
    load=json.loads(load_path.read_text())
    frame=pd.DataFrame(load.get('endpoints',[]))
    display(frame)
    print({'requests':load.get('requests'),'failures':load.get('failures'),
           'achieved_rps':result.get('achieved_rps'),'success_rps':result.get('success_rps')})
    http_path=OUTPUT/'run/http-summary.json'
    if http_path.exists(): print(json.loads(http_path.read_text()))
    if not frame.empty:
        import matplotlib.pyplot as plt
        fig,axes=plt.subplots(1,2,figsize=(14,5))
        axes[0].barh(frame['name'],frame['p95_ms']); axes[0].axvline(2000,color='red',linestyle='--')
        axes[0].set(xlabel='p95 tất cả phản hồi (ms)')
        axes[1].barh(frame['name'],frame['within_2s_success_ratio']); axes[1].axvline(.95,color='red',linestyle='--')
        axes[1].set(xlabel='Tỷ lệ thành công trong 2s',xlim=(0,1.02))
        fig.tight_layout(); fig.savefig(OUTPUT/'pcn-latency.png',dpi=140); plt.show()
else:
    print('Không có load-final.json: xem manifest failed_stage; giữ nguyên kết quả FAIL, không suy PASS.')
''')
    add('markdown', '## Tải ZIP\nGiữ cả FAIL/PARTIAL và raw data. ZIP chỉ gồm báo cáo đã liệt kê; không có fixture/token, source, log runtime hay database. Chưa chạy PCN03–PCN07. Không suy kết quả mới tốt hơn pha 1 chỉ từ ngưỡng PASS.')
    add('code', '''from zipfile import ZipFile, ZIP_DEFLATED
archive_out=OUTPUT.with_suffix('.zip')
allowed=['environment.json','pcn-latency.png','run/manifest.json','run/pcn-report.json',
         'run/load-final.json','run/requests.jsonl','run/http.csv','run/http-summary.json',
         'run/resources.jsonl','run/reconciliation.json','run/generator.json']
with ZipFile(archive_out,'x',ZIP_DEFLATED) as bundle:
    for name in allowed:
        path=OUTPUT/name
        if path.is_file() and not path.is_symlink(): bundle.write(path,name)
display(FileLink(str(archive_out)))
print({'download':str(archive_out),'load_status':result['load_status'],'overall':result['overall']})
''')
    notebook = {'cells': cells, 'metadata': base['metadata'], 'nbformat': 4, 'nbformat_minor': 5}
    target = Path(target) if target is not None else HERE.parent / 'phase2-pcn-kaggle.ipynb'
    target.write_text(json.dumps(notebook, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    return target


if __name__ == '__main__':
    print(build())
