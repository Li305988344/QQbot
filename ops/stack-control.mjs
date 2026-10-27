// stack-control.mjs -- start / stop / status for the whole QQ bot stack.
//
//   node stack-control.mjs start    start SnowLuma + DSH engine + qq-bridge-01/02
//   node stack-control.mjs stop     stop all three (bridge first, then deps)
//   node stack-control.mjs status   only report what is listening
//
// The batch wrappers start-all.bat / stop-all.bat just call this file, so the
// real logic stays in one place. Idempotent: already-running services are left
// alone, missing ones are started.
//
// Ports:
//   3000 / 3001  SnowLuma OneBot HTTP + WebSocket (bot A)
//   3010 / 3011  SnowLuma OneBot HTTP + WebSocket (bot B)
//   3080         DSH engine (fixed address the bridge dials)
//   3100         qq-bridge-01 console + API
//   3200         qq-bridge-02 console + API
//   5099         SnowLuma web UI
//   5110         unified console switcher
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// 本文件住在 <repo>/ops/，项目根目录是它的上一级。
// （曾写在根目录，用 dirname(import.meta.url) 直接当 ROOT；搬进 ops/ 后必须退一级，
//   否则 SnowLuma / qq-bridge-01 / qq-bridge-02 / deepseek_harness 全都会指到 ops/ 下面。）
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SNOWLUMA_DIR = path.join(ROOT, 'SnowLuma');
const BRIDGE_DIR = path.join(ROOT, 'qq-bridge-01');
// 用户安装的 DeepSeek Harness 自带的 CLI（**唯一** DSH 引擎来源）
// 历史：这里曾有一个备选 `dsh-engine/`（@deepseek-ai/dsh@0.2.1-rc.2 的独立副本，583 MB）。
// 实测它从未被启用过——DSH_CLI 一直存在，下面的 startDshEngine() 永远走第一支；
// 而 3080 端口上真正服务的是 harness 里的 rc.3。留着它只会让“版本对账”对错对象，已删除。
const DSH_CLI = path.join(ROOT, 'deepseek_harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
const LOCK_FILE = path.join(BRIDGE_DIR, 'state', 'bridge.lock');
const CONSOLE_TOKEN_FILE = path.join(BRIDGE_DIR, 'state', 'console-token');

// 第二个桥接实例：服务另一个机器人账号，接 SnowLuma 的 3010/3011。
// 桥接本身只支持单个 snowluma 端点，所以多账号 = 多实例、各自独立目录与端口。
const BRIDGE2_DIR = path.join(ROOT, 'qq-bridge-02');
const LOCK2_FILE = path.join(BRIDGE2_DIR, 'state', 'bridge.lock');

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const TASKKILL = path.join(SYSTEM_ROOT, 'System32', 'taskkill.exe');
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CMD = path.join(SYSTEM_ROOT, 'System32', 'cmd.exe');
const NODE_EXE = process.execPath;
const DSH_HOME = path.join(os.homedir(), '.dsh');

const PORTS = {
  snowlumaHttp: 3000,
  snowlumaWs: 3001,
  snowlumaHttp2: 3010,
  snowlumaWs2: 3011,
  dsh: 3080,
  bridge: 3100,
  bridge2: 3200,
  snowlumaUi: 5099,
  switcher: 5110,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

function listProcesses() {
  try {
    const out = execSync(
      `"${POWERSHELL}" -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"`,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    const text = out.trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function killPid(pid) {
  try {
    execSync(`"${TASKKILL}" /F /PID ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const matches = (proc, pattern) => typeof proc.CommandLine === 'string' && pattern.test(proc.CommandLine);

function stopWhere(predicate, label) {
  const targets = listProcesses().filter(predicate);
  if (targets.length === 0) {
    console.log(`  ${label}: 未运行`);
    return 0;
  }
  let killed = 0;
  for (const proc of targets) {
    if (killPid(proc.ProcessId)) {
      killed += 1;
      console.log(`  ${label}: 已停止 PID ${proc.ProcessId}`);
    } else {
      console.log(`  ${label}: 无法停止 PID ${proc.ProcessId}（可能需要管理员权限）`);
    }
  }
  return killed;
}

async function report() {
  const rows = [
    ['SnowLuma HTTP(大肥鱼)', PORTS.snowlumaHttp],
    ['SnowLuma WS(大肥鱼)', PORTS.snowlumaWs],
    ['SnowLuma HTTP(小黑)', PORTS.snowlumaHttp2],
    ['SnowLuma WS(小黑)', PORTS.snowlumaWs2],
    ['SnowLuma 控制台', PORTS.snowlumaUi],
    ['DSH 引擎', PORTS.dsh],
    ['桥接 大肥鱼', PORTS.bridge],
    ['桥接 小黑', PORTS.bridge2],
    ['统一切换页', PORTS.switcher],
  ];
  for (const [label, port] of rows) {
    const open = await isOpen(port);
    console.log(`  ${open ? '✔' : '✘'} ${label.padEnd(16)} 127.0.0.1:${port}`);
  }
}

function readConsoleToken() {
  try {
    return fs.readFileSync(CONSOLE_TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function startSnowLuma() {
  const localNode = path.join(SNOWLUMA_DIR, 'node.exe');
  const nodeForSnowLuma = fs.existsSync(localNode) ? localNode : NODE_EXE;
  const child = spawn(nodeForSnowLuma, ['index.mjs'], {
    cwd: SNOWLUMA_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function startDshEngine() {
  // 优先用用户安装的 DeepSeek Harness 自带 CLI，这样版本与桌面端一致。
  if (fs.existsSync(DSH_CLI)) {
    // 不能用 `spawn(cmd, ['/c', 'set "X=..." && "path" ...'])`：
    // Node 会把整串加引号传给 cmd，而 cmd /c 会剥掉首尾引号，
    // 于是 `"D:\...\dsh.cmd"` 变成 `"D:\...\dsh.cmd"` 里层引号错位，
    // 报「'"..."' 不是内部或外部命令」。交给 shell:true 由 Node 生成
    // 合规的 `cmd /d /s /c "..."` 命令行，环境变量也改由 env 传入。
    // DSH_PERMISSION_MODE 是 dsh-base 自己读取的部署级开关（见其 cordis.patch.yml）：
    //   sandbox-policy.mode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    //   approval.policy     = (同一变量) === 'danger-full-access' ? 'never' : 'ask'
    // 不设它的话进程级默认是 workspace-write + ask，任何「已 seeded 但没有
    // sandbox/approval 事件」的旧会话打开后都会退回到逐次审批（Allow once）。
    const child = spawn(
      `"${DSH_CLI}" web --host 127.0.0.1 --port ${PORTS.dsh} --no-open`,
      {
        shell: true,
        cwd: ROOT,
        env: { ...process.env, DSH_HOME, DSH_PERMISSION_MODE: 'danger-full-access' },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }
    );
    child.unref();
    return true;
  }
  if (!fs.existsSync(DSH_CLI)) {
    console.log(`  DSH 引擎: 找不到 DeepSeek Harness CLI（${DSH_CLI}），跳过`);
    return false;
  }
  return true;
}

function startBridge() {
  const child = spawn(NODE_EXE, ['src/bridge.js'], {
    cwd: BRIDGE_DIR,
    env: { ...process.env, DSH_HOME },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function startBridge2() {
  if (!fs.existsSync(BRIDGE2_DIR)) {
    console.log(`  桥接 小黑: 找不到 ${BRIDGE2_DIR}，跳过`);
    return false;
  }
  syncBridge2Sources();
  const child = spawn(NODE_EXE, ['src/bridge.js'], {
    cwd: BRIDGE2_DIR,
    env: { ...process.env, DSH_HOME },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return true;
}

/**
 * 把实例①的 src/*.js 同步到实例②。
 *
 * 为什么需要：第二个桥接是**目录拷贝**（只有 node_modules 是联接），src 是各自一份。
 * 于是每次改 `qq-bridge-01/src/`（加工具、修 bug）都不会自动进入第二个实例，
 * 表现就是「大肥鱼有新功能，小黑报 404 / 工具不存在」——这种漂移非常难查，
 * 因为两边代码几乎一样、日志也正常。
 *
 * 为什么不用目录联接代替拷贝：`node src/bridge.js` 通过联接时会 realpath 到真实目录，
 * `__dirname` 变成实例①的路径 ⇒ 实例②的 ROOT 也指向实例①，两边抢同一个
 * state/bridge.lock 与 social-v2.json，第二个直接把「已有实例在运行」然后退出。
 *
 * 只同步 `.js` 源文件；config.json / state / node_modules 一律不动（那是实例私有的）。
 */
function syncBridge2Sources() {
  const from = path.join(BRIDGE_DIR, 'src');
  const to = path.join(BRIDGE2_DIR, 'src');
  if (!fs.existsSync(from) || !fs.existsSync(to)) return;
  const copied = [];
  for (const name of fs.readdirSync(from)) {
    if (!name.endsWith('.js')) continue;
    const src = path.join(from, name);
    const dst = path.join(to, name);
    try {
      const a = fs.readFileSync(src);
      const b = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
      if (b && a.equals(b)) continue;
      fs.writeFileSync(dst, a);
      copied.push(name);
    } catch (error) {
      console.log(`  桥接 小黑: 同步 ${name} 失败（${error?.message ?? error}）`);
    }
  }
  if (copied.length) console.log(`  桥接 小黑: 已同步源码 ${copied.join(', ')}`);
  return copied;
}

function startSwitcher() {
  const child = spawn(NODE_EXE, [path.join(ROOT, 'ops', 'console-switch-server.mjs')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function waitFor(port, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOpen(port)) {
      console.log(`  ${label}: 已就绪（${port}）`);
      return true;
    }
    await sleep(500);
  }
  console.log(`  ${label}: 等待超时（${port} 未监听）`);
  return false;
}

async function start() {
  console.log('[start-all] 启动顺序：SnowLuma → DSH 引擎 → 桥接 ×2 → 统一切换页');

  // 先把实例①的 src 同步到实例②（两个桥接是目录拷贝，src 各自一份）。
  // 放在最前面：即使两个桥接都已在运行、本轮不重启，也能保证磁盘上的代码一致，
  // 但要提醒"正在跑的进程还是旧代码"——否则会出现"文件明明改过却没生效"的困惑。
  const syncedFiles = syncBridge2Sources() ?? [];
  const bridge2Running = await isOpen(PORTS.bridge2);
  if (syncedFiles.length && bridge2Running) {
    console.log('  ⚠ 桥接 小黑 正在用旧代码运行，重启后新代码才生效：node stack-control.mjs stop && start');
  }

  // Opportunistic cleanup: a stale lock from a crashed bridge blocks the start.
  // The lock file holds the owner PID, so liveness is checked directly — a global
  // `bridge.js` match would confuse the two bridge instances with each other.
  for (const [lock, port, label] of [
    [LOCK_FILE, PORTS.bridge, '桥接 大肥鱼'],
    [LOCK2_FILE, PORTS.bridge2, '桥接 小黑'],
  ]) {
    if ((await isOpen(port)) || !fs.existsSync(lock)) continue;
    let alive = false;
    try {
      const pid = Number(fs.readFileSync(lock, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) alive = listProcesses().some((p) => p.ProcessId === pid);
    } catch { /* unreadable lock is treated as stale */ }
    if (!alive) {
      fs.rmSync(lock, { force: true });
      console.log(`  清理了 ${label} 残留的 bridge.lock`);
    }
  }

  if (await isOpen(PORTS.snowlumaHttp)) {
    console.log('  SnowLuma: 已在运行，跳过');
  } else {
    console.log('  SnowLuma: 启动中…');
    startSnowLuma();
    await waitFor(PORTS.snowlumaHttp, 60000, 'SnowLuma HTTP(大肥鱼)');
    await waitFor(PORTS.snowlumaWs, 20000, 'SnowLuma WS(大肥鱼)');
  }
  await waitFor(PORTS.snowlumaHttp2, 15000, 'SnowLuma HTTP(小黑)');
  await waitFor(PORTS.snowlumaWs2, 15000, 'SnowLuma WS(小黑)');

  if (await isOpen(PORTS.dsh)) {
    console.log('  DSH 引擎: 已在运行，跳过');
  } else {
    console.log('  DSH 引擎: 启动中…');
    if (startDshEngine()) {
      await waitFor(PORTS.dsh, 60000, 'DSH 引擎');
    }
  }

  if (await isOpen(PORTS.bridge)) {
    console.log('  桥接 大肥鱼: 已在运行，跳过');
  } else {
    console.log('  桥接 大肥鱼: 启动中…');
    startBridge();
    await waitFor(PORTS.bridge, 45000, '桥接 大肥鱼');
  }

  if (await isOpen(PORTS.bridge2)) {
    console.log('  桥接 小黑: 已在运行，跳过');
  } else {
    console.log('  桥接 小黑: 启动中…');
    if (startBridge2()) await waitFor(PORTS.bridge2, 45000, '桥接 小黑');
  }

  if (await isOpen(PORTS.switcher)) {
    console.log('  统一切换页: 已在运行，跳过');
  } else {
    console.log('  统一切换页: 启动中…');
    startSwitcher();
    await waitFor(PORTS.switcher, 20000, '统一切换页');
  }

  console.log('\n[start-all] 当前状态');
  await report();

  const token = readConsoleToken();
  const consoleUrl = token
    ? `http://127.0.0.1:${PORTS.bridge}/?token=${encodeURIComponent(token)}`
    : `http://127.0.0.1:${PORTS.bridge}/`;
  console.log(`\n  桥接控制台: ${consoleUrl}`);
  console.log(`  SnowLuma 控制台: http://127.0.0.1:${PORTS.snowlumaUi}/processes`);
  console.log(`  统一切换页: http://127.0.0.1:${PORTS.switcher}/`);

  // 打开一个统一切换页：左上角可切换桥接控制台与 SnowLuma。
  if (!process.argv.includes('--no-open')) {
    try {
      const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
      const rundll32 = path.join(windowsRoot, 'System32', 'rundll32.exe');
      spawn(rundll32, ['url.dll,FileProtocolHandler', 'http://127.0.0.1:5110/'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      console.log('  已在浏览器打开统一控制台: http://127.0.0.1:5110/');
    } catch {
      console.log('  无法自动打开浏览器，请手动打开 http://127.0.0.1:5110/');
    }
  }
}

async function stop() {
  console.log('[stop-all] 停止顺序：桥接 → DSH 引擎 → SnowLuma');

  stopWhere(
    (p) => p.Name === 'cmd.exe' && matches(p, /start\.bat/i),
    '桥接启动循环'
  );
  await sleep(800);

  stopWhere(
    (p) => p.Name === 'node.exe' && matches(p, /bridge\.js/i),
    '桥接进程'
  );
  await sleep(800);

  for (const lock of [LOCK_FILE, LOCK2_FILE]) {
    if (fs.existsSync(lock)) {
      fs.rmSync(lock, { force: true });
      console.log(`  已删除 ${path.basename(path.dirname(path.dirname(lock)))} 的 state/bridge.lock`);
    }
  }

  stopWhere(
    (p) => p.Name === 'node.exe' && matches(p, /SnowLuma/i) && matches(p, /index\.mjs/i),
    'SnowLuma'
  );

  // 用户安装的 DeepSeek Harness 引擎：由 dsh.cmd 以 Electron-as-node 方式拉起，
  // 进程名是 "DeepSeek Harness.exe"，命令行带 --expose-internals 与 web 参数。
  stopWhere(
    (p) => p.Name === 'DeepSeek Harness.exe' && matches(p, /--expose-internals/i) && matches(p, /\bweb\b/i),
    'DSH 引擎（DeepSeek Harness）'
  );

  stopWhere(
    (p) => p.Name === 'node.exe' && matches(p, /console-switch-server/i),
    '统一切换页'
  );

  await sleep(1200);
  console.log('\n[stop-all] 剩余监听');
  await report();
  console.log('\n  提示：QQ 客户端不会被关闭，SnowLuma 只是停止挂接。');
}

const action = (process.argv[2] || '').toLowerCase();
if (action === 'start') {
  await start();
} else if (action === 'stop') {
  await stop();
} else if (action === 'status') {
  console.log('[status] 当前监听');
  await report();
} else {
  console.log('用法: node stack-control.mjs <start|stop|status>');
  process.exitCode = 1;
}
