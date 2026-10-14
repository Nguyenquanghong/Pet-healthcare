"""Open-loop measurement and scenario runner for an owned native Kaggle stack."""
from __future__ import annotations
import concurrent.futures as futures
import csv
import datetime as dt
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import platform
import random
import re
import threading
import time
from urllib.parse import urlsplit
import uuid
from native_stack import NativeStack

POLICY = json.loads(Path(__file__).with_name('acceptance.json').read_text())
READS = [('core.pets', '/api/pets'), ('clinic.appointments', '/api/appointments'),
         ('clinic.medical', '/api/medical-records'), ('core.hotel', '/api/hotel-bookings'),
         ('core.invoices', '/api/invoices'), ('notification.list', '/api/notifications')]


def percentile(values, q):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(q * len(ordered)) - 1)] if ordered else None


def summarize(rows, duration):
    result = []
    for op in sorted({r['operation'] for r in rows}):
        group = [r for r in rows if r['operation'] == op]
        sent = [r for r in group if r['sent']]
        good = [r for r in sent if r['outcome'] == 'success']
        kind = 'auth' if op.startswith('auth.') else 'clinic_write' if op == 'clinic.create' else 'read'
        threshold = POLICY['latency_ms'][kind]
        p95, p99 = percentile([r['latency_ms'] for r in good], .95), percentile([r['latency_ms'] for r in good], .99)
        success_ratio = len(good) / len(group)
        errors = sum(r['outcome'] in ('transport_error', 'contract_error', 'overload') for r in group)
        enough = len(good) >= POLICY['minimum_samples_per_operation']
        meets = bool(good) and p95 <= threshold['p95'] and p99 <= threshold['p99'] and success_ratio >= POLICY['minimum_success_ratio'] and errors / len(group) < POLICY['maximum_unexpected_error_ratio_exclusive']
        result.append({'operation': op, 'scheduled': len(group), 'sent': len(sent), 'success': len(good),
            'success_ratio_of_scheduled': success_ratio, 'success_rps': len(good) / duration,
            'p50_success_ms': percentile([r['latency_ms'] for r in good], .5), 'p95_success_ms': p95,
            'p99_success_ms': p99, 'p95_all_http_ms': percentile([r['latency_ms'] for r in sent], .95),
            'p95_schedule_to_done_ms': percentile([r['total_ms'] for r in sent], .95),
            'http_429': sum(r['status'] == 429 for r in group), 'http_503': sum(r['status'] == 503 for r in group),
            'unexpected_error_ratio': errors / len(group), 'not_sent': len(group) - len(sent),
            'threshold_result': 'FAIL' if not meets else 'PASS_IN_SCOPE' if enough else 'INSUFFICIENT_SAMPLES'})
    return result


def open_loop(call, *, rate, seconds, concurrency=32, max_requests=100000):
    if not all(math.isfinite(x) and x > 0 for x in (rate, seconds)) or rate > 200 or seconds > 1800:
        raise ValueError('rate 0..200 and seconds 0..1800 required')
    count = math.ceil(rate * seconds)
    if count > max_requests or not 1 <= concurrency <= 128:
        raise ValueError('Request/concurrency budget exceeded before issuing requests')
    rows, pending = [], set()
    start = time.monotonic()

    def execute(index, due):
        began = time.monotonic()
        row = call(index)
        row.update({'sequence': index, 'scheduled_s': due - start, 'lag_ms': (began - due) * 1000,
                    'latency_ms': (time.monotonic() - began) * 1000, 'total_ms': (time.monotonic() - due) * 1000})
        return row

    with futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        for index in range(count):
            due = start + index / rate
            time.sleep(max(0, due - time.monotonic()))
            done = {f for f in pending if f.done()}
            for f in done:
                rows.append(f.result())
            pending -= done
            lag = time.monotonic() - due
            if len(pending) >= concurrency or lag > max(.25, 2 / rate):
                # Do not queue an unbounded backlog or hide missed arrivals behind closed-loop pacing.
                rows.append({'sequence': index, 'operation': 'generator.drop', 'status': 0, 'sent': False,
                    'outcome': 'generator_drop', 'scheduled_s': due - start, 'lag_ms': lag * 1000,
                    'latency_ms': 0, 'total_ms': lag * 1000, 'instance': ''})
            else:
                pending.add(pool.submit(execute, index, due))
        for f in futures.as_completed(pending):
            rows.append(f.result())
        time.sleep(max(0, start + seconds - time.monotonic()))
    drops = sum(r['outcome'] == 'generator_drop' for r in rows)
    lag = percentile([r['lag_ms'] for r in rows if r['sent']], .95)
    return {'rows': sorted(rows, key=lambda r: r['sequence']), 'offered_rps': rate, 'seconds': seconds,
        'drain_seconds': max(0, time.monotonic() - start - seconds), 'scheduled': count,
        'generator_drop_ratio': drops / count, 'scheduler_lag_p95_ms': lag,
        'generator_valid': drops / count <= POLICY['maximum_generator_drop_ratio'] and lag is not None and lag <= POLICY['maximum_scheduler_lag_p95_ms'],
        'summary': summarize(rows, seconds)}


class Client:
    def __init__(self, stack):
        self.stack, self.fixture = stack, stack.fixture
        url = urlsplit(self.fixture['baseUrl'])
        if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port:
            raise ValueError('Only the owned loopback fixture is allowed')
        self.host, self.port = url.hostname, url.port
        self.actors, self.created, self.write_attempts = [], [], []
        self.lock, self.offset = threading.Lock(), 0
        self.cooldowns = {}
        for account in self.fixture['accounts']:
            status, body, _ = self.request('POST', '/api/auth/owner/login', {'email': account['email'], 'password': self.fixture['password']})
            if status != 200 or body.get('user', {}).get('id') != account['id']:
                raise RuntimeError('Synthetic owner login failed; do not lower the limiter to proceed')
            self.actors.append({**account, 'token': body['token']})

    def request(self, method, path, body=None, token=None, key=None):
        connection = http.client.HTTPConnection(self.host, self.port, timeout=15)
        headers = {'Content-Type': 'application/json'}
        if token: headers['Authorization'] = 'Bearer ' + token
        if key: headers['Idempotency-Key'] = key
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None, headers)
            response = connection.getresponse()
            raw = response.read()
            try: data = json.loads(raw) if raw else {}
            except (ValueError, UnicodeError): data = {}
            return response.status, data if isinstance(data, dict) else {}, dict(response.getheaders())
        finally:
            connection.close()

    def workload(self, profile, seed=20261014):
        if profile not in ('read', 'clinic_write', 'mixed', 'login_policy', 'hotel_background'):
            raise ValueError('Unknown profile')
        with self.lock:
            offset = self.offset; self.offset += 400000

        def call(index):
            actor = self.actors[index % len(self.actors)]
            write = profile == 'clinic_write' or profile == 'mixed' and random.Random(seed + index).random() < .2
            if profile == 'login_policy':
                op, method, path, body = 'auth.login_policy', 'POST', '/api/auth/owner/login', {'email': actor['email'], 'password': self.fixture['password']}
            elif write:
                n = offset + index
                day = dt.datetime.now(dt.timezone(dt.timedelta(hours=7))).date() + dt.timedelta(days=30 + n // 420)
                op, method, path = 'clinic.create', 'POST', '/api/appointments'
                body = {'petId': actor['pets'][n % 21]['id'], 'type': 'spa_bath', 'serviceName': 'Synthetic Kaggle load',
                        'date': day.isoformat(), 'time': f'{8 + (n // 21) % 10:02d}:{30 * ((n // 210) % 2):02d}'}
            else:
                op, path = ('core.hotel', '/api/hotel-bookings') if profile == 'hotel_background' else READS[index % len(READS)]
                method, path, body = 'GET', path + '?page=1&pageSize=20', None
            row = {'operation': op, 'sent': False, 'status': 0, 'outcome': 'client_backoff', 'instance': ''}
            group = 'auth' if profile == 'login_policy' else 'write' if write else 'read'
            with self.lock:
                if self.cooldowns.get((actor['id'], group), 0) > time.monotonic():
                    return row
            key = str(uuid.uuid4()) if write else None
            if write:
                with self.lock: self.write_attempts.append({'key': key, 'actor': actor['id'], 'body': body})
            row['sent'] = True
            try:
                status, data, headers = self.request(method, path, body, None if profile == 'login_policy' else actor['token'], key)
                row['status'] = status
                row['instance'] = next((v for k, v in headers.items() if k.lower() == 'x-service-instance'), '')
                if write:
                    resource = data.get('appointment', {}).get('id')
                    valid = status == 201 and isinstance(resource, str)
                    if valid:
                        with self.lock: self.created.append(resource)
                elif profile == 'login_policy':
                    valid = status == 200 and data.get('user', {}).get('id') == actor['id'] and bool(data.get('token'))
                else:
                    valid = status == 200 and isinstance(data.get('items'), list) and isinstance(data.get('pagination'), dict)
                    if valid:
                        valid = all(item.get('ownerId', actor['id']) == actor['id'] and item.get('recipientOwnerId', actor['id']) == actor['id'] and not item.get('internalNote') for item in data['items'])
                        if op != 'notification.list': valid = valid and bool(data['items'])
                row['outcome'] = 'success' if valid else 'rate_limited' if status == 429 else 'overload' if status == 503 else 'contract_error'
                if status in (429, 503):
                    from email.utils import parsedate_to_datetime
                    raw = next((v for k, v in headers.items() if k.lower() == 'retry-after'), '1')
                    try: wait = float(raw)
                    except ValueError:
                        try: wait = (parsedate_to_datetime(raw) - dt.datetime.now(dt.timezone.utc)).total_seconds()
                        except (ValueError, TypeError, OverflowError): wait = 1
                    if not math.isfinite(wait) or wait < 0: wait = 1
                    with self.lock: self.cooldowns[(actor['id'], group)] = time.monotonic() + wait
            except (OSError, TimeoutError, http.client.HTTPException):
                row['outcome'] = 'transport_error'
            return row
        return call


def reconcile(before, after, created):
    before_ids = {r['id'] for r in before['appointments']}
    after_ids = {r['id'] for r in after['appointments']}
    slots = set(); duplicates = 0
    for row in after['appointments']:
        if row['status'] in ('cancelled', 'no_show'): continue
        slot = (row['petId'], row['appointmentDate'], row['appointmentTime'])
        duplicates += slot in slots; slots.add(slot)
    missing = len(set(created) - after_ids)
    unknown = len(after_ids - before_ids - set(created))
    duplicate_ids = len(created) - len(set(created))
    return {'status': 'PASS_IN_SCOPE' if not (missing or unknown or duplicates or duplicate_ids or after['unexpectedExit']) else 'REVIEW_REQUIRED',
        'missing_success_ids': missing, 'writes_without_success_response': unknown,
        'duplicate_active_slots': duplicates, 'duplicate_response_ids': duplicate_ids,
        'unexpected_child_exit': after['unexpectedExit']}


def notification_probe(client, count=10, outage=0):
    stack = client.stack
    if not 1 <= count <= POLICY['recovery_max_events']//2 or not 0 <= outage <= 60: raise ValueError('Fault probe bounds')
    admin=client.fixture['admin']
    status,body,_=client.request('POST','/api/auth/admin/login',{'username':admin['username'],'password':client.fixture['password']})
    if status!=200 or body.get('user',{}).get('id')!=admin['id']: raise RuntimeError('Synthetic admin login failed')
    admin_token=body['token']
    call = client.workload('clinic_write')
    created=[]; observed={}; duplicates=0
    def observe(snapshot):
        nonlocal duplicates
        for appointment,started,owner in created:
            notices=[n for n in snapshot['notifications'] if n['relatedAppointmentId']==appointment
                     and n['recipientRole']=='owner' and n['recipientOwnerId']==owner]
            if notices: observed.setdefault(appointment,(time.monotonic()-started)*1000)
            duplicates=max(duplicates,max(0,len(notices)-1))
    if outage: stack.control('pause-notification')
    paused_at = time.monotonic()
    try:
        for i in range(count):
            before = len(client.created); row = call(i)
            if row['outcome'] != 'success' or len(client.created) != before + 1:
                raise RuntimeError('Notification probe write failed')
            appointment=client.created[-1]
            snapshot=stack.control('inspect',appointmentIds=[appointment])
            source=next(a for a in snapshot['appointments'] if a['id']==appointment)
            # Owner booking -> admin notice; staff confirmation -> owner notice.
            # Measure the notification-producing request for the intended owner.
            started=time.monotonic()
            status,_,_=client.request('PATCH','/api/appointments/'+appointment+'/status',
                {'status':'confirmed','expectedRevision':source['statusRevision']},admin_token)
            if status!=200: raise RuntimeError('Staff confirmation failed in notification probe')
            created.append((appointment,started,source['ownerId']))
            if not outage:
                deadline=time.monotonic()+30
                while appointment not in observed and time.monotonic()<deadline:
                    observe(stack.control('inspect',appointmentIds=[appointment]))
                    if appointment not in observed: time.sleep(.2)
            # Two valid events per appointment, at most five events/second.
            time.sleep(.4)
        if outage: time.sleep(max(0, paused_at + outage - time.monotonic()))
    finally:
        if outage: stack.control('resume-notification')
    resumed = time.monotonic()
    deadline = resumed + (POLICY['recovery_deadline_seconds'] if outage else 30)
    while time.monotonic() < deadline:
        snapshot=stack.control('inspect',appointmentIds=[a for a,_,_ in created])
        observe(snapshot)
        if len(observed) == count and not snapshot['pendingClinic'] and not snapshot['pendingCore']: break
        time.sleep(.5)
    elapsed = time.monotonic() - resumed
    healthy_p95 = percentile(list(observed.values()), .95) if not outage else None
    return {'scenario': 'notification-recovery' if outage else 'notification-healthy', 'expected': count,
        'observed': len(observed), 'missing': count - len(observed), 'duplicate_owner_notices': duplicates,
        'outage_seconds': outage, 'recovery_seconds': elapsed if outage else None, 'p95_upper_bound_ms': healthy_p95,
        'committed_notification_events':count*2,
        'measurement': 'staff confirmation request start to intended owner notice; upper bound includes polling/inspection overhead',
        'status': 'PASS_IN_SCOPE' if len(observed) == count and not duplicates and (elapsed <= POLICY['recovery_deadline_seconds'] if outage else healthy_p95 <= POLICY['notification_p95_ms']) else 'FAIL'}


def sample_resources(stack, stop, rows, metrics):
    import psutil
    tracked = {p['pid']: p['name'] for p in stack.fixture['processes']}
    tracked[os.getpid()] = 'generator'
    for name, child in stack.processes:
        if name != 'application': tracked[child.pid] = name
    tracked[int((stack.private / 'pgdata/postmaster.pid').read_text().splitlines()[0])] = 'postgres'
    previous = {}; next_metrics=0
    while not stop.is_set():
        now = time.monotonic()
        for pid, name in tracked.items():
            try:
                process = psutil.Process(pid); processes = [process, *process.children(recursive=True)] if name in ('postgres', 'rabbitmq') else [process]
                cpu = sum(p.cpu_times().user + p.cpu_times().system for p in processes)
                rss = sum(p.memory_info().rss for p in processes)
                old = previous.get(pid); previous[pid] = (now, cpu)
                rows.append({'monotonic_s': now, 'component': name, 'cpu_seconds': cpu, 'rss_bytes': rss,
                    'cpu_percent_one_core': max(0, (cpu - old[1]) / (now - old[0]) * 100) if old else None})
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                rows.append({'monotonic_s': now, 'component': name, 'error': 'process_unavailable'})
        if now >= next_metrics:
            next_metrics=now+2
            for target in stack.fixture['metrics']:
                url=urlsplit(target['origin'])
                if url.hostname!='127.0.0.1' or url.scheme!='http':
                    metrics.append({'component':target['name'],'error':'invalid_target'}); continue
                connection=http.client.HTTPConnection(url.hostname,url.port,timeout=2)
                sample={'component':target['name'],'monotonic_s':time.monotonic()}
                try:
                    connection.request('GET','/metrics',headers={'X-Service-Token':stack.fixture['metricsToken']})
                    response=connection.getresponse(); raw=response.read().decode('utf-8')
                    sample['status']=response.status
                    # Fixed service-only numeric metrics; never export label strings/body/token.
                    sample['values']={name:float(value) for name,value in re.findall(r'^(pet_[a-z_]+)\{service="[a-z]+"\} ([0-9.eE+-]+)$',raw,re.M)}
                except (OSError,TimeoutError,http.client.HTTPException,UnicodeError): sample['status']=0
                finally: connection.close()
                metrics.append(sample)
        stop.wait(1)


def billing_probe(client, count=10):
    snapshot = client.stack.control('inspect')
    actor = client.actors[0]
    sources = [a for a in snapshot['appointments'] if a['ownerId']==actor['id'] and a['status']=='completed' and a['type']=='spa_bath'][:count]
    latencies, accepted, invoices = [], 0, {}
    for source in sources:
        began=time.monotonic(); key=str(uuid.uuid4())
        status, body, _ = client.request('POST','/api/invoices/checkout',{'type':'appointment','relatedId':source['id']},actor['token'],key)
        if status==202:
            accepted+=1; operation=body.get('operationId')
            if not operation: raise RuntimeError('202 without durable operation ID')
            while time.monotonic()-began < POLICY['billing_terminal_deadline_seconds']:
                time.sleep(.5)
                status, body, _ = client.request('GET','/api/operations/'+operation,token=actor['token'])
                if status==200 and body.get('status') in ('succeeded','failed'): break
        invoice=body.get('invoice',{})
        if status not in (200,201) or not invoice.get('id'):
            raise RuntimeError('Billing did not reach successful terminal within deadline')
        invoices[source['id']]=invoice['id']; latencies.append((time.monotonic()-began)*1000)
        # Repeat exactly the same request key: one durable invoice.
        status, duplicate, _ = client.request('POST','/api/invoices/checkout',{'type':'appointment','relatedId':source['id']},actor['token'],key)
        if status!=200 or duplicate.get('invoice',{}).get('id')!=invoice['id']:
            raise RuntimeError('Billing replay changed the invoice')
    deadline=time.monotonic()+30; matched=False
    while time.monotonic()<deadline:
        after=client.stack.control('inspect',appointmentIds=list(invoices))
        matched=bool(invoices) and all(
            len([i for i in after['invoices'] if i['appointmentId']==appointment and i['id']==invoice])==1 and
            len([r for r in after['reservations'] if r['appointmentId']==appointment and r['state']=='INVOICED' and r['invoiceId']==invoice])==1
            for appointment,invoice in invoices.items())
        if matched: break
        time.sleep(.5)
    p95=percentile(latencies,.95)
    return {'scenario':'billing-terminal','attempts':len(sources),'http_202':accepted,'completed':len(latencies),
        'p95_ms':p95,'invoice_reservation_reconciled':matched,
        'status':'PASS_IN_SCOPE' if len(sources)==count and matched and p95<=POLICY['billing_terminal_p95_ms'] else 'FAIL',
        'limitations':'Healthy checkout and same-key replay; forced prepare/commit/abort/undo races remain in P1/P4 integration suites.'}


def run_case(repo, output, *, profile='read', rate=5, warmup=120, seconds=300, repeat=1, replicas=1, accounts=40, faults=False):
    # A fresh cluster/fixture/Redis namespace PER case keeps warmups/repeats comparable.
    output = Path(output); output.mkdir(parents=True, exist_ok=False)
    public = {'protocol': POLICY['version'], 'run': str(uuid.uuid4()), 'profile': profile, 'offered_rps': rate,
        'warmup_seconds': warmup, 'steady_seconds': seconds, 'repeat': repeat, 'clinic_replicas': replicas,
        'topology': 'native-three-service-nginx', 'capacity_accepted': False, 'status': 'RUNNING',
        'environment': {'os': platform.platform(), 'python': platform.python_version(), 'cpus': os.cpu_count()},
        'budgets': {'hard_cpu_memory_quotas': False, 'shared_host_with_generator': True,
                    'api_pool_per_replica': 4, 'worker_pool': 4, 'note': 'Two Clinic replicas increase aggregate pool; not equal-budget B2.'},
        'limitations': ['No B0 baseline or B2/B3 resource-matched capacity conclusion', 'Common IP; auth profile measures limiter policy',
                        'No registration journey, external payment or production SLA', 'DB pool/lock histograms require separate instrumentation']}
    if hasattr(os,'sched_getaffinity'): public['environment']['cpu_affinity']=sorted(os.sched_getaffinity(0))
    for name in ('cpu.max','memory.max'):
        path=Path('/sys/fs/cgroup')/name
        public['environment']['cgroup_'+name.replace('.','_')]=path.read_text().strip() if path.exists() else 'unavailable'
    public['environment']['memory_total_bytes']=next((int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:')),None) if Path('/proc/meminfo').exists() else None
    (output / 'manifest.json').write_text(json.dumps(public, indent=2))
    try:
        with NativeStack(repo, accounts, replicas) as stack:
            client = Client(stack)
            public['dataset'] = stack.fixture['dataset']; public['db_cross_connect_denied'] = 6
            baseline = stack.control('inspect')
            if warmup:
                warm = open_loop(client.workload(profile), rate=rate, seconds=warmup)
                public['warmup'] = {k: v for k, v in warm.items() if k != 'rows'}
            resources=[]; metrics=[]; collector_errors=[]; stop=threading.Event()
            def collect():
                try: sample_resources(stack,stop,resources,metrics)
                except Exception as error: collector_errors.append(type(error).__name__)
            collector=threading.Thread(target=collect,daemon=True); collector.start()
            try:
                result = open_loop(client.workload(profile), rate=rate, seconds=seconds)
            finally:
                stop.set(); collector.join(timeout=10)
                if collector.is_alive() or collector_errors: raise RuntimeError('Resource collector failed')
            public.update({k: v for k, v in result.items() if k != 'rows'})
            public['classification'] = 'MEASURED_SCOPE_ONLY' if warmup >= POLICY['warmup_seconds'] and seconds >= POLICY['steady_seconds'] else 'SCREENING'
            with (output / 'requests.csv').open('w', newline='', encoding='utf-8') as stream:
                writer=csv.DictWriter(stream,fieldnames=list(result['rows'][0])); writer.writeheader(); writer.writerows(result['rows'])
            (output / 'resources.json').write_text(json.dumps(resources))
            (output / 'metrics.json').write_text(json.dumps(metrics))
            public['telemetry']={'process_samples':len(resources),'process_errors':sum('error' in r for r in resources),
                'metric_samples':len(metrics),'metric_errors':sum(r.get('status')!=200 or not r.get('values') for r in metrics),
                'note':'Every ~2s, sequential bounded scrapes; timing recorded, not guaranteed under outage.'}
            # Save measured raw data before post-load inspection/fault probes can fail.
            public['reconciliation'] = reconcile(baseline, stack.control('inspect'), client.created)
            if faults:
                public['billing_terminal'] = billing_probe(client)
                public['notification_healthy'] = notification_probe(client)
                public['notification_recovery'] = notification_probe(client, count=30, outage=POLICY['consumer_outage_seconds'])
            public['status'] = 'COMPLETE'  # completion is not acceptance
    except BaseException as error:
        public['status'] = 'FAILED'; public['error_type'] = type(error).__name__
        raise
    finally:
        public['runner_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        public['policy_sha256'] = hashlib.sha256(Path(__file__).with_name('acceptance.json').read_bytes()).hexdigest()
        (output / 'summary.json').write_text(json.dumps(public, indent=2))
        (output / 'manifest.json').write_text(json.dumps({k:v for k,v in public.items() if k not in ('summary','warmup')},indent=2))
    return public


def matrix_report(reports):
    groups = {}
    for report in reports:
        key = (report['profile'], report['offered_rps'], report['clinic_replicas'])
        groups.setdefault(key, []).append(report)
    rows=[]
    for key, runs in groups.items():
        complete = len({r['repeat'] for r in runs if r['status']=='COMPLETE'}) >= POLICY['repeats']
        durations = all(r.get('classification')=='MEASURED_SCOPE_ONLY' for r in runs)
        valid = all(r.get('generator_valid') and r.get('reconciliation',{}).get('status')=='PASS_IN_SCOPE' for r in runs)
        # Every repeat must pass. Do not pool successes and hide a bad repeat.
        measured = all(r.get('summary') and all(op['threshold_result']=='PASS_IN_SCOPE' for op in r['summary']) for r in runs)
        rows.append({'profile':key[0],'offered_rps':key[1],'clinic_replicas':key[2],
            'completed_repeats':len(runs),'status':'PASS_IN_SCOPE' if complete and durations and valid and measured else 'NOT_ACCEPTED',
            'capacity_accepted':False})
    return rows
