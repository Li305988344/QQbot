// 直接和 MCP 服务器握手，列出它实际注册的工具。
//
// 为什么要这个：DSH 是 MCP 服务器的父进程，工具清单只在它的会话里生效，
// 从外面看不到。这个脚本绕过 DSH，直接走 JSON-RPC，回答一个具体问题：
// 「mcp-snowluma-safe.js 到底有没有把 qq_post_qzone 注册进去？」
//
// 用法：node ops\list-mcp-tools.mjs [bridgeDir]

import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = 'D:/QQbot';
const dir = process.argv[2] || 'qq-bridge-01';
const script = path.join(ROOT, dir, 'src', 'mcp-snowluma-safe.js');

const child = spawn(process.execPath, [script], {
  cwd: path.join(ROOT, dir),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let stderr = '';
child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

function send(method, params, timeoutMs = 20000) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(payload + '\n');
  });
}

const init = await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'qqbot-tool-audit', version: '1.0.0' },
});
console.log('initialize -> ' + (init?.result ? 'OK' : 'FAIL ' + JSON.stringify(init).slice(0, 200)));

child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

const list = await send('tools/list', {});
const tools = list?.result?.tools ?? [];
console.log(`tools/list -> ${tools.length} 个工具`);
const names = tools.map((t) => t.name);
for (const n of names) console.log('  ' + n);

const want = ['qq_post_qzone', 'qq_get_forward_msg', 'qq_affection', 'qq_say'];
console.log('\n关键工具：');
for (const w of want) console.log(`  ${w.padEnd(22)} ${names.includes(w) ? 'OK' : 'MISSING'}`);

if (stderr.trim()) console.log('\n[stderr]\n' + stderr.trim().slice(0, 800));

child.kill();
process.exit(0);
