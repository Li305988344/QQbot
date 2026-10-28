// 验证「TA 发了说说，我回复」这条通道（复现模型侧的真实调用路径）。
//
// ⚠️ 默认**只读**。原因：上游没有删除评论的接口 —— 评论一旦发出去就撤不回，
//    这是本仓库所有对外动作里唯一不可逆的一个。所以脚本默认只做「能证明链路通」的事：
//      1. 缺 token 应被拒（403）—— 否则任何拿到 x-agent-call 的请求都能以机器人名义评论；
//      2. 带 token 能读到待回复清单（qq_qzone_pending 走的就是这个）；
//      3. 对**已经评论过**的那条再调一次，应返回 alreadyCommented 而**不重新发**
//         —— 这一条正好验证判重，而且不产生任何新内容。
//    想真发一条，显式加 --post（会在 pending 里挑第一条回一句测试文本）。
//
// 用法：
//   node ops\check-qzone-comment.mjs           # 只读校验（推荐）
//   node ops\check-qzone-comment.mjs --post    # 真的回一条（不可撤回，慎重）

import http from 'node:http';
import path from 'node:path';
import { bridgeEnv, agentTokenFor, firstGroupKey, requireEnv } from './lib/local-env.mjs';

const POST = process.argv.includes('--post');
// 令牌 / 端口 / 会话 key 全部从本地配置读（见 ops/lib/local-env.mjs）。
const env = requireEnv(bridgeEnv('qq-bridge-02'), ['consoleToken']);
const PORT = env.consolePort;
const CONSOLE_TOKEN = env.consoleToken;
const KEY = firstGroupKey(env);

function call(port, path, headers, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      host: '127.0.0.1', port, path, method,
      headers: {
        ...headers,
        ...(payload ? { 'content-type': 'application/json;charset=utf-8', 'content-length': payload.length } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 保留原文 */ }
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
const agentHeaders = { 'x-console-token': CONSOLE_TOKEN, 'x-agent-call': '1', 'x-agent-token': agentToken };

// ── 1. 缺 token 应被拒 ──────────────────────────────────────────────────────
console.log('\n== 1. 缺 token 读待回复清单（应 403）==');
const noToken = await call(PORT, '/api/socialV2/qzone-pending', {
  'x-console-token': CONSOLE_TOKEN,
  'x-agent-call': '1'
}, null, 'GET');
console.log(`   status=${noToken.status} error=${noToken.json?.error ?? '(无)'}`);

// ── 2. 带 token 读清单 ─────────────────────────────────────────────────────
console.log('\n== 2. 带 token 读待回复清单（应 200）==');
const pend = await call(PORT, '/api/socialV2/qzone-pending', agentHeaders, null, 'GET');
const pending = Array.isArray(pend.json?.pending) ? pend.json.pending : [];
const done = Array.isArray(pend.json?.alreadyDone) ? pend.json.alreadyDone : [];
console.log(`   status=${pend.status} pending=${pending.length} alreadyDone=${done.length}`
  + ` 读不到评论列表=${pend.json?.unreadable ?? '?'} 今日=${pend.json?.todayCommentCount ?? '?'}`);
for (const it of pending) {
  console.log(`   [待回] ${it.tid} ${it.ageText} 尝试=${it.attempts} | ${String(it.content).slice(0, 30)}`);
}
for (const it of done.slice(0, 5)) {
  console.log(`   [已回] ${it.tid}${it.gaveUp ? `（放弃，试了 ${it.attempts} 次）` : ` | 我的评论：${String(it.myComment ?? '').slice(0, 30)}`}`);
}

// ── 3. 判重：对已评论过的那条再调一次，必须不重发 ──────────────────────────
if (done.length && !done[0].gaveUp) {
  console.log('\n== 3. 判重：对已回复过的再说一次（应 alreadyCommented，不产生新评论）==');
  const dup = await call(PORT, '/api/socialV2/qzone-comment', agentHeaders, {
    key: KEY,
    tid: done[0].tid,
    content: '【判重测试】这条不该被发出去'
  });
  console.log(`   status=${dup.status} ${dup.text.replace(/\s+/g, ' ').slice(0, 200)}`);
  if (dup.json?.alreadyCommented !== true) {
    console.error('   ✗ 判重失效 —— 这条重复内容可能已经被真的发出去了，请立刻去空间手动删除');
  } else {
    console.log('   ✓ 判重生效，没有产生新评论');
  }
} else {
  console.log('\n== 3. 判重 == 跳过：目前没有「已回复过」的说说可以拿来验证');
}

// ── 4. 真发一条（仅在 --post 时）───────────────────────────────────────────
if (POST) {
  if (!pending.length) {
    console.log('\n== 4. 真发 == 跳过：没有待回复的说说');
  } else {
    console.log('\n== 4. 真发一条（不可撤回）==');
    const target = pending[0];
    const r = await call(PORT, '/api/socialV2/qzone-comment', agentHeaders, {
      key: KEY,
      tid: target.tid,
      content: '【自检】评论通道验证，请忽略。'
    });
    console.log(`   status=${r.status} ${r.text.replace(/\s+/g, ' ').slice(0, 260)}`);
    if (r.json?.ok) console.log(`   ✓ 已发出，回读确认 commentId=${r.json.commentId || '(空)'}`);
  }
} else {
  console.log('\n== 4. 真发 == 跳过（默认只读；要真发加 --post）');
}

const ok = noToken.status === 403 && pend.status === 200;
console.log(`\n结论：${ok ? '链路正常' : '有问题，看上面'}`);
process.exit(ok ? 0 : 1);
