"""Bounded synthetic CPU competition, never a claim to emulate a real game."""
import argparse,multiprocessing,time,ctypes

def load(deadline,duty):
    while time.monotonic()<deadline:
        start=time.monotonic();n=1
        while time.monotonic()-start<.1*duty:n=(n*1664525+1013904223)&0xffffffff
        time.sleep(max(0,.1-(time.monotonic()-start)))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--seconds',type=float,default=45)
    p.add_argument('--workers',type=int,default=16);p.add_argument('--duty',type=float,default=.9);a=p.parse_args()
    assert 0<a.seconds<=180 and 0<a.workers<=multiprocessing.cpu_count() and 0<a.duty<=1
    ctypes.windll.kernel32.SetThreadExecutionState(0x80000003)
    deadline=time.monotonic()+a.seconds
    jobs=[multiprocessing.Process(target=load,args=(deadline,a.duty)) for _ in range(a.workers)]
    try:
        for job in jobs:job.start()
        for job in jobs:job.join(timeout=a.seconds+5)
    finally:
        for job in jobs:
            if job.is_alive():job.terminate();job.join()
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)
