#!/usr/bin/env python3
"""Route only an admitted QA publisher's signaling TCP through an owned gate.

No TLS interception, DNS override, global firewall flush, or application patch.
The random cgroup contains exactly the admitted PID. EOF removes exact rules
and restores the process's original cgroup if it is still alive.
"""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--exe', type=Path, required=True)
    parser.add_argument('--exe-sha256', required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--address', action='append', required=True)
    args = parser.parse_args()
    owner = int(os.environ['SUDO_UID'])
    assert os.getuid() == 0 and owner > 0 and 1024 <= args.port <= 65535
    report = args.report.resolve(); assert report.is_dir() and report.stat().st_uid == owner
    proc = Path('/proc') / str(args.pid); exe = args.exe.resolve()
    assert proc.stat().st_uid == owner and (proc/'exe').resolve() == exe
    assert hashlib.sha256(exe.read_bytes()).hexdigest() == args.exe_sha256
    command = (proc/'cmdline').read_bytes().split(b'\0')
    assert any(value.startswith(('--settings-dir='+str(report)+'/').encode()) for value in command)
    assert b'--headless' not in command and b'--local-control' in command
    start = (proc/'stat').read_text().rsplit(')', 1)[1].split()[19]
    original = (proc/'cgroup').read_text().strip(); assert original.startswith('0::/') and '\n' not in original
    original = Path('/sys/fs/cgroup') / original[4:]
    addresses = sorted(set(args.address))
    resolved = {v[4][0] for v in socket.getaddrinfo('wss.vdo.ninja', 443, socket.AF_INET, socket.SOCK_STREAM)}
    assert addresses and set(addresses) <= resolved
    for address in addresses: assert ipaddress.ip_address(address).version == 4 and ipaddress.ip_address(address).is_global
    name = 'gc-signaling-' + uuid.uuid4().hex; group = Path('/sys/fs/cgroup') / name
    rules = []; result = {'passed':False,'pid':args.pid,'cgroup':name,'addresses':addresses,'port':args.port,
        'scope':'Only admitted publisher cgroup, IPv4 TCP destination wss.vdo.ninja:443; opaque TLS forwarded by an owned loopback gate.'}
    def iptables(*arguments, check=True):
        value = subprocess.run(['iptables','-w','5','-t','nat',*arguments],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=8)
        if check and value.returncode:raise RuntimeError(value.stderr.strip())
        return value
    def same_process():
        try:return (proc/'exe').resolve()==exe and (proc/'stat').read_text().rsplit(')',1)[1].split()[19]==start
        except (OSError,IndexError):return False
    def interrupt(*_):raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupt)
    try:
        group.mkdir(); (group/'cgroup.procs').write_text(str(args.pid))
        assert (group/'cgroup.procs').read_text().split()==[str(args.pid)]
        for address in addresses:
            rule=['OUTPUT','-p','tcp','-d',address,'--dport','443','-m','cgroup','--path',name,'-m','comment','--comment',name,'-j','DNAT','--to-destination','127.0.0.1:'+str(args.port)]
            iptables('-A',*rule);rules.append(rule);iptables('-C',*rule)
        result['installed']=True
        print(json.dumps({'ready':True,'cgroup':name,'addresses':addresses}),flush=True)
        # The pipe is owned by the Node fixture, not the publisher. EOF also
        # handles its unexpected exit, so firewall state cannot outlive it.
        assert sys.stdin.read()==''
    finally:
        errors=[]
        for rule in reversed(rules):
            try:
                iptables('-D',*rule);assert iptables('-C',*rule,check=False).returncode==1
            except Exception as error:errors.append(repr(error))
        try:
            if group.exists():
                members=(group/'cgroup.procs').read_text().split();assert set(members)<={str(args.pid)}
                if same_process() and members:(original/'cgroup.procs').write_text(str(args.pid))
                assert not (group/'cgroup.procs').read_text().strip();group.rmdir()
        except Exception as error:errors.append(repr(error))
        result.update(rulesRemoved=not errors,cgroupRetired=not group.exists(),cleanupErrors=errors)
        result['passed']=bool(result.get('installed')) and not errors
        (report/'signaling-route-cleanup.json').write_text(json.dumps(result,indent=2)+'\n')
        assert not errors, errors


if __name__=='__main__':main()
