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

// Pollinations 免费档的真实限制（实测自 402 响应体，不是猜的）：
//   {"code":"FREE_LIMIT","message":"Free limit reached: 1 image every 45 seconds per IP. ..."}
// 所以它**仍然是免费的**，只是每出口 IP 每 45 秒只能出 1 张。
// 两个机器人跑在同一台机器上 ⇒ 共用一个出口 IP ⇒ 共用一个额度。
const POLLINATIONS_HOST = 'image.pollinations.ai';
const DEFAULT_MIN_INTERVAL_MS = 45000;

// 支持的供应商：
//   pollinations  免密钥，但是「每 IP 每 45 秒 1 张」（实测确认），且文档写明每张带角标
//   cloudflare    Workers AI 免费档 10000 neurons/天（≈170 张 1024²），无水印、无排队
//   siliconflow / zhipu  自家 key，国内可用
const KNOWN_PROVIDERS = ['pollinations', 'cloudflare', 'siliconflow', 'zhipu'];

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 上游限流错误：带一个"大概要等多久"的毫秒数，供调度层排期。 */
export class RateLimitError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
    this.rateLimited = true;
  }
}

/**
 * 找到「同机所有桥接实例共享」的目录。
 *
 * 为什么需要跨进程协调：免费额度是按**出口 IP** 算的，而两个机器人是**两个进程**、
 * 同一个 IP。各自在进程内做节流只能保证自己不撞自己 —— 两边同时画照样 402。
 * 所以节流状态必须落到一个两个进程都能看到的文件上。
 *
 * 实例目录形如 <repo>/qq-bridge-01 ⇒ 共享目录是 <repo>/.cache。
 */
function sharedStateDir(root) {
  const abs = path.resolve(root);
  const parent = path.dirname(abs);
  const base = path.basename(abs);
  const repoRoot = /^qq-bridge/i.test(base) ? parent : abs;
  return path.join(repoRoot, '.cache');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 在共享文件上做「预约」：算出轮到我的时刻，并把下一个可用时刻往后推一格。
 *
 * 用 `wx` 独占创建做互斥（两个进程同时 open 只有一个成功），
 * 拿不到就稍等重试。锁文件可能因为进程崩溃残留，所以带过期时间。
 */
function reserveSlot(sharedDir, intervalMs) {
  const lockFile = path.join(sharedDir, 'image-gen.lock');
  const slotFile = path.join(sharedDir, 'image-gen.slot');
  const LOCK_STALE_MS = 5000;
  fs.mkdirSync(sharedDir, { recursive: true });

  // ── 拿锁 ──
  let gotLock = false;
  for (let i = 0; i < 200 && !gotLock; i += 1) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(Date.now()));
      fs.closeSync(fd);
      gotLock = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // 残留锁：超过 LOCK_STALE_MS 就当作已失效，抢过来。
      try {
        const age = Date.now() - Number(fs.readFileSync(lockFile, 'utf8'));
        if (age > LOCK_STALE_MS) { fs.rmSync(lockFile, { force: true }); continue; }
      } catch { /* 被别的进程删了，直接重试 */ }
      // 同步阻塞几毫秒即可：这一段只做文件读写，不涉及网络。
      const until = Date.now() + 25;
      while (Date.now() < until) { /* spin */ }
    }
  }

  try {
    let nextAt = 0;
    try {
      const raw = Number(fs.readFileSync(slotFile, 'utf8'));
      if (Number.isFinite(raw)) nextAt = raw;
    } catch { /* 第一次，或者文件被清掉 */ }
    const mySlot = Math.max(Date.now(), nextAt);
    fs.writeFileSync(slotFile, String(mySlot + intervalMs), 'utf8');
    return mySlot;
  } finally {
    if (gotLock) { try { fs.rmSync(lockFile, { force: true }); } catch {} }
  }
}

/**
 * 出图成功后，把下一个可用时刻**按完成时刻**重算。
 *
 * 为什么必须有这一步：服务端的 45 秒窗口是从**上一张生成完成**开始算的，
 * 而 reserveSlot 是按**开始时刻**排期。一次生成要 3~5 秒，累积几次之后
 * 我们的排期就会比服务端早几秒 → 又撞 402。实测就是这么翻车的：
 * 排期上第二个请求"该轮到我了"，服务端却说 "Retry after 44s"。
 *
 * 这里只在「算出来比文件里更晚」时才写，避免把后来的预约往回拨。
 */
function markCompleted(sharedDir, intervalMs) {
  if (intervalMs <= 0) return;
  const lockFile = path.join(sharedDir, 'image-gen.lock');
  const slotFile = path.join(sharedDir, 'image-gen.slot');
  const nextAt = Date.now() + intervalMs;
  let gotLock = false;
  try {
    fs.mkdirSync(sharedDir, { recursive: true });
    for (let i = 0; i < 200 && !gotLock; i += 1) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        fs.writeSync(fd, String(Date.now()));
        fs.closeSync(fd);
        gotLock = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') return;
        try {
          const age = Date.now() - Number(fs.readFileSync(lockFile, 'utf8'));
          if (age > 5000) { fs.rmSync(lockFile, { force: true }); continue; }
        } catch { /* 继续重试 */ }
        const until = Date.now() + 10;
        while (Date.now() < until) { /* spin */ }
      }
    }
    if (!gotLock) return;
    let current = 0;
    try { current = Number(fs.readFileSync(slotFile, 'utf8')) || 0; } catch {}
    if (nextAt > current) fs.writeFileSync(slotFile, String(nextAt), 'utf8');
  } catch {
    /* 排期写失败不影响本次已经画好的图 */
  } finally {
    if (gotLock) { try { fs.rmSync(lockFile, { force: true }); } catch {} }
  }
}

/**
 * 取一张 Pollinations 图，专门处理免费档限流。
 *
 * 为什么这里**不用** safeFetchBuffer：
 *   · 那个函数只回 buffer，把状态码和响应头都吃掉了 —— 而 402 的关键信息
 *     （`retry-after`、"1 image every 45 seconds"）全在头/正文里；
 *   · SSRF 面在这里不存在：URL 是我们自己用常量主机名（POLLINATIONS_HOST）
 *     拼出来的，prompt 只是路径段。不会出现"用户控制 host"的情况。
 *   带 key 的供应商仍然走 safeFetchBuffer，因为它们的响应里可能给任意 URL。
 */
async function fetchPollinationsOnce(url, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const msg = String(error?.message ?? error);
    // 超时/断连属于可重试；包成普通 Error 让外层 withRetry 判断。
    throw new Error(`网络错误：${msg}`);
  }
  if (res.status === 402 || res.status === 429) {
    const retryAfterSec = Number(res.headers.get('retry-after'));
    const body = await res.text().catch(() => '');
    let text = body;
    try {
      const j = JSON.parse(body);
      text = j?.error?.message || body;
    } catch { /* 保留原文 */ }
    // `retry-after` 是服务端给的权威等待时间；没给就按一个 45 秒窗口保守估计。
    const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : DEFAULT_MIN_INTERVAL_MS;
    throw new RateLimitError(
      `免费额度限流：${String(text).slice(0, 160) || `HTTP ${res.status}`}`,
      waitMs
    );
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!looksLikeImageBuffer(buf)) {
    // 200 但不是图片：多半是错误页/HTML，把开头几字节带上便于排查。
    throw new Error(`返回内容不是有效图片（前 16 字节：${buf.subarray(0, 16).toString('hex')}）`);
  }
  return { buffer: buf, status: 200 };
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
    provider: KNOWN_PROVIDERS.includes(provider) ? provider : 'pollinations',
    apiKey: String(raw.apiKey ?? '').trim(),
    // 允许从环境变量取 key，避免把密钥写进 config.json（那个文件含多个凭据，风险更高）
    apiKeyEnv: String(raw.apiKeyEnv ?? '').trim(),
    // Cloudflare 需要 account id（不是密钥，但仍属于本机配置）
    accountId: String(raw.accountId ?? '').trim(),
    accountIdEnv: String(raw.accountIdEnv ?? '').trim(),
    baseURL: String(raw.baseURL ?? '').trim(),
    model: String(raw.model ?? '').trim(),
    // Cloudflare flux-1-schnell 不支持尺寸参数（固定 1024×1024），这里仅对其余供应商生效。
    size: num(raw.size, DEFAULT_SIZE, MIN_SIZE, MAX_SIZE),
    steps: num(raw.steps, 4, 1, 8),
    // nologo：Pollinations 默认会在角落加水印，nologo=true 去掉。保留可配置是为了
    // 尊重对方服务的免费额度（不想关就不关，不影响功能）。
    nologo: raw.nologo !== false,
    timeoutMs: num(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 10000, 300000),
    maxPerDay: num(raw.maxPerDay, 20, 0, 200),
    // 免费档的最小出图间隔（毫秒）。实测服务端就是「1 image every 45 seconds per IP」，
    // 所以默认 45000。拿到 pollen key 后可以调小。
    minIntervalMs: num(raw.minIntervalMs, DEFAULT_MIN_INTERVAL_MS, 0, 600000),
    // 最多愿意为一个画图请求等多久（毫秒）。排队排到超过这个数就直接如实告诉用户
    // 「现在画不了，还要等 N 秒」，而不是让他盯着"正在输入"干等两分钟。
    maxWaitMs: num(raw.maxWaitMs, 180000, 5000, 600000),
    // 重试次数（不含首次）。Pollinations 除了限流，还会在负载高时给 503；
    // 那是**瞬时**的（同一地址隔两秒就 200），所以必须容忍。
    // 只重试可重试的错误（402/429/5xx/网络），内容闸门的拒绝不重试。
    retries: num(raw.retries, 2, 0, 5),
  };
}

/** 这个错误值不值得再试一次。 */
function isRetryableError(error) {
  if (error?.rateLimited) return true;
  const msg = String(error?.message ?? error ?? '');
  if (/HTTP 429/.test(msg)) return true;
  if (/HTTP 5\d\d/.test(msg)) return true;
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|网络错误|network/i.test(msg)) return true;
  return false;
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带退避的重试包装：只重试瞬时错误，其它错误立刻抛。
 *
 * 限流（RateLimitError）用服务端给的 `retry-after` 等，不用固定退避 ——
 * 那是权威值，猜一个更短的只会白撞一次、把限流窗口又往后推。
 */
async function withRetry(fn, retries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableError(error)) throw error;
      const wait = error?.rateLimited && error.retryAfterMs > 0
        ? error.retryAfterMs + 250      // 多给 250ms，避开边界上的又一次撞车
        : 1500 * (attempt + 1);         // 1.5s, 3s, 4.5s…（503/网络这类瞬时抖动）
      await sleepMs(wait);
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

    // 排队：免费档是「每 IP 每 45 秒 1 张」，两个机器人共用同一个出口 IP，
    // 所以必须跨进程排期，不能各自闷头发。见 reserveSlot 的注释。
    const shared = sharedStateDir(root ?? '.');
    const deadline = Date.now() + cfg.maxWaitMs;
    let slotAt = 0;
    try {
      slotAt = reserveSlot(shared, cfg.minIntervalMs);
    } catch {
      // 拿不到共享目录（权限/磁盘）就退化成"不排队"，宁可偶尔撞 402 也别整个坏掉。
      slotAt = 0;
    }
    let waitedMs = Math.max(0, slotAt - Date.now());
    if (waitedMs > cfg.maxWaitMs) {
      // 与其让用户干等，不如立刻如实说清楚 —— 这也是模型能转述的唯一有效信息。
      throw new Error(
        `免费画图额度排队中：前面还有人要画，约 ${Math.ceil(waitedMs / 1000)} 秒后才轮到你`
        + `（免费档限制：每 ${Math.round(cfg.minIntervalMs / 1000)} 秒 1 张，全机共用出口 IP）。`
        + '可以稍后再让我画，或者配置里换一个带 key 的供应商就没有这个限制。'
      );
    }
    if (waitedMs > 800) await sleep(waitedMs);

    // 拿到图后按**完成时刻**重排下一次，避免排期逐渐早于服务端窗口而反复撞 402。
    let fetched;
    try {
      fetched = await withRetry(async () => {
        if (Date.now() > deadline + cfg.timeoutMs) {
          throw new Error('排队/等待时间已超过上限，这次先不画了');
        }
        return fetchPollinationsOnce(url, cfg.timeoutMs);
      }, cfg.retries);
    } catch (error) {
      // 失败也要把窗口让出去：这一格已经被我们用掉了，别让下一个请求立刻撞上去。
      try { markCompleted(shared, cfg.minIntervalMs); } catch {}
      if (error?.rateLimited) {
        const waitSec = Math.ceil(error.retryAfterMs / 1000);
        throw new Error(
          `免费画图额度正在被占用（每 ${Math.round(cfg.minIntervalMs / 1000)} 秒 1 张，全机共用出口 IP）。`
          + `服务端说要再等约 ${waitSec} 秒。稍后再让我画就行 —— 这不是"额度用完了"，也不是画不出来。`
        );
      }
      throw error;
    }
    try { markCompleted(shared, cfg.minIntervalMs); } catch {}
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
      waitedMs,
    };
  }

  // ── Cloudflare Workers AI（免费档 10000 neurons/天，无水印、无排队）─────────
  //
  // 为什么这是「免费 + 不排队 + 无水印」的正解：
  //   · 免费档每天 10000 neurons，重置于 00:00 UTC；
  //   · `flux-1-schnell` 计费 = 4.80 neurons/512² tile + 9.60 neurons/step，
  //     1024² 且 4 步 ≈ 57.6 neurons ⇒ 每天约 170 张，远超日常聊天用量；
  //   · 是 Cloudflare 托管的原生 FLUX 输出，**没有**角标；
  //   · 不需要等 45 秒（只有分钟级速率上限，正常聊天碰不到）。
  // 代价：要一个免费 Cloudflare 账号 → API Token + Account ID。两者都填进配置即可。
  //
  // 注意 flux-1-schnell **不支持宽高参数**（固定 1024×1024），所以 cfg.size 在这里无效；
  // 与其假装能控制，不如在返回值里如实报实际的 size。
  if (cfg.provider === 'cloudflare') {
    const apiKey = resolveApiKey(cfg);
    const accountId = cfg.accountId || (cfg.accountIdEnv ? String(process.env[cfg.accountIdEnv] ?? '').trim() : '');
    if (!apiKey) {
      throw new Error(
        'Cloudflare 画图需要 API Token：请在 config.json 的 imageGen.apiKey 填写，'
        + '或设环境变量（imageGen.apiKeyEnv，例如 CLOUDFLARE_API_TOKEN）。'
        + '在 dash.cloudflare.com → My Profile → API Tokens 创建一个带 Workers AI 权限的 token。'
      );
    }
    if (!accountId) {
      throw new Error(
        'Cloudflare 画图需要 Account ID：请在 config.json 的 imageGen.accountId 填写，'
        + '或设环境变量（imageGen.accountIdEnv，例如 CLOUDFLARE_ACCOUNT_ID）。'
        + 'Account ID 在 dash.cloudflare.com 的 Workers & Pages 概览页右侧。'
      );
    }
    const model = cfg.model || '@cf/black-forest-labs/flux-1-schnell';
    const url = cfg.baseURL
      || `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    const payload = { prompt: withSafetySuffix(text), steps: cfg.steps };
    if (useSeed !== undefined) payload.seed = useSeed;

    const result = await withRetry(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      const rawText = await res.text();
      let body = null;
      try { body = JSON.parse(rawText); } catch { /* 保留原文 */ }
      if (!res.ok || body?.success === false) {
        const detail = body?.errors?.map((e) => e?.message).filter(Boolean).join('；')
          || body?.error?.message || rawText.slice(0, 200) || `HTTP ${res.status}`;
        // 把状态码留在消息里，让 isRetryableError 判断得出该不该重试。
        throw new Error(`HTTP ${res.status} Cloudflare 画图失败：${detail}`);
      }
      // REST 返回 { result: { image: "<base64>" } }；SDK 直接返回 { image }。
      const b64 = body?.result?.image ?? body?.image;
      if (!b64) throw new Error(`Cloudflare 没有返回图片；原文：${rawText.slice(0, 200)}`);
      const buf = Buffer.from(String(b64), 'base64');
      if (!looksLikeImageBuffer(buf)) throw new Error('Cloudflare 返回的 base64 不是有效图片');
      return buf;
    }, cfg.retries);

    return {
      buffer: result,
      mime: sniffMime(result),
      provider: 'cloudflare',
      model,
      prompt: text,
      // flux-1-schnell 固定 1024×1024；如实报，不要回 cfg.size 骗人。
      size: 1024,
      seed: useSeed ?? null,
      bytes: result.length,
      url,
      waitedMs: 0,
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
