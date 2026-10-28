// 验证「画图」这条通道。
//
// 分层验证，默认**不发图**（画图很慢，而且真发出去就是一条可见的聊天记录）：
//   1. 配置读得到（provider / size / maxPerDay）；
//   2. 内容闸门真的拦得住（色情 / 未成年人 / 血腥 / 真实人物写实）；
//   3. 提示词里确实有【画图】段、且 enabledTools 里有 qq_draw_image
//      —— 这两处任一缺失，模型就会「不知道自己能画」或「看到名字调不到」；
//   4. 生成一张图但不发（只证明能生成、字节数和耗时）；
//   5. --send 时才真的经桥接发到管理员私聊（不发群，避免打扰）。
//
// 用法：
//   node ops\check-draw.mjs                     # 只检查（不生成、不发）
//   node ops\check-draw.mjs --gen               # 多跑一步：真生成一张但不发
//   node ops\check-draw.mjs --gen --send        # 真生成并私聊发给管理员

import http from 'node:http';
import { bridgeEnv, agentTokenFor, firstGroupKey, requireEnv } from './lib/local-env.mjs';
import { loadImageGenConfig, checkDrawPrompt, generateImageV1 } from '../qq-bridge-01/src/image-gen.js';

const GEN = process.argv.includes('--gen');
const SEND = process.argv.includes('--send');
const INSTANCE = 'qq-bridge-01';

const env = requireEnv(bridgeEnv(INSTANCE), ['consoleToken', 'ownerQQ']);
const agentToken = agentTokenFor(env, firstGroupKey(env));
if (!agentToken) {
  console.error('没有找到群会话的 agentToken，无法验证模型侧调用路径');
  process.exit(1);
}

function call(path, headers, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      host: '127.0.0.1', port: env.consolePort, path, method,
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
        try { json = JSON.parse(text); } catch { /* 原文 */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── 1. 配置 ────────────────────────────────────────────────────────────────
const cfg = loadImageGenConfig(env.dir);
console.log('== 1. 配置 ==');
console.log(`   enabled=${cfg.enabled} provider=${cfg.provider} size=${cfg.size}`
  + ` maxPerDay=${cfg.maxPerDay} timeout=${cfg.timeoutMs}ms nologo=${cfg.nologo}`);
if (!cfg.enabled) console.error('   ✗ imageGen.enabled=false，画图是关的');

// ── 2. 内容闸门 ────────────────────────────────────────────────────────────
console.log('\n== 2. 内容闸门（应全部拦下）==');
const shouldBlock = [
  ['nude woman lying on bed', '露骨色情'],
  ['loli schoolgirl', '未成年人'],
  ['血腥 肢解 场景', '血腥暴力'],
  ['photorealistic 习近平 portrait', '真实人物写实'],
];
let gateOk = true;
for (const [p, why] of shouldBlock) {
  const r = checkDrawPrompt(p);
  console.log(`   ${r.ok ? '✗ 没拦住' : '✓ 拦下'}  「${p}」（${why}）${r.ok ? '' : ' → ' + r.reason.slice(0, 40)}`);
  if (r.ok) gateOk = false;
}
const allowed = ['一只橘猫蹲在木窗台上，水墨画风，侧光，背景留白', 'cyberpunk city street at night, rainy, neon'];
for (const p of allowed) {
  const r = checkDrawPrompt(p);
  console.log(`   ${r.ok ? '✓ 放行' : '✗ 误拦'}  「${p.slice(0, 20)}…」`);
  if (!r.ok) gateOk = false;
}

// ── 3. 提示词与工具清单 ────────────────────────────────────────────────────
console.log('\n== 3. 提示词 / 工具清单 ==');
const prompt = await call(`/api/socialV2/prompt?key=${encodeURIComponent(firstGroupKey(env))}`, { 'x-console-token': env.consoleToken }, null, 'GET');
const hasTool = (prompt.json?.enabledTools ?? []).includes('qq_draw_image');
const hint = String(prompt.json?.draw ?? '');
console.log(`   enabledTools 含 qq_draw_image = ${hasTool}`);
console.log(`   draw 提示段 ${hint.length} 字符${hint ? '，开头：' + hint.split('\n')[0] : '（空 —— 模型不会知道自己能画图）'}`);
if (!hasTool || !hint) console.error('   ✗ 工具或提示词缺失');

// ── 3b. 缺 token 应被拒 ────────────────────────────────────────────────────
console.log('\n== 3b. 缺 token 画图（应 403）==');
const noToken = await call('/api/socialV2/send-image', { 'x-console-token': env.consoleToken, 'x-agent-call': '1' }, { key: firstGroupKey(env), prompt: '一只猫' });
console.log(`   status=${noToken.status} error=${noToken.json?.error ?? '(无)'}`);

// ── 4. 真生成但不发 ────────────────────────────────────────────────────────
if (GEN) {
  console.log('\n== 4. 真生成一张（不发送）==');
  const t0 = Date.now();
  try {
    const img = await generateImageV1('一只橘猫蹲在木窗台上，水墨画风，侧逆光，背景留白', { root: env.dir, config: cfg });
    console.log(`   ✓ ${img.provider}/${img.model} ${img.mime} ${Math.round(img.bytes / 1024)}KB ${img.size}px  ${Date.now() - t0}ms`);
  } catch (error) {
    console.error(`   ✗ 生成失败：${error?.message ?? error}`);
  }
}

// ── 5. 经桥接真发（仅 --send，发管理员私聊）────────────────────────────────
if (SEND) {
  // 每个会话有自己的 agentToken：拿群会话的令牌去发私聊会被判「agent token 无效」。
  const privKey = `private:${env.ownerQQ}`;
  const privToken = agentTokenFor(env, privKey);
  if (!privToken) {
    console.error(`\n== 5. 跳过：本机还没有 ${privKey} 这个会话（先让管理员私聊机器人一次）==`);
    process.exit(1);
  }
  console.log(`\n== 5. 经桥接发一张到管理员私聊 ${privKey} ==`);
  const t0 = Date.now();
  const r = await call('/api/socialV2/send-image', {
    'x-console-token': env.consoleToken,
    'x-agent-call': '1',
    'x-agent-token': privToken
  }, {
    key: privKey,
    prompt: '一只橘猫蹲在木窗台上，水墨画风，侧逆光，背景留白'
  });
  console.log(`   status=${r.status} 耗时=${Date.now() - t0}ms`);
  if (r.json?.ok) {
    const img = r.json.image ?? {};
    console.log(`   ✓ 已发出 messageId=${img.messageId} source=${img.source} ${Math.round((img.bytes || 0) / 1024)}KB`);
    console.log(`   drawn: ${JSON.stringify(img.drawn)}`);
  } else {
    console.error(`   ✗ ${r.json?.error ?? r.text.slice(0, 200)}`);
  }
} else {
  console.log('\n== 5. 真发 == 跳过（加 --send 才会发到管理员私聊）');
}

const ok = cfg.enabled && gateOk && hasTool && Boolean(hint) && noToken.status === 403;
console.log(`\n结论：${ok ? '链路正常' : '有问题，看上面'}`);
process.exit(ok ? 0 : 1);
