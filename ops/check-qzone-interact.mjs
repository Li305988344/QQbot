// 验证「小黑看大肥鱼空间 + 点赞」这条通道（复现模型侧的真实调用路径）。
//
// 检查四件事，任何一件不成立都说明链路断了：
//   1. 缺 token 的智能体调用必须被拒（403）—— 否则任何拿到 x-agent-call 的请求
//      都能以机器人名义去赞别人的动态；
//   2. 带 token 能读到 feed（qq_qzone_feed 走的就是这个）；
//   3. 带 token 能点赞，且服务端读回来 isLiked=true / likeCount 有变化；
//   4. 重复点赞是幂等的（alreadyLiked），不会把当日配额刷高。
//
// 测完**默认把状态还原**：取消赞、抹掉本地点赞记录。真机上点赞是公开动作，
// 运维脚本不该在别人的空间里留下痕迹。
//
// 用法：node ops\check-qzone-interact.mjs [--keep]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeEnv, agentTokenFor, firstGroupKey, requireEnv } from './lib/local-env.mjs';

const KEEP = process.argv.includes('--keep');
// 令牌 / 端口 / 目标 QQ / 会话 key 全部从本地配置读（见 ops/lib/local-env.mjs）。
const env = requireEnv(bridgeEnv('qq-bridge-02'), ['consoleToken']);
const PORT = env.consolePort;
const CONSOLE_TOKEN = env.consoleToken;
const STATE = path.join(env.dir, 'state', 'qzone-likes.json');
const KEY = firstGroupKey(env);
const TARGET_UIN = String(env.cfg.socialV2?.qzoneInteract?.targetUin ?? '');

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
console.log('\n== 1. 缺 token 读 feed（应 403）==');
const noToken = await call(PORT, '/api/socialV2/qzone-feed?count=3', {
  'x-console-token': CONSOLE_TOKEN,
  'x-agent-call': '1'
}, null, 'GET');
console.log(`   status=${noToken.status} error=${noToken.json?.error ?? '(无)'}`);

// ── 2. 带 token 读 feed ────────────────────────────────────────────────────
console.log('\n== 2. 带 token 读 feed（应 200 且有 items）==');
const feed = await call(PORT, '/api/socialV2/qzone-feed?count=5', agentHeaders, null, 'GET');
const items = Array.isArray(feed.json?.items) ? feed.json.items : [];
console.log(`   status=${feed.status} count=${items.length} todayLike=${feed.json?.todayLikeCount}`);
if (!items.length) {
  console.log('   ⚠ 目标空间没有可读的动态（可能一条都没发过），跳过点赞测试');
  process.exit(feed.status === 200 ? 0 : 1);
}
const target = items.find((it) => it.uin === TARGET_UIN) ?? items[0];
console.log(`   目标 tid=${target.tid} liked=${target.liked} isLiked=${target.isLiked} likeCount=${target.likeCount}`);

// ── 3. 点赞 ────────────────────────────────────────────────────────────────
console.log('\n== 3. 带 token 点赞（应 ok:true 且不是 alreadyLiked）==');
const liked = await call(PORT, '/api/socialV2/qzone-like', agentHeaders, { key: KEY, tid: target.tid });
console.log(`   status=${liked.status} ${liked.text.replace(/\s+/g, ' ').slice(0, 200)}`);
const likeOk = liked.json?.ok === true;

if (likeOk) {
  const after = await call(PORT, '/api/socialV2/qzone-feed?count=5', agentHeaders, null, 'GET');
  const now = (after.json?.items ?? []).find((it) => it.tid === target.tid);
  console.log(`   读回：isLiked=${now?.isLiked} likeCount=${now?.likeCount} todayLike=${after.json?.todayLikeCount}`);
  if (now && now.isLiked !== true) {
    console.error('   ✗ 服务端读回的 isLiked 不是 true，点赞没真正生效');
  }

  // ── 4. 幂等 ──────────────────────────────────────────────────────────────
  console.log('\n== 4. 重复点赞（应 alreadyLiked，且配额不涨）==');
  const again = await call(PORT, '/api/socialV2/qzone-like', agentHeaders, { key: KEY, tid: target.tid });
  console.log(`   ${again.text.replace(/\s+/g, ' ').slice(0, 200)}`);
}

// ── 收尾：还原 ─────────────────────────────────────────────────────────────
if (!KEEP) {
  console.log('\n== 收尾：取消赞并清掉本地记录 ==');
  const undone = await call(PORT, '/api/socialV2/qzone-like', agentHeaders, { key: KEY, tid: target.tid, like: false });
  console.log(`   取消赞 status=${undone.status} ${undone.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  try {
    fs.writeFileSync(STATE, JSON.stringify({ likes: [] }), 'utf8');
    console.log('   已清空 qzone-likes.json（配额归零）');
  } catch (error) {
    console.log(`   清空状态失败：${error?.message ?? error}`);
  }
  const final = await call(PORT, '/api/socialV2/qzone-feed?count=5', agentHeaders, null, 'GET');
  const last = (final.json?.items ?? []).find((it) => it.tid === target.tid);
  console.log(`   最终：isLiked=${last?.isLiked} likeCount=${last?.likeCount} todayLike=${final.json?.todayLikeCount}`);
} else {
  console.log('\n（--keep：保留这条赞）');
}

process.exit(likeOk ? 0 : 1);
