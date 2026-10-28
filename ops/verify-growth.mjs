// 校验「自我演变」的权重与渲染：把两边的可读视图写成 UTF-8 文本（终端中文不可信）。
// 用法：node ops\verify-growth.mjs [outFile]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeEnv, firstGroupKey } from './lib/local-env.mjs';

// 令牌 / 端口 / 会话 key 一律从本地配置读（见 ops/lib/local-env.mjs）。
const envA = bridgeEnv('qq-bridge-01');
const envB = bridgeEnv('qq-bridge-02');
const KEY = firstGroupKey(envA) || firstGroupKey(envB);
const outFile = process.argv[2] || path.join(envA.dir, '..', 'ops', '_growth-verify.txt');

const BRIDGES = [
  { name: `大肥鱼(:${envA.consolePort})`, port: envA.consolePort, token: envA.consoleToken },
  { name: `小黑(:${envB.consolePort})`, port: envB.consolePort, token: envB.consoleToken }
];

function get(port, p, token) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers: { 'x-console-token': token } }, (res) => {
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
    r.end();
  });
}

const out = [];
for (const b of BRIDGES) {
  const g = await get(b.port, `/api/socialV2/growth?key=${encodeURIComponent(KEY)}`, b.token);
  out.push(`\n================ ${b.name} ================`);
  if (g.status !== 200 || !g.json?.ok) {
    out.push(`请求失败 status=${g.status} ${g.text.slice(0, 200)}`);
    continue;
  }
  const j = g.json;
  out.push(`当前角色 = ${j.currentRole}   会话活跃度 = ${j.sessionActivity}`);
  for (const [role, list] of Object.entries(j.buckets || {})) {
    out.push(`--- ${role}：${list.length} 条 ---`);
    for (const e of list) {
      out.push(`  eff=${String(e.eff).padEnd(6)} w=${String(e.w).padEnd(4)} hits=${String(e.hits).padEnd(2)} ${e.weak ? '[模糊]' : '[确定]'}  ${e.text}`);
    }
  }
  out.push('');
  out.push('----- 实际注入的文本 -----');
  out.push(j.growth || '(空)');
}

fs.writeFileSync(outFile, out.join('\n'), 'utf8');
console.log('written ' + outFile);
