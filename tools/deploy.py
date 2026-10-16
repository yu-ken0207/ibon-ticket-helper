#!/usr/bin/env python3
"""把擴充功能部署到各台機器的安裝資料夾，讓每一台都跑同一個版本。

用法：
  python3 tools/deploy.py              部署到 tools/targets.local.json 裡的每一台
  python3 tools/deploy.py pc1 pc2      只部署到指定的幾台
  python3 tools/deploy.py --check      只比對各台和這裡是否一致，不寫入

規則：
  - 只寫入擴充功能本身的檔案，不碰安裝資料夾裡的其他檔案，例如 preset.json。
  - 寫入前把目標資料夾整個複製成「<資料夾>.bak-<舊版本>」。同一個版本只備份一次。
    Windows 上先複製到「.partial」再改名，中斷時不會留下半份卻被當成已備份。
    除了這種半份暫存和自己上傳的暫存腳本，從不刪除任何東西。
  - 寫完逐一比對 SHA-256。部署後要到 chrome://extensions 按重新載入，新版才會生效。
  - Windows 機器走 SSH 跑 PowerShell：腳本先用 scp 傳成使用者家目錄裡的暫存檔，再用很短的命令列執行，跑完刪掉。
    不從 stdin 傳：Windows 的 OpenSSH 傳大量 stdin 常卡住（2026-10-15 實測 260 KB 三到六成會卡，scp 十次都正常）。
    還是逾時的話，另開一條連線清掉卡住的部署程序和留下的暫存腳本，再重試，最多三次。
"""
import base64
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGETS_FILE = ROOT / 'tools' / 'targets.local.json'
RELEASE_FILES = ['manifest.json', 'background.js', 'alert-hook.js', 'page-agent.js',
                 'popup.html', 'popup.css', 'popup.js', 'README.md']


def release_files():
    files = (list(RELEASE_FILES)
             + sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'icons').glob('*.png'))
             + sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'lib').glob('*.js')))
    out = {}
    for rel in files:
        data = (ROOT / rel).read_bytes()
        out[rel] = (data, hashlib.sha256(data).hexdigest())
    return out


def ensure_built():
    """page-agent.js 是由 tools/build.mjs 從 src/agent/ 和 lib/ 產生的，部署前確認它是最新的"""
    node = os.environ.get('NODE') or shutil.which('node') or next(
        (p for p in [str(Path.home() / 'miniconda3' / 'bin' / 'node'), '/usr/local/bin/node', '/usr/bin/node'] if Path(p).exists()), None)
    if not node:
        sys.exit('找不到 node，沒辦法確認 page-agent.js 是不是最新的。可以用環境變數 NODE 指定')
    r = subprocess.run([node, str(ROOT / 'tools' / 'build.mjs'), '--check'], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit('page-agent.js 不是最新的，請先執行 node tools/build.mjs 再部署')


def version_of(manifest_bytes):
    try:
        return json.loads(manifest_bytes.decode('utf-8')).get('version', '')
    except Exception:
        return ''


# ───────────── 本機資料夾 ─────────────

def local_state(path):
    path = Path(path)
    mf = path / 'manifest.json'
    ver = version_of(mf.read_bytes()) if mf.exists() else ''
    if path.exists() and mf.exists() and not ver:
        raise RuntimeError(f'{mf} 讀不到版本號，為了安全不寫入')
    hashes = {}
    for rel in release_files():
        p = path / rel
        if p.exists():
            hashes[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    return ver, hashes


def deploy_local(path, files):
    path = Path(path)
    ver, _ = local_state(path)
    backup = None
    if path.exists() and ver:
        bak = path.with_name(path.name + '.bak-' + ver)
        if not bak.exists():
            shutil.copytree(path, bak)
            backup = str(bak)
    for rel, (data, _) in files.items():
        p = path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    return ver, backup, local_state(path)[1]


# ───────────── Windows（SSH + PowerShell） ─────────────

RUN_MARK = '<# kkh-deploy #>'   # 部署在 Windows 上跑的程序都以這段開頭，清理時只認它
PS_TIMEOUT = 45    # 正常幾秒就跑完；等這麼久還沒結束就當成卡住
STUCK_AGE = 20     # 部署程序啟動超過這麼多秒還在就是卡住的（正常的早就結束了）
PS_ATTEMPTS = 3
SSH_OPTS = ['-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10']


def ps_quote(s):
    return "'" + str(s).replace("'", "''") + "'"


def ps_encoded(code):
    return base64.b64encode(code.encode('utf-16-le')).decode()


def ssh_ps(host, code, timeout):
    """在 Windows 上跑一小段 PowerShell。整段放命令列、stdin 接空的，不會卡在讀 stdin"""
    return subprocess.run(['ssh', *SSH_OPTS, host, 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', ps_encoded(code)],
                          stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)


def kill_stuck(host):
    """清掉卡住的部署程序，以及它們沒刪掉的暫存腳本，回傳清掉的程序編號"""
    code = f"""{RUN_MARK}
$cut = (Get-Date).AddSeconds(-{STUCK_AGE})
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ForEach-Object {{
  $cl = [string]$_.CommandLine
  if ($_.ProcessId -ne $PID -and $_.CreationDate -lt $cut -and $cl -match '-EncodedCommand\\s+(\\S+)') {{
    $text = try {{ [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1])) }} catch {{ '' }}
    if ($text.StartsWith({ps_quote(RUN_MARK)})) {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; 'KILLED ' + $_.ProcessId }}
  }}
}}
Get-ChildItem $env:USERPROFILE -Filter 'kkh-deploy-*.ps1' | Where-Object {{ $_.LastWriteTime -lt $cut }} | Remove-Item -Force -ErrorAction SilentlyContinue
"""
    try:
        r = ssh_ps(host, code, 30)
    except subprocess.TimeoutExpired:
        return []
    return [l.split()[1] for l in r.stdout.decode('cp950', errors='replace').splitlines() if l.startswith('KILLED ')]


def run_ps(host, script, timeout=PS_TIMEOUT):
    """把腳本用 scp 傳到 Windows 使用者家目錄，執行完刪掉，回傳輸出"""
    name = f'kkh-deploy-{os.getpid()}-{secrets.token_hex(4)}.ps1'
    runner = (f"{RUN_MARK} $ProgressPreference='SilentlyContinue'; $f = Join-Path $env:USERPROFILE {ps_quote(name)}; "
              "try { . ([ScriptBlock]::Create([IO.File]::ReadAllText($f))) } finally { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }")
    with tempfile.TemporaryDirectory() as tmp:
        local = Path(tmp) / name
        local.write_bytes(script.encode('utf-8'))
        last = None
        for n in range(1, PS_ATTEMPTS + 1):
            try:
                up = subprocess.run(['scp', '-q', *SSH_OPTS, str(local), f'{host}:{name}'],
                                    stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
                if up.returncode != 0:
                    last = f'scp 失敗：{up.stderr.decode("utf-8", "replace").strip()[-300:]}'
                else:
                    r = ssh_ps(host, runner, timeout)
                    out = r.stdout.decode('cp950', errors='replace')
                    if r.returncode == 0:
                        return out
                    last = f'exit {r.returncode}: {out[-300:]} {r.stderr.decode("utf-8", "replace")[-300:]}'
            except subprocess.TimeoutExpired:
                killed = kill_stuck(host)
                last = f'等了 {timeout} 秒沒結束' + (f'，清掉卡住的程序 {"、".join(killed)}' if killed else '')
            if n < PS_ATTEMPTS:
                print(f'  {host}：PowerShell {last}，重試（第 {n + 1} 次）')
    raise RuntimeError(f'{host}: PowerShell 執行失敗（{last}）')


def ps_state_lines(dir_var):
    rels = ', '.join(ps_quote(r) for r in release_files())
    return f"""
$mf = Join-Path {dir_var} 'manifest.json'
'EXISTS ' + (Test-Path $mf)
if (Test-Path $mf) {{ 'VERSION ' + (([IO.File]::ReadAllText($mf, [Text.Encoding]::UTF8)) | ConvertFrom-Json).version }} else {{ 'VERSION ' }}
foreach ($rel in @({rels})) {{
  $p = Join-Path {dir_var} $rel
  if (Test-Path $p) {{ 'HASH ' + $rel + ' ' + (Get-FileHash $p -Algorithm SHA256).Hash.ToLower() }}
}}
'END'
"""


def parse_state(out):
    ver, hashes, exists, complete = '', {}, None, False
    for line in out.splitlines():
        line = line.strip()
        if line.startswith('EXISTS '):
            exists = line[7:].strip().lower() == 'true'
        elif line.startswith('VERSION '):
            ver = line[8:].strip()
        elif line.startswith('HASH '):
            _, rel, h = line.split(' ', 2)
            hashes[rel.replace('\\', '/')] = h.strip()
        elif line == 'END':
            complete = True
    # 讀到一半、或資料夾在卻讀不到版本號：都當成讀取失敗，不能拿來決定要不要備份
    if not complete or exists is None or (exists and not ver):
        raise RuntimeError('讀不到目前安裝的版本：' + (out.strip()[-200:] or '沒有輸出'))
    return ver, hashes


def windows_state(host, path):
    script = f"$ErrorActionPreference = 'Stop'\n$dir = {ps_quote(path)}\n" + ps_state_lines('$dir')
    try:
        return parse_state(run_ps(host, script))
    except RuntimeError:
        return parse_state(run_ps(host, script))   # 偶發讀取失敗：再試一次，還是不行就停下來


def deploy_windows(host, path, files):
    ver, _ = windows_state(host, path)
    lines = ["$ErrorActionPreference = 'Stop'", f"$dir = {ps_quote(path)}"]
    if ver:
        # 先複製到 .partial 再改名：重試前被中斷的話，只會留下 .partial，下次重做，不會把半份當成備份好了
        lines.append(f"$bak = {ps_quote(path + '.bak-' + ver)}; $tmp = $bak + '.partial'")
        lines.append("if (-not (Test-Path $bak)) { if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }; "
                     "Copy-Item -LiteralPath $dir -Destination $tmp -Recurse; Rename-Item -LiteralPath $tmp -NewName (Split-Path $bak -Leaf); "
                     "'BACKUP ' + $bak }")
    for rel, (data, _) in files.items():
        win_rel = rel.replace('/', '\\')
        lines.append(f"$p = Join-Path $dir {ps_quote(win_rel)}; New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null; "
                     f"[IO.File]::WriteAllBytes($p, [Convert]::FromBase64String('{base64.b64encode(data).decode()}'))")
    out = run_ps(host, '\n'.join(lines) + '\n' + ps_state_lines('$dir'))
    backup = next((l[7:].strip() for l in out.splitlines() if l.startswith('BACKUP ')), None)
    return ver, backup, parse_state(out)[1]


# ───────────── 主程式 ─────────────

def main(argv):
    check_only = '--check' in argv
    names = [a for a in argv if not a.startswith('--')]
    if not TARGETS_FILE.exists():
        sys.exit(f'找不到 {TARGETS_FILE}。照 tools/targets.example.json 建一份，填上各台的安裝資料夾。')
    targets = json.loads(TARGETS_FILE.read_text(encoding='utf-8'))
    if names:
        unknown = [n for n in names if n not in targets]
        if unknown:
            sys.exit(f'設定檔裡沒有這幾台：{", ".join(unknown)}')
        targets = {n: targets[n] for n in names}
    ensure_built()
    files = release_files()
    here_ver = version_of(files['manifest.json'][0])
    print(f'這裡的版本：{here_ver}，共 {len(files)} 個檔案')
    ok_all = True
    for name, t in targets.items():
        kind, path = t.get('type'), t.get('path')
        try:
            if check_only:
                ver, hashes = local_state(path) if kind == 'local' else windows_state(t['host'], path)
                backup = None
            elif kind == 'local':
                ver, backup, hashes = deploy_local(path, files)
            elif kind == 'ssh-windows':
                ver, backup, hashes = deploy_windows(t['host'], path, files)
            else:
                raise RuntimeError(f'不認得的類型 {kind}')
        except Exception as e:   # 一台失敗不影響其他台
            ok_all = False
            print(f'✗ {name}：{e}')
            continue
        diff = [rel for rel, (_, h) in files.items() if hashes.get(rel) != h]
        ok_all = ok_all and not diff
        action = '檢查' if check_only else '部署'
        state = '一致' if not diff else '不一致：' + '、'.join(diff)
        extra = f'，原本 {ver or "沒有安裝"}' + (f'，已備份到 {backup}' if backup else '')
        print(f'{"✓" if not diff else "✗"} {name} {action}{extra}，現在和這裡{state}')
    if not check_only and ok_all:
        print('記得到每一台的 chrome://extensions 按「ibon 訂票助手」的重新載入，新版才會生效。')
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
