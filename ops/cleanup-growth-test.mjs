// 删除自我演变里包含指定关键字的测试记录（走 HTTP 接口，不需要停桥接）。
// 用法：node ops\cleanup-growth-test.mjs [marker] [port] [token]

import http from 'node:http';
import { bridgeEnv, firstGroupKey } from './lib/local-env.mjs';

// 令牌 / 端口 / 会话 key 一律从本地配置读（见 ops/lib/local-env.mjs）。
const envA = bridgeEnv('qq-bridge-01');
const KEY = firstGroupKey(envA);
const marker = process.argv[2] || 'TEST';
const port = Number(process.argv[3]) || envA.consolePort;
const token = process.argv[4] || envA.consoleToken;
if (!token) {
  console.error('读不到控制台令牌：确认 qq-bridge-01 已启动过（会生成 state/console-token）');
  process.exit(1);
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      host: '127.0.0.1', port, method, path,
      headers: {
        'x-console-token': token,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {})
      }
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

const g = await req('GET', `/api/socialV2/growth?key=${encodeURIComponent(KEY)}`);
const buckets = g.json?.buckets || {};
let removed = 0;
for (const [role, list] of Object.entries(buckets)) {
  for (const e of list) {
    if (!String(e.text).includes(marker)) continue;
    const r = await req('POST', '/api/socialV2/memory-remove', { key: KEY, category: 'selfGrowth', content: e.text });
    console.log(`[remove] ${r.status} ${role}: ${e.text}`);
    removed++;
  }
}
if (!removed) console.log('没有匹配的记录');
else {
  const c = await req('POST', '/api/socialV2/growth/consolidate', { key: KEY });
  console.log('[consolidate] ' + JSON.stringify(c.json && { roles: c.json.roles, entries: c.json.entries }));
}
