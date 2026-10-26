// 联网图片搜索（MCP `image_search` 与桥接 `/api/socialV2/send-image` 的 `query` 分支共用）。
//
// 为什么不用官方图搜 API：DeepSeek 的联网搜索只返回网页结果，不含可直链的图片；
// 各家图搜 API（Bing/Google）都要单独买 key 和备案主体，对一个自建 QQ 机器人不现实。
// 所以这里抓 Bing 图片搜索的结果页 —— 它把每张图的结构化元数据（`murl` 原图、
// `turl` 缩略图、`purl` 来源页）直接内联在 HTML 的 `m="..."` 属性里，
// 解析稳定、无需额外凭据，也不依赖 JS 渲染。
//
// 安全边界（与 safe-fetch / web-search 一致）：
// - 只走 safeFetch（SSRF 防护、逐跳校验、限字节）；
// - 只接受 http/https 的候选地址，剔除 svg/ico/avif 等 DSH 与 QQ 都不支持的格式；
// - 原图字节的合法性由调用方用 safeFetchBuffer 的 magic 校验兜底 ——
//   **不能**直接把搜到的 URL 交给 QQ 网关或 DSH 去二次抓取，那样就绕过了 SSRF 防护。
// - 默认开启严格安全搜索（`adlt=strict`）：这是给人看的群聊，不是在给自己搜图。
import { safeFetch } from './safe-fetch.js';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_COUNT = 12;
const MAX_COUNT = 24;
const MAX_HTML_CHARS = 2 * 1024 * 1024;
const CACHE_TTL_MS = 3 * 60 * 1000;
const CACHE_MAX_ENTRIES = 40;
// DSH 只认 PNG/JPEG/GIF/WebP（见 safe-fetch 的 looksLikeImageBuffer），
// QQ 侧同理；其余格式即使搜到了也发不出去，提前剔掉省一次下载。
const UNSUPPORTED_EXT_RE = /\.(svg|ico|avif|bmp|tif|tiff|heic|heif|jxl)(?:$|[?#])/i;

const cache = new Map();

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 读取 config.json 的 `imageSearch` 段（缺省用内置默认值）。 */
export function loadImageSearchConfig(root) {
  let file = {};
  try {
    const text = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
    file = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {}
  const raw = file?.imageSearch && typeof file.imageSearch === 'object' && !Array.isArray(file.imageSearch) ? file.imageSearch : {};
  return {
    enabled: raw.enabled !== false,
    market: typeof raw.market === 'string' && raw.market.trim() ? raw.market.trim() : 'zh-CN',
    safeSearch: raw.safeSearch !== false,
    defaultCount: num(raw.defaultCount, DEFAULT_COUNT, 1, MAX_COUNT),
    timeoutMs: num(raw.timeoutMs, 20000, 5000, 60000)
  };
}

/** 清洗搜索词：去 CQ 码/控制字符/超长。 */
export function sanitizeImageQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    // Bing 会把中文标题写成数字实体（&#20013;）或十六进制（&#x4e2d;）
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; }
    });
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

/**
 * 从 Bing 图片结果 HTML 里抽取候选图。
 *
 * 页面结构（简化）：
 *   <a class="iusc" m="{&quot;murl&quot;:&quot;https://...jpg&quot;,
 *                      &quot;turl&quot;:&quot;https://...jpg&quot;,
 *                      &quot;purl&quot;:&quot;https://页面&quot;,
 *                      &quot;t&quot;:&quot;标题&quot;}" ...>
 *
 * 解析要尽量宽容：`m` 属性里没有裸双引号（都被转义成 &quot;），
 * 所以可以安全地截到下一个 `"`；字段顺序不固定，逐条 JSON.parse 而不是正则抠字段。
 */
export function parseBingImageResults(html) {
  const text = String(html ?? '');
  const items = [];
  const seen = new Set();
  const attrRe = /m="([^"]+)"/g;
  let match;
  while ((match = attrRe.exec(text)) !== null) {
    let data;
    try {
      data = JSON.parse(decodeEntities(match[1]));
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    const url = typeof data.murl === 'string' ? data.murl.trim() : '';
    if (!/^https?:\/\//i.test(url)) continue;
    if (UNSUPPORTED_EXT_RE.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({
      url,
      thumbnailUrl: typeof data.turl === 'string' && /^https?:\/\//i.test(data.turl) ? data.turl.trim() : '',
      pageUrl: typeof data.purl === 'string' && /^https?:\/\//i.test(data.purl) ? data.purl.trim() : '',
      title: decodeEntities(typeof data.t === 'string' ? data.t : '').replace(/\s+/g, ' ').trim().slice(0, 120),
      source: hostOf(url)
    });
  }
  return items;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { at: Date.now(), value });
}

function buildSearchUrl(query, { count, market, safeSearch, first = 0, variant = 0 }) {
  const params = new URLSearchParams({
    q: query,
    first: String(first),
    count: String(count),
    qft: '',
    form: 'HDRSC2'
  });
  if (safeSearch) params.set('adlt', 'strict');
  // Bing 图片搜索会**间歇性**返回不含 `m=` 属性的骨架页（只剩 JS 外壳），
  // 这不是"没有结果"，而是抓取被降级了。variant 用来换一组等价参数再试一次，
  // 换 URL 形状比原样重试命中率高得多（同一 URL 往往还是同一份缓存页）。
  if (variant === 1) params.set('form', 'IRFLTR');
  if (variant === 2) {
    params.set('form', 'HDRSC3');
    params.set('mmasync', '1');
  }
  return `https://cn.bing.com/images/search?${params.toString()}`;
}

/**
 * 搜索图片。
 *
 * 会做最多 3 次（1 次主请求 + 2 个参数变体）的尝试：Bing 有时返回不含结构化
 * `m=` 属性的降级页面，单次失败就报"没搜到"会让模型以为真没有图，
 * 于是错误地放弃配图或反复换词。
 * @returns {Promise<{provider:string, query:string, count:number, items:Array}>}
 */
export async function imageSearch(query, options = {}) {
  const rawQuery = options.raw === true ? String(query ?? '') : sanitizeImageQuery(query);
  if (!rawQuery) throw new Error('搜索词为空，已拒绝');

  const cfg = options.config ?? loadImageSearchConfig(options.root ?? process.cwd());
  if (cfg.enabled === false) throw new Error('图片搜索已在配置中关闭（config.json → imageSearch.enabled）');

  const wanted = num(options.count, cfg.defaultCount, 1, MAX_COUNT);
  const cacheKey = `${cfg.market}|${cfg.safeSearch}|${wanted}|${rawQuery}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // 多抓一些再筛：Bing 会掺入 svg/avif 以及失效链接。
  const fetchCount = Math.min(MAX_COUNT, wanted * 2);
  const failures = [];
  for (let variant = 0; variant < 3; variant += 1) {
    const url = buildSearchUrl(rawQuery, {
      count: fetchCount,
      market: cfg.market,
      safeSearch: cfg.safeSearch,
      variant
    });
    let page;
    try {
      page = await safeFetch(url, MAX_HTML_CHARS);
    } catch (error) {
      failures.push(error?.message ?? String(error));
      continue;
    }
    if (page.statusCode < 200 || page.statusCode >= 300) {
      failures.push(`HTTP ${page.statusCode}`);
      continue;
    }
    const items = parseBingImageResults(page.body).slice(0, wanted);
    if (!items.length) {
      failures.push('页面无可解析的图片元数据');
      continue;
    }
    const result = { provider: 'bing-images', query: rawQuery, count: items.length, items };
    cacheSet(cacheKey, result);
    return result;
  }

  // 全部尝试都没拿到图：把最后一次的真实原因带出去，别只说"没搜到"。
  const detail = failures.length ? `（${failures[failures.length - 1]}）` : '';
  const error = new Error(`没搜到「${rawQuery}」的可用图片${detail}，换个更具体的词试试`);
  error.empty = true;
  throw error;
}
