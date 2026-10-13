"""Build the committed notebook without requiring nbformat/Jupyter at generation time."""
import json
from pathlib import Path

cells = []


def md(text):
    cells.append({'cell_type': 'markdown', 'metadata': {}, 'source': text.strip().splitlines(keepends=True)})


def code(text):
    cells.append({'cell_type': 'code', 'metadata': {}, 'execution_count': None, 'outputs': [], 'source': text.strip().splitlines(keepends=True)})


md('''# Pet-healthcare — kiểm thử tải pha 2

Notebook chạy trên máy local có repo, Node, Python 3.10+, Docker Desktop và dependencies đã cài.
Không cần cài thư viện Python để chạy tải hoặc xuất CSV/JSON. Biểu đồ dùng matplotlib nếu đã có.

**Mục đích:** đo p50/p95/p99, RPS nghiệp vụ thành công, tỷ lệ 429/503/lỗi,
CPU tích lũy/RSS/event-loop/outbox qua metrics của ba API. Có workload đọc,
ghi lịch khám/Spa và kiểm chính sách login. Mỗi lần tạo fixture UUID riêng;
không dùng tài khoản admin hoặc DB `nipopeto` đang hoạt động.

**Giới hạn:** mô hình closed-loop, VU được gán lần lượt vào các owner theo `ACCOUNTS`,
vẫn chung IP; đây là screening ba service. Limiter vẫn bật và 429 được báo riêng.
Chưa là benchmark B0/B1/B2/B3, chưa đo hoàn thành billing, notification end-to-end
hay CPU của DB/worker. Test proxy là Node; một Clinic replica. Không gọi kết quả này là capacity production.
''')
md('''## Chuẩn bị một lần

Tại root repo, chạy các lệnh sau trong terminal:

```powershell
npm run phase2:up
npm run phase2:build
npm run build --workspace frontend
```

Stack hạ tầng thử dùng PostgreSQL `55432`, RabbitMQ `5679`, Redis `6389`.
Fixture kiểm Compose project, DB/role/marker trước khi migrate hoặc tạo dữ liệu.
Cổng `5189` phải trống. Không chạy song song với `phase2:verify`, E2E hoặc notebook khác.
Không chạy seed/reset/prune/down -v. Giữ lại dữ liệu thử và volumes sau chạy.
''')
code('''from pathlib import Path
import sys, json, datetime, platform, subprocess

ROOT = next((p for p in [Path.cwd(), *Path.cwd().parents]
             if (p / 'benchmarks/phase2/load_runner.py').exists()), None)
assert ROOT is not None, 'Mở notebook bên trong repo Pet-healthcare'
sys.path.insert(0, str(ROOT / 'benchmarks/phase2'))
from load_runner import LocalFixture, run_load, save_run
print({'python': platform.python_version(), 'os': platform.platform(), 'repo': str(ROOT)})
''')
md('''## Cấu hình

Mặc định là smoke nhỏ, chỉ đọc. Muốn thử ghi, thêm `clinic_write` hoặc `mixed`
và đặt `ALLOW_WRITES=True`; chỉ fixture do notebook khởi tạo được chấp nhận.
`login_policy` quan sát giới hạn 30 lần/15 phút cho từng account; chưa là phép đo capacity auth độc lập.

Với lượt đo dài: warmup 120 giây, steady 300 giây, 3 lần lặp. Cần xem quota,
tổng số request, kích thước fixture và tài nguyên trước khi tăng tải. Mức max_requests
là phanh bảo vệ; chạm phanh trước đủ thời gian chỉ được ghi SCREENING.
''')
code('''MODE = 'smoke'  # 'smoke' hoặc 'measured_scope'
ACCOUNTS = 8  # 1 giữ fixture cũ; 2–40 tạo các chủ nuôi và dữ liệu tổng hợp riêng
PROFILES = ['read']  # read, clinic_write, mixed (80% đọc/20% tạo lịch), login_policy
CONCURRENCY = [2] if MODE == 'smoke' else [1, 5, 10]
WARMUP_SECONDS = 2 if MODE == 'smoke' else 120
STEADY_SECONDS = 10 if MODE == 'smoke' else 300
REPEATS = 1 if MODE == 'smoke' else 3
MAX_REQUESTS = 200 if MODE == 'smoke' else 10000
THINK_SECONDS = 0.1
ALLOW_WRITES = False

assert MODE in ('smoke', 'measured_scope')
assert ALLOW_WRITES or not set(PROFILES) & {'clinic_write', 'mixed'}
print({'mode': MODE, 'profiles': PROFILES, 'vus': CONCURRENCY,
       'warmup_s': WARMUP_SECONDS, 'steady_s': STEADY_SECONDS,
       'repeats': REPEATS, 'request_cap_per_run': MAX_REQUESTS})
''')
md('''## Chạy fixture và tải

Cell này dựng ba API thật cùng worker trên DB thử. `ACCOUNTS=8` tạo 168 pet,
960 lịch sử appointment, 240 bệnh án, 240 hotel booking và 240 invoice tổng hợp;
`ACCOUNTS=1` giữ fixture nhỏ cũ với 21 pet. Không có dữ liệu thanh toán thật,
đăng nhập lấy token trong bộ nhớ rồi đo. Các danh sách bệnh án/hotel/invoice ban đầu
có thể trống; báo cáo giữ giới hạn dataset này, không tự nhận là dữ liệu sản xuất.
Warmup không tính vào steady latency, nhưng vẫn tiêu thụ quota thật của limiter.
Các profile trong cùng fixture tiếp tục dùng quota account/IP đã tiêu thụ; không
so throughput giữa profile như các phép đo độc lập. 429/503 tôn trọng Retry-After,
kể cả dạng HTTP-date, và không kéo dài thời gian chờ quá hạn đo.
Đối soát ghi từ chối ID phản hồi trùng; ID trong response lỗi không tính là ghi thành công.

Context manager gửi lệnh dừng có kiểm soát trong `finally`, kể cả khi interrupt cell.
Không in token/password hoặc body response. Không chia sẻ các file fixture/log thô
trong `test-results`; chỉ xuất summary/requests/metrics đã loại credentials.
''')
code('''reports = []
with LocalFixture(accounts=ACCOUNTS) as fixture:
    print({'fixture_ready': True, 'topology': fixture.manifest['topology']})
    for profile in PROFILES:
        for vus in CONCURRENCY:
            for repeat in range(1, REPEATS + 1):
                warmup = run_load(fixture, profile=profile, users=vus, seconds=WARMUP_SECONDS,
                                  max_requests=MAX_REQUESTS, think_seconds=THINK_SECONDS,
                                  allow_writes=ALLOW_WRITES)
                actual_warmup = min(WARMUP_SECONDS, warmup['elapsed_seconds'])
                if warmup['request_cap_reached']:
                    actual_warmup = 0  # không đủ bằng chứng đã warmup theo lịch
                result = run_load(fixture, profile=profile, users=vus, seconds=STEADY_SECONDS,
                                  max_requests=MAX_REQUESTS, think_seconds=THINK_SECONDS,
                                  allow_writes=ALLOW_WRITES, seed=20261013 + repeat)
                directory, report = save_run(fixture, result, warmup_seconds=actual_warmup,
                                             repeat=repeat, repeats=REPEATS)
                reports.append({'directory': str(directory), **report})
                print({'profile': profile, 'vus': vus, 'repeat': repeat,
                       'requests': report['completed_requests'],
                       'classification': report['classification'], 'artifacts': str(directory)})
print('Đã dừng các API/worker thuộc fixture; giữ hạ tầng Docker và dữ liệu thử.')
''')
md('''## Số đo và mục tiêu tham chiếu

Latency đo từ phía client, gồm kết nối TCP. Báo cả p95 tất cả lượt và p95 thành công
để không đánh tráo lỗi trả nhanh thành dịch vụ nhanh. `successful_rps` chỉ đếm HTTP
và cấu trúc dữ liệu phù hợp contract; 429 không phải thành công. 503/timeout vẫn là lỗi.

Mục tiêu từ thiết kế: đọc p95 ≤750 ms, ghi Clinic ≤1.500 ms, auth ≤2.000 ms,
lỗi ngoài dự kiến <1%. Không sửa yêu cầu theo kết quả. Ít mẫu, screening, request cap,
dataset rỗng hoặc cùng account bị rate limit không đủ để kết luận hệ thống đạt tải mục tiêu.
''')
code('''for report in reports:
    print(f"\\n{report['profile']} / VU={report['users']} / {report['classification']}")
    for row in report['summary']:
        print({k: round(v, 3) if isinstance(v, float) else v for k, v in row.items()})
    print('capacity_accepted =', report['capacity_accepted'])
''')
md('''## Biểu đồ tùy chọn và telemetry

`metrics.json` lấy mẫu khoảng hai giây/lượt, có HTTP status cho từng lần scrape.
CPU là CPU-seconds tích lũy: lấy chênh lệch chia thời gian để tính số lõi đã dùng;
RSS là bytes. Metric scrape cũng gây một lượng tải nhỏ và phải giữ giống nhau khi so sánh.
Không suy ra CPU toàn máy hoặc DB pool usage từ CPU/RSS của API.
''')
code('''try:
    import matplotlib.pyplot as plt
except ImportError:
    print('Chưa có matplotlib; dùng requests.csv và metrics.json, không tự cài thêm.')
else:
    labels, p95 = [], []
    for report in reports:
        for row in report['summary']:
            if row['p95_ms_success'] is not None:
                labels.append(f"{report['users']}VU/{row['operation']}")
                p95.append(row['p95_ms_success'])
    if labels:
        fig, ax = plt.subplots(figsize=(10, max(3, len(labels) * .35)))
        ax.barh(labels, p95)
        ax.set_xlabel('p95 successful request (ms)')
        ax.set_title('Measured scope only — xem tỷ lệ thành công/429 cùng biểu đồ')
        fig.tight_layout()
        plt.show()

if reports:
    metrics = json.loads((Path(reports[-1]['directory']) / 'metrics.json').read_text())
    print('Số mẫu metrics:', len(metrics))
    print('Scrape lỗi:', sum(x['http_status'] != 200 for x in metrics))
''')
md('''## Đánh giá cuối và bước đo đầy đủ

Không có cờ PASS tổng thể tự động. Xem độ bao phủ từng workload, số mẫu,
request cap, quota và lỗi trước khi kết luận. `MEASURED_SCOPE_ONLY` mới chỉ đạt
thời lượng cấu hình của một lượt; phải kiểm đủ các lần lặp đã hoàn thành.

P8 đầy đủ còn cần: account/dataset phù hợp từng VU; arrival-rate R/2R/4R;
B0/B1/B2 cùng ngân sách và B3 công khai tăng tài nguyên; ít nhất hai Clinic replica
qua Nginx; hành trình invoice 202→terminal; notification lag/recovery sau outage;
CPU/RAM/container/DB và đối soát invariant sau tải. Không bật những thứ này bằng
cách tắt bảo mật, sửa limiter của ứng dụng hoặc trỏ notebook vào DB đang dùng.

Dừng riêng hạ tầng thử sau khi không còn suite/notebook sử dụng:
`docker compose -f deploy/phase2/compose.test.yml stop`.
''')
notebook = {'cells': cells, 'metadata': {'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
                                      'language_info': {'name': 'python', 'version': '3.10'}},
            'nbformat': 4, 'nbformat_minor': 5}
for index, cell in enumerate(cells):
    cell['id'] = f'phase2-load-{index:02}'
path = Path(__file__).with_name('phase2-load.ipynb')
path.write_text(json.dumps(notebook, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'Created {path.name}: {len(cells)} cells, outputs cleared')
