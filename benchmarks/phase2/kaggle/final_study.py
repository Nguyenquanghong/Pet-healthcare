"""cqrs-final-matched-kaggle-v1 controller: the v2 list-study controller with two members.

Reuses list_study.py (v1) and list_study_v2.py (diagnostics sampler) unchanged:
this module rebinds study, bundle, policy, controller and overlay constants, grades
with final_evaluate (F/O non-regression) and accepts blocks of the policy's size
(O and F) instead of three members. Measurement, validity, CPU accounting, pools,
diagnostics and export are exactly the list study's. Imported only after the
notebook verified every source bundle member.
"""
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import list_study_v2 as v2  # noqa: E402
import final_evaluate as fe  # noqa: E402

base = v2.base
base.STUDY = 'cqrs-final-matched-kaggle-v1'
base.BUNDLE = 'test-results/phase2/cqrs/final-v1/cqrs-final-source-v13.zip'
base.BUNDLE_SHA = 'e7180abd9f5721fcf65c2761f95b00bfee3837c9feb67727dda618ebb75c1cbc'
base.POLICY = 'phase2-plan/cqrs/final/cqrs-final-matched-kaggle-v1.policy.json'
# final_trial.py runs the member (list_trial.py does the work, so it is copied too).
base.OVERLAY = ('benchmarks/phase2/kaggle/final_trial.py', 'benchmarks/phase2/kaggle/list_pcn_locust.py',
                'benchmarks/phase2/kaggle/list_trial.py')
base.CONTROLLER = (*base.CONTROLLER, 'benchmarks/phase2/kaggle/final_study.py', 'benchmarks/phase2/kaggle/final_evaluate.py',
                   'benchmarks/phase2/kaggle/make_final_policy.py', 'benchmarks/phase2/kaggle/make_final_notebook.py',
                   'benchmarks/phase2/kaggle/final_source.py')
base.ev = fe


class Study(v2.Study):
    def evaluate(self):
        size = len(self.policy['blocksForEachWorkload'][0])
        workloads = {}
        for workload, entries in self.outcomes.items():
            chosen = {}
            for e in (e for e in entries if e['mode'] == 'full'):  # first valid complete attempt of each planned block wins
                if e['index'] not in chosen and len(e['records']) == size and all(r['status'] == 'COMPLETE' for r in e['records']):
                    members = {r['configuration']: self.loaded(r) for r in e['records']}
                    if all(fe.member_metrics(m, self.policy)['validity']['valid'] for m in members.values()) or e['attempt'] == 1:
                        chosen[e['index']] = {'index': e['index'], 'profileKeySha256': e['profileKeySha256'], 'members': members}
            if chosen:
                workloads[workload] = [chosen[i] for i in sorted(chosen)]
        result = fe.evaluate(workloads, self.policy) if workloads else {'decision': 'NOT_RUN'}
        result['scope'] = 'session-partial: combine all sessions offline with final_review.py before any claim'
        base.write_json(self.reports / 'evaluation.json', result)
        return result


base.Study = Study
run_study = base.run_study
