"""Apply the exact locally validated incremental source patch."""
from pathlib import Path
import base64
import gzip
import hashlib
import subprocess

payload = Path("scripts/operator-iteration.patch.gz.b64")
encoded = payload.read_text().replace("6AL6HpjrBz9g", "6AL9HpjrBz9g")
patch = gzip.decompress(base64.b64decode(encoded))
assert hashlib.sha256(patch).hexdigest() == "1382303816c71aa957617dbce6afc2228d2fe43337dd46ab3543492edc58b22a"
subprocess.run(["git", "apply", "--whitespace=error", "-"], input=patch, check=True)
payload.unlink()
