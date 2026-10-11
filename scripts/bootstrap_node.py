"""Install a verified x64 Node build locally for Windows ARM emulation."""
import hashlib, urllib.request, zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]/'app/.sites-runtime'
root.mkdir(exist_ok=True)
version='v22.13.1'
name=f'node-{version}-win-x64.zip'
base=f'https://nodejs.org/dist/{version}/'
checks=urllib.request.urlopen(base+'SHASUMS256.txt').read().decode()
expected=next(line.split()[0] for line in checks.splitlines() if line.endswith('  '+name))
payload=urllib.request.urlopen(base+name).read()
assert hashlib.sha256(payload).hexdigest()==expected
archive=root/name
archive.write_bytes(payload)
with zipfile.ZipFile(archive) as z: z.extractall(root)
print(root/f'node-{version}-win-x64')
