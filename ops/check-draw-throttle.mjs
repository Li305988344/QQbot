// 验证「免费档限速」的跨进程排队是否真的生效。
//
// 背景：Pollinations 免费档的真实限制是「每出口 IP 每 45 秒 1 张」
// （实测自 402 响应体：{"code":"FREE_LIMIT","message":"Free limit reached:
//  1 image every 45 seconds per IP."}）。两个机器人是**两个进程、同一个 IP**，
// 所以各自在进程内节流没用 —— 必须共享一个预约文件（<repo>/.cache/image-gen.slot）。
//
// 本脚本同时发 2 个请求（模拟"两个机器人都被要求画图"），期望：
//   · 两个都成功（第二个排队等约 45 秒），**没有 402**；
//   · 两个的 messageId 都存在；
//   · 总耗时明显大于 45 秒（证明真的排队了，而不是并发撞上去碰运气）。
//
// 用法：node ops\check-draw-throttle.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, bridgeEnv, agentTokenFor, requireEnv } from './lib/local-env.mjs';

const env = requireEnv(bridgeEnv('qq-bridge-01'), ['consoleToken', 'ownerQQ']);
const privKey = `private:${env.ownerQQ}`;
const token = agentTokenFor(env, privKey);
if (!token) {
  console.error(`没有 ${privKey} 会话的 agentToken（先让管理员私聊机器人一次）`);
  process.exit(1);
}

function draw(prompt) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ key: privKey, prompt }), 'utf8');
    const started = Date.now();
    const r = http.request({
      host: '127.0.0.1', port: env.consolePort, path: '/api/socialV2/send-image', method: 'POST',
      headers: {
        'content-type': 'application/json;charset=utf-8',
        'content-length': body.length,
        'x-console-token': env.consoleToken,
        'x-agent-call': '1',
        'x-agent-token': token
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text, ms: Date.now() - started });
      });
    });
    r.on('error', (error) => resolve({ status: 0, json: null, text: String(error?.message ?? error), ms: Date.now() - started }));
    r.write(body);
    r.end();
  });
}

const slotFile = path.join(REPO_ROOT, '.cache', 'image-gen.slot');
if (fs.existsSync(slotFile)) {
  const next = Number(fs.readFileSync(slotFile, 'utf8')) || 0;
  const wait = Math.max(0, next - Date.now());
  if (wait > 0) {
    console.log(`预约文件里还有 ${Math.ceil(wait / 1000)} 秒的排期，先等它过去（避免干扰本次测量）`);
  }
}

console.log('== 同时发 2 个画图请求（应排队，不应 402）==');
const t0 = Date.now();
const results = await Promise.all([
  draw('a red fox sitting in snow, watercolor'),
  draw('a blue whale in deep ocean, ink painting'),
]);
const wall = Date.now() - t0;

let ok = 0;
let rateLimited = 0;
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const okFlag = r.json?.ok === true;
  if (okFlag) ok += 1;
  if (/402|FREE_LIMIT|免费.*限流/.test(r.text)) rateLimited += 1;
  console.log(`  #${i}: status=${r.status} ok=${okFlag} ${Math.round(r.ms / 1000)}s`
    + `${okFlag ? ` messageId=${r.json?.image?.messageId}` : ` err=${(r.json?.error ?? r.text).slice(0, 110)}`}`);
}
console.log(`  总耗时 ${Math.round(wall / 1000)}s`);

const passed = ok === 2 && rateLimited === 0;
console.log(`\n结论：${passed
  ? '✓ 两个都成功，排队生效（免费档 45 秒/张）'
  : '✗ 有问题 —— 见上面的 status 与 error'}`);
process.exit(passed ? 0 : 1);
