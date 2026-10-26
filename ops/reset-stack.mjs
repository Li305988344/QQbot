// Reset the QQ bridge stack: kill leftovers, start the DSH engine on 3080,
// then start exactly one bridge instance and report the结果.
import { execSync, spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const root = 'D:\\QQbot';
const bridgeDir = path.join(root, 'qq-bridge-01');
// 唯一的 DSH 引擎来源：deepseek_harness 自带的 CLI。
// （原来指向 dsh-engine 的独立副本，那份是 0.2.1-rc.2 的旧拷贝且从未被启动过，已删除。）
const dshCli = path.join(root, 'deepseek_harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
const lockFile = path.join(bridgeDir, 'state', 'bridge.lock');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kill(filter) {
  const out = execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${filter}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
    { stdio: 'pipe' }
  );
  return out;
}

function isOpen(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(1200);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.connect(port, '127.0.0.1');
  });
}

console.log('[reset] stopping leftovers...');
try { kill("start\\\\.bat"); } catch {}
await sleep(1000);
try { kill("bridge\\\\.js"); } catch {}

try { kill("dsh-desktop-host"); } catch {}
await sleep(2000);
try { fs.rmSync(lockFile, { force: true }); } catch {}

console.log('[reset] ports before:', {
  3000: await isOpen(3000),
  3080: await isOpen(3080),
  3100: await isOpen(3100),
});

if (!(await isOpen(3080))) {
  if (!fs.existsSync(dshCli)) {
    console.log('[reset] WARN: DSH CLI not found: ' + dshCli);
  } else {
    console.log('[reset] starting DSH engine on 3080...');
    const child = spawn(`"${dshCli}" web --host 127.0.0.1 --port 3080 --no-open`, {
      shell: true,
      cwd: root,
      env: { ...process.env, DSH_HOME: 'C:\\Users\\Administrator\\.dsh' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    await sleep(12000);
  }
}

console.log('[reset] 3080 open:', await isOpen(3080));

console.log('[reset] starting bridge...');
const bridge = spawn('cmd.exe', ['/c', 'start', '""', 'start.bat'], {
  cwd: bridgeDir,
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
});
bridge.unref();
await sleep(8000);

console.log('[reset] ports after:', {
  3000: await isOpen(3000),
  3001: await isOpen(3001),
  3080: await isOpen(3080),
  3100: await isOpen(3100),
});

const logPath = path.join(bridgeDir, 'state', 'bridge.log');
const tail = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-12).join('\n');
console.log('[reset] bridge log tail:\n' + tail);
