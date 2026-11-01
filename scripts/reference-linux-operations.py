#!/usr/bin/env python3
"""Bounded synthetic loopback CLI acceptance, NOT a capacity/production soak."""
import argparse
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import resource
import secrets
import stat
import subprocess
import tempfile
import time

spec = importlib.util.spec_from_file_location('smoke', Path(__file__).with_name('smoke-package.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    # A failed rerun must not leave a stale successful receipt.
    args.output.unlink(missing_ok=True)
    binary = args.binary.resolve(strict=True)
    if platform.system() != 'Linux':
        raise RuntimeError('This reference profile requires Linux')
    # Fixed before execution: two 30s windows, one ready probe/second, clean restart.
    report = {'profile': 'single CP, synthetic admin/feed, loopback, two 30-second windows',
              'kernel': platform.release(), 'platform': platform.platform(),
              'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'os_release': Path('/etc/os-release').read_text(),
              'nofile': resource.getrlimit(resource.RLIMIT_NOFILE),
              'hard_cpu_memory_limits': 'unknown: no assumption from Go runtime settings',
              'GOMAXPROCS': '1', 'GOMEMLIMIT': '256MiB (soft Go memory target, not RSS ceiling)',
              'cgroup': {}, 'windows': [], 'refusals': []}
    for name in ('cpu.max', 'memory.max'):
        path = Path('/sys/fs/cgroup') / name
        report['cgroup'][name] = path.read_text().strip() if path.exists() else 'not exposed'
    with tempfile.TemporaryDirectory(prefix='rw-reference-ops-') as temporary:
        root = Path(temporary)
        env = {k: v for k, v in os.environ.items() if not k.startswith('ROUTEWEAVER_')}
        env.update(ROUTEWEAVER_MASTER_KEY=secrets.token_hex(32), ROUTEWEAVER_ADMIN_USERNAME='reference-admin',
                   ROUTEWEAVER_ADMIN_PASSWORD=secrets.token_urlsafe(32), GOMAXPROCS='1', GOMEMLIMIT='256MiB')
        username, password = env['ROUTEWEAVER_ADMIN_USERNAME'], env['ROUTEWEAVER_ADMIN_PASSWORD']
        db = root / 'private' / 'state.db'
        command = [str(binary), '--db', str(db), '--listen', '127.0.0.1:0']
        feed = body = None
        for window in range(2):
            log_path = root / f'process-{window}.log'
            with log_path.open('w+') as log:
                start = time.monotonic()
                process = subprocess.Popen(command, env=env, stdout=log, stderr=log)
                try:
                    deadline = start + 20
                    while time.monotonic() < deadline:
                        if process.poll() is not None:
                            raise RuntimeError('CLI exited before readiness')
                        match = re.search(r'listening at (http://127\.0\.0\.1:\d+)', log_path.read_text())
                        if match:
                            client = smoke.Client(match[1])
                            client.request('/healthz')
                            break
                        time.sleep(.05)
                    else:
                        raise RuntimeError('CLI readiness timeout')
                    startup = time.monotonic() - start
                    if startup > 20:
                        raise RuntimeError('CLI became ready after the 20-second startup budget')
                    client.login(username, password)
                    if window == 0:
                        feed, body = smoke.create_subscription(client)
                        alias = root / 'hardlink.db'
                        os.link(db, alias)
                        for target in (db, alias):
                            refusal = subprocess.run([str(binary), '--db', str(target), '--listen', '127.0.0.1:0'], env=env, capture_output=True, timeout=10)
                            if refusal.returncode == 0 or b'database is in use' not in refusal.stderr:
                                raise RuntimeError('Second writer was not observably refused')
                            report['refusals'].append('same inode writer refused: ' + ('main' if target == db else 'hardlink'))
                        alias.unlink()
                    else:
                        if smoke.Client(client.origin).request(feed)[0] != body:
                            raise RuntimeError('Restart changed persisted feed')
                    sizes = lambda: sum(p.stat().st_size for p in db.parent.glob('state.db*'))
                    before = sizes()
                    samples = []
                    observed = time.monotonic()
                    for i in range(30):
                        time.sleep(max(0, observed + i - time.monotonic()))
                        tick = time.monotonic()
                        client.request('/healthz')
                        elapsed = time.monotonic() - tick
                        status = Path(f'/proc/{process.pid}/status').read_text()
                        cpu = Path(f'/proc/{process.pid}/stat').read_text().split(') ', 1)[1].split()
                        samples.append({'latency_ms': elapsed * 1000,
                                        'rss_kib': int(re.search(r'VmRSS:\s+(\d+)', status)[1]),
                                        'cpu_ticks': int(cpu[11]) + int(cpu[12])})
                    time.sleep(max(0, observed + 30 - time.monotonic()))
                    for p in [db.parent, *db.parent.glob('state.db*')]:
                        if stat.S_IMODE(p.stat().st_mode) & 0o077:
                            raise RuntimeError('Database or parent permissions are not private')
                    row = {'startup_seconds': startup, 'observation_seconds': time.monotonic() - observed,
                           'successful_probes': len(samples), 'failed_probes': 0,
                           'max_rss_kib': max(s['rss_kib'] for s in samples),
                           'max_readiness_latency_ms': max(s['latency_ms'] for s in samples),
                           'sampled_cpu_seconds': (samples[-1]['cpu_ticks'] - samples[0]['cpu_ticks']) / os.sysconf('SC_CLK_TCK'),
                           'db_bytes_before': before, 'db_bytes_after': sizes(), 'private_permissions': True}
                finally:
                    stop = time.monotonic()
                    smoke.stop_process(process)
                row['sigterm_shutdown_seconds'] = time.monotonic() - stop
                report['windows'].append(row)
            # Restart must use persisted account, not bootstrap initialization.
            if window == 0:
                env.pop('ROUTEWEAVER_ADMIN_USERNAME')
                env.pop('ROUTEWEAVER_ADMIN_PASSWORD')
        report['status'] = 'passed'
        report['limitations'] = 'Readiness is not service health; no external traffic, target host, backup, notifications delivery, capacity SLA or kernel security certification.'
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
