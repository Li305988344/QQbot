// 验证 qq_post_qzone 携带 token 后真的能发（复现模型侧那条调用路径）。
//
// 用桥接里该会话的 agentToken，模拟 MCP 工具的请求形状：
//   POST /api/socialV2/qzone  + x-agent-token + x-agent-call + body{key, content, ugcRight}
// 之前缺 token 时这里会 403「未授权：该接口的智能体调用必须携带有效的会话令牌」。
//
// 用法：node ops\check-qzone-agent.mjs [--keep]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeEnv, agentTokenFor, firstGroupKey, requireEnv } from './lib/local-env.mjs';

const KEEP = process.argv.includes('--keep');
// 令牌与端口一律从本地配置读，不写死在源码里（见 ops/lib/local-env.mjs 的说明）。
const env = requireEnv(bridgeEnv('qq-bridge-01'), ['consoleToken', 'onebotToken']);
const PORT = env.consolePort;
const CONSOLE_TOKEN = env.consoleToken;
const QBOT_PORT = env.onebotPort;
const QBOT_TOKEN = env.onebotToken;
const STATE = path.join(env.dir, 'state', 'qzone.json');
const KEY = firstGroupKey(env);

function call(port, path, headers, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      host: '127.0.0.1', port, path, method,
      headers: { ...headers, ...(payload ? { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length } : {}) }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 原文 */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const agentToken = agentTokenFor(env, KEY);
if (!agentToken) {
  console.error(`会话 ${KEY || '(没有群会话)'} 没有 agentToken，无法测试`);
  process.exit(1);
}
console.log(`agentToken = ${agentToken.slice(0, 8)}…（长度 ${agentToken.length}）`);

console.log('\n== 1. 缺 token（应被拒，复现之前的 bug）==');
const noToken = await call(PORT, '/api/socialV2/qzone', {
  'x-console-token': CONSOLE_TOKEN,
  'x-agent-call': '1'
}, { key: KEY, content: '【缺 token 测试】不应发出去', ugcRight: 64 });
console.log(`   status=${noToken.status} error=${noToken.json?.error ?? '(无)'}`);

console.log('\n== 2. 带 token（应成功）==');
const TEXT = '【token 链路验证】这条用于确认 qq_post_qzone 能正常鉴权，仅自己可见，测完即删。';
const withToken = await call(PORT, '/api/socialV2/qzone', {
  'x-console-token': CONSOLE_TOKEN,
  'x-agent-call': '1',
  'x-agent-token': agentToken
}, { key: KEY, content: TEXT, ugcRight: 64 });
console.log(`   status=${withToken.status} ok=${withToken.json?.ok} tid=${withToken.json?.tid}`);
if (withToken.json?.ok) {
  console.log(`   todayCount=${withToken.json.todayCount}/${withToken.json.maxPerDay} 权限=${withToken.json.rightLabel}`);
}

const tid = withToken.json?.tid;
if (tid && !KEEP) {
  console.log('\n== 3. 清理 ==');
  const del = await call(QBOT_PORT, '/delete_qzone_msg', { authorization: `Bearer ${QBOT_TOKEN}` }, { tid });
  console.log('   delete: ' + JSON.stringify(del.json));
  try {
    const raw = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const n = (raw.posts || []).length;
    raw.posts = (raw.posts || []).filter((p) => String(p.tid) !== String(tid));
    fs.writeFileSync(STATE, JSON.stringify(raw, null, 2), 'utf8');
    console.log(`   本地配额 ${n} -> ${raw.posts.length}`);
  } catch (e) { console.log('   清理失败：' + e.message); }
}

process.exit(withToken.json?.ok ? 0 : 1);
