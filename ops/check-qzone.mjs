// 端到端验证 qzone 通道：经桥接 /api/socialV2/qzone 发一条「仅自己可见」，
// 确认返回 tid，然后删掉说说 + 抹掉本地配额记录（不留任何痕迹）。
//
// 用法：node ops\check-qzone.mjs [--keep]   （--keep 会保留那条说说，不删）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeEnv, requireEnv } from './lib/local-env.mjs';

const KEEP = process.argv.includes('--keep');
// 令牌与端口一律从本地配置读（见 ops/lib/local-env.mjs）。
const env = requireEnv(bridgeEnv('qq-bridge-01'), ['consoleToken', 'onebotToken']);
const PORT = env.consolePort;
const CONSOLE_TOKEN = env.consoleToken;
const QBOT_PORT = env.onebotPort;
const QBOT_TOKEN = env.onebotToken;
const STATE = path.join(env.dir, 'state', 'qzone.json');

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

const H = { 'x-console-token': CONSOLE_TOKEN };
const TEXT = '【通道验证】这条是接口测试，仅自己可见，发完即删。';

console.log('== 1. 通过桥接发一条（ugcRight=64 仅自己）==');
const sent = await call(PORT, '/api/socialV2/qzone', H, { content: TEXT, ugcRight: 64 });
console.log(`   status=${sent.status} ${JSON.stringify(sent.json)}`);
if (!sent.json?.ok) {
  console.log('   发送失败，后续跳过');
  process.exit(1);
}
const tid = sent.json.tid;

console.log('\n== 2. 状态（配额是否被计入）==');
const st = await call(PORT, '/api/socialV2/qzone', H, null, 'GET');
console.log(`   today=${st.json.todayCount}/${st.json.limits.maxPerDay} canPost=${st.json.canPostNow}`);
console.log(`   blockedReason=${st.json.blockedReason || '(无)'}`);

console.log('\n== 3. 配额拦截验证（立刻再发一条，应被 minGap 拒绝）==');
const again = await call(PORT, '/api/socialV2/qzone', H, { content: '【通道验证】第二条，应该被拒绝。', ugcRight: 64 });
console.log(`   status=${again.status} error=${again.json?.error ?? '(无)'}`);

if (KEEP) {
  console.log('\n--keep：保留这条说说 tid=' + tid);
  process.exit(0);
}

console.log('\n== 4. 清理：删除说说 + 抹掉配额记录 ==');
const del = await call(QBOT_PORT, '/delete_qzone_msg', { authorization: `Bearer ${QBOT_TOKEN}` }, { tid });
console.log('   delete_qzone_msg: ' + JSON.stringify(del.json));

try {
  const raw = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const before = (raw.posts || []).length;
  raw.posts = (raw.posts || []).filter((p) => String(p.tid) !== String(tid));
  fs.writeFileSync(STATE, JSON.stringify(raw, null, 2), 'utf8');
  console.log(`   本地配额记录 ${before} -> ${raw.posts.length} 条`);
} catch (e) {
  console.log('   清理本地状态失败（可能文件不存在）：' + e.message);
}

console.log('\n== 5. 复查 ==');
const st2 = await call(PORT, '/api/socialV2/qzone', H, null, 'GET');
console.log(`   today=${st2.json.todayCount}/${st2.json.limits.maxPerDay} canPost=${st2.json.canPostNow}`);
console.log(`   recent=${JSON.stringify(st2.json.recent)}`);
