"""Copy manifest-listed result files byte-for-byte into an evidence received/ dir.

Usage: python -I benchmarks/phase2/kaggle/list_copy_received.py <source result dir> <evidence dir>
Reads only from the source. Refuses to overwrite an existing received/ dir.
Files outside the manifest (user-downloaded notebook logs) go to notebook-log/.
"""
import hashlib, json, shutil, sys
from pathlib import Path

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
received = dst / 'received'
if received.exists():
    sys.exit(f'REFUSE: {received} exists')
manifest = json.loads((src / 'result-manifest.json').read_bytes())
listed = {f['path']: f for f in manifest['files']}

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

rows, extras = [], []
for path in sorted(p.relative_to(src).as_posix() for p in src.rglob('*') if p.is_file()):
    if path == 'result-manifest.json' or path in listed:
        target = received / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src / path, target)
        digest = sha(target)
        if digest != sha(src / path):
            sys.exit(f'COPY_MISMATCH {path}')
        if path in listed and (digest != listed[path]['sha256'] or target.stat().st_size != listed[path]['bytes']):
            sys.exit(f'MANIFEST_MISMATCH {path}')
        rows.append(f'{digest} *./{path}')
    else:
        extras.append(path)
missing = sorted(set(listed) - {r.split(' *./', 1)[1] for r in rows})
if missing:
    sys.exit(f'MISSING {missing}')
(dst / 'SHA256SUMS.received').write_text('\n'.join(rows) + '\n', encoding='utf-8', newline='\n')
logs = []
for path in extras:
    target = dst / 'notebook-log' / path
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src / path, target)
    logs.append({'path': path, 'bytes': target.stat().st_size, 'sha256': sha(target)})
print(json.dumps({'copied': len(rows), 'manifestEntries': len(listed), 'outsideManifest': logs}))
