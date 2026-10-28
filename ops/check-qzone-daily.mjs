// 验证「每日保底 + 通知 owner」这条链路。
//
// 做三件事：
//   1. 查当前状态（下限/上限/今日计数）；
//   2. 经桥接发一条「仅自己可见」的测试说说 —— 顺便验证发完会不会私聊通知 owner（配置里的 ownerQQ）；
//   3. 删掉那条说说 + 抹掉本地配额记录（不留痕迹）。
//
// 用法：node ops\check-qzone-daily.mjs [--keep]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeEnv, requireEnv } from './lib/local-env.mjs';

const KEEP = process.argv.includes('--keep');
// 令牌与端口一律从本地配置读（见 ops/lib/local-env.mjs）。
// 注意：ownerQQ（“发完通知谁”）也从配置读，不写在源码里。
const env = requireEnv(bridgeEnv('qq-bridge-01'), ['consoleToken', 'onebotToken', 'ownerQQ']);
const PORT = env.consolePort;
const CONSOLE_TOKEN = env.consoleToken;
const QBOT_PORT = env.onebotPort;
const QBOT_TOKEN = env.onebotToken;
const OWNER_QQ = env.ownerQQ;
const STATE = path.join(env.dir, 'state', 'qzone.json');
const OWNER = OWNER_QQ;

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

console.log('== 1. 当前状态 ==');
const before = await call(PORT, '/api/socialV2/qzone', H, null, 'GET');
const b = before.json;
console.log(`   maxPerDay=${b.limits.maxPerDay} minPerDay=${b.limits.minPerDay} today=${b.todayCount}`);
console.log(`   minPerDayMet=${b.minPerDayMet}  canPostNow=${b.canPostNow}`);
console.log(`   ensureDaily=${b.auto.ensureDaily} catchUpHour=${b.auto.catchUpHour} interval=${b.auto.intervalMs}ms`);

const TEXT = '【每日保底测试】这条用于验证发说说并通知主人，仅自己可见，测试完即删。';
console.log('\n== 2. 发一条（ugcRight=64 仅自己）==');
const sent = await call(PORT, '/api/socialV2/qzone', H, { content: TEXT, ugcRight: 64 });
console.log(`   status=${sent.status} ok=${sent.json?.ok} tid=${sent.json?.tid}`);
console.log(`   todayCount=${sent.json?.todayCount}/${sent.json?.maxPerDay}`);

console.log('\n== 3. 等 3 秒，检查通知是否落到 state 日志 ==');
await new Promise((r) => setTimeout(r, 3000));
const logFiles = fs.readdirSync('D:/QQbot/qq-bridge-01/state').filter((f) => f.startsWith('bridge.log'));
let foundNotice = false;
for (const f of logFiles) {
  const lines = fs.readFileSync('D:/QQbot/qq-bridge-01/state/' + f, 'utf8').split(/\r?\n/);
  for (const line of lines.slice(-80)) {
    if (line.includes('[qzone] 已把发表结果私聊告知')) {
      console.log('   ' + line.trim());
      foundNotice = true;
    }
    if (line.includes('[qzone] 通知') && line.includes('失败')) {
      console.log('   ⚠ ' + line.trim());
    }
    if (line.includes('跳过通知')) {
      console.log('   ⚠ ' + line.trim());
    }
  }
}
console.log('   通知已发出: ' + (foundNotice ? '是' : '否（见上面的日志）'));
console.log(`   → 请检查 QQ ${OWNER} 是否收到「说说已发布」私聊`);

if (KEEP) {
  console.log('\n--keep：保留这条说说');
  process.exit(0);
}

console.log('\n== 4. 清理 ==');
const tid = sent.json?.tid;
if (tid) {
  const del = await call(QBOT_PORT, '/delete_qzone_msg', { authorization: `Bearer ${QBOT_TOKEN}` }, { tid });
  console.log('   delete_qzone_msg: ' + JSON.stringify(del.json));
  try {
    const raw = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const n = (raw.posts || []).length;
    raw.posts = (raw.posts || []).filter((p) => String(p.tid) !== String(tid));
    fs.writeFileSync(STATE, JSON.stringify(raw, null, 2), 'utf8');
    console.log(`   本地配额记录 ${n} -> ${raw.posts.length}`);
  } catch (e) { console.log('   清本地状态失败：' + e.message); }
}

console.log('\n== 5. 复查 ==');
const after = await call(PORT, '/api/socialV2/qzone', H, null, 'GET');
console.log(`   today=${after.json.todayCount}/${after.json.limits.maxPerDay} canPostNow=${after.json.canPostNow}`);
