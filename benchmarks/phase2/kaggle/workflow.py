"""Import-and-Run-All workflow: correctness smoke gates the measured cases."""
from __future__ import annotations
import json
from pathlib import Path
from benchmark import run_case, matrix_report


def plan(mode='auto'):
    if mode not in ('auto','smoke','stress'):
        raise ValueError('mode: auto, smoke or stress')
    cases=[{'stage':'smoke','profile':'mixed','rate':2,'warmup':2,'seconds':5,
            'replicas':n,'accounts':8,'repeat':1} for n in (1,2)]
    if mode=='smoke': return cases
    # Fixed points chosen below write-IP quota; measured read/mixed cover
    # >=1000 samples/operation if the server/generator meet the target.
    for profile,rate in (('read',20),('mixed',30),('clinic_write',10)):
        for replicas in (1,2):
            for repeat in (1,2,3):
                cases.append({'stage':'measured','profile':profile,'rate':rate,
                    'warmup':120,'seconds':300,'replicas':replicas,'accounts':40,'repeat':repeat})
    cases.append({'stage':'faults','profile':'read','rate':2,'warmup':2,'seconds':5,
                  'replicas':2,'accounts':40,'repeat':1,'faults':True})
    cases.append({'stage':'policy','profile':'login_policy','rate':10,'warmup':0,'seconds':30,
                  'replicas':1,'accounts':8,'repeat':1})
    if mode=='stress':
        for rate in (20,40,80):
            cases.append({'stage':'stress','profile':'mixed','rate':rate,'warmup':10,
                          'seconds':60,'replicas':2,'accounts':40,'repeat':1})
    return cases


def smoke_passed(report):
    return (report.get('status')=='COMPLETE' and report.get('generator_valid') is True
        and report.get('reconciliation',{}).get('status')=='PASS_IN_SCOPE'
        and bool(report.get('summary'))
        and all(op.get('success_ratio_of_scheduled',0)>=.99
                and op.get('unexpected_error_ratio',1)==0 for op in report['summary'])
        and report.get('telemetry',{}).get('metric_errors',1)==0
        and report.get('telemetry',{}).get('process_errors',1)==0)


def execute(repo, output, *, mode='auto', runner=run_case, progress=print):
    output=Path(output)
    cases=plan(mode); reports=[]; measured=[]; errors=[]; stopped=None
    for index,case in enumerate(cases):
        stage=case['stage']; kwargs={k:v for k,v in case.items() if k!='stage'}
        progress(f'[{index+1}/{len(cases)}] {stage}: {case["profile"]}, {case["rate"]} RPS, Clinic={case["replicas"]}, repeat={case["repeat"]}')
        try:
            report=runner(repo,output/f'case-{index+1:03d}',**kwargs)
        except Exception as error:
            errors.append({'case':index+1,'stage':stage,'error_type':type(error).__name__})
            stopped='case_failed'; break
        report['stage']=stage; reports.append(report)
        if stage=='measured': measured.append(report)
        # Failed smoke never escalates load. A slow measured endpoint is reported
        # and all planned repeats are retained; bad correctness/generator stops.
        if stage=='smoke' and not smoke_passed(report):
            stopped='smoke_not_passed'; break
        if stage=='faults' and any(report.get(name,{}).get('status')!='PASS_IN_SCOPE'
            for name in ('billing_terminal','notification_healthy','notification_recovery')):
            stopped='fault_scenario_failed'; break
        if stage!='policy' and (not report.get('generator_valid') or report.get('reconciliation',{}).get('status')!='PASS_IN_SCOPE'):
            stopped='generator_or_reconciliation_failed'; break
        (output/'workflow-progress.json').write_text(json.dumps({'completed':len(reports),'planned':len(cases),'last_stage':stage},indent=2))
    result={'mode':mode,'planned':len(cases),'completed':len(reports),'errors':errors,
        'stopped_reason':stopped,'status':'STOPPED' if stopped else 'COMPLETE',
        'capacity_accepted':False,'matrix':matrix_report(measured)}
    (output/'workflow.json').write_text(json.dumps(result,indent=2))
    return reports,result
