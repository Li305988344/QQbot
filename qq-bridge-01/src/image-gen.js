// 文字生成图片（"画图"）。与 web-image-search.js 是**两条不同的通道**：
//
//   web-image-search  → 去互联网上**找**一张已经存在的图（搜「金毛幼犬」，拿回别人的照片）
//   image-gen（本文件）→ 让模型**画**一张不存在的图（说「画一只戴礼帽的猫」，生成新图）
//
// 为什么必须分开：
//   · 搜图的失败模式是「找不到/防盗链」，画图的失败模式是「生成慢/被内容策略拒」；
//   · 搜图可以挑候选逐个试，画图一次就是一次生成，重试成本高得多（几十秒）；
//   · 搜图的产出是别人的作品（要注意版权语境），画图的产出是这次对话独有的。
//
// ── 为什么默认用 Pollinations（免密钥）──────────────────────────────────────
// 本机没有任何图像生成服务的 API key。而 DeepSeek 本身不提供文生图。
// Pollinations 的接口是「一个 GET 地址就是一张图」：
//     https://image.pollinations.ai/prompt/<urlencoded>?width=&height=&nologo=true&seed=
// 实测可用（768×768 JPEG 约 90 KB），无注册、无额度页面，正好适合这种自建机器人。
//
// 需要更好质量/更可控时可以在配置里换成带 key 的供应商（siliconflow / zhipu），
// 代码路径已经留好，见 generateImageV1 的 provider 分支。
//
// ── 安全边界（和搜图同样严格，另有两条画图独有的）──────────────────────────
//   ① 一律经 safeFetchBuffer 拉取字节：SSRF 防护 + magic 校验。**不能**把生成地址
//      直接塞进 image 段交给 OneBot/DSH 二次抓取 —— 那等于绕过 SSRF 防护；
//   ② 图片格式只认 PNG/JPEG/GIF/WebP（QQ 与 DSH 都只支持这四种）；
//   ③ 【画图独有】提示词必须过内容闸门。搜图是「找已有的」，画图是「凭空造」，
//      而群里任何人都能让机器人画 —— 不做过滤，就有人会拿它画不该画的东西，
//      而且图一旦发进群就无法收回；
//   ④ 【画图独有】每日配额 + 单次超时。生成比下载慢一个数量级，
//      没有配额的话一句「画 100 张」就能把机器人和带宽占满半天。
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SIZE = 768;
const MIN_SIZE = 256;
const MAX_SIZE = 1536;
const DEFAULT_TIMEOUT_MS = 90000;
const MAX_PROMPT_CHARS = 400;
// 生成图的字节上限：QQ 侧单图上限比这宽松，但画图产出不需要更大。
const MAX_BYTES = 8 * 1024 * 1024;

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 读取 config.json 的 `imageGen` 段。
 * 与 imageSearch 不同：这里 provider 缺省是 pollinations（免密钥），
 * 因为绝大多数自建部署根本没有图像生成 key —— 默认必须是"开箱能用"的那条。
 */
export function loadImageGenConfig(root) {
  let file = {};
  try {
    const text = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
    // 本仓库的 config.json 用 PowerShell 写过，可能带 UTF-8 BOM；JSON.parse 不认。
    file = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {}
  const raw = file?.imageGen && typeof file.imageGen === 'object' && !Array.isArray(file.imageGen) ? file.imageGen : {};
  const provider = String(raw.provider ?? 'pollinations').trim().toLowerCase();
  return {
    // enabled 用 !== false：画图是用户明确要的功能，缺省就该是开的；
    // 想关掉时在配置里写 false（或在 socialV2.tools.drawImage 里关）。
    enabled: raw.enabled !== false,
    provider: ['pollinations', 'siliconflow', 'zhipu'].includes(provider) ? provider : 'pollinations',
    apiKey: String(raw.apiKey ?? '').trim(),
    // 允许从环境变量取 key，避免把密钥写进 config.json（那个文件含多个凭据，风险更高）
    apiKeyEnv: String(raw.apiKeyEnv ?? '').trim(),
    baseURL: String(raw.baseURL ?? '').trim(),
    model: String(raw.model ?? '').trim(),
    size: num(raw.size, DEFAULT_SIZE, MIN_SIZE, MAX_SIZE),
    // nologo：Pollinations 默认会在角落加水印，nologo=true 去掉。保留可配置是为了
    // 尊重对方服务的免费额度（不想关就不关，不影响功能）。
    nologo: raw.nologo !== false,
    timeoutMs: num(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 10000, 300000),
    maxPerDay: num(raw.maxPerDay, 20, 0, 200),
    // 重试次数（不含首次）。
    //
    // 为什么默认是 2 而不是 0：Pollinations 是免费公共服务，实测在负载高时会对
    // 同一时刻的并发请求返回 **HTTP 503**，而同样的地址隔两秒再请求就 200。
    // 也就是说 503 是**瞬时**的，不是"这个提示词画不出来"。不重试的话，
    // 用户会看到「画图失败」而其实再等两秒就好 —— 免费方案必须容忍这种抖动。
    // 注意只对**可重试**的错误重试（429/5xx/网络），内容闸门的拒绝不重试。
    retries: num(raw.retries, 2, 0, 5),
  };
}

/** 这个错误值不值得再试一次。 */
function isRetryableError(error) {
  const msg = String(error?.message ?? error ?? '');
  // 4xx（除 429）是"这个请求本身有问题"，重试没用。
  if (/HTTP 429/.test(msg)) return true;
  if (/HTTP 5\d\d/.test(msg)) return true;
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|network/i.test(msg)) return true;
  return false;
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 带退避的重试包装：只重试瞬时错误，其它错误立刻抛。 */
async function withRetry(fn, retries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableError(error)) throw error;
      // 1.5s, 3s, 4.5s…：给上游一点时间缓过来，又不至于把调用方拖太久。
      await sleepMs(1500 * (attempt + 1));
    }
  }
  throw lastError;
}

/**
 * 内容闸门。
 *
 * 这不是"道德洁癖"，是**安全边界**：群聊是公共场合，谁都能让机器人画图，
 * 而图片发进群之后和评论一样**无法收回**（撤回有时限，且可能已被保存/转发）。
 * 所以宁可错拒，不可放过。
 *
 * 覆盖三类高风险：未成年人性化、露骨色情、真实暴力/血腥。
 * 另外拦「写实真人 + 名字」这类容易被用来伪造他人形象的组合（deepfake 语境）。
 */
const BLOCKED_TERMS = [
  // 未成年人性化（最高优先级）
  /(loli|lolita|shota|child|children|kid|kids|toddler|minor|underage|young\s*girl|young\s*boy|小萝莉|正太|幼女|幼童|未成年)/i,
  // 露骨色情
  /(nude|naked|nudity|nsfw|porn|porno|explicit|erotic|hentai|sex|sexual|genital|penis|vagina|breast|nipple|butt\s*naked|裸体|裸照|全裸|色情|情色|性行为|做爱|生殖器|淫秽)/i,
  // 真实暴力 / 血腥 / 自伤
  /(gore|guro|bloodbath|dismember|behead|decapitat|torture|mutilat|suicide|self[\s-]?harm|cutting\s*wrist|血腥|肢解|斩首|酷刑|自杀|自残|割腕)/i,
];

// 「写实照片 + 具体人名」的组合：单独出现任一项都正常，组合起来才是伪造他人形象。
const REALISTIC_RE = /(photo|photograph|photorealistic|realistic|hyperrealistic|真实照片|写实|真人)/i;
const NAMED_PERSON_RE = /(习近平|毛泽东|普京|Trump|Biden|Putin|Musk|马斯克|拜登|特朗普)/i;

/** 清洗画图提示词：去 CQ 码 / 控制字符 / 超长。 */
export function sanitizeDrawPrompt(prompt) {
  return String(prompt ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PROMPT_CHARS);
}

/**
 * 检查提示词是否可以画。
 * 返回 { ok: true } 或 { ok: false, reason }。
 */
export function checkDrawPrompt(prompt) {
  const text = sanitizeDrawPrompt(prompt);
  if (!text) return { ok: false, reason: '画图提示词不能为空' };
  if (text.length < 2) return { ok: false, reason: '画图提示词太短，至少写两个字符' };
  for (const re of BLOCKED_TERMS) {
    const m = text.match(re);
    if (m) return { ok: false, reason: `这个画图请求包含不能生成的内容（命中「${m[0]}」），换一个描述吧` };
  }
  if (REALISTIC_RE.test(text) && NAMED_PERSON_RE.test(text)) {
    return { ok: false, reason: '不生成真实人物的写实图像（这种图容易被用来伪造他人形象），换一个描述吧' };
  }
  return { ok: true };
}

/** 追加安全后缀：即使提示词漏过闸门，也让生成侧往安全方向收敛。 */
function withSafetySuffix(prompt) {
  return `${prompt}, safe for work, no text`;
}

function buildPollinationsUrl(prompt, { size, nologo, model, seed }) {
  const q = new URLSearchParams();
  q.set('width', String(size));
  q.set('height', String(size));
  if (nologo) q.set('nologo', 'true');
  if (model) q.set('model', model);
  if (seed !== undefined && seed !== null) q.set('seed', String(seed));
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(withSafetySuffix(prompt))}?${q.toString()}`;
}

function resolveApiKey(cfg) {
  if (cfg.apiKey) return cfg.apiKey;
  const envName = cfg.apiKeyEnv || '';
  if (envName && process.env[envName]) return String(process.env[envName]).trim();
  return '';
}

/** OpenAI 兼容的 images/generations 响应解析（siliconflow / zhipu 都用这个形状）。 */
function pickImageRef(body) {
  const list = body?.data ?? body?.images ?? [];
  if (!Array.isArray(list) || !list.length) return null;
  const first = list[0];
  if (typeof first === 'string') return { url: first };
  if (first?.url) return { url: String(first.url) };
  // zhipu 有时给 b64_json
  if (first?.b64_json) return { b64: String(first.b64_json) };
  return null;
}

/**
 * 生成一张图。
 *
 * 返回 { buffer, mime, provider, model, prompt, size, seed, bytes, url }。
 * 失败一律抛错（由调用方决定怎么告诉模型），不返回半成品。
 */
export async function generateImageV1(prompt, { root, config, seed } = {}) {
  const cfg = config ?? loadImageGenConfig(root);
  if (!cfg.enabled) throw new Error('画图功能已关闭（config.json → imageGen.enabled）');

  const gate = checkDrawPrompt(prompt);
  if (!gate.ok) throw new Error(gate.reason);
  const text = sanitizeDrawPrompt(prompt);

  // 固定 seed 时结果可复现（便于排查「同一句话为什么画出不同的图」）。
  const useSeed = Number.isFinite(Number(seed)) ? Number(seed) : undefined;

  if (cfg.provider === 'pollinations') {
    const url = buildPollinationsUrl(text, {
      size: cfg.size,
      nologo: cfg.nologo,
      // 默认不指定 model，交给服务端选；配置里写了就用
      model: cfg.model || '',
      seed: useSeed,
    });
    // 见 config 里 retries 那段注释：503 是瞬时的，必须重试。
    const fetched = await withRetry(() => safeFetchBuffer(url, MAX_BYTES), cfg.retries);
    if (!looksLikeImageBuffer(fetched.buffer)) {
      // safeFetchBuffer 内部已经校验过，这里是双保险（防止将来改动放松校验）。
      throw new Error('生成结果不是有效图片');
    }
    return {
      buffer: fetched.buffer,
      // 生成图基本都是 JPEG/PNG；按内容推断，别信 Content-Type。
      mime: sniffMime(fetched.buffer),
      provider: 'pollinations',
      model: cfg.model || 'flux',
      prompt: text,
      size: cfg.size,
      seed: useSeed ?? null,
      bytes: fetched.buffer.length,
      url,
    };
  }

  // ── 带 key 的供应商（siliconflow / zhipu）────────────────────────────────
  const apiKey = resolveApiKey(cfg);
  if (!apiKey) {
    throw new Error(`画图供应商 ${cfg.provider} 需要 API key：请在 config.json 的 imageGen.apiKey 填写，或设置环境变量 ${cfg.apiKeyEnv || '（imageGen.apiKeyEnv）'}`);
  }
  const endpoints = {
    siliconflow: {
      url: cfg.baseURL || 'https://api.siliconflow.cn/v1/images/generations',
      model: cfg.model || 'Kwai-Kolors/Kolors',
      body: (p, size) => ({ model: cfg.model || 'Kwai-Kolors/Kolors', prompt: p, image_size: `${size}x${size}`, batch_size: 1 }),
    },
    zhipu: {
      url: cfg.baseURL || 'https://open.bigmodel.cn/api/paas/v4/images/generations',
      model: cfg.model || 'cogview-3-flash',
      body: (p, size) => ({ model: cfg.model || 'cogview-3-flash', prompt: p, size: `${size}x${size}` }),
    },
  };
  const ep = endpoints[cfg.provider];
  if (!ep) throw new Error(`不支持的画图供应商：${cfg.provider}`);

  const res = await withRetry(async () => {
    const r = await fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(ep.body(withSafetySuffix(text), cfg.size)),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const rawText = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(rawText); } catch { /* 保留原文 */ }
    if (!r.ok) {
      const msg = parsed?.error?.message || parsed?.message || rawText.slice(0, 200) || `HTTP ${r.status}`;
      // 把状态码放进消息里，isRetryableError 才判断得出该不该重试。
      throw new Error(`HTTP ${r.status} 画图接口失败（${cfg.provider}）：${msg}`);
    }
    return { body: parsed, raw: rawText };
  }, cfg.retries);
  const body = res.body;
  const raw = res.raw;
  const ref = pickImageRef(body);
  if (!ref) throw new Error(`画图接口没有返回图片（${cfg.provider}）；原文：${raw.slice(0, 200)}`);

  let buffer;
  let sourceUrl = '';
  if (ref.b64) {
    buffer = Buffer.from(ref.b64, 'base64');
    if (!looksLikeImageBuffer(buffer)) throw new Error('画图接口返回的 base64 不是有效图片');
  } else {
    // 返回的是 URL ⇒ 仍然走 safeFetchBuffer，避免把第三方地址直接交给下游抓取。
    const fetched = await withRetry(() => safeFetchBuffer(ref.url, MAX_BYTES), cfg.retries);
    buffer = fetched.buffer;
    sourceUrl = ref.url;
  }
  return {
    buffer,
    mime: sniffMime(buffer),
    provider: cfg.provider,
    model: ep.model,
    prompt: text,
    size: cfg.size,
    seed: useSeed ?? null,
    bytes: buffer.length,
    url: sourceUrl,
  };
}

/** 按 magic 判断图片 MIME（不信 Content-Type）。 */
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return 'application/octet-stream';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'application/octet-stream';
}
