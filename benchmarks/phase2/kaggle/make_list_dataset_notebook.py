"""Split the built list-study notebook into a small notebook + a Kaggle Dataset file.

Kaggle refuses to commit (Save Version) a kernel whose source exceeds 1 MB; the
self-contained notebook embeds the source archive as base64. This tool takes the
already built and dry-run notebook, writes its embedded archive byte-for-byte to
a zip for upload as a private Kaggle Dataset, and writes a notebook whose only
change is how the same archive is obtained: it is read from /kaggle/input and
must match the same pinned SHA256 before anything is verified or executed. The
file uses a .bin name because Kaggle Datasets auto-extract uploaded .zip files.
Not part of the source bundle (the bundle hash stays the one validated in K1).
"""
import base64
import hashlib
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SOURCE = REPO / 'benchmarks/phase2/cqrs-list-matched-kaggle-v1.ipynb'
SOURCE_SHA = 'c6674cdc1cfd2a8bf287c77a1a0d9b662d45e69e3a199fe5ce4d75688e183cdf'
TARGET = REPO / 'benchmarks/phase2/cqrs-list-matched-kaggle-v1-dataset.ipynb'
LOADER = '''# The source archive comes from an attached private Kaggle Dataset (Add Input);
# the notebook pins its SHA256, so any other file is refused before use.
ARCHIVE_NAME = 'cqrs-list-source-{short}.bin'
candidates = sorted(Path('/kaggle/input').rglob(ARCHIVE_NAME))
assert len(candidates) == 1, 'Attach the Kaggle Dataset containing ' + ARCHIVE_NAME + ' (Add Input); found: ' + str(len(candidates))
raw = candidates[0].read_bytes()
'''


def digest(value):
    return hashlib.sha256(value).hexdigest()


def build(source=SOURCE, target=TARGET):
    data = Path(source).read_bytes()
    if digest(data) != SOURCE_SHA:
        raise ValueError('LIST_SOURCE_NOTEBOOK_HASH')
    notebook = json.loads(data)
    code = [c for c in notebook['cells'] if c['cell_type'] == 'code']
    text = ''.join(code[0]['source'])
    lines = text.split('\n')
    sha_line = next(l for l in lines if l.startswith('SOURCE_SHA256 = '))
    b64_line = next(l for l in lines if l.startswith('SOURCE_BASE64 = '))
    decode_line = 'raw = base64.b64decode(SOURCE_BASE64, validate=True)'
    if lines.count(decode_line) != 1:
        raise ValueError('LIST_NOTEBOOK_LAYOUT')
    archive = base64.b64decode(eval(b64_line.split(' = ', 1)[1]), validate=True)  # literal from our own verified notebook
    sha = eval(sha_line.split(' = ', 1)[1])
    if digest(archive) != sha:
        raise ValueError('LIST_EMBEDDED_ARCHIVE_HASH')
    zip_path = target.with_name(f'cqrs-list-source-{sha[:8]}.bin')
    new = text.replace(b64_line + '\n', '').replace(decode_line, LOADER.format(short=sha[:8]).rstrip('\n'))
    code[0]['source'] = new.splitlines(keepends=True)
    intro = notebook['cells'][0]
    intro['source'] = [s.replace('Source đã nhúng và kiểm hash', f'Source lấy từ Kaggle Dataset `cqrs-list-source-{sha[:8]}.bin` (Add Input), kiểm SHA256 cố định') for s in intro['source']]
    notebook['metadata']['cqrs_list_source_delivery'] = 'kaggle-dataset'
    for path in (target, zip_path):
        if path.exists():
            raise ValueError('LIST_DATASET_TARGET_EXISTS:' + path.name)
    value = (json.dumps(notebook, ensure_ascii=False, indent=2) + '\n').encode()
    if len(value) >= 1_000_000:
        raise ValueError('LIST_DATASET_NOTEBOOK_TOO_LARGE')
    zip_path.write_bytes(archive)
    target.write_bytes(value)
    record = {'format': 'cqrs-list-dataset-notebook-v1', 'fromNotebook': {'path': source.relative_to(REPO).as_posix(), 'sha256': SOURCE_SHA},
              'notebook': target.relative_to(REPO).as_posix(), 'notebookSha256': digest(value), 'notebookBytes': len(value),
              'datasetFile': zip_path.relative_to(REPO).as_posix(), 'sourceArchiveSha256': sha, 'sourceArchiveBytes': len(archive),
              'change': 'only the archive delivery (embedded base64 -> /kaggle/input file with the same pinned SHA256)'}
    target.with_suffix('.manifest.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    target.with_suffix('.sha256').write_text(digest(value) + '  ' + target.name + '\n' + sha + '  ' + zip_path.name + '\n', encoding='utf-8')
    return record


if __name__ == '__main__':
    print(json.dumps(build(), indent=2))
