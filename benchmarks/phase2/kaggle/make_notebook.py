"""Generate the uploadable Kaggle notebook; committed output contains no results."""
import json
from pathlib import Path

cells=[]
def md(value): cells.append({'cell_type':'markdown','metadata':{},'source':value.strip().splitlines(keepends=True)})
def code(value): cells.append({'cell_type':'code','metadata':{},'execution_count':None,'outputs':[],'source':value.strip().splitlines(keepends=True)})

md('''# Pet-healthcare — kiểm thử tải sâu pha 2 trên Kaggle

Import notebook, chọn **CPU / Internet: On**, rồi **Run All**. Các giá trị Git và
quy trình Smoke→Deep đã đặt sẵn, không cần tạo Dataset hoặc sửa cell cấu hình.
Notebook dựng Core,
Clinic, Notification, PostgreSQL (3 DB/role), RabbitMQ, Redis và Nginx trong phiên
Linux hiện tại. Không cần Docker, URL public hoặc mật khẩu hệ thống của bạn.

**Mặc định:** tự clone repo public từ nhánh `phase2/service-split-checkpoint-20261012`.
Commit thật và hash source được ghi trong report. Các trường cấu hình chỉ cần
thay khi muốn chạy một mốc khác. Repo private có thể dùng Secret `PET_GITHUB_TOKEN`.

Tùy chọn `SOURCE_MODE='archive'` vẫn hỗ trợ archive/receipt private khi cần kiểm
một snapshot local chưa đưa lên Git. Không upload `.env`, DB hoặc node_modules.

**Phạm vi:** open-loop đọc/ghi/mixed/login-policy, 1 hoặc 2 Clinic qua Nginx,
đối soát DB, thông báo khi khỏe và sau consumer outage 60s, billing tới terminal,
CPU/RSS, lỗi/429/503 và độ trễ bộ phát tải. NFR dùng policy version cố định.
Chưa là B0–B3 có CPU/RAM quota bằng nhau; Kaggle chia sẻ tài nguyên với generator.
`COMPLETE` chỉ có nghĩa chạy xong; đọc kết quả từng tiêu chí.

Nguồn môi trường: [Kaggle Notebooks](https://www.kaggle.com/docs/notebooks).
Mặc định `MODE='auto'`: Smoke với 1/2 Clinic; nếu đạt thì tự chạy 18 lượt đo sâu
(khoảng 2,1 giờ warmup/steady, cộng setup), rồi kiểm thông báo/hóa đơn và limiter.
Smoke lỗi thì ngừng tăng tải và xuất báo cáo lỗi. Không tự retry để đổi FAIL thành PASS.
''')
code('''from pathlib import Path
import os, sys, json, hashlib, tarfile, subprocess, platform, uuid, shutil, urllib.request, re
from urllib.parse import urlsplit

assert platform.system() == 'Linux' and Path('/kaggle/working').is_dir(), 'Chạy trong Kaggle CPU notebook'
SOURCE_MODE = 'git'
REPO_URL = 'https://github.com/Nguyenquanghong/Pet-healthcare.git'
GIT_REF = 'phase2/service-split-checkpoint-20261012'  # hoặc SHA commit đã push
EXPECTED_COMMIT = None  # có thể đặt full SHA để từ chối nhánh sai mốc
PRIVATE_REPO = False  # True: dùng Kaggle Secret PET_GITHUB_TOKEN
RECEIPT_PATH = None  # chỉ cần cho SOURCE_MODE='archive' nếu có nhiều input
assert SOURCE_MODE in ('git','archive')
# Source/dependencies cũng ở /tmp để Kaggle output chỉ chứa báo cáo được chọn.
ROOT = Path('/tmp') / ('pet-phase2-source-' + str(uuid.uuid4()))
if SOURCE_MODE == 'git':
    address=urlsplit(REPO_URL)
    assert address.scheme=='https' and address.hostname=='github.com' and not address.username and not address.password
    assert re.fullmatch(r'/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:[.]git)?',address.path) and not address.query and not address.fragment
    assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,180}',GIT_REF) and '..' not in GIT_REF
    CLONE_PRIVATE=Path('/tmp')/('pet-phase2-git-'+str(uuid.uuid4())); CLONE_PRIVATE.mkdir(mode=0o700)
    clone_env=dict(os.environ,GIT_TERMINAL_PROMPT='0')
    if PRIVATE_REPO:
        from kaggle_secrets import UserSecretsClient
        clone_env['PET_GITHUB_TOKEN']=UserSecretsClient().get_secret('PET_GITHUB_TOKEN')
        askpass=CLONE_PRIVATE/'askpass.py'
        askpass.write_text('#!/usr/bin/env python3\\nimport os,sys\\nprint("x-access-token" if "Username" in sys.argv[1] else os.environ["PET_GITHUB_TOKEN"])\\n')
        askpass.chmod(0o700); clone_env['GIT_ASKPASS']=str(askpass)
    try:
        with (CLONE_PRIVATE/'clone.log').open('w') as log:
            for args in (['git','clone','--depth','1','--no-checkout',REPO_URL,str(ROOT)],
                         ['git','-C',str(ROOT),'fetch','--depth','1','origin',GIT_REF],
                         ['git','-C',str(ROOT),'checkout','--detach','FETCH_HEAD']):
                result=subprocess.run(args,env=clone_env,stdout=log,stderr=subprocess.STDOUT)
                assert result.returncode==0, 'Git clone/fetch lỗi: kiểm URL/ref, Internet hoặc quyền Secret; log riêng trong /tmp'
    finally:
        clone_env.pop('PET_GITHUB_TOKEN',None)
        if PRIVATE_REPO: askpass.unlink(missing_ok=True)
    ROOT.chmod(0o700)
    commit=subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip()
    assert EXPECTED_COMMIT is None or commit==EXPECTED_COMMIT, 'Commit không khớp mốc yêu cầu'
    tracked=subprocess.check_output(['git','-C',str(ROOT),'ls-files','-z']).decode().split(chr(0))
    entries=[]
    for name in filter(None,tracked):
        file=ROOT/name
        assert not file.is_symlink() and file.resolve().is_relative_to(ROOT.resolve())
        content=file.read_bytes()
        entries.append({'path':name,'sha256':hashlib.sha256(content).hexdigest(),'bytes':len(content)})
    source_hash=hashlib.sha256(json.dumps(entries,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    receipt={'sourceHash':source_hash,'archiveHash':None,'files':len(entries),'gitHead':commit}
    INPUT_MODE='git-checkout'
else:
    matches = list(Path('/kaggle/input').rglob('receipt.json'))
    if RECEIPT_PATH is None:
        assert len(matches) == 1, 'Cần đúng một receipt.json hoặc tự đặt RECEIPT_PATH'
        RECEIPT_PATH = matches[0]
    receipt_path = Path(RECEIPT_PATH)
    receipt = json.loads(receipt_path.read_text())
    archive = receipt_path.parent / 'pet-healthcare-phase2-source.tgz'
    ROOT.mkdir(mode=0o700)
if SOURCE_MODE == 'archive' and archive.exists():
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == receipt['archiveHash'], 'Archive hash không khớp'
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        assert sum(m.size for m in members) < 100_000_000, 'Source bundle quá lớn'
        for member in members:
            path = Path(member.name)
            assert not path.is_absolute() and '..' not in path.parts and chr(92) not in member.name
            assert member.isfile() or member.isdir(), 'Không nhận symlink/hardlink/device'
            assert (ROOT / path).resolve().is_relative_to(ROOT)
        # Members were checked above: regular files/directories only, confined to ROOT.
        bundle.extractall(ROOT, members=members)
    INPUT_MODE='archive-hash-verified'
elif SOURCE_MODE == 'archive':
    # Hỗ trợ input đã được giải nén: copy đúng manifest, kiểm source hash ở cell kế.
    manifests=list(receipt_path.parent.rglob('phase2-handoff-manifest.json'))
    assert len(manifests)==1, 'Cần archive hoặc đúng một manifest source đã giải nén'
    source=manifests[0].parent
    manifest=json.loads(manifests[0].read_text())
    for entry in manifest['files']:
        path=Path(entry['path'])
        assert not path.is_absolute() and '..' not in path.parts and chr(92) not in entry['path']
        original=source/path
        assert original.resolve().is_relative_to(source.resolve()) and not original.is_symlink()
        content=original.read_bytes()
        assert len(content)==entry['bytes'] and hashlib.sha256(content).hexdigest()==entry['sha256']
        target=ROOT/path; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(content)
    shutil.copyfile(manifests[0],ROOT/'phase2-handoff-manifest.json')
    INPUT_MODE='extracted-source-manifest-only'
assert (ROOT / 'benchmarks/phase2/kaggle/workflow.py').is_file(), 'Ref/source còn thiếu workflow Kaggle; chọn đúng nhánh có notebook mới.'
print({'source_hash': receipt['sourceHash'], 'git_commit':receipt.get('gitHead'),'files':receipt['files'], 'machine':platform.machine(),'input_mode':INPUT_MODE})
''')
md('''## Cài native dependencies một lần trong phiên

Cell cần Internet và quyền root của phiên notebook để cài PostgreSQL, RabbitMQ,
Redis, Nginx; không tạo Docker image. Phiên bản apt thực tế được ghi lại. Node
24.16.0 tải từ nodejs.org và đối chiếu SHASUMS256. `npm ci` dùng lockfile.
Log setup riêng ở `/tmp`; output công khai không chứa credential/runtime log.
''')
code('''assert os.geteuid() == 0, 'Cell cài apt cần quyền root của phiên Kaggle'
SETUP = Path('/tmp') / ('pet-phase2-setup-' + str(uuid.uuid4()))
SETUP.mkdir(mode=0o700)
def setup_command(args, **kwargs):
    with (SETUP / 'setup.log').open('a') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, **kwargs)
    assert result.returncode == 0, 'Setup thất bại; xem setup.log riêng trong /tmp, không công bố log trước khi kiểm secret'

# Chặn auto-start service mặc định của apt; chỉ restore file do cell này tạo.
policy = Path('/usr/sbin/policy-rc.d')
created_policy = not policy.exists()
if created_policy:
    policy.write_text('#!/bin/sh\\nexit 101\\n'); policy.chmod(0o755)
try:
    setup_command(['apt-get', 'update', '-qq'])
    setup_command(['apt-get', 'install', '-y', '-qq', '--no-install-recommends',
                   'postgresql', 'postgresql-client', 'libpq-dev', 'rabbitmq-server',
                   'redis-server', 'nginx', 'ca-certificates', 'xz-utils'])
finally:
    if created_policy and policy.read_text() == '#!/bin/sh\\nexit 101\\n': policy.unlink()

assert platform.machine() in ('x86_64','aarch64'), 'Kiến trúc Node chưa hỗ trợ'
arch = 'x64' if platform.machine() == 'x86_64' else 'arm64'
name = f'node-v24.16.0-linux-{arch}.tar.xz'
origin = 'https://nodejs.org/dist/v24.16.0/'
sums = urllib.request.urlopen(origin+'SHASUMS256.txt', timeout=30).read().decode()
expected = next(line.split()[0] for line in sums.splitlines() if line.split()[-1] == name)
node_archive = SETUP / name
urllib.request.urlretrieve(origin+name, node_archive)
assert hashlib.sha256(node_archive.read_bytes()).hexdigest() == expected
setup_command(['tar','-xJf',str(node_archive),'-C',str(SETUP)])  # official archive verified above
os.environ['PATH'] = str(SETUP / name.removesuffix('.tar.xz') / 'bin') + ':' + os.environ['PATH']
if SOURCE_MODE == 'archive':
    setup_command(['node','tools/phase2/check-handoff.mjs','.',receipt['sourceHash']], cwd=ROOT)
else:
    setup_command(['git','diff','--exit-code','HEAD','--'],cwd=ROOT)
setup_command(['npm','ci'], cwd=ROOT)
setup_command(['npm','run','phase2:build'], cwd=ROOT)
setup_command([sys.executable,'-m','pip','install','-q','psutil==7.0.0'])
sys.path.insert(0, str(ROOT / 'benchmarks/phase2/kaggle'))
for module in ('workflow','benchmark','native_stack'):
    sys.modules.pop(module,None)  # Run All lại phải dùng đúng source vừa clone
from benchmark import run_case, matrix_report, POLICY
from workflow import plan, execute
from IPython.display import display
import pandas as pd

VERSIONS = {}
for program, args in {'node':['--version'], 'psql':['--version'], 'redis-server':['--version'], 'nginx':['-v']}.items():
    VERSIONS[program] = subprocess.check_output([program,*args], stderr=subprocess.STDOUT, text=True).strip()
VERSIONS['packages'] = subprocess.check_output(['dpkg-query','-W','postgresql','rabbitmq-server','redis-server','nginx'], text=True).splitlines()
print({'versions':VERSIONS,'policy':POLICY['version'],'node_archive_sha256':expected})
''')
md('''## Thiết kế lượt đo

- Auto: Smoke mixed/8 owner với 1 và 2 Clinic, 2s warmup/5s steady.
- Nếu Smoke đạt: 40 owner, read20 RPS/mixed30 RPS/clinic-write10 RPS,
  1/2 Clinic, 120s warmup/300s steady, 3 lượt thực cho mỗi cấu hình.
- Mỗi case dùng cluster và fixture mới; warmup vẫn tiêu thụ quota của case đó.
- 18 lượt đo sâu cần **2,1 giờ warmup/steady**, chưa setup; quy trình còn fault
  và login-policy riêng. `MODE='smoke'` chỉ chạy Smoke; `MODE='stress'` bổ sung
  mixed20/40/80 RPS, 10s warmup/60s steady — các lượt tăng tải này là SCREENING.
- `login_policy` đo nhiều tài khoản chung IP với limiter giữ nguyên; 429/backoff
  vẫn nằm trong mẫu số. Không dùng profile này để suy năng lực băm thuần.
- Tăng R sau smoke; đủ 1.000 success mỗi operation **mỗi lượt** mới đánh latency
  PASS_IN_SCOPE. Operation ít mẫu báo INSUFFICIENT_SAMPLES, không tự gộp để PASS.
''')
code('''MODE = 'auto'  # mặc định: Run All, không cần sửa; có thể chọn 'smoke'/'stress'
cases=plan(MODE)
print({'cases':len(cases),'minimum_minutes':sum(c['warmup']+c['seconds'] for c in cases)/60,
       'scheduled_http_arrivals':sum(c['rate']*(c['warmup']+c['seconds']) for c in cases),
       'policy':POLICY,'note':'Fault probe thêm 60s outage + tối đa120s recovery; setup chưa tính vào thời gian.'})
''')
md('''## Thực thi — kết quả được ghi sau từng case

Một process lỗi, đối soát sai hoặc bộ phát tải không theo kịp đều được ghi nhận.
Không tự retry case lỗi, hạ ngưỡng, reset Redis giữa warmup/steady hoặc đổi key
của giao dịch chưa rõ kết quả. Native process/data riêng được dừng, giữ trong
`/tmp` đến khi phiên Kaggle kết thúc. Chỉ giữ aggregate/CSV không body/token.
''')
code('''OUTPUT = Path('/kaggle/working') / ('phase2-results-' + str(uuid.uuid4()))
OUTPUT.mkdir()
(OUTPUT / 'environment.json').write_text(json.dumps({'source_hash':receipt['sourceHash'],'git_commit':receipt.get('gitHead'),'input_mode':INPUT_MODE,
    'archive_hash':receipt['archiveHash'],'versions':VERSIONS,'policy':POLICY,'mode':MODE},indent=2))
reports,workflow=execute(ROOT,OUTPUT,mode=MODE,progress=lambda text:print(text,flush=True))
assessment=workflow['matrix']
(OUTPUT/'matrix.json').write_text(json.dumps(assessment,indent=2))
display(pd.DataFrame(assessment))
print({k:v for k,v in workflow.items() if k!='matrix'})
for report in reports:
    if report.get('stage')=='faults':
        print({k:v for k,v in report.items() if k in ('billing_terminal','notification_healthy','notification_recovery')})
''')
md('''## Đồ thị và diễn giải

Xem latency thành công **cùng** tỷ lệ hoàn thành trên toàn bộ arrival dự kiến,
429/503/backoff/drop. p95 thấp nhưng phần lớn bị chặn không đạt NFR07.
CPU 100% tương đương một core; RSS cộng tiến trình có thể đếm trùng shared pages.
Latency là loopback trong phiên Kaggle, không gồm mạng Internet của người dùng.
''')
code('''import matplotlib.pyplot as plt
points=[]
for report in reports:
    for row in report['summary']:
        points.append({**row,'profile':report['profile'],'rps':report['offered_rps'],
                       'replicas':report['clinic_replicas'],'repeat':report['repeat']})
frame=pd.DataFrame(points)
if not frame.empty:
    fig,axes=plt.subplots(1,2,figsize=(14,4))
    for (op,replicas),group in frame.groupby(['operation','replicas']):
        axes[0].scatter(group['rps'],group['p95_success_ms'],label=f'{op} / {replicas} Clinic')
        axes[1].scatter(group['rps'],group['success_ratio_of_scheduled'],label=f'{op} / {replicas} Clinic')
    axes[0].set(xlabel='Offered RPS (profile)',ylabel='p95 success (ms)')
    axes[1].set(xlabel='Offered RPS (profile)',ylabel='Success / scheduled',ylim=(0,1.02))
    axes[1].axhline(.99,color='red',linestyle='--',label='NFR >=99%')
    axes[0].legend(fontsize=7); fig.tight_layout(); fig.savefig(OUTPUT/'latency-completion.png',dpi=160)
    plt.show()
    display(frame[['profile','operation','rps','replicas','repeat','success','http_429','http_503','not_sent','threshold_result']])
''')
md('''## Xuất báo cáo

ZIP chỉ lấy JSON/CSV/PNG trong thư mục results đã chọn; source, log, DB, credential
và dump ở `/tmp` không được đưa vào. Trước Save Version, kiểm output của bạn không
có cell tự in fixture/token. Ghi Kaggle session/version trong báo cáo khi có kết quả.
Để nghiệm thu đầy đủ P8 còn B0 và ngân sách B2/B3 được cưỡng chế, hotel interference,
ma trận workload hành trình 10/20/70, pool/lock metrics và người nhận độc lập.
''')
code('''from zipfile import ZipFile, ZIP_DEFLATED
archive_out=OUTPUT.with_suffix('.zip')
with ZipFile(archive_out,'x',ZIP_DEFLATED) as bundle:
    for path in sorted(OUTPUT.rglob('*')):
        if path.is_file() and path.suffix in ('.json','.csv','.png'):
            bundle.write(path,path.relative_to(OUTPUT))
print({'download':str(archive_out),'capacity_accepted':False,
       'note':'Nộp raw report và các FAIL/INSUFFICIENT_SAMPLES cùng kết luận; không chỉ ảnh chart.'})
from IPython.display import FileLink
display(FileLink(str(archive_out)))
''')
notebook={'cells':cells,'metadata':{'kernelspec':{'display_name':'Python 3','language':'python','name':'python3'},
    'language_info':{'name':'python','version':'3.11'},'kaggle':{'accelerator':'none','isInternetEnabled':True,'language':'python','sourceType':'notebook'}},'nbformat':4,'nbformat_minor':5}
for index,cell in enumerate(cells): cell['id']=f'phase2-kaggle-{index:02d}'
Path(__file__).parents[1].joinpath('phase2-kaggle.ipynb').write_text(json.dumps(notebook,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
