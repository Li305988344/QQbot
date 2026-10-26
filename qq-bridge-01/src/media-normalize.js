// 媒体归一化：把「QQ 给我们的原始图片」压成「DSH 与模型真能吃下的形状」。
//
// ── 为什么需要这一层（2026-10-18 审计结论，见 docs/audits/AUDIT_2026-10-18_MEDIA_AND_WATERMARK.md）
//
// ① 体积悬崖：DSH 的 MCP 图片入口会用正则校验 base64
//    （dsh-mcp-client 的 CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:…)?$/）。
//    这条正则在长输入上会压爆 V8 的 regexp 回溯栈，实测：
//        base64 ≥ 4,474,880 字符（原始字节 ≥ 3.20 MiB）→ RangeError: Maximum call stack size exceeded
//    而 DSH 把这个异常原样降级成 `[image unavailable: image/gif; Maximum call stack size exceeded; …]`
//    —— 模型只看到一行错误，图一个字节都没进上下文。
//    桥接侧的抓取上限（socialV2.media.maxBytes，默认 8 MiB）远在这条线之上，
//    于是「3.2–8 MiB 的图」就成了「桥接认为合法、DSH 必然拒绝」的死区。
//
// ② 动图变单帧：DSH 的 canPassThroughNormalization() 显式排除 image/gif，
//    一律交给 sharp 归一化，而 sharp 默认只解 page 0 —— 一张 48 帧、4.8 MB 的动图，
//    模型最终只看到「第 1 帧压成的 12 KB 静态 JPEG」，而且上下文里没有任何「这是动图」的提示。
//    模型于是只能瞎猜（实测会话里它连着两次给出的解释都是错的）。
//
// ── 本模块的取舍
//
// · **只动喂给模型的那一份**。收集表情（add_custom_face）必须用原始字节，
//   所以归一化只接在 fetchMediaData / resolveMediaList / sticker-image 这些「给模型看」的出口，
//   不去改 fetchOneBotImage / fetchFaceMedia 的返回值。
// · **动图抽帧拼图**而不是发多张图：一条消息 5 张图 = 5 次 DSH admission + 5 份 token，
//   而 3×2 拼图信息密度更高、只算一张图（实测 4.83 MB / 200 帧 → 92 KB / 269 ms）。
// · **能不动就不动**：小图（≤ maxModelBytes 且长边够小）原样放行，零延迟。
// · **ffmpeg 缺失也不硬塞**：超线又压不动的，宁可回一句「太大，看不了」，也不发注定被 DSH 丢掉
//   的字节（那样模型只会看到一行看不懂的错误）。
//
// 依赖：只用 node 内置 + voice-core 的 resolveFfmpeg（ffmpeg 定位的唯一实现）。
// 子进程一律 `stdio: 'ignore'` + 写文件：受限沙箱里 pipe 会 EPERM（见 voice-core.js 开头的说明）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpeg } from './voice-core.js';

/** 默认值集中一处，bridge.js 只做 config 覆盖（见 modelMediaLimits）。 */
export const MEDIA_DEFAULTS = Object.freeze({
  // 交给 DSH 的单张图片原始字节上限。DSH 的炸栈线是 ≈3.20 MiB，
  // 这里取 1 MiB：留 3 倍余量，顺带把 token 成本压一个数量级（1 MiB 图 ≈ 1.33 MB base64）。
  maxModelBytes: 1024 * 1024,
  // 长边上限：手机直出 4000×3000 缩到 1280 后约 150–250 KB，肉眼描述完全够用。
  maxLongEdge: 1280,
  // 动图抽几帧：6 帧正好 3×2，超过 9 帧拼图会小到看不清单帧。
  gifFrames: 6,
  // 每一格的目标宽度（px）：240 一格，3×2 拼图约 736×492，实测 92 KB。
  gifTile: 240,
  // 单张 ffmpeg 调用的硬超时。实测 200 帧 GIF 拼图 269 ms、4K 重编码 < 1 s，25 s 是兜底。
  timeoutMs: 25000
});

/** 硬上限：不管 config 怎么写，都不允许超过 DSH 的实测炸栈线下沿。 */
const HARD_MAX_MODEL_BYTES = Math.floor(3.0 * 1024 * 1024);

// ── 格式探测（纯函数，可单测） ────────────────────────────────────────────

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** GIF 子块链跳过：每个子块首字节是长度，0 结束。返回新游标（越界返回 -1）。 */
function skipGifSubBlocks(buf, pos) {
  let p = pos;
  let guard = 0;
  while (p < buf.length) {
    const size = buf[p];
    p += 1;
    if (size === 0) return p;
    p += size;
    if (++guard > 1_000_000) return -1;
  }
  return -1;
}

/**
 * 解析 GIF 的帧数与总时长（以及是否有透明帧）。
 *
 * 为什么不直接问 ffprobe：a) ffmpeg 可能没装，而「这是动图，N 帧」这句话就算没 ffmpeg
 * 也要能告诉模型；b) 每次看图都 spawn 一次 ffprobe 是白花的时间（这里纯内存解析）。
 * GIF 的块结构很实在：0x2C = 图像描述符（一帧），0x21 0xF9 = 图形控制扩展（带 delay）。
 */
function parseGif(buf) {
  if (buf.length < 13) return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  let pos = 13;
  if (packed & 0x80) pos += 3 * (2 << (packed & 0x07)); // 全局颜色表
  let frames = 0;
  let durationCs = 0;
  let alpha = false;
  let delayCs = 0;
  let guard = 0;
  while (pos >= 0 && pos < buf.length) {
    if (++guard > 5_000_000) break;
    const block = buf[pos];
    pos += 1;
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      if (pos >= buf.length) break;
      const label = buf[pos];
      pos += 1;
      if (label === 0xf9 && pos + 4 <= buf.length) {
        // 块长(1) 打包位(1) delay(2) 透明色索引(1) 终结符(1)
        const size = buf[pos];
        if (size >= 4 && pos + 4 < buf.length) {
          const gcePacked = buf[pos + 1];
          delayCs = buf.readUInt16LE(pos + 2);
          if (gcePacked & 0x01) alpha = true;
        }
      }
      pos = skipGifSubBlocks(buf, pos);
      continue;
    }
    if (block === 0x2c) {
      if (pos + 9 > buf.length) break;
      const descPacked = buf[pos + 8];
      pos += 9;
      if (descPacked & 0x80) pos += 3 * (2 << (descPacked & 0x07)); // 局部颜色表
      pos += 1; // LZW 最小码长
      pos = skipGifSubBlocks(buf, pos);
      frames += 1;
      durationCs += delayCs || 0;
      delayCs = 0;
      continue;
    }
    break; // 解析不了就别硬猜
  }
  return {
    width,
    height,
    frames: Math.max(1, frames),
    durationMs: durationCs > 0 ? durationCs * 10 : 0,
    alpha
  };
}

/** WebP：解析尺寸，并识别动图（ANIM 块 / ANMF 帧块）。 */
function parseWebp(buf) {
  if (buf.length < 30) return null;
  const fourcc = buf.toString('ascii', 12, 16);
  let width = 0;
  let height = 0;
  if (fourcc === 'VP8X') {
    width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
    height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
  } else if (fourcc === 'VP8L') {
    const b = [buf[21], buf[22], buf[23], buf[24]];
    width = 1 + (((b[1] & 0x3f) << 8) | b[0]);
    height = 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
  } else if (fourcc === 'VP8 ') {
    width = buf.readUInt16LE(26) & 0x3fff;
    height = buf.readUInt16LE(28) & 0x3fff;
  } else {
    return null;
  }
  // 动图：RIFF 里出现 ANIM（动画头）与若干个 ANMF（帧）。只数块头，不解析负载。
  let frames = 0;
  let pos = 12;
  let guard = 0;
  while (pos + 8 <= buf.length && ++guard < 1_000_000) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'ANMF') frames += 1;
    pos += 8 + size + (size & 1);
  }
  const alpha = fourcc === 'VP8X' ? (buf[20] & 0x10) !== 0 : true;
  return { width, height, frames: Math.max(1, frames), durationMs: 0, alpha };
}

function parsePng(buf) {
  if (buf.length < 26) return null;
  const colorType = buf[25];
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    frames: 1,
    durationMs: 0,
    alpha: colorType === 4 || colorType === 6
  };
}

function parseJpeg(buf) {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const len = buf.readUInt16BE(offset + 2);
    if (len < 2) return null;
    // SOF0–SOF15（排除 DHT C4 / JPG C8 / DAC CC）
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5), frames: 1, durationMs: 0, alpha: false };
    }
    offset += 2 + len;
  }
  return null;
}

/**
 * 从字节里认出格式/尺寸/帧数。
 *
 * @returns null（认不出）或
 *   { format:'gif'|'png'|'jpeg'|'webp', width, height, frames, durationMs, animated, alpha }
 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  let format = null;
  let parsed = null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    format = 'png'; parsed = parsePng(buf);
  } else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    format = 'jpeg'; parsed = parseJpeg(buf);
  } else if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
    format = 'gif'; parsed = parseGif(buf);
  } else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    format = 'webp'; parsed = parseWebp(buf);
  }
  if (!parsed || !parsed.width || !parsed.height) return null;
  return {
    format,
    width: parsed.width,
    height: parsed.height,
    frames: Math.max(1, parsed.frames || 1),
    durationMs: parsed.durationMs || 0,
    animated: (parsed.frames || 1) > 1,
    alpha: !!parsed.alpha
  };
}

// ── 决策（纯函数，可单测） ────────────────────────────────────────────────

/**
 * 要不要动这张图？返回 null = 原样放行。
 *
 * @param info sniffImage() 的结果（null 表示认不出 → 一律放行，交给下游）
 * @param bytes 原始字节数
 * @param limits 归一化上限
 */
export function planNormalization(info, bytes, limits = {}) {
  const maxBytes = clampInt(limits.maxModelBytes, 64 * 1024, HARD_MAX_MODEL_BYTES, MEDIA_DEFAULTS.maxModelBytes);
  const maxLongEdge = clampInt(limits.maxLongEdge, 256, 2048, MEDIA_DEFAULTS.maxLongEdge);
  if (!info) {
    // 认不出的格式：能放就放（下游 mimeFromBuffer 会兜底），太大就拒绝——绝不硬塞。
    return bytes > maxBytes ? { action: 'reject', reason: `未知图片格式且 ${bytes} 字节超过上限` } : null;
  }
  if (info.animated) {
    return { action: 'animate', maxBytes, maxLongEdge };
  }
  const longEdge = Math.max(info.width, info.height);
  if (bytes <= maxBytes && longEdge <= maxLongEdge) return null;
  return { action: 'shrink', maxBytes, maxLongEdge, bytes, longEdge };
}

/** 动图拼图布局：帧数 → { cols, rows, fps, sampleFrames }。纯函数。 */
export function planAnimation(info, limits = {}) {
  const wanted = clampInt(limits.gifFrames, 2, 12, MEDIA_DEFAULTS.gifFrames);
  const frames = Math.max(1, info?.frames || 1);
  // 帧比想要的多才有意思抽帧；帧本来就少就全用上（不重复填充没信息量的格子）。
  const sample = Math.min(wanted, frames);
  // 布局偏好：6→3×2、9→3×3、8→4×2（都填满），其余按接近正方形算。
  const layout = { 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2], 7: [4, 2], 8: [4, 2], 9: [3, 3], 10: [5, 2], 11: [4, 3], 12: [4, 3] }[sample]
    ?? [Math.ceil(Math.sqrt(sample)), Math.ceil(sample / Math.ceil(Math.sqrt(sample)))];
  const [cols, rows] = layout;
  // fps 必须让 ffmpeg 恰好产出 sample 帧；时长未知时按每帧 100 ms 估（QQ 表情的常见默认）。
  const durationMs = info?.durationMs > 0 ? info.durationMs : frames * 100;
  const seconds = Math.max(0.05, durationMs / 1000);
  const fps = Math.min(30, Math.max(0.05, Number((sample / seconds).toFixed(4))));
  return { cols, rows, fps, sampleFrames: sample, totalFrames: frames, durationMs };
}

// ── ffmpeg 调用 ──────────────────────────────────────────────────────────

/**
 * 跑一次 ffmpeg：输入/输出都走文件，stdio 全 ignore。
 *
 * 为什么不用管道：受限沙箱里 `spawn` + stdio:'pipe' 会直接 EPERM（voice-core.js 开头有同样记录）。
 * 代价是拿不到 ffmpeg 的 stderr —— 所以调用方只报「退出码 + 动作名」，不假装能诊断具体原因。
 */
function runFfmpeg(ffmpeg, args, { timeoutMs = MEDIA_DEFAULTS.timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error: `ffmpeg 启动失败：${error?.message ?? error}` });
      return;
    }
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      settle({ ok: false, error: `ffmpeg 超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.on('error', (error) => settle({
      ok: false,
      error: error?.code === 'ENOENT'
        ? '找不到 ffmpeg（设置 FFMPEG_PATH 或 config.json 的 socialV2.voice.ffmpegPath）'
        : `ffmpeg 不可用：${error?.message ?? error}`
    }));
    child.on('close', (code) => settle(code === 0 ? { ok: true } : { ok: false, error: `ffmpeg 退出码 ${code}` }));
  });
}

function makeTempWorkspace(tmpDir) {

  const base = tmpDir ? path.resolve(tmpDir) : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'qqb-media-'));
}

function cleanupWorkspace(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** 按扩展名挑输出容器：有 alpha 用 PNG（保透明），否则 JPEG（体积小得多）。 */
function pickOutputExt(info) {
  return info?.alpha ? '.png' : '.jpg';
}

function readIfExists(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return null;
    return fs.readFileSync(file);
  } catch { return null; }
}

/**
 * ffmpeg 不可用（或压不动）时的**降级放行**。
 *
 * ── 为什么需要
 * 桥接侧的 maxModelBytes（默认 1 MiB）是「主动压小以省 token」的闸门；而 DSH 真正的
 * 炸栈线在 ≈3.20 MiB（base64 正则回溯，见文件头 ①）。1–3 MiB 这段本来靠 ffmpeg 缩图
 * 越过，一旦机器上没装 ffmpeg，它就变成**死区**：图明明 DSH 吃得下，却被我们自己判死，
 * 模型一个字节都看不到。
 *
 * 实测（本机）：群里 2.2 MB 动图 → `动图 2.20MB 无法压缩（找不到 ffmpeg）` → 整张跳过。
 * 同一张图若原样交给 DSH，sharp 会解出首帧并缩放，模型至少能看见内容。
 *
 * 所以：压不动时，只要原始字节仍在 DSH 的硬上限内，就原样放行，并用 note 明说
 * 「这是动图首帧/未缩放的原图」，避免模型对尺寸和"是不是动图"瞎猜。
 * 超过硬上限才真的拒绝 —— 那种字节 DSH 必然丢掉，发了只会让模型看到一行错误。
 *
 * @returns {null} 超过硬上限，调用方应报错
 */
export function degradeToRawPassThrough(buf, bytes, mimeType, info, reason) {
  if (bytes > HARD_MAX_MODEL_BYTES) return null;
  const fmt = info?.format
    ? (info.format === 'jpeg' ? 'image/jpeg' : `image/${info.format}`)
    : (mimeType || 'image/jpeg');
  const bits = [];
  if (info?.animated) bits.push(`动图 ${info.frames} 帧，只提供首帧`);
  else if (info?.width && info?.height) bits.push(`原尺寸 ${info.width}×${info.height} 未缩放`);
  bits.push(`${(bytes / 1024 / 1024).toFixed(2)}MB`);
  if (reason) bits.push(`未压缩原因：${reason}`);
  return { ok: true, buffer: buf, mimeType: fmt, note: bits.join('；') };
}

// ── 主入口 ──────────────────────────────────────────────────────────────

/**
 * 把一张图整理成「可以安全交给 DSH / 模型」的形态。
 *
 * @param buf       原始字节
 * @param mimeType  调用方已知的 MIME（可能与实际不符，以字节探测为准）
 * @param opts      { maxModelBytes, maxLongEdge, gifFrames, gifTile, enabled, ffmpegPath, tmpDir, label, timeoutMs }
 * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, note?:string, error?:string, skipped?:boolean}>}
 *   ok=false 只在「超大且压不动」时出现；调用方应把它变成一句可读的失败原因，而不是发空图。
 */
export async function normalizeImageForModel(buf, mimeType, opts = {}) {
  const bytes = Buffer.isBuffer(buf) ? buf.length : 0;
  if (!bytes) return { ok: false, error: '图片字节为空' };
  if (opts.enabled === false) return { ok: true, buffer: buf, mimeType, note: '' };

  const info = sniffImage(buf);
  const plan = planNormalization(info, bytes, opts);
  if (!plan) {
    // 原样放行：这是绝大多数情况（小图），零额外延迟。
    return { ok: true, buffer: buf, mimeType: mimeType || (info ? `image/${info.format === 'jpeg' ? 'jpeg' : info.format}` : 'image/jpeg'), note: '' };
  }
  if (plan.action === 'reject') {
    return { ok: false, error: plan.reason, skipped: true };
  }

  const ffmpeg = resolveFfmpeg({ ffmpegPath: opts.ffmpegPath ?? null });
  const maxBytes = plan.maxBytes;
  const maxLongEdge = plan.maxLongEdge;

  const dir = makeTempWorkspace(opts.tmpDir);
  try {
    const inExt = info.format === 'jpeg' ? '.jpg' : `.${info.format}`;
    const inFile = path.join(dir, `in${inExt}`);
    fs.writeFileSync(inFile, buf);

    if (plan.action === 'animate') {
      const layout = planAnimation(info, opts);
      const tileWidth = clampInt(opts.gifTile, 64, 400, MEDIA_DEFAULTS.gifTile);
      const outFile = path.join(dir, 'strip.jpg');
      const vf = `fps=${layout.fps},scale=${tileWidth}:-1:flags=lanczos,` +
        `tile=${layout.cols}x${layout.rows}:padding=4:margin=4:color=white`;
      const run = await runFfmpeg(ffmpeg, [
        '-v', 'error', '-y', '-i', inFile,
        '-filter_complex', `[0:v]${vf}[out]`, '-map', '[out]',
        '-frames:v', '1', '-q:v', '4', outFile
      ], { timeoutMs: opts.timeoutMs });
      const out = run.ok ? readIfExists(outFile) : null;
      if (out && out.length <= maxBytes) {
        const seconds = (layout.durationMs / 1000).toFixed(1);
        return {
          ok: true,
          buffer: out,
          mimeType: 'image/jpeg',
          // 这段文字会原样出现在工具结果里（外面还会再包一层括号），所以**不要用嵌套括号**。
          note: `动图 ${layout.totalFrames} 帧/${seconds}s，已抽 ${layout.sampleFrames} 帧拼成 ${layout.cols}×${layout.rows} 网格，行优先 左上→右下；原图 ${(bytes / 1024 / 1024).toFixed(2)}MB`
        };
      }
      // 拼图失败（没 ffmpeg / 超时 / 还是太大）：退化到「能看多少算多少」。
      // 注意这里不再用 `bytes <= maxBytes` 卡：那个闸门是「为省 token 而主动压小」的
      // 目标值，不是 DSH 的生死线。没 ffmpeg 时它会把 1–3 MiB 的图白白卡死，
      // 而这正是群里梗图最常见的大小。degradeToRawPassThrough 用硬上限判定。
      const degraded = degradeToRawPassThrough(buf, bytes, mimeType, info, run.ok ? '输出仍超限' : run.error);
      if (degraded) return degraded;
      return { ok: false, error: `动图 ${(bytes / 1024 / 1024).toFixed(2)}MB 无法压缩（${run.ok ? '输出仍超限' : run.error}）` };
    }

    // action === 'shrink'：静态图降采样 + 重编码，最多试三轮（逐步缩小尺寸/降质量）。
    const outExt = pickOutputExt(info);
    let edge = maxLongEdge;
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const scale = Math.min(1, edge / Math.max(info.width, info.height));
      const width = Math.max(2, Math.round(info.width * scale) & ~1);
      const height = Math.max(2, Math.round(info.height * scale) & ~1);
      const outFile = path.join(dir, `out-${attempt}${outExt}`);
      const args = ['-v', 'error', '-y', '-i', inFile, '-vf', `scale=${width}:${height}:flags=lanczos`];
      if (outExt === '.jpg') args.push('-q:v', String(3 + attempt * 3));
      args.push(outFile);
      const run = await runFfmpeg(ffmpeg, args, { timeoutMs: opts.timeoutMs });
      if (!run.ok) { lastError = run.error; }
      else {
        const out = readIfExists(outFile);
        if (out && out.length <= maxBytes) {
          return {
            ok: true,
            buffer: out,
            mimeType: outExt === '.jpg' ? 'image/jpeg' : 'image/png',
            note: `原图 ${info.width}×${info.height} ${(bytes / 1024).toFixed(0)}KB → ${width}×${height} ${(out.length / 1024).toFixed(0)}KB`
          };
        }
        lastError = '压缩后仍超限';
      }
      edge = Math.max(320, Math.round(edge * 0.7));
    }
    // 压不动：只要没超 DSH 硬上限就照发（让 DSH 自己缩放/取首帧），超了才明确拒绝。
    // 旧写法 `if (bytes <= maxBytes)` 会在**没装 ffmpeg** 的机器上把 1–3 MiB 的静态图
    // 全部判死 —— 而它们本来只是被「省 token」的软闸门拦住，DSH 完全吃得下。
    const degraded = degradeToRawPassThrough(buf, bytes, mimeType, info, lastError);
    if (degraded) return degraded;
    return { ok: false, error: `${(bytes / 1024 / 1024).toFixed(2)}MB 压不到 ${(maxBytes / 1024).toFixed(0)}KB 以内（${lastError}）` };
  } finally {
    cleanupWorkspace(dir);
  }
}

/** 供日志/提示用的一句话摘要（不含 base64）。 */
export function describeImage(buf) {
  const info = sniffImage(buf);
  if (!info) return `未知格式 ${buf?.length ?? 0}B`;
  const parts = [`${info.format} ${info.width}×${info.height}`, `${(buf.length / 1024).toFixed(0)}KB`];
  if (info.animated) parts.push(`动图 ${info.frames} 帧${info.durationMs ? `/${(info.durationMs / 1000).toFixed(1)}s` : ''}`);
  return parts.join(' ');
}

// ── 视频：抽帧拼图 ──────────────────────────────────────────────────────────
//
// Q: 为什么不能把视频原样交给模型？
// A: DeepSeek 的 inputModalities 只有 text/image，视频根本进不去；就算能进去，
//    一个 10 MB 的 mp4 直接撞 DSH 的 base64 炸栈线（≈3.20 MiB，见文件头 ①）。
//
// 所以视频理解的实现方式是「**把视频变成一张图**」：用 ffmpeg 按时间均匀抽 N 帧，
// 拼成 3×2 网格（与动图 GIF 同一套 tile 滤镜），模型看到的是「时间轴上的 6 个瞬间」。
// 这与动图抽帧的取舍完全一致：信息密度高、只算一张图、体积可控（实测 ~40–90 KB）。
//
// 局限（必须让模型知道，否则它会瞎编）：听到的东西拿不到 —— QQ 视频的音轨没有转写通道
// （QQ 只对语音条做 ASR）。所以 note 里写明「只有画面，没有声音」。

export const VIDEO_DEFAULTS = Object.freeze({
  // 单条视频的下载上限。QQ 群里常见 3–20 MB，24 MB 足够；
  // 更大的多半是长视频，抽帧也没意义（而且下载要几十秒）。
  maxBytes: 24 * 1024 * 1024,
  // 抽几帧：6 帧正好 3×2，再多每格就小到看不清。
  frames: 6,
  // 每格宽度（px）：320 时 3×2 拼图约 976×556，实测 40–90 KB。
  tile: 320,
  timeoutMs: 60000
});

/** 硬上限：不管 config 怎么写，视频字节都不允许超过这个数（防止把内存打爆）。 */
const HARD_MAX_VIDEO_BYTES = 64 * 1024 * 1024;

/**
 * 解析 MP4/MOV 的 box 树，取 moov/mvhd 里的时长。
 *
 * 为什么不用 ffprobe：走子进程要读 stdout，而受限环境里 `stdio:'pipe'` 会 EPERM
 * （见 voice-core.js 开头的记录），生产代码一律 `stdio:'ignore'` + 写文件。
 * 而 `-f ffmetadata` 写出来的元数据里**不含 duration**（实测，只有 format tags）。
 * mvhd 的时长是纯内存解析，零子进程，QQ 发来的视频又几乎都是 mp4 —— 所以走这条。
 *
 * @returns {{durationMs:number, timescale:number}|null}
 */
function parseMp4Duration(buf) {
  const readBoxes = (start, end, want) => {
    let pos = start;
    let guard = 0;
    while (pos + 8 <= end && ++guard < 10000) {
      let size = buf.readUInt32BE(pos);
      const type = buf.toString('ascii', pos + 4, pos + 8);
      let headerSize = 8;
      if (size === 1) {
        // 64 位 largesize：在 4+4 之后
        if (pos + 16 > end) return null;
        const hi = buf.readUInt32BE(pos + 8);
        const lo = buf.readUInt32BE(pos + 12);
        size = hi * 2 ** 32 + lo;
        headerSize = 16;
      } else if (size === 0) {
        size = end - pos; // 延伸到文件末尾
      }
      if (size < headerSize) return null;
      if (type === want) return { start: pos + headerSize, end: Math.min(end, pos + size) };
      pos += size;
    }
    return null;
  };

  const moov = readBoxes(0, buf.length, 'moov');
  if (!moov) return null;
  const mvhd = readBoxes(moov.start, moov.end, 'mvhd');
  if (!mvhd) return null;
  const version = buf[mvhd.start];
  if (version === 1) {
    if (mvhd.start + 32 > mvhd.end) return null;
    const timescale = buf.readUInt32BE(mvhd.start + 20);
    const hi = buf.readUInt32BE(mvhd.start + 24);
    const lo = buf.readUInt32BE(mvhd.start + 28);
    const duration = hi * 2 ** 32 + lo;
    if (!timescale || duration === 0xFFFFFFFFFFFFFFFF) return null;
    return { durationMs: Math.round((duration / timescale) * 1000), timescale };
  }
  if (mvhd.start + 20 > mvhd.end) return null;
  const timescale = buf.readUInt32BE(mvhd.start + 12);
  const duration = buf.readUInt32BE(mvhd.start + 16);
  if (!timescale || duration === 0xFFFFFFFF) return null;
  return { durationMs: Math.round((duration / timescale) * 1000), timescale };
}

/**
 * 从字节里认出视频格式，并尽量读出时长（只有 mp4/mov 能做到）。
 *
 * @returns null（不是视频）或 { format, durationMs, hasDuration }
 */
export function sniffVideo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  let format = null;
  // ISO-BMFF（mp4/mov/m4v）：第 4–8 字节是 'ftyp'，8–12 是 brand
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    format = brand === 'qt  ' ? 'mov' : 'mp4';
  } else if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    format = 'webm'; // EBML：可能是 webm 也可能是 mkv，ffmpeg 都能读
  } else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'AVI ') {
    format = 'avi';
  } else if (buf.toString('ascii', 0, 3) === 'FLV') {
    format = 'flv';
  } else if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] !== undefined
    && (buf[2] === 0x01 || buf[3] === 0xba)) {
    // MPEG-PS/TS：0x000001BA 是 pack header；QQ 老视频偶见
    format = 'mpeg';
  }
  if (!format) return null;
  const mp4 = (format === 'mp4' || format === 'mov') ? parseMp4Duration(buf) : null;
  return {
    format,
    durationMs: mp4?.durationMs ?? 0,
    hasDuration: Boolean(mp4?.durationMs)
  };
}

/** 视频抽帧布局：帧数 → { cols, rows, fps|null, sampleFrames, useThumbnail }。纯函数。 */
export function planVideoFrames({ durationMs = 0, frames = VIDEO_DEFAULTS.frames } = {}) {
  const wanted = clampInt(frames, 2, 9, VIDEO_DEFAULTS.frames);
  const layout = { 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2], 7: [4, 2], 8: [4, 2], 9: [3, 3] }[wanted]
    ?? [3, 2];
  const [cols, rows] = layout;
  const seconds = durationMs > 0 ? durationMs / 1000 : 0;
  if (seconds > 0.2) {
    // 时长已知：fps 精确让 ffmpeg 产出 wanted 帧（与 GIF 抽帧同一套算法）
    return {
      cols,
      rows,
      sampleFrames: wanted,
      fps: Math.min(30, Math.max(0.02, Number((wanted / seconds).toFixed(4)))),
      useThumbnail: false
    };
  }
  // 时长读不出来（webm/mkv/异常 mp4）：改用 thumbnail 选代表帧。
  // 它不需要时长，按批次挑「最能代表这一批」的帧，短到 1 秒的视频也能出图（实测）。
  return { cols, rows, sampleFrames: wanted, fps: null, useThumbnail: true };
}

/**
 * 把一段视频整理成「模型能看懂的一张图」（时间轴抽帧拼图）。
 *
 * @param buf       视频字节
 * @param mimeType  调用方已知的 MIME（以字节探测为准）
 * @param opts      { enabled, frames, tile, maxModelBytes, ffmpegPath, tmpDir, timeoutMs, label }
 * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, note?:string, error?:string}>}
 */
export async function normalizeVideoForModel(buf, mimeType, opts = {}) {
  const bytes = Buffer.isBuffer(buf) ? buf.length : 0;
  if (!bytes) return { ok: false, error: '视频字节为空' };
  if (opts.enabled === false) return { ok: false, error: '视频理解已关闭（socialV2.video.enabled=false）' };
  const info = sniffVideo(buf);
  if (!info) return { ok: false, error: '不是可识别的视频格式（MP4/MOV/WebM/AVI/FLV）' };

  const maxModelBytes = clampInt(opts.maxModelBytes, 64 * 1024, HARD_MAX_MODEL_BYTES, MEDIA_DEFAULTS.maxModelBytes);
  const tile = clampInt(opts.tile, 120, 480, VIDEO_DEFAULTS.tile);
  const plan = planVideoFrames({ durationMs: info.durationMs, frames: opts.frames });
  const ffmpeg = resolveFfmpeg({ ffmpegPath: opts.ffmpegPath ?? null });

  const dir = makeTempWorkspace(opts.tmpDir);
  try {
    const inFile = path.join(dir, `in.${info.format === 'mpeg' ? 'mpg' : info.format}`);
    fs.writeFileSync(inFile, buf);
    const outFile = path.join(dir, 'frames.jpg');
    // 两档尝试：先按目标宽度，太大就缩到 200px 再来一次（帧数不变，只是格子更小）。
    const tileTry = [tile, Math.max(160, Math.round(tile * 0.62))];
    let lastError = '';
    let out = null;
    for (const width of tileTry) {
      const pre = plan.useThumbnail
        // thumbnail 的批次值取「按 2 fps 估的每格间隔帧数」，10 是常见默认，短片段也够用
        ? `thumbnail=${Math.max(5, Math.round(plan.sampleFrames * 5))}`
        : `fps=${plan.fps}`;
      const vf = `${pre},scale=${width}:-1:flags=lanczos,` +
        `tile=${plan.cols}x${plan.rows}:padding=4:margin=4:color=white`;
      const run = await runFfmpeg(ffmpeg, [
        '-v', 'error', '-y', '-i', inFile,
        '-filter_complex', `[0:v]${vf}[out]`, '-map', '[out]',
        '-frames:v', '1', '-q:v', '4', outFile
      ], { timeoutMs: opts.timeoutMs ?? VIDEO_DEFAULTS.timeoutMs });
      if (!run.ok) { lastError = run.error; continue; }
      out = readIfExists(outFile);
      if (!out) { lastError = 'ffmpeg 没有产出图片'; continue; }
      if (out.length <= maxModelBytes) break;
      lastError = `拼图仍超限（${(out.length / 1024).toFixed(0)}KB）`;
      out = null;
    }
    if (!out) {
      return { ok: false, error: `${info.format} 视频抽帧失败（${lastError || '未知原因'}）` };
    }
    const seconds = info.durationMs > 0 ? (info.durationMs / 1000).toFixed(1) : '?';
    const note = `视频 ${seconds}s，已抽 ${plan.sampleFrames} 帧拼成 ${plan.cols}×${plan.rows} 网格` +
      `（行优先 左上→右下，按时间顺序）；只有画面**没有声音**；原视频 ${(bytes / 1024 / 1024).toFixed(2)}MB`;
    return { ok: true, buffer: out, mimeType: 'image/jpeg', note };
  } finally {
    cleanupWorkspace(dir);
  }
}

/** 供日志/提示用的一句话摘要（不含 base64）。 */
export function describeVideo(buf) {
  const info = sniffVideo(buf);
  if (!info) return `未知视频格式 ${buf?.length ?? 0}B`;
  const parts = [info.format];
  if (info.durationMs) parts.push(`${(info.durationMs / 1000).toFixed(1)}s`);
  parts.push(`${(buf.length / 1024 / 1024).toFixed(2)}MB`);
  return parts.join(' ');
}

