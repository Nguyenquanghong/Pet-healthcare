"""Export partial evidence too, without private fixtures, DB dumps or secret log values."""
import json
from pathlib import Path
import re
import uuid
import zipfile


def export_evidence(folder, output_dir):
    folder, output_dir = Path(folder), Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / f'{folder.name}-{uuid.uuid4().hex[:8]}.zip'
    with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED) as zipped:
        files = sorted(folder.rglob('*')) if folder.exists() else []
        for path in files:
            if not path.is_file() or path.is_symlink() or path.suffix not in {'.json', '.jsonl', '.csv', '.log', '.png'}:
                continue
            if path.name in {'fixture.json', 'snapshot.json'} or path.name.startswith('.env'):
                continue
            content = path.read_bytes()
            if path.suffix == '.log':
                text = content.decode('utf-8', errors='replace')
                text = re.sub(r'postgres(?:ql)?://\S+', '[REDACTED_DATABASE_URL]', text)
                text = re.sub(r'(?i)Bearer\s+\S+', 'Bearer [REDACTED]', text)
                text = re.sub(r'(?i)(JWT_SECRET|BENCH_PASSWORD)\s*[=:]\s*\S+', r'\1=[REDACTED]', text)
                content = text.encode('utf-8')
            zipped.writestr(f'{folder.name}/{path.relative_to(folder).as_posix()}', content)
        if not (folder / 'pcn-report.json').is_file():
            zipped.writestr(f'{folder.name}/export-status.json', json.dumps({
                'overall': 'PARTIAL_OR_FAILED', 'note': 'The runner did not produce a final PCN report; inspect runner.log.'}))
    return archive
