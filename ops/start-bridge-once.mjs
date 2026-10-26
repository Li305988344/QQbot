// Kill whatever holds the bridge console port, then start exactly one bridge.
import { execSync, spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const bridgeDir = 'D:\\QQbot\\qq-bridge-01';
const lockFile = path.join(bridgeDir, 'state', 'bridge.lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidsOnPort(port) {
  const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
  const set = new Set();
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 5 && parts[1].endsWith(`:${port}`) && parts[3] === 'LISTENING') {
      set.add(parts[4]);
    }
  }
  return [...set];
}

function killPid(pid) {
  try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {}
}

console.log('[fix] stopping every bridge holder...');
for (const pid of pidsOnPort(3100)) {
  console.log('  kill 3100 holder', pid);
  killPid(pid);
}
try {
  execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'bridge\\.js' -or $_.CommandLine -match 'start\\.bat' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
    { stdio: 'ignore' }
  );
} catch {}
await sleep(2500);
try { fs.rmSync(lockFile, { force: true }); } catch {}

const isOpen = (port) => new Promise((resolve) => {
  const s = new net.Socket();
  s.setTimeout(1200);
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('timeout', () => { s.destroy(); resolve(false); });
  s.once('error', () => { s.destroy(); resolve(false); });
  s.connect(port, '127.0.0.1');
});

console.log('[fix] 3080 open:', await isOpen(3080), '| 3100 open:', await isOpen(3100));
if (!(await isOpen(3080))) {
  console.log('[fix] engine is not running; start it with reset-stack.mjs first');
}

const env = { ...process.env };
if (!env.DSH_HOME) env.DSH_HOME = 'C:\\Users\\Administrator\\.dsh';

const child = spawn('cmd.exe', ['/c', 'start', '""', 'start.bat'], {
  cwd: bridgeDir,
  env,
  detached: true,
  stdio: 'ignore',
});
child.unref();
await sleep(9000);

console.log('[fix] ports:', {
  3000: await isOpen(3000),
  3001: await isOpen(3001),
  3080: await isOpen(3080),
  3100: await isOpen(3100),
});
const tail = fs.readFileSync(path.join(bridgeDir, 'state', 'bridge.log'), 'utf8').trim().split('\n').slice(-10).join('\n');
console.log('[fix] bridge log tail:\n' + tail);
