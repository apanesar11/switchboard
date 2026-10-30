'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const pexec = promisify(execFile);

async function snapshot() {
  const { stdout } = await pexec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{Name="Started";Expression={if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks.ToString() }}} | ConvertTo-Json -Compress'],
  { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const rows = JSON.parse(stdout.trim() || '[]');
  const kids = new Map();
  const info = new Map();
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    const pid = Number(row.ProcessId);
    const ppid = Number(row.ParentProcessId);
    if (!pid || !row.Started) continue;
    info.set(pid, { ppid, pgid: null, start: row.Started, command: row.Name });
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  return { kids, info };
}

async function killKnown(records) {
  if (!records.size) return;
  // Check creation time again in the same PowerShell process that kills the PID.
  // Never kill by port, directory or process name.
  await pexec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "SilentlyContinue"; ' +
    'foreach ($r in (ConvertFrom-Json $env:SB_PROCESS_IDENTITIES)) { ' +
    '$p = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $r.pid); ' +
    'if ($p -and $p.CreationDate.ToUniversalTime().Ticks.ToString() -eq $r.start) { ' +
    '& taskkill.exe /PID $r.pid /T /F 2>$null | Out-Null } }'],
  { windowsHide: true, timeout: 15000, env: { ...process.env,
    SB_PROCESS_IDENTITIES: JSON.stringify([...records].map(([pid, start]) => ({ pid, start }))) } });
}

module.exports = { snapshot, killKnown };
