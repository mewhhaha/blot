#!/usr/bin/env bash
# T2 decisive probe matrix: 8 ops x {prefix,full} x 5 reps, fresh process each.
# Retains raw.jsonl + provenance before/after; closure drift rejects the batch.
# Run from the repo root: bash experiments/compiler-bench/cold-semantic/t2_probe_matrix.sh
set -u
D=experiments/compiler-bench/cold-semantic
OUT=$D/t2_probes
FIX1=$PWD/$D/prefix.blot
FIX2=$PWD/$D/full.blot
PROBE=$PWD/$D/t2_probe.ts
DENO=${DENO:-$HOME/.deno/bin/deno}
REPS=${REPS:-5}

capture() {
  local f=$1
  python3 - "$f" <<'EOF'
import json,sys,subprocess,hashlib,os
out=sys.argv[1]
def sha(p):
  try:
    h=hashlib.sha256()
    with open(p,'rb') as fh:
      for ch in iter(lambda: fh.read(65536),b''): h.update(ch)
    return h.hexdigest()
  except OSError:
    return None
def git(*a):
  return subprocess.run(['git',*a],capture_output=True,text=True).stdout.strip()
doc={
  'commit': git('rev-parse','HEAD'),
  'worktreeStatus': git('status','--short'),
  'denoVersion': subprocess.run([os.environ.get('DENO',os.path.expanduser('~/.deno/bin/deno')),'--version'],capture_output=True,text=True).stdout.splitlines()[0] if True else None,
  'denoExecutableSha256': sha(os.environ.get('DENO',os.path.expanduser('~/.deno/bin/deno'))),
  'probeSha256': sha(os.environ['PROBE']),
  'fixtureSha256': {os.environ['FIX1']: sha(os.environ['FIX1']), os.environ['FIX2']: sha(os.environ['FIX2'])},
  'compilerArtifactSha256': sha('generated/compiler/compiler.wasm'),
  'compilerManifestSha256': sha('generated/compiler/compiler-artifact.json'),
  'preludeSha256': sha('generated/compiler/prelude.snapshot'),
}
json.dump(doc,open(out,'w'),indent=2)
print(out,'artifact:',(doc['compilerArtifactSha256'] or '?')[:12])
EOF
}

export DENO PROBE FIX1 FIX2
mkdir -p "$OUT"
capture "$OUT/provenance_before.json"

OPS=(check analyze prepare prepare_then_compile analyze_twice check_then_analyze second_compiler prime_trivial)
FIXTURES=("$FIX1" "$FIX2")
: > "$OUT/raw.jsonl"
slot=0
for ((rep=0; rep<REPS; rep++)); do
  for ((i=0; i<${#OPS[@]}; i++)); do
    for ((j=0; j<${#FIXTURES[@]}; j++)); do
      op=${OPS[$(( (i+rep) % ${#OPS[@]} ))]}
      fix=${FIXTURES[$(( (j+rep) % ${#FIXTURES[@]} ))]}
      start=$(date +%s%N)
      sample=$("$DENO" run --allow-read --allow-env --allow-sys "$PROBE" --fixture="$fix" --op="$op" --telemetry=phase 2>/dev/null)
      code=$?
      end=$(date +%s%N)
      wallMs=$(python3 -c "print(($end-$start)/1e6)")
      ok=$(echo "$sample" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok') is True)" 2>/dev/null || echo PARSE_FAIL)
      firstMs=$(echo "$sample" | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join('%.0f'%c['ms'] for c in d.get('calls',[])))" 2>/dev/null || echo '?')
      # Append raw record (sample embedded verbatim).
      python3 - "$OUT/raw.jsonl" <<EOF2
import json
sample = '''$sample'''.replace("'''", "''")
try:
  parsed = json.loads('''$sample''')
except Exception:
  parsed = {'schema': 1, 'ok': False, 'class': 'harness-error', 'raw': '''$sample'''[:200]}
rec = {'rep': $rep, 'slot': $slot, 'op': '$op', 'fixture': '$fix', 'exit': $code, 'wallMs': $wallMs, 'sample': parsed}
with open('$OUT/raw.jsonl', 'a') as fh:
  fh.write(json.dumps(rec) + '\n')
EOF2
      echo "rep=$rep slot=$slot op=$op fixture=$(basename "$fix") exit=$code ok=$ok ms=[$firstMs] wallMs=$wallMs"
      slot=$((slot+1))
    done
  done
done

capture "$OUT/provenance_after.json"
python3 - <<'EOF'
import json
b=json.load(open('experiments/compiler-bench/cold-semantic/t2_probes/provenance_before.json'))
a=json.load(open('experiments/compiler-bench/cold-semantic/t2_probes/provenance_after.json'))
keys=['commit','denoVersion','denoExecutableSha256','probeSha256','fixtureSha256','compilerArtifactSha256','compilerManifestSha256','preludeSha256']
stable=all(b[k]==a[k] for k in keys)
json.dump({'provenanceStable':stable},open('experiments/compiler-bench/cold-semantic/t2_probes/stability.json','w'))
print('STABLE' if stable else 'DRIFT-REJECTED', {k:(b[k]==a[k]) for k in keys})
EOF
