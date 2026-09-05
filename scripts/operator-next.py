"""Apply the reviewed incremental patch, checking its exact content first."""
from pathlib import Path
import base64
import gzip
import hashlib
import subprocess

payload = Path("scripts/operator-iteration.patch.gz.b64")
# Correct a transport transcription error; the digest below guards all bytes.
encoded = payload.read_text().replace("cBZJ/IbzzJjVj2SuBRx", "cBZJ/IbzzJjV2SuBRx")
patch = gzip.decompress(base64.b64decode(encoded))
assert hashlib.sha256(patch).hexdigest() == "f02a6210f3d4301d344cf8cb274dbf9b9c28b52679adf541b1dfb8dc45d19685"
subprocess.run(["git", "apply", "--whitespace=error", "-"], input=patch, check=True)
payload.unlink()
