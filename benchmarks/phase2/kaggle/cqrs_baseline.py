"""Q0 baseline O: a fresh smoke trial must pass before a fresh full PCN trial."""
import json
from pathlib import Path
from pcn_runner import run_pcn


def smoke_passed(output, result):
    """Smoke is a readiness gate, never a PCN acceptance verdict."""
    try:
        read = lambda name: json.loads((Path(output) / name).read_text(encoding='utf-8'))
        manifest, load, http = read('manifest.json'), read('load-final.json'), read('http-summary.json')
        generator, reconciliation = read('generator.json'), read('reconciliation.json')
        return (manifest.get('status') == 'COMPLETE' and manifest.get('mode') == 'smoke'
                and manifest.get('process_sample_errors') == 0
                and result.get('load_status') == 'PARTIAL' and not result.get('runtime_error')
                and load.get('completed') is True and load.get('requests', 0) > 0
                and load.get('requests') == load.get('started_requests') == http.get('requests')
                and load.get('failures') == http.get('failures') == 0
                and http.get('http_429') == http.get('http_503') == http.get('transport_errors') == 0
                and generator.get('user_errors') == 0
                and reconciliation.get('status') == 'PASS_IN_SCOPE')
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def run_baseline(repo, output, *, full=True, runner=run_pcn, progress=print):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    report = {'protocol': 'cqrs-q0-pcn-baseline-v1', 'status': 'STARTING',
              'smoke_gate': 'NOT_RUN', 'full': 'NOT_RUN', 'capacity_accepted': False,
              'application_configuration': 'O; original optimized application, no CQRS overlay',
              'limitations': 'Smoke is not PCN acceptance. Shared host, no equal-budget capacity claim.'}
    stage = 'smoke'
    try:
        smoke = runner(repo, output / 'smoke', mode='smoke', replicas=1, progress=progress)
        if not smoke_passed(output / 'smoke', smoke):
            report.update(status='STOPPED', smoke_gate='FAIL', stopped_reason='smoke_not_passed')
        else:
            report['smoke_gate'] = 'PASS'
            if full:
                stage = 'full'
                result = runner(repo, output / 'full', mode='full', replicas=1, progress=progress)
                report['full'] = result['load_status']
                manifest = json.loads((output / 'full/manifest.json').read_text(encoding='utf-8'))
                report['status'] = 'COMPLETE' if manifest['status'] == 'COMPLETE' else 'STOPPED'
            else:
                report['status'] = 'SMOKE_ONLY'
    except Exception as error:
        # Setup exceptions can include credentials. Preserve only the type/stage.
        report.update(status='STOPPED', failed_stage=stage, error_type=type(error).__name__)
        report['full' if stage == 'full' else 'smoke_gate'] = 'FAIL'
    finally:
        (output / 'workflow.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report
