#!/usr/bin/env python3
"""Finite normal-CLI overview history measurement, never a production SLO."""
import argparse, concurrent.futures, hashlib, http.cookiejar, json, math, os
from pathlib import Path
import re, secrets, sqlite3, subprocess, tempfile, threading, time, urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args): raise RuntimeError('redirect refused')
class Client:
    def __init__(self, origin):
        self.origin=origin
        self.http=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(self,path,data=None):
        request=urllib.request.Request(self.origin+path,headers={'Origin':self.origin,'Content-Type':'application/json'},data=None if data is None else json.dumps(data).encode())
        with self.http.open(request,timeout=30) as r:
            assert r.status==200
            return json.loads(r.read())
def metrics(pid,root):
    stat=Path(f'/proc/{pid}/stat').read_text().split(') ',1)[1].split()
    return {'rss_kib':int(re.search(r'VmRSS:\s+(\d+)',Path(f'/proc/{pid}/status').read_text())[1]),'cpu_seconds':(int(stat[11])+int(stat[12]))/os.sysconf('SC_CLK_TCK'),'owned_data_bytes':sum(p.stat().st_size for p in root.rglob('*') if p.is_file())}
def stop(p):
    if p.poll() is None:
        p.terminate()
        try:p.wait(timeout=15)
        except subprocess.TimeoutExpired:p.kill();p.wait();raise
    assert p.returncode==0,p.returncode

def main():
    p=argparse.ArgumentParser();p.add_argument('--binary',type=Path,required=True);p.add_argument('--fixture',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    a.output.unlink(missing_ok=True)
    report={'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'status':'running','bounds':{'process_rss_kib':524288,'owned_data_bytes':1073741824,'measurement_watchdog_seconds':240,'request_timeout_seconds':30},'profile':'26 synthetic accounts (25 loaded, one zero-history); empty then 100000 ledger rows, 4000/account; first+5 warm serial, then 2 requests/client at 1/5/25 concurrent clients with >=2 s between own request starts','environment':{'GOMAXPROCS':1,'GOMEMLIMIT':'256MiB soft target','hard_cpu_rss_limits':'unknown','native_child':'none','shared_host':'not isolated'},'setup':[],'stages':[]}
    for name in ('binary','fixture'):
        report[name+'_sha256']=hashlib.sha256(getattr(a,name).read_bytes()).hexdigest()
    def save():a.output.write_text(json.dumps(report,indent=2)+'\n')
    with tempfile.TemporaryDirectory(prefix='rw-overview-history-') as tmp:
        root=Path(tmp);db=root/'private'/'state.db'
        env={k:v for k,v in os.environ.items() if not k.startswith('ROUTEWEAVER_')}
        env.update(ROUTEWEAVER_MASTER_KEY=secrets.token_hex(32),CAPACITY_PASSWORD=secrets.token_urlsafe(32),GOMAXPROCS='1',GOMEMLIMIT='256MiB')
        for history,mode in ((0,'accounts'),(100000,'history')):
            began=time.monotonic();samples=[]
            fixture=subprocess.Popen([str(a.fixture.resolve()),str(db),mode],env=env,stdout=subprocess.DEVNULL)
            try:
                while fixture.poll() is None:
                    try:m=metrics(fixture.pid,root)
                    except FileNotFoundError:continue
                    samples.append(m)
                    if m['rss_kib']>524288 or m['owned_data_bytes']>1073741824 or time.monotonic()-began>180:
                        fixture.terminate();fixture.wait(timeout=15);raise RuntimeError('fixture resource/watchdog stop')
                    time.sleep(.25)
                assert fixture.returncode==0
            finally:
                if fixture.poll() is None:fixture.kill();fixture.wait()
            report['setup'].append({'kind':mode,'elapsed_seconds':time.monotonic()-began,'max_rss_kib':max(m['rss_kib'] for m in samples),'sampled_cpu_seconds':samples[-1]['cpu_seconds'],'owned_data_bytes':samples[-1]['owned_data_bytes']})
            with sqlite3.connect(f'file:{db}?mode=ro',uri=True) as c:
                count=c.execute("SELECT count(*) FROM records WHERE kind='ledger'").fetchone()[0]
                assert count==history
            log_path=root/f'{mode}.log'
            with log_path.open('w') as log:
                proc=subprocess.Popen([str(a.binary.resolve()),'--db',str(db),'--listen','127.0.0.1:0'],env=env,stdout=log,stderr=log)
                stage={'ledger_rows':history,'observations':[]};report['stages'].append(stage)
                began=time.monotonic()
                try:
                    while time.monotonic()-began<60:
                        assert proc.poll() is None,'CLI exited'
                        m=metrics(proc.pid,root)
                        if m['rss_kib']>524288 or m['owned_data_bytes']>1073741824:raise RuntimeError('startup resource stop')
                        match=re.search(r'listening at (http://127\.0\.0\.1:\d+)',log_path.read_text())
                        if match:break
                        time.sleep(.1)
                    else:raise RuntimeError('CLI readiness timeout')
                    stage['startup_seconds']=time.monotonic()-began
                    with sqlite3.connect(f'file:{db}?mode=ro',uri=True,timeout=5) as c:
                        stage['index_rows']={name:c.execute('SELECT count(*) FROM '+name).fetchone()[0] for name in ('usage_history','usage_history_owners','usage_history_state')}
                        try: stage['index_allocated_pages_bytes']=dict(c.execute("SELECT name,sum(pgsize) FROM dbstat WHERE name LIKE '%usage_history%' GROUP BY name"))
                        except sqlite3.OperationalError: stage['index_allocated_pages_bytes']='dbstat unavailable'
                        stage['database_files']={p.name:p.stat().st_size for p in db.parent.glob('state.db*')}

                    clients=[]
                    for i in range(26):
                        m=metrics(proc.pid,root)
                        if m['rss_kib']>524288 or m['owned_data_bytes']>1073741824:raise RuntimeError('login setup resource stop')
                        c=Client(match[1]);c.call('/api/auth/login',{'username':f'capacity-{i:02d}','password':env['CAPACITY_PASSWORD']});clients.append(c)
                    baseline=metrics(proc.pid,root);observed=[];abort=threading.Event();monitor_start=time.monotonic()
                    def monitor():
                        while not abort.wait(.25):
                            m=metrics(proc.pid,root);observed.append(m)
                            if m['rss_kib']>524288 or m['owned_data_bytes']>1073741824 or time.monotonic()-monitor_start>240:
                                proc.terminate();abort.set();return
                    watch=threading.Thread(target=monitor);watch.start()
                    def request(i):
                        t=time.monotonic()
                        try:
                            got=clients[i].call('/api/me/overview');usage=got['usage'];mult=4000 if history and i < 25 else 0
                            assert usage=={'rawBytes':mult*(i+1),'weightedBytes':mult*(i+1)*3//2,'providerBytes':mult*(i+1)*2},usage
                            return {'ms':(time.monotonic()-t)*1000,'status':200,'exact_usage':True}
                        except Exception as e:return {'ms':(time.monotonic()-t)*1000,'status':'error','error_type':type(e).__name__}
                    try:
                        first=request(0);stage['first']=first;print(json.dumps({'ledger_rows':history,'first':first}),flush=True);save()
                        if first['status']!=200:raise RuntimeError('first overview failed')
                        stage['warm']=[request(0) for _ in range(5)];stage['zero_history_probe']=[request(25) for _ in range(3)];save()
                        assert all(x['status']==200 for x in stage['zero_history_probe'])
                        assert all(x['status']==200 for x in stage['warm'])
                        for concurrency in (1,5,25):
                            start=time.monotonic();cpu=metrics(proc.pid,root)['cpu_seconds']
                            def worker(i):
                                results=[]
                                for _ in range(2):
                                    t=time.monotonic();results.append(request(i))
                                    if results[-1]['status']!=200:break
                                    time.sleep(max(0,2-(time.monotonic()-t)))
                                return results
                            with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:results=[v for result in pool.map(worker,range(concurrency)) for v in result]
                            lat=sorted(v['ms'] for v in results)
                            summary={'concurrent_clients':concurrency,'elapsed_seconds':time.monotonic()-start,'requests':len(results),'errors':sum(x['status']!=200 for x in results),'p50_ms':lat[math.ceil(.5*len(lat))-1],'p95_ms':lat[math.ceil(.95*len(lat))-1],'max_ms':lat[-1],'cpu_seconds':metrics(proc.pid,root)['cpu_seconds']-cpu,'results':results}
                            stage['observations'].append(summary);print(json.dumps({'ledger_rows':history,**summary}),flush=True);save()
                            if summary['errors'] or abort.is_set():raise RuntimeError('stop escalation after request/resource error')
                    finally:
                        abort.set();watch.join();stage['before']=baseline;stage['after']=metrics(proc.pid,root);stage['max_rss_kib']=max([baseline['rss_kib']]+[m['rss_kib'] for m in observed]);save()
                        stage['final_database_files']={p.name:p.stat().st_size for p in db.parent.glob('state.db*')}
                        stage['process_log_bytes']=log_path.stat().st_size
                        stage['background_notification_log_lines']=sum('Background notifications:' in line for line in log_path.read_text().splitlines())
                        save()
                except Exception as e:
                    report['status']='stopped';report['reason']=str(e);save();raise
                finally:
                    stop(proc)
                    private_log=a.output.with_name(a.output.stem+'.'+mode+'.process.log')
                    fd=os.open(private_log,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
                    with os.fdopen(fd,'w') as out:out.write(log_path.read_text())
            save()
        report['status']='passed';report['temporary_data_cleaned']=True
    save()
if __name__=='__main__':main()
