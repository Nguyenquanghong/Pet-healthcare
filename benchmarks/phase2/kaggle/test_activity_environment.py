"""Pure D0 checks; never touches a real cgroup or runs pressure helpers."""
import ast
import importlib.util
import json
import errno
import os
import uuid
import subprocess
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('env_probe',HERE/'activity_environment.py')
probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)

class EnvironmentTests(unittest.TestCase):
    def test_namespace_root_and_subtree_mapping(self):
        line='29 23 0:26 /tenant/session /sys/fs/cgroup ro,nosuid - cgroup2 cgroup rw'
        self.assertEqual(probe.locations(line,'0::/')[0]['current'],'/sys/fs/cgroup')
        self.assertEqual(probe.locations(line,'0::/workers/api')[0]['current'],'/sys/fs/cgroup/workers/api')
        self.assertEqual(probe.locations(line,'0::/tenant/session/workers/api')[0]['current'],'/sys/fs/cgroup/workers/api')
        self.assertIn('ro',probe.locations(line,'0::/')[0]['flags'])

    def test_escaped_mounts_and_unsafe_mapping(self):
        line=r'29 23 0:26 / /cg\040test rw - cgroup2 cgroup rw'
        self.assertEqual(probe.locations(line,'0::/a')[0]['current'],'/cg test/a')
        for membership in ['0::/../../host','2:memory:/x','0::/a\n0::/b']:
            with self.assertRaises(probe.Unavailable):probe.locations(line,membership)
        with self.assertRaises(probe.Unavailable):probe.locations('29 23 0:26 / relative rw - cgroup2 cgroup rw','0::/')

    def test_budget_is_aggregate_and_effective_ancestor_limits_win(self):
        row=lambda c,m:{'controls':{'cpu.max':c,'memory.max':m}}
        self.assertEqual(probe.budget_fits([row('400000 100000',str(30*1024**3))],range(4))['effectiveCpuUpperBound'],4)
        for ancestors in [[row('max 100000','max')],[row('400000 100000',str(30*1024**3)),row('200000 100000',str(30*1024**3))],
                          [row('400000 100000',str(8*1024**3))]]:
            with self.assertRaises(probe.Unavailable):probe.budget_fits(ancestors,range(4))

    def test_wrong_host_stops_before_proc_or_write_or_helper(self):
        with patch.object(probe.platform,'system',return_value='Windows'),patch.object(probe.subprocess,'Popen') as popen:
            result=probe.run_probe()
        self.assertEqual(result['reason'],'LINUX_REQUIRED');self.assertEqual(result['ownedCgroupsRetained'],[])
        self.assertEqual(result['d0'],'PARTIAL_ENVIRONMENT');self.assertFalse(result['applicationStarted']);popen.assert_not_called()

    def test_budget_changes_rejected_and_helper_waits_before_payload(self):
        with self.assertRaises(ValueError):probe.run_probe({'stack':{'cpuMax':'999999 100000'}})
        tree=ast.parse(probe.HELPER)
        self.assertIn("sys.stdin.buffer.readline()!=b'run\\n'",probe.HELPER)
        self.assertIn('64*1024*1024',probe.HELPER);self.assertIn('0.2',probe.HELPER)
        self.assertGreater(len(tree.body),0)

    def test_probe_does_not_contain_remount_sudo_existing_pid_migration_or_application_commands(self):
        code=(HERE/'activity_environment.py').read_text()
        calls=[node for node in ast.walk(ast.parse(code)) if isinstance(node,ast.Call)
               and isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Name)
               and node.func.value.id=='subprocess' and node.func.attr=='Popen']
        self.assertEqual(len(calls),1)
        self.assertEqual(ast.unparse(calls[0].args[0].elts[0]),'sys.executable')
        self.assertNotIn("(parent/'cgroup.subtree_control').write_text",code)
        self.assertNotIn("(parent/'cgroup.procs').write_text",code)
        self.assertNotIn('DATABASE_URL',code);self.assertNotIn('pg_ctl',code)

    def test_helper_rejects_input_before_pressure_payload(self):
        result=subprocess.run([sys.executable,'-I','-S','-c',probe.HELPER,'memory'],input=b'reject\n',
                              stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=3)
        self.assertEqual(result.returncode,2);self.assertEqual(result.stdout,b'');self.assertEqual(result.stderr,b'')

    def unavailable_kernel(self, readonly):
        base=HERE.parents[2]/'test-results/phase2/cqrs/activity/d0-fake-kernel'/uuid.uuid4().hex
        base.mkdir(parents=True);(base/'cgroup.subtree_control').write_text('ORIGINAL')
        read_text=Path.read_text;mkdir=Path.mkdir
        def text(path,*args,**kwargs):
            if str(path).replace('\\','/') in ['/proc/self/mountinfo','/proc/self/cgroup']:return 'fake'
            return read_text(path,*args,**kwargs)
        def create(path,*args,**kwargs):
            if readonly and path.name.startswith('clinic-activity-env-'):raise OSError(errno.EROFS,'unit test read-only fs')
            return mkdir(path,*args,**kwargs)
        def control(path):
            name=Path(path).name
            return {'cgroup.procs':str(os.getpid()),'cpu.max':'400000 100000','memory.max':str(30*1024**3),
                    'cgroup.subtree_control':''}.get(name,'')
        from contextlib import ExitStack
        with ExitStack() as stack:
            stack.enter_context(patch.object(probe.platform,'system',return_value='Linux'))
            stack.enter_context(patch.object(probe.platform,'platform',return_value='FAKE_UNIT_KERNEL'))
            stack.enter_context(patch.object(probe.os,'geteuid',return_value=1000,create=True))
            stack.enter_context(patch.object(probe.os,'sched_getaffinity',return_value=set(range(4)),create=True))
            stack.enter_context(patch.object(probe,'locations',return_value=[{'mount':str(base),'current':str(base),'flags':['ro' if readonly else 'rw']}]))
            stack.enter_context(patch.object(Path,'read_text',text));stack.enter_context(patch.object(Path,'mkdir',create))
            stack.enter_context(patch.object(probe,'read',side_effect=control))
            popen=stack.enter_context(patch.object(probe.subprocess,'Popen'))
            result=probe.run_probe();popen.assert_not_called()
        self.assertEqual((base/'cgroup.subtree_control').read_text(),'ORIGINAL')
        return result

    def test_readonly_kernel_records_actual_mkdir_errno_and_never_starts_helpers(self):
        report=self.unavailable_kernel(True)
        self.assertEqual(report['reason'],'CGROUP_READ_ONLY');self.assertEqual(report['ownedChildCreationErrno'],errno.EROFS)
        self.assertEqual(report['ownedCgroupsRetained'],[]);self.assertTrue(report['ownedHelperProcessesStopped'])

    def test_missing_delegation_never_enables_existing_parent_or_calls_helpers(self):
        report=self.unavailable_kernel(False)
        self.assertEqual(report['reason'],'CPU_MEMORY_NOT_DELEGATED_TO_CHILDREN')
        self.assertEqual(len(report['ownedCgroupsRetained']),1);self.assertFalse(report['existingParentControlsModified'])

if __name__=='__main__':unittest.main()
