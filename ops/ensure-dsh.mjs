// ensure-dsh.mjs -- make sure a DSH engine listens on 127.0.0.1:3080.
//
// qq-bridge talks to DSH over a fixed address (config.json -> dsh.baseUrl).
// The DSH desktop app spawns its engine on a random port, so the bridge can
// never reach that one. This helper starts a detached engine that serves the
// same DSH home (API key, sessions, presets, MCP mounts stay shared).
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3080;
// 唯一的 DSH 引擎来源：deepseek_harness 自带的 CLI。
// 历史：这里曾指向 dsh-engine/node_modules/@deepseek-ai/dsh/lib/bin.js（0.2.1-rc.2 的独立
// 副本，583 MB）。实测它从未被启动过——3080 上一服务的就是 harness 里的 rc.3。
const DSH_CLI = 'D:\\QQbot\\deepseek_harness\\resources\\runtime\\cli\\bin\\dsh.cmd';
const DSH_HOME = path.join(os.homedir(), '.dsh');

const isOpen = (port) => new Promise((resolve) => {
  const socket = new net.Socket();
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => { socket.destroy(); resolve(false); });
  socket.connect(port, '127.0.0.1');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (await isOpen(PORT)) {
  console.log(`[ensure-dsh] port ${PORT} already listening`);
  process.exit(0);
}

if (!fs.existsSync(DSH_CLI)) {
  console.log(`[ensure-dsh] WARN: DSH CLI not found: ${DSH_CLI}`);
  console.log('[ensure-dsh] bridge will start, but replies stay queued until DSH is up');
  process.exit(1);
}

console.log(`[ensure-dsh] starting engine on 127.0.0.1:${PORT}`);
console.log(`[ensure-dsh] DSH_HOME=${DSH_HOME}`);

const child = spawn(
  `"${DSH_CLI}" web --host 127.0.0.1 --port ${PORT} --no-open`,
  {
    shell: true,
    cwd: 'D:\\QQbot',
    env: { ...process.env, DSH_HOME },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  },
);
child.unref();

for (let i = 0; i < 80; i += 1) {
  await sleep(500);
  if (await isOpen(PORT)) {
    console.log('[ensure-dsh] engine is up');
    process.exit(0);
  }
}

console.log('[ensure-dsh] WARN: engine did not come up within 40s');
process.exit(1);
