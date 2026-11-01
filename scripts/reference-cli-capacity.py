#!/usr/bin/env python3
"""Finite, paced authenticated CLI reference; not a saturation test or capacity SLA."""
import argparse, concurrent.futures, hashlib, http.cookiejar, json, math, os
from pathlib import Path
import platform, re, secrets, sqlite3, subprocess, tempfile, threading, time
import urllib.request, urllib.error

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise RuntimeError('Reference refuses HTTP redirects')

class Client:
    def __init__(self, origin):
        self.origin, self.csrf = origin, ''
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(self, path, data=None):
        headers = {'Origin': self.origin, 'X-CSRF-Token': self.csrf, 'Content-Type': 'application/json'}
        req = urllib.request.Request(self.origin+path, headers=headers, data=None if data is None else json.dumps(data).encode())
        with self.http.open(req, timeout=5) as r:
            assert r.status == 200, r.status
            return json.loads(r.read())

def snapshot(db, pid):
    with sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=2) as c:
        rows = dict(c.execute("SELECT CASE WHEN kind LIKE 'tenant/%/sources' THEN 'tenant/*/sources' ELSE kind END AS category,count(*) FROM records GROUP BY category"))
        payload = dict(c.execute("SELECT CASE WHEN kind LIKE 'tenant/%/sources' THEN 'tenant/*/sources' ELSE kind END AS category,sum(length(data)) FROM records GROUP BY category"))
    stat = Path(f'/proc/{pid}/stat').read_text().split(') ',1)[1].split()
    status = Path(f'/proc/{pid}/status').read_text()
    return {'rows_by_kind': rows, 'encrypted_payload_bytes_by_kind': payload,
            'files': {p.name:p.stat().st_size for p in db.parent.glob('state.db*')},
            'rss_kib': int(re.search(r'VmRSS:\s+(\d+)',status)[1]),
            'cpu_seconds': (int(stat[11])+int(stat[12]))/os.sysconf('SC_CLK_TCK')}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary',type=Path,required=True); p.add_argument('--fixture',type=Path,required=True); p.add_argument('--output',type=Path,required=True)
    a=p.parse_args(); a.output.unlink(missing_ok=True)
    report={'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(), 'binary_sha256':hashlib.sha256(a.binary.read_bytes()).hexdigest(),
            'platform':platform.platform(), 'GOMAXPROCS':1, 'GOMEMLIMIT':'256MiB soft target', 'native_child':'none', 'hard_cpu_memory_limits':'unknown',
            'profile':'25 synthetic tenants, 1 private text source each; 1/5/25 concurrent clients, 30 seconds each, 2 requests/client/second, 90% GET source / 10% POST source update; login once per unique account outside timed windows',
            'bounds':{'max_rss_kib':524288,'max_data_bytes':536870912,'request_timeout_seconds':5,'benchmark_watchdog_seconds':180,'maximum_timed_requests':1860},'windows':[]}
    for n in ('cpu.max','memory.max'):
        f=Path('/sys/fs/cgroup')/n; report[n]=f.read_text().strip() if f.exists() else 'not exposed'
    with tempfile.TemporaryDirectory(prefix='rw-capacity-') as tmp:
        root=Path(tmp); db=root/'private'/'state.db'
        env={k:v for k,v in os.environ.items() if not k.startswith('ROUTEWEAVER_')}
        env.update(ROUTEWEAVER_MASTER_KEY=secrets.token_hex(32),CAPACITY_PASSWORD=secrets.token_urlsafe(32),GOMAXPROCS='1',GOMEMLIMIT='256MiB')
        subprocess.run([str(a.fixture.resolve()),str(db)],env=env,check=True,timeout=60)
        with (root/'process.log').open('w') as log:
            process=subprocess.Popen([str(a.binary.resolve()),'--db',str(db),'--listen','127.0.0.1:0'],env=env,stdout=log,stderr=log)
            try:
                deadline=time.monotonic()+20
                while time.monotonic()<deadline:
                    assert process.poll() is None, 'CLI exited'
                    m=re.search(r'listening at (http://127\.0\.0\.1:\d+)',(root/'process.log').read_text())
                    if m: break
                    time.sleep(.05)
                else: raise RuntimeError('startup timeout')
                clients=[]; sources=[]
                for i in range(25):
                    c=Client(m[1]); c.csrf=c.call('/api/auth/login',{'username':f'capacity-{i:02d}','password':env['CAPACITY_PASSWORD']})['csrfToken']
                    s={'id':f'source-{i:02d}','name':f'Private {i:02d}','kind':'text','enabled':True,'content':f'socks5://192.0.2.1:1080#Private{i:02d}'}
                    c.call('/api/me/sources',s); clients.append(c); sources.append(s)
                for i,c in enumerate(clients):
                    got=c.call('/api/me/sources'); assert len(got)==1 and got[0]['id']==sources[i]['id'], 'tenant isolation'
                all_start=time.monotonic()
                for concurrency in (1,5,25):
                    before=snapshot(db,process.pid); samples=[]; stop=threading.Event(); start=time.monotonic()
                    def worker(i):
                        results=[]
                        for j in range(60):
                            if stop.wait(max(0,start+j*.5-time.monotonic())): break
                            t=time.monotonic(); mutation=j%10==9
                            try:
                                if mutation:
                                    s={**sources[i],'name':f'Private {i:02d} update {concurrency}-{j}'}
                                    got=clients[i].call('/api/me/sources',s)
                                    assert got['name']==s['name'], 'mutation response mismatch'
                                else: got=clients[i].call('/api/me/sources/'+sources[i]['id'])
                                assert got['id']==sources[i]['id'], 'wrong tenant source'
                                results.append({'ms':(time.monotonic()-t)*1000,'status':200,'mutation':mutation})
                            except Exception:
                                stop.set(); raise
                        return results
                    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
                        futures=[pool.submit(worker,i) for i in range(concurrency)]
                        while not all(f.done() for f in futures):
                            s=snapshot(db,process.pid); samples.append(s)
                            if s['rss_kib']>524288 or sum(p.stat().st_size for p in root.rglob('*') if p.is_file())>536870912 or time.monotonic()-all_start>180:
                                stop.set(); raise RuntimeError('resource/watchdog bound exceeded')
                            time.sleep(.5)
                        results=[v for f in futures for v in f.result()]
                    time.sleep(max(0,start+30-time.monotonic()))
                    after=snapshot(db,process.pid); ms=sorted(x['ms'] for x in results)
                    assert len(results)==60*concurrency
                    row={'concurrent_clients':concurrency,'elapsed_seconds':time.monotonic()-start,'request_count':len(results),'errors':0,'status_counts':{'200':len(results)},'mutations':sum(x['mutation'] for x in results),
                         'p50_ms':ms[math.ceil(len(ms)*.50)-1],'p95_ms':ms[math.ceil(len(ms)*.95)-1],'p99_ms':ms[math.ceil(len(ms)*.99)-1],'max_ms':ms[-1],
                         'max_cli_rss_kib':max(s['rss_kib'] for s in samples),'cli_cpu_seconds':after['cpu_seconds']-before['cpu_seconds'],'before':before,'after':after}
                    report['windows'].append(row); print(json.dumps(row),flush=True)
                for i,c in enumerate(clients):
                    got=c.call('/api/me/sources'); assert len(got)==1 and got[0]['id']==sources[i]['id']
                    assert got[0]['name']==f'Private {i:02d} update 25-59', 'final persisted update mismatch'
                report['tenant_isolation_and_fixed_source_count']=True
            finally:
                process.terminate()
                try: process.wait(timeout=15)
                except subprocess.TimeoutExpired: process.kill(); process.wait(); raise
                assert process.returncode==0, 'unclean CLI shutdown'
        report['status']='passed'; report['temporary_data_cleaned']=True
    a.output.write_text(json.dumps(report,indent=2)+'\n')
if __name__=='__main__': main()
