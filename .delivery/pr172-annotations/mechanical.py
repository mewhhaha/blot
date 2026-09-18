from pathlib import Path
import subprocess,re
root=Path.cwd()
files=subprocess.check_output(['git','ls-files'],cwd=root,text=True).splitlines()
changed=[]
for f in files:
 p=root/f
 if p.is_symlink() or f.startswith('generated/'):continue
 if p.suffix not in {'.blot','.ts','.rs','.md','.baba','.json'}:continue
 if p.suffix=='.json' and f!='docs/language-claims.json':continue
 if f=='docs/gpu-profile.md' or (f.startswith('experiments/') and p.suffix=='.md' and ('RESULT' in p.name or 'WIP' in p.name)):continue
 if f.startswith('scripts/generate') and p.suffix=='.ts':continue
 t=p.read_text()
 if '::' not in t:continue
 u=re.sub(r'[ \t]+::(?=[\s"\\\x27`\)]|$)',':',t)
 if p.suffix=='.ts':u=u.replace('::',':')
 elif p.suffix=='.baba':u=u.replace('"::"','":"')
 elif p.suffix in {'.md','.rs'}:u=u.replace('`::`','`:`')
 if u!=t:p.write_text(u);changed.append(f)
print(len(changed),'files migrated')
