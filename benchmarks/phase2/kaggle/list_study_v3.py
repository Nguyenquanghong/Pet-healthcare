"""cqrs-list-matched-kaggle-v3 controller: the v2 controller with v3 identity.

Imports list_study_v2 (which reuses the unchanged v1 controller and adds the
diagnostics sampler) and rebinds study, bundle, policy and controller files to
v3. No behaviour change beyond identity. Imported only after the notebook
verified every source bundle member.
"""
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import list_study_v2 as v2  # noqa: E402

base = v2.base
base.STUDY = 'cqrs-list-matched-kaggle-v3'
base.BUNDLE = 'test-results/phase2/cqrs/list-v3/cqrs-list-source-v11.zip'
base.BUNDLE_SHA = '8c87465e9034aa1627038d2a656719a4da45d9c9877718bba03d45846df47fc9'
base.POLICY = 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v3.policy.json'
base.CONTROLLER = (*base.CONTROLLER, 'benchmarks/phase2/kaggle/list_study_v3.py', 'benchmarks/phase2/kaggle/make_list_policy_v3.py',
                   'benchmarks/phase2/kaggle/make_list_notebook_v3.py', 'benchmarks/phase2/kaggle/list_source_v3.py')
Study = v2.Study
run_study = base.run_study
