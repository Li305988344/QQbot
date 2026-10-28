// 把「自己录的」音频处理成可当 QQ 语音发出去的音频，并装进两个桥接的语音库。
//
// 用法：
//   node ops/prep-voice.mjs              处理 voice-samples/own/raw/ 里所有录音
//   node ops/prep-voice.mjs --dry        只看会做什么，不写文件
//   node ops/prep-voice.mjs --keep-raw   处理后保留 raw 里的原文件（默认移到 raw/_done/）
//
// ── 为什么要处理，而不是直接丢进 audio/
//
// ① **首尾静音**。手机录音前后常有一两秒空白（实测 edge-tts 生成的 mp3 自己也带 0.82s 尾巴），
//    QQ 语音条会原样播出来 —— 点开先听两秒空气，听感极差。中间的自然停顿必须保留，
//    所以 **不能用 silenceremove**：
//      · silenceremove 的 stop_periods 遇到**句中停顿**就把后面全砍掉（实测 4.2s 语音只剩 0.9s）；
//      · `areverse + silenceremove` 更糟：尾音渐弱，反转后被当成静音，实测吃掉 1 秒多真实语音。
//    正确做法是**两遍法**：先 silencedetect 拿到所有静音区间，只裁首尾，再用 -ss/-to 精确切。
// ② **响度不统一**。不同时间/距离录的音量差很多，连发几条会忽大忽小。统一 loudnorm 到 -16 LUFS。
// ③ **声道/采样率**。手机可能是 48kHz 立体声，统一成 24kHz 单声道，体积小且够用。
//
// ── 一个避免不了的损失
//
// QQ 语音条最终会被网关转成 SILK 窄带（约 8kHz、十几个 kbps）。这里只能保证「交给网关之前」
// 是干净的；窄带损失无法在这一步避免。想听无损请用「发文件」而不是语音条。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const INTAKE = path.join(ROOT, 'voice-samples', 'own', 'raw');
const READY = path.join(ROOT, 'voice-samples', 'own', 'ready');
// 日志跟着素材放，不要落到仓库根目录（之前每次跑都会在顶层多一个 _prep-voice.log）。
const LOG_FILE = path.join(ROOT, 'voice-samples', 'own', 'prep-voice.log');
const BRIDGES = ['qq-bridge-01', 'qq-bridge-02'];

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|amr|wma)$/i;
const NOISE_DB = -45;    // 低于这个电平算静音
const MIN_SILENCE = 0.2; // 至少静这么久才算一段静音
const MARGIN = 0.05;     // 边界各留一点余量，别切掉第一个音素
const TARGET_I = -16;    // 响度目标（LUFS）

const dry = process.argv.includes('--dry');
const keepRaw = process.argv.includes('--keep-raw');

const log = [];
const say = (s) => { log.push(s); console.log(s); };

/** ffmpeg 位置：优先读桥接配置里的 ffmpegPath（本机不在 PATH），再读环境变量。 */
function findFfmpeg() {
  const envPath = String(process.env.FFMPEG_PATH ?? '').trim();
  if (envPath && fs.existsSync(envPath)) return envPath;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'qq-bridge-01', 'config.json'), 'utf8'));
    const p = cfg.socialV2?.voice?.ffmpegPath;
    if (p && fs.existsSync(p)) return p;
  } catch { /* 配置读不到就退回 PATH */ }
  return 'ffmpeg';
}

const FFMPEG = findFfmpeg();
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

/** 时长（秒）；拿不到返回 null。 */
function probeDuration(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', windowsHide: true });
  const n = Number(String(r.stdout ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** silencedetect 拿静音区间。ffmpeg 把日志写到 stderr，只能从这里读。 */
function detectSilence(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file,
    '-af', `silencedetect=noise=${NOISE_DB}dB:d=${MIN_SILENCE}`, '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true });
  const err = String(r.stderr ?? '');
  return {
    starts: [...err.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1])),
    ends: [...err.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1])),
  };
}

/**
 * 推算真正的语音区间（只裁首尾，保留句中停顿）。
 *
 * 判据的坑：ffmpeg 在 EOF 处**也会**发 silence_end，所以「starts 比 ends 多」
 * 不能用来判断尾部有没有静音（实测两者数量相等，尾部静音的 end 就是文件总时长）。
 * 正确判据是「最后一个静音区间的终点 ≈ 总时长」。
 */
function speechBounds(file) {
  const total = probeDuration(file);
  if (!total) return { total: null, reason: '读不到时长（不是音频 / ffprobe 不可用）' };
  const { starts, ends } = detectSilence(file);
  let start = 0;
  if (starts.length && ends.length && starts[0] <= 0.05) start = ends[0];
  let end = total;
  if (starts.length) {
    const lastStart = starts[starts.length - 1];
    const lastEnd = ends[ends.length - 1];
    const trailingToEof = starts.length > ends.length;
    const trailingEndsAtEof = Number.isFinite(lastEnd) && lastEnd >= total - 0.15;
    if ((trailingToEof || trailingEndsAtEof) && lastStart > start) end = lastStart;
  }
  return { total, start, end, dur: Math.max(0, end - start) };
}

function run(cmd, args) {
  return new Promise((resolve) => {
    let err = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, error: `无法启动：${error?.message ?? error}` });
      return;
    }
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ ok: false, error: `执行失败：${e.message}` }));
    child.on('close', (code) => resolve({ ok: code === 0, code, error: code === 0 ? '' : err.trim().slice(-400) }));
  });
}

function sanitizeStem(name) {
  return path.basename(name, path.extname(name))
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/\s+/g, '-')
    .trim() || 'voice';
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
say('ffmpeg: ' + FFMPEG);
say('输入  : ' + INTAKE);
say('输出  : ' + READY);
if (dry) say('（--dry：不写任何文件）');
say('');

for (const d of [INTAKE, READY]) fs.mkdirSync(d, { recursive: true });

const files = fs.readdirSync(INTAKE, { withFileTypes: true })
  .filter((e) => e.isFile() && AUDIO_EXT.test(e.name))
  .map((e) => e.name)
  .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

if (!files.length) {
  say('raw/ 里没有音频。把录音（mp3 / wav / m4a / amr 都行）放进：');
  say('  ' + INTAKE);
  say('然后重新运行本脚本。');
  fs.writeFileSync(LOG_FILE, log.join('\n'), 'utf8');
  process.exit(0);
}

say(`找到 ${files.length} 个文件：`);
say('');

let okCount = 0;
for (const name of files) {
  const src = path.join(INTAKE, name);
  const stem = sanitizeStem(name);
  const dst = path.join(READY, stem + '.mp3');

  const b = speechBounds(src);
  if (!b.total) { say(`  ✗ ${name}  ${b.reason}`); continue; }
  if (b.dur < 0.3) { say(`  ✗ ${name}  几乎全是静音（录音音量太小？）`); continue; }

  const ss = Math.max(0, b.start - MARGIN);
  const to = Math.min(b.total, b.end + MARGIN);

  say(`  ${name}`);
  say(`      原 ${b.total.toFixed(2)}s → 语音 ${b.start.toFixed(2)}~${b.end.toFixed(2)} (${b.dur.toFixed(2)}s)`);

  if (dry) { say('      （dry：将输出 ' + path.basename(dst) + '）'); okCount += 1; continue; }

  const r = await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(ss), '-to', String(to), '-i', src,
    '-af', `loudnorm=I=${TARGET_I}:TP=-1.5:LRA=11`,
    '-ar', '24000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k',
    dst,
  ]);
  if (!r.ok) { say('      ✗ 处理失败：' + r.error); continue; }

  const after = probeDuration(dst);
  const size = fs.statSync(dst).size;
  say(`      输出 ${after ? after.toFixed(2) + 's' : '?'} · ${(size / 1024).toFixed(1)} KB → ready/${path.basename(dst)}`);
  okCount += 1;
}

if (dry || !okCount) {
  say('');
  say(dry ? '（--dry：未写入任何文件）' : '没有成功处理的文件。');
  fs.writeFileSync(LOG_FILE, log.join('\n'), 'utf8');
  process.exit(0);
}

// 装进两个桥接的语音库
say('');
say('装入语音库：');
const readyFiles = fs.readdirSync(READY).filter((x) => AUDIO_EXT.test(x));
for (const bridge of BRIDGES) {
  const lib = path.join(ROOT, bridge, 'audio');
  fs.mkdirSync(lib, { recursive: true });
  for (const f of readyFiles) fs.copyFileSync(path.join(READY, f), path.join(lib, f));
  say(`  ${bridge}/audio: 共 ${readyFiles.length} 个文件`);
}

// 处理过的原文件挪走，避免下次重复处理
if (!keepRaw) {
  const doneDir = path.join(INTAKE, '_done');
  fs.mkdirSync(doneDir, { recursive: true });
  let moved = 0;
  for (const name of files) {
    try { fs.renameSync(path.join(INTAKE, name), path.join(doneDir, name)); moved += 1; } catch { /* 占用中就算了 */ }
  }
  if (moved) say(`\n原文件已移到 raw/_done/（${moved} 个；加 --keep-raw 可保留）`);
}

say('');
say('完成。桥接会自动发现新文件（qq_list_voices 可查），无需重启。');
fs.writeFileSync(LOG_FILE, log.join('\n'), 'utf8');
