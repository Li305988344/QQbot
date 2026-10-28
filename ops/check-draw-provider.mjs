// 验证「画图供应商」配置是否真的能用 —— 用你自己的 key 真生成一张。
//
// 为什么需要这个脚本：免密钥的只有 Pollinations（且每 IP 每 45 秒 1 张、带角标）。
// 想「免费 + 不排队 + 无水印」必须配一个带 key 的供应商，而 key 只有你有 ——
// 所以这里做的是「用你填的配置真跑一次，把结果和错误原样打出来」，
// 而不是我猜它能不能用。
//
// 用法：
//   node ops\check-draw-provider.mjs            # 只打印配置 + 缺什么
//   node ops\check-draw-provider.mjs --run      # 真生成一张（图存到 ops\_prov-<provider>.jpg）
//
// 常见配法：
//   Cloudflare（免费 10000 neurons/天，无水印）：
//     "imageGen": { "provider": "cloudflare",
//                   "apiKeyEnv": "CLOUDFLARE_API_TOKEN",
//                   "accountIdEnv": "CLOUDFLARE_ACCOUNT_ID" }
//     set CLOUDFLARE_API_TOKEN=... 且 set CLOUDFLARE_ACCOUNT_ID=...
//   Pollinations enter key（无限、无角标）：
//     "imageGen": { "provider": "pollinations", "apiKey": "<pollen key>", "minIntervalMs": 0 }
//   SiliconFlow / 智谱：
//     "imageGen": { "provider": "siliconflow", "apiKey": "sk-..." }

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, bridgeEnv, requireEnv } from './lib/local-env.mjs';
import { loadImageGenConfig, generateImageV1 } from '../qq-bridge-01/src/image-gen.js';

const RUN = process.argv.includes('--run');
const env = requireEnv(bridgeEnv('qq-bridge-01'), ['consoleToken']);
const cfg = loadImageGenConfig(env.dir);

const keyFromEnv = cfg.apiKeyEnv ? String(process.env[cfg.apiKeyEnv] ?? '').trim() : '';
const accFromEnv = cfg.accountIdEnv ? String(process.env[cfg.accountIdEnv] ?? '').trim() : '';
const effectiveKey = cfg.apiKey || keyFromEnv;
const effectiveAccount = cfg.accountId || accFromEnv;

const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

say('== 当前配置 ==');
say(`  provider      = ${cfg.provider}`);
say(`  enabled       = ${cfg.enabled}`);
say(`  model         = ${cfg.model || '(供应商默认)'}`);
say(`  size          = ${cfg.size}（cloudflare 不支持，固定 1024）`);
say(`  steps         = ${cfg.steps}（仅 cloudflare 用）`);
say(`  minIntervalMs = ${cfg.minIntervalMs}（pollinations 免密钥时服务端强制 ≥45000）`);
say(`  maxPerDay     = ${cfg.maxPerDay}`);

say('\n== 凭据 ==');
say(`  apiKey        = ${effectiveKey ? `${effectiveKey.slice(0, 6)}…（${effectiveKey.length} 字符，来源：${cfg.apiKey ? 'config.json' : `环境变量 ${cfg.apiKeyEnv}`}）` : '(未配置)'}`);
if (cfg.provider === 'cloudflare') {
  say(`  accountId     = ${effectiveAccount ? `${effectiveAccount.slice(0, 6)}…（来源：${cfg.accountId ? 'config.json' : `环境变量 ${cfg.accountIdEnv}`}）` : '(未配置)'}`);
}

const needsKey = cfg.provider !== 'pollinations';
const missing = [];
if (needsKey && !effectiveKey) missing.push('apiKey（或 apiKeyEnv 指向的环境变量）');
if (cfg.provider === 'cloudflare' && !effectiveAccount) missing.push('accountId（或 accountIdEnv）');

if (missing.length) {
  say('\n⚠ 这个供应商还缺配置：' + missing.join('、'));
  say('  换成免密钥的 Pollinations 不需要 key，但受「每 IP 每 45 秒 1 张」限制且带角标。');
  process.exit(RUN ? 1 : 0);
}

if (!RUN) {
  say('\n（只检查了配置。加 --run 会真生成一张来验证 key 是否有效。）');
  process.exit(0);
}

say('\n== 真生成一张 ==');
const t0 = Date.now();
try {
  const img = await generateImageV1('一只橘猫蹲在木窗台上，水墨画风，侧逆光，背景留白', {
    root: env.dir,
    config: cfg,
  });
  const out = path.join(REPO_ROOT, 'ops', `_prov-${img.provider}.jpg`);
  fs.writeFileSync(out, img.buffer);
  say(`  ✓ provider=${img.provider} model=${img.model}`);
  say(`    mime=${img.mime} bytes=${Math.round(img.bytes / 1024)}KB size=${img.size} waited=${img.waitedMs}ms 总耗时=${Date.now() - t0}ms`);
  say(`    已存到 ${out}（可以打开看看有没有角标）`);
} catch (error) {
  say(`  ✗ ${error?.message ?? error}`);
  process.exit(1);
}
