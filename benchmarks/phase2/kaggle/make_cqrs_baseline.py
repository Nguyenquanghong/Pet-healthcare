"""Generate the separate Q0 notebook; leave the historical PCN notebook intact."""
import hashlib
import json
from pathlib import Path
from make_pcn_notebook import build as build_pcn, HERE, REPO

BASELINE = '3e88d7e57fbf4f74da363d320f286244237a4389'
TARGET = HERE.parent / 'cqrs-q0-pcn-baseline.ipynb'


def build(target=TARGET):
    target = build_pcn(base_commit=BASELINE, target=target,
                       extra_files=['benchmarks/phase2/kaggle/cqrs_baseline.py'])
    notebook = json.loads(target.read_text(encoding='utf-8'))
    policy_text = (REPO / 'phase2-plan/cqrs/acceptance.json').read_bytes()
    policy = json.loads(policy_text)
    for cell in notebook['cells']:
        source = ''.join(cell['source'])
        if cell['cell_type'] == 'markdown':
            source = source.replace('**commit 5881154**, cùng mốc ZIP tải sâu đã phân tích; chưa gồm\nbản sửa Admin local mới hơn.',
                f'**commit {BASELINE}**, bản tối ưu request trước CQRS (O).\nLocal diff Q1 không thuộc ứng dụng được đo.')
            source = source.replace('# Pha 2 — đo tải theo bài PCN pha 1', '# CQRS Q0 — baseline O, smoke trước full')
            source = source.replace('## Chạy bài đối chứng\nMặc định FULL 100 users/30 phút, một Clinic. `MODE="smoke"` chỉ để chẩn đoán 2 users/15s, luôn thiếu điều kiện nghiệm thu; không thay thế kết quả FULL.',
                '## Chạy baseline O\nMặc định smoke 2 users/15s; chỉ khi smoke đạt mới chạy full 100 users/30 phút trên trial UUID mới. `RUN_FULL=False` chỉ chạy smoke. Không retry tự động khi lỗi.')
        elif source.startswith('MODE='):
            source = '''RUN_FULL=True
OUTPUT=Path('/kaggle/working')/('cqrs-q0-pcn-'+str(uuid.uuid4()))
OUTPUT.mkdir()
''' + 'CQRS_POLICY = ' + repr(policy) + '\nCQRS_POLICY_SHA256 = ' + repr(hashlib.sha256(policy_text).hexdigest()) + '''
(OUTPUT/'environment.json').write_text(json.dumps({'application_git_commit':commit,
    'base_source_hash':source_hash,'benchmark_overlay_hash':overlay_hash,'overlay_files':overlay_entries,
    'versions':VERSIONS,'configuration':'O','clinic_replicas':1,'run_full':RUN_FULL,
    'cqrs_policy_version':CQRS_POLICY['version'],'cqrs_policy_sha256':CQRS_POLICY_SHA256,
    'note':'Only benchmark helpers are overlaid after build; local Q1 application changes are excluded.'},indent=2))
sys.modules.pop('cqrs_baseline',None)
from cqrs_baseline import run_baseline
workflow=run_baseline(ROOT,OUTPUT/'trials',full=RUN_FULL,progress=lambda value:print(value,flush=True))
print(workflow)
RUN_DIR=OUTPUT/'trials'/('full' if (OUTPUT/'trials/full/pcn-report.json').exists() else 'smoke')
report_path=RUN_DIR/'pcn-report.json'
result=json.loads(report_path.read_text()) if report_path.exists() else {'load_status':'NOT_RUN','overall':'PARTIAL','requirements':{}}
display(pd.DataFrame([{'criterion':key,**value} for key,value in result['requirements'].items()]))
'''
        elif source.startswith('load_path='):
            source = source.replace("OUTPUT/'run/", "RUN_DIR/'")
        elif source.startswith('from zipfile import'):
            source = '''from zipfile import ZipFile, ZIP_DEFLATED
archive_out=OUTPUT.with_suffix('.zip')
allowed=['environment.json','pcn-latency.png','trials/workflow.json']
for trial in ('smoke','full'):
    allowed += ['trials/'+trial+'/'+name for name in ('manifest.json','pcn-report.json',
        'load-final.json','requests.jsonl','http.csv','http-summary.json','resources.jsonl',
        'reconciliation.json','generator.json')]
with ZipFile(archive_out,'x',ZIP_DEFLATED) as bundle:
    for name in allowed:
        path=OUTPUT/name
        if path.is_file() and not path.is_symlink(): bundle.write(path,name)
display(FileLink(str(archive_out)))
print({'download':str(archive_out),'workflow':workflow,'capacity_accepted':False})
'''
        cell['source'] = source.splitlines(keepends=True)
    target.write_text(json.dumps(notebook, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return target


if __name__ == '__main__':
    print(build())
