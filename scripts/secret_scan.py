"""Scan publishable source, built output, and reachable Git blobs without printing secrets."""
from pathlib import Path
import re, subprocess, sys
root=Path(__file__).resolve().parents[1]
patterns=[re.compile(rb'bh_[A-Za-z0-9_-]{18,}'),re.compile(rb'gh[pousr]_[A-Za-z0-9]{20,}'),re.compile(rb'github_pat_[A-Za-z0-9_]{20,}')]
varsfile=root/'app/.dev.vars'
if varsfile.exists():
    for line in varsfile.read_bytes().splitlines():
        if line.startswith((b'CRM_TOKEN=',b'PROXY_KEY=',b'CRON_SECRET=',b'SITES_SERVICE_TOKEN=')):
            value=line.split(b'=',1)[1].strip().strip(b'"').strip(b"'")
            if value: patterns.append(re.compile(re.escape(value)))
excluded={'.git','node_modules','.sites-runtime','.wrangler','.vinext','.next','private','__pycache__','.agents','.codex'}
hits=[];count=0
def walk(folder):
    for p in folder.iterdir():
        if p.name in excluded or p.is_symlink():continue
        if p.is_dir():yield from walk(p)
        elif not p.name.startswith(('.env','.dev.vars')):yield p
for p in walk(root):
    data=p.read_bytes();count+=1
    if any(pattern.search(data) for pattern in patterns):hits.append(str(p.relative_to(root)))
for repo in (root,root/'app'):
    if not (repo/'.git').exists():continue
    inventory=subprocess.run(['git','rev-list','--objects','--all'],cwd=repo,capture_output=True)
    if inventory.returncode:
        print('FAIL: cannot inspect Git history at '+str(repo.relative_to(root))+'. Resolve Git access before publishing.')
        sys.exit(1)
    objects=inventory.stdout.splitlines()
    for line in objects:
        oid=line.split(b' ',1)[0]
        blob=subprocess.run(['git','cat-file','-p',oid.decode()],cwd=repo,capture_output=True)
        if blob.returncode:
            print('FAIL: cannot read a reachable Git object. Resolve Git access before publishing.')
            sys.exit(1)
        data=blob.stdout
        if any(pattern.search(data) for pattern in patterns):hits.append('git:'+oid.decode())
print(f'Scanned {count} publishable files plus reachable Git objects.')
print('PASS: no configured credentials or token patterns found.' if not hits else 'FAIL: credential matches in '+', '.join(hits))
sys.exit(bool(hits))
