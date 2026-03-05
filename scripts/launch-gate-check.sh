#!/usr/bin/env bash
set -euo pipefail

HOURS="${1:-24}"
if ! [[ "$HOURS" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 [hours]" >&2
  exit 2
fi

python3 - "$HOURS" <<'PY'
import datetime, os, re, sys, collections
hours=int(sys.argv[1])
cutoff=datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=hours)
path=os.path.expanduser('~/.openclaw/logs/openclaw.log')
err_path=os.path.expanduser('~/.openclaw/logs/gateway.err.log')
iso=re.compile(r'"date":"([0-9T:\.-]+Z)"')
err_iso=re.compile(r'^([0-9T:\.-]+Z)\s')
pat={
  'oauth_refresh_401': re.compile(r'openai-codex.*Token refresh failed: 401|OAuth token refresh failed', re.I),
  'rpc_probe_failed': re.compile(r'RPC probe: failed|gateway closed \(1006|port 18789 is not listening', re.I),
  'launchctl_timeout': re.compile(r'spawnSync launchctl ETIMEDOUT|full process restart failed', re.I),
  'brave_429': re.compile(r'Brave Search API error \(429\)|rate limit exceeded', re.I),
  'gigabrain_provenance_warn': re.compile(r'\[plugins\]\s+gigabrain: loaded without install/load-path provenance', re.I),
  'tools_allow_unknown_warn': re.compile(r'tools\.allow allowlist contains unknown entries', re.I),
}
counts=collections.Counter(); samples={}
if os.path.exists(path):
  with open(path,'r',errors='ignore') as f:
    for i,line in enumerate(f,1):
      m=iso.search(line)
      if not m:
        continue
      try:
        ts=datetime.datetime.fromisoformat(m.group(1).replace('Z','+00:00'))
      except Exception:
        continue
      if ts<cutoff:
        continue
      for k,p in pat.items():
        if p.search(line):
          counts[k]+=1
          samples.setdefault(k,(m.group(1),i,line.strip()[:220]))

# hard-check for gigabrain crashes in gateway.err.log, but only within window
crash_count=0
crash_sample=None
if os.path.exists(err_path):
  with open(err_path,'r',errors='ignore') as f:
    for i,line in enumerate(f,1):
      m=err_iso.search(line)
      if not m:
        continue
      try:
        ts=datetime.datetime.fromisoformat(m.group(1).replace('Z','+00:00'))
      except Exception:
        continue
      if ts<cutoff:
        continue
      if 'gigabrain' in line.lower() and re.search(r'error|exception|failed|traceback', line, re.I):
        crash_count += 1
        if crash_sample is None:
          crash_sample=(m.group(1),i,line.strip()[:220])
counts['gigabrain_errlog_error_lines']=crash_count

print(f'launch_gate_window_hours={hours}')
for k in [
  'oauth_refresh_401',
  'rpc_probe_failed',
  'launchctl_timeout',
  'gigabrain_errlog_error_lines',
  'tools_allow_unknown_warn',
  'gigabrain_provenance_warn',
  'brave_429',
]:
  print(f'{k}\t{counts.get(k,0)}')

print('--- samples ---')
for k in samples:
  ts,ln,msg=samples[k]
  print(f'{k}\t{ts}\tline={ln}\t{msg}')
if crash_sample:
  ts,ln,msg=crash_sample
  print(f'gigabrain_errlog_error_lines\t{ts}\tline={ln}\t{msg}')

blockers=(
  counts.get('oauth_refresh_401',0)
  + counts.get('rpc_probe_failed',0)
  + counts.get('launchctl_timeout',0)
  + counts.get('gigabrain_errlog_error_lines',0)
)
if blockers == 0:
  print('GATE_RESULT\tPASS')
  sys.exit(0)
print('GATE_RESULT\tFAIL')
sys.exit(1)
PY
