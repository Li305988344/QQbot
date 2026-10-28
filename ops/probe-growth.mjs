// 自检脚本：验证「自我演变（selfGrowth）」这层是否真的接进了唤醒提示词。
//
// 用法：node ops/probe-growth.mjs
//
// 它会做四件事：
//   1. 读两边桥接的角色状态，确认还是姐姐 / 妹妹、随机关着；
//   2. 往 3100 写一条测试用的 selfGrowth 记录；
//   3. 拉一次 /api/socialV2/prompt，检查【你现在是什么样】这一段是否渲染出来；
//   4. 把那条件测试记录删掉，避免污染真实对话。
//
// 全部输出用 ASCII 标记 + 少量中文上下文，方便在 PowerShell 里看。

import http from 'node:http';
import { bridgeEnv, firstGroupKey, requireEnv } from './lib/local-env.mjs';

// 令牌 / 端口 / 会话 key 一律从本地配置读（见 ops/lib/local-env.mjs）。
const envA = requireEnv(bridgeEnv('qq-bridge-01'), ['consoleToken']);
const envB = requireEnv(bridgeEnv('qq-bridge-02'), ['consoleToken']);
const BRIDGES = [
  { name: 'b1', port: envA.consolePort, token: envA.consoleToken },
  { name: 'b2', port: envB.consolePort, token: envB.consoleToken }
];
const TEST_KEY = firstGroupKey(envA) || firstGroupKey(envB);
const TEST_TEXT = '开始觉得这群人吵归吵，但一天不看会有点空落落的。';

function req(port, method, path, token, body) {
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
        try { json = JSON.parse(text); } catch { /* 非 JSON 就用原文 */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function has(text, needle) { return text.includes(needle); }

for (const b of BRIDGES) {
  console.log(`\n===== ${b.name} :${b.port} =====`);

  const role = await req(b.port, 'GET', '/api/roles', b.token).catch((e) => ({ status: 0, json: null, text: String(e.message) }));
  if (role.json) {
    console.log('roles status=' + role.status + ' current=' + role.json.current + ' random=' + role.json.random
      + ' count=' + (role.json.roles || []).length);
  } else {
    console.log('roles status=' + role.status + ' body=' + role.text.slice(0, 120));
  }

  const aff = await req(b.port, 'GET', '/api/affection', b.token).catch((e) => ({ status: 0, json: null, text: String(e.message) }));
  console.log('affection status=' + aff.status);
}

const b1 = BRIDGES[0];

// —— 写一条测试记录 ——
const add = await req(b1.port, 'POST', '/api/socialV2/memory-append', b1.token, {
  key: TEST_KEY, category: 'selfGrowth', content: TEST_TEXT, extra: {}
});
console.log('\n[append] status=' + add.status + ' body=' + (add.json ? JSON.stringify(add.json) : add.text.slice(0, 200)));

// —— 拉提示词看渲染 ——
const pr = await req(b1.port, 'GET', `/api/socialV2/prompt?key=${encodeURIComponent(TEST_KEY)}`, b1.token);
const growth = String(pr.json?.growth ?? '');
const hint = String(pr.json?.role?.hint ?? '');
console.log('[prompt] status=' + pr.status + ' growth-chars=' + growth.length + ' hint-chars=' + hint.length);

const markers = [
  ['growth-header', growth, '【你现在是什么样】'],
  ['role-card-is-start', growth, '是你刚来时的样子，不是现在的全部'],
  ['conflict-rule', growth, '以下面为准'],
  ['speak-naturally', growth, '【把经历说成人话】'],
  ['append-hint', growth, 'category="selfGrowth"'],
  ['test-entry', growth, TEST_TEXT],
  ['initial-role-hint', hint, '【初始设定】']
];
for (const [label, text, needle] of markers) {
  console.log(`  ${label.padEnd(20)} ${has(text, needle) ? 'OK' : 'MISSING'}`);
}

// 顺序检查：角色行必须在演变段之前（先「我是谁」再「我变成什么样」）；
// 没记录时 growth 里不会有【你现在是什么样】，所以放行了「有记录才检查」。
const iRole = String(pr.json?.prompt ?? '').indexOf('【当前角色】');
console.log(`  role-line-in-prompt ${iRole >= 0 ? 'OK@' + iRole : 'absent(看唤醒提示)'}`);

// —— 清理测试记录 ——
const rm = await req(b1.port, 'POST', '/api/socialV2/memory-remove', b1.token, {
  key: TEST_KEY, category: 'selfGrowth', content: TEST_TEXT
});
console.log('[remove] status=' + rm.status + ' body=' + (rm.json ? JSON.stringify(rm.json) : rm.text.slice(0, 200)));

const pr2 = await req(b1.port, 'GET', `/api/socialV2/prompt?key=${encodeURIComponent(TEST_KEY)}`, b1.token);
const growth2 = String(pr2.json?.growth ?? '');
console.log('[after-clean] test-entry still present = ' + has(growth2, TEST_TEXT)
  + ' | growth-header = ' + has(growth2, '【你现在是什么样】'));
console.log('[after-clean] growth-chars=' + growth2.length + ' (应只剩下行为要求那两段)');
