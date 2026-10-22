"""Offline review of cqrs-list-matched-kaggle-v3 results (data only, no execution).

list_review_v2.py with v3 identity: same check/combine and diagnostics summary,
against the v3 policy; sessions from other study versions are refused.
Not part of the notebook bundle.
"""
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import list_review_v2 as r2  # noqa: E402

r2.STUDY = 'cqrs-list-matched-kaggle-v3'
r2.v1.POLICY = r2.v1.REPO / 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v3.policy.json'
check, combine, diagnostics, require_v2 = r2.check, r2.combine, r2.diagnostics, r2.require_v2

if __name__ == '__main__':
    r2.main()
