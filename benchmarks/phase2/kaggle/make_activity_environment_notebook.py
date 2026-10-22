"""Package the D0-only capability probe; never run it during packaging."""
from pathlib import Path
import ast
import base64
import hashlib
import json

ROOT=Path(__file__).resolve().parents[3]

def build():
    script=ROOT/'benchmarks/phase2/kaggle/activity_environment.py';raw=script.read_bytes();digest=hashlib.sha256(raw).hexdigest()
    target=ROOT/'benchmarks/phase2/clinic-activity-d0-environment-v1.ipynb'
    if any(p.exists() for p in [target,target.with_suffix('.sha256'),target.with_suffix('.manifest.json')]):
        raise ValueError('CHOOSE_NEW_ARTIFACT_NAME_DO_NOT_OVERWRITE')
    code='''import base64,hashlib,json,platform,uuid,zipfile
from pathlib import Path
from IPython.display import display,FileLink
assert platform.system()=='Linux' and Path('/kaggle/working').is_dir(), 'Run in the assigned Kaggle CPU notebook.'
'''+'PROBE_SHA256='+repr(digest)+'\nPROBE_BASE64='+repr(base64.b64encode(raw).decode())+'''
source=base64.b64decode(PROBE_BASE64,validate=True)
assert hashlib.sha256(source).hexdigest()==PROBE_SHA256
scope={'__name__':'activity_environment_probe'}
exec(compile(source,'<verified-d0-probe>','exec'),scope)
report=scope['run_probe']()
report['probeSourceSha256']=PROBE_SHA256
output=Path('/kaggle/working')/('clinic-activity-d0-env-'+report['run'])
output.mkdir(mode=0o700)
raw=(json.dumps(report,indent=2)+'\\n').encode()
with (output/'environment.json').open('xb') as f:f.write(raw)
manifest={'format':'clinic-activity-d0-probe-result-v1','probeSourceSha256':PROBE_SHA256,
          'files':[{'path':'environment.json','bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}]}
with (output/'manifest.json').open('x') as f:json.dump(manifest,f,indent=2)
archive=output.with_suffix('.zip')
with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as z:
    z.write(output/'environment.json','environment.json');z.write(output/'manifest.json','manifest.json')
print(json.dumps({k:report[k] for k in ['status','d0','resourceEnforcement','ownedHelperProcessesStopped']},indent=2))
if 'reason' in report:print('reason:',report['reason'])
print('No application startup, database connection, migration or benchmark. Send this ZIP for the environment decision.')
display(FileLink(str(archive)))
'''
    ast.parse(code)
    intro='''# Clinic activity D0 — kiểm quyền enforce môi trường

Import vào notebook Kaggle **CPU mới**, rồi **Run All**. Không cần Internet/package hoặc notebook D1/Q6. Phép kiểm này giải quyết quyền cgroup còn thiếu; không chạy lại D1.

Đọc namespace/ancestors và thử tạo subtree UUID mới. Không remount/sudo, sửa controller của parent hiện có hoặc chuyển process có sẵn. Nếu không được delegated CPU/memory thì dừng trước cài/start dịch vụ. Nếu có quyền, tạo budget đề xuất stack2CPU/8GiB, generator1CPU/2GiB; kiểm readback/PID và hai helper nhỏ: CPU0.1CPU có throttling, memory32MiB với helper64MiB bị OOM trong group riêng. Dừng đúng helper do run tạo; giữ empty cgroups, không xóa file/data.

Đây là kiểm capability bằng helper tổng hợp, **không phải full-stack enforcement proof hoặc benchmark**. D0 vẫn PARTIAL tới khi có full trial/process/roles/pools/profile được xác minh. Nếu output CGROUP_READ_ONLY hoặc CPU_MEMORY_NOT_DELEGATED_TO_CHILDREN, kernel đó chưa đáp ứng gate; không cài stack để cố đổi kết quả. ZIP chỉ có JSON metadata/cgroup/PID của helper, không env/context/token/log/DB.
'''
    cells=[{'cell_type':'markdown','id':'d0-environment-intro','metadata':{},'source':intro.splitlines(keepends=True)},
           {'cell_type':'code','id':'d0-environment-probe','metadata':{},'source':code.splitlines(keepends=True),'execution_count':None,'outputs':[]}]
    notebook={'nbformat':4,'nbformat_minor':5,'cells':cells,'metadata':{'kernelspec':{'display_name':'Python 3','language':'python','name':'python3'},
              'language_info':{'name':'python'},'kaggle':{'accelerator':'none','isInternetEnabled':False,'language':'python','sourceType':'notebook'},
              'probe_source_sha256':digest,'application_performance_measurements_allowed':False}}
    payload=(json.dumps(notebook,ensure_ascii=False,indent=2)+'\n').encode();target.write_bytes(payload)
    manifest={'format':'clinic-activity-d0-environment-notebook-v1','notebook':target.relative_to(ROOT).as_posix(),
              'notebookSha256':hashlib.sha256(payload).hexdigest(),'probeSource':script.relative_to(ROOT).as_posix(),
              'probeSourceSha256':digest,'execution':'NOT_RUN','d0':'PARTIAL_ENVIRONMENT','performance':'NOT_RUN',
              'policySha256':hashlib.sha256((ROOT/'phase2-plan/cqrs/clinic-activity/acceptance.frozen.json').read_bytes()).hexdigest()}
    target.with_suffix('.manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8',newline='\n')
    target.with_suffix('.sha256').write_text(manifest['notebookSha256']+'  '+target.name+'\n',encoding='ascii',newline='\n')
    return manifest

if __name__=='__main__':print(json.dumps(build(),indent=2))
