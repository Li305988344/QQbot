// Restart only the layers that need new code, leaving SnowLuma (the QQ connection) alone.
//
// Why not `stack-control.mjs stop && start`: stop() also kills SnowLuma, which drops the
// QQ connection for 10-20 seconds and interrupts whatever conversation is in progress.
// Editing bridge.js or the MCP tool list does not require touching SnowLuma at all.
//
// What must restart for which change:
//   src/bridge.js                  -> bridge (endpoints, commands, prompt, state model)
//   src/mcp-snowluma-safe.js       -> **DSH** (it spawns the MCP server and reads the
//                                     tool list at startup; a bridge restart alone leaves
//                                     the model seeing the old tool set)
//   public/console.html            -> nothing (served from disk per request)
//
//   node ops/restart-bridge.mjs [--dsh] [--no-dsh]

import { execSync, spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = 'D:\\QQbot';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';
const NODE_EXE = process.execPath;
const STACK = path.join(ROOT, 'ops', 'stack-control.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listProcesses() {
  try {
    const out = execSync(
      `"${POWERSHELL}" -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"`,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
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

const cmd = (p) => (typeof p.CommandLine === 'string' ? p.CommandLine : '');

function stopWhere(predicate, label) {
  const targets = listProcesses().filter(predicate);
  if (!targets.length) {
    console.log(`  ${label}: 未运行`);
    return 0;
  }
  let killed = 0;
  for (const proc of targets) {
    if (killPid(proc.ProcessId)) {
      killed += 1;
      console.log(`  ${label}: 已停止 PID ${proc.ProcessId}`);
    } else {
      console.log(`  ${label}: 无法停止 PID ${proc.ProcessId}`);
    }
  }
  return killed;
}

const wantDsh = !process.argv.includes('--no-dsh');

console.log('[restart] 只重启桥接 + DSH，SnowLuma 保持不动');

// 1) 先杀桥接的“自启循环”，否则下面杀掉的 bridge 会被立刻拉起来，出现双实例抢状态文件。
stopWhere((p) => p.Name === 'cmd.exe' && /start\.bat/i.test(cmd(p)), '桥接启动循环');
await sleep(800);

// 2) 桥接进程
stopWhere((p) => p.Name === 'node.exe' && /src[\\/]bridge\.js/i.test(cmd(p)), '桥接进程');
await sleep(800);

// 3) DSH 引擎（MCP 工具清单在它启动时确定）
if (wantDsh) {
  stopWhere(
    (p) => p.Name === 'DeepSeek Harness.exe' && /--expose-internals/i.test(cmd(p)),
    'DSH 引擎',
  );
  await sleep(1200);
}

// 4) 交给 stack-control 拉起缺的那几层（SnowLuma 已在运行会被跳过）
console.log('[restart] 重新启动…');
const child = spawn(NODE_EXE, [STACK, 'start'], { cwd: ROOT, stdio: 'inherit' });
const code = await new Promise((resolve) => child.on('exit', resolve));
console.log(`[restart] stack-control 退出码 ${code}`);
process.exit(code ?? 0);
