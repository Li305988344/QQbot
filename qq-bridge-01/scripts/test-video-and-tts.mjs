// 视频理解（抽帧）+ 口播（TTS）自检。
//
// 覆盖三件事：
//   ① 字节层：视频格式识别 / 时长解析 / 抽帧拼图，以及「不是视频就不许硬塞」的闸门
//   ② 文本层：口播前的文本清洗（Markdown/链接不能念出来）、音色挑选
//   ③ 接线层：桥接与 MCP 里必须有对应路由/工具/开关（防止改了源码忘了接线）
//
// 依赖 ffmpeg 与 Windows SAPI 的断言在缺失时**跳过**（并说明原因），不是失败：
// 这两样都是「这台机器的装没装」，装没装都不该让其它断言变红（与项目里
// voice-tool 缺席时的 skip 口径一致）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  describeVideo, normalizeVideoForModel, planVideoFrames, sniffVideo, sniffImage
} from '../src/media-normalize.js';
import { listOneCoreVoices, listSapiVoices, pickChineseVoice, sanitizeSpeechText, synthesizeSpeech, synthesizeSpeechOneCore } from '../src/tts-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const skipped = [];
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
const skip = (name, why) => { skipped.push(name); console.log(`  ℹ  跳过：${name}（${why}）`); };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 找 ffmpeg：优先用 config.json 里配的那个（生产用的就是它），否则退回 PATH。 */
const FFMPEG = (() => {
  try {
    const cfg = JSON.parse(read('config.json'));
    const p = cfg?.socialV2?.voice?.ffmpegPath || cfg?.socialV2?.video?.ffmpegPath;
    if (p && fs.existsSync(p)) return p;
  } catch {}
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true });
  return probe.status === 0 ? 'ffmpeg' : null;
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-video-'));
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

console.log('## 视频格式识别（纯字节解析，不需要 ffmpeg）');
{
  ok(sniffVideo(null) === null, 'null 不是视频');
  ok(sniffVideo(Buffer.alloc(4)) === null, '太短的字节不是视频');
  // 一张 PNG 不能被认成视频 —— 分类错了会把图片塞进抽帧流程，白跑一次 ffmpeg
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  ok(sniffVideo(png) === null, 'PNG 不会被认成视频');
  ok(sniffImage(png) !== null, '同一份字节能被认成 PNG（两个探测器不互相污染）');
  // ISO-BMFF 头：第 4–8 字节 'ftyp'，8–12 是 brand
  const mp4Head = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(64)]);
  const f = sniffVideo(mp4Head);
  ok(f?.format === 'mp4', 'ftyp/isom 认成 mp4', String(f?.format));
  ok(f && f.durationMs === 0 && f.hasDuration === false, '没有 moov 时如实报告「时长未知」，不瞎猜');
  const movHead = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypqt  ', 'ascii'), Buffer.alloc(64)]);
  ok(sniffVideo(movHead)?.format === 'mov', 'qt brand 认成 mov');
  const flv = Buffer.concat([Buffer.from('FLV\x01', 'binary'), Buffer.alloc(32)]);
  ok(sniffVideo(flv)?.format === 'flv', 'FLV 头被识别');
  const avi = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('AVI ', 'ascii'), Buffer.alloc(32)]);
  ok(sniffVideo(avi)?.format === 'avi', 'RIFF/AVI 头被识别');
}

console.log('## 抽帧布局（纯函数）');
{
  const p6 = planVideoFrames({ durationMs: 8000, frames: 6 });
  ok(p6.cols === 3 && p6.rows === 2, '6 帧 → 3×2');
  ok(Math.abs(p6.fps - 0.75) < 1e-6, '8 秒 6 帧 → fps=0.75', String(p6.fps));
  ok(p6.useThumbnail === false, '时长已知时用 fps 精确抽帧');
  const unknown = planVideoFrames({ durationMs: 0, frames: 6 });
  ok(unknown.useThumbnail === true && unknown.fps === null, '时长未知时退回 thumbnail 选帧（不需要时长）');
  const p9 = planVideoFrames({ durationMs: 60000, frames: 9 });
  ok(p9.cols === 3 && p9.rows === 3, '9 帧 → 3×3');
  ok(planVideoFrames({ durationMs: 5000, frames: 100 }).sampleFrames <= 9, '帧数被收敛到上限（防止拼图小到看不清）');
  ok(planVideoFrames({ durationMs: 5000, frames: 1 }).sampleFrames >= 2, '过小的帧数被抬到下限');
}

console.log('## 闸门：不是视频 / 开关关闭时绝不硬塞');
{
  const notVideo = await normalizeVideoForModel(Buffer.from('not a video'), 'video/mp4', { ffmpegPath: FFMPEG, tmpDir: tmp });
  ok(notVideo.ok === false && /不是可识别的视频/.test(notVideo.error), '非视频字节被拒绝并说明原因', notVideo.error);

  const disabled = await normalizeVideoForModel(Buffer.alloc(64), 'video/mp4', { enabled: false, tmpDir: tmp });
  ok(disabled.ok === false && /已关闭/.test(disabled.error), 'enabled=false 时直接拒绝（不去碰 ffmpeg）', disabled.error);

  const empty = await normalizeVideoForModel(Buffer.alloc(0), 'video/mp4', { tmpDir: tmp });
  ok(empty.ok === false && /为空/.test(empty.error), '空字节被拒绝');
}

console.log('## 抽帧拼图（需要 ffmpeg）');
if (!FFMPEG) {
  skip('真实视频抽帧 / 时长解析', '这台机器上找不到 ffmpeg');
} else {
  const video = path.join(tmp, 'sample.mp4');
  const gen = spawnSync(FFMPEG, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=640x360:rate=25',
    '-pix_fmt', 'yuv420p', video
  ], { windowsHide: true, stdio: 'ignore' });
  ok(gen.status === 0 && fs.existsSync(video), '生成测试视频');
  const buf = fs.readFileSync(video);
  const info = sniffVideo(buf);
  ok(info?.format === 'mp4', '识别出 mp4');
  ok(info?.hasDuration === true && Math.abs(info.durationMs - 6000) < 300, 'mvhd 解析出约 6 秒时长', `${info?.durationMs}ms`);
  ok(describeVideo(buf).includes('mp4'), '摘要含格式', describeVideo(buf));

  const out = await normalizeVideoForModel(buf, 'video/mp4', { ffmpegPath: FFMPEG, tmpDir: tmp, frames: 6, tile: 240 });
  ok(out.ok === true, '抽帧成功', out.error ?? '');
  if (out.ok) {
    ok(out.mimeType === 'image/jpeg', '产物是一张 JPEG');
    ok(out.buffer.length < 1024 * 1024, '拼图体积远小于 1 MiB（DSH 的炸栈线在 3.2 MiB）', `${(out.buffer.length / 1024).toFixed(0)}KB`);
    // JPEG SOI
    ok(out.buffer[0] === 0xff && out.buffer[1] === 0xd8, '产物字节确实是 JPEG（不是空文件）');
    // 模型必须知道拿不到声音，否则会编造对白
    ok(/没有声音/.test(out.note), '说明里明确写了「没有声音」', out.note);
    ok(/6 帧/.test(out.note) && /3×2/.test(out.note), '说明里写了抽帧数与网格布局');
  }
}

console.log('## 口播文本清洗（纯函数，不需要任何引擎）');
{
  ok(sanitizeSpeechText('**你好**呀') === '你好呀', '去掉 Markdown 星号');
  ok(!sanitizeSpeechText('看这个 https://a.b/c 好不好').includes('http'), '不念 URL');
  ok(sanitizeSpeechText('[看这个](https://x.com) 真好看') === '看这个 真好看', '链接只留文字（括号不漏出来）');
  ok(sanitizeSpeechText('![图](a.png) 今天天气不错') === '今天天气不错', '图片语法整段不念');
  ok(sanitizeSpeechText('[图片] 你看看这个') === '图片 你看看这个', '方括号壳被去掉但内容保留');
  ok(sanitizeSpeechText('第一行\n第二行') === '第一行，第二行', '换行念成停顿而不是空白');
  ok(!sanitizeSpeechText('```js\nconst a = 1\n```明白了').includes('const'), '代码块不念');
  ok(sanitizeSpeechText('x'.repeat(500), { maxChars: 100 }).length === 100, '按 maxChars 截断（避免 30 秒长语音）');
  ok(sanitizeSpeechText('   ') === '', '纯空白清洗后为空（调用方据此拒绝发送）');
}

console.log('## 音色挑选（纯函数）');
{
  const voices = [
    { name: 'Microsoft Zira Desktop', culture: 'en-US' },
    { name: 'Microsoft Huihui Desktop', culture: 'zh-CN' }
  ];
  ok(pickChineseVoice(voices)?.name === 'Microsoft Huihui Desktop', '优先挑 zh-CN 音色');
  ok(pickChineseVoice([{ name: 'X', culture: 'zh-TW' }])?.name === 'X', '只有 zh-TW 时也能挑中');
  ok(pickChineseVoice([{ name: 'Y', culture: 'en-US' }]) === null, '没有中文音色时返回 null（调用方给 warning）');
  ok(pickChineseVoice([]) === null && pickChineseVoice(null) === null, '空/非法输入不抛错');
}

console.log('## 口播合成（需要 Windows SAPI）');
{
  const list = await listSapiVoices({ timeoutMs: 20000 });
  if (!list.ok || list.voices.length === 0) {
    skip('真实合成 wav', `系统里没有可用音色（${list.error ?? '空列表'}）`);
  } else {
    ok(list.voices.every((v) => typeof v.name === 'string'), '列出音色', `${list.voices.length} 个`);
    const zh = pickChineseVoice(list.voices);
    const r = await synthesizeSpeech('这是一次语音合成自检。', { voice: zh?.name ?? '', timeoutMs: 30000 });
    ok(r.ok === true, '合成成功', r.error ?? '');
    if (r.ok) {
      ok(r.bytes > 1000, '产出的 wav 不是空文件', `${(r.bytes / 1024).toFixed(0)}KB`);
      const head = fs.readFileSync(r.path).subarray(0, 4).toString('ascii');
      ok(head === 'RIFF', '确实是 WAV（RIFF 头）', head);
      // 44 字节 = 只有 WAV 头，等于没声音；上面 >1000 已覆盖，这里再确认一次时长感
      ok(r.bytes > 44 * 10, '字节量说明真的编码了音频');
      try { fs.rmSync(path.dirname(r.path), { recursive: true, force: true }); } catch {}
    }
    const empty = await synthesizeSpeech('   ', {});
    ok(empty.ok === false, '空文本不做合成（不烧引擎、不产生空语音）');
  }
}

console.log('## 口播：OneCore 引擎（音色比 SAPI 多）');
{
  // 为什么单独测：System.Speech 只能看到 SAPI5 传统音色（本机 1 个中文），
  // 而 OneCore（WinRT）能看到同一台机器上另外两个中文音色。
  // 这是「多一个男声」的唯一来源，也是 default(auto) 走的路。
  const oc = await listOneCoreVoices({ force: true });
  if (!oc.ok || oc.voices.length === 0) {
    skip('OneCore 音色枚举与合成', `WinRT 音色不可用（${oc.error ?? '空列表'}）`);
  } else {
    ok(oc.voices.some((v) => /^zh/i.test(v.culture)), 'OneCore 里有中文音色', oc.voices.map((v) => v.name).join('/'));
    ok(oc.voices.every((v) => typeof v.gender === 'string'), '音色带性别信息（能区分男/女声）');
    ok(pickChineseVoice(oc.voices) !== null, 'pickChineseVoice 能从中挑出中文音色');

    const zh = pickChineseVoice(oc.voices);
    const r = await synthesizeSpeechOneCore('这是一次 OneCore 自检。', { voice: zh.name, timeoutMs: 30000 });
    ok(r.ok === true, 'OneCore 合成成功', r.error ?? '');
    if (r.ok) {
      ok(r.engine === 'onecore', '回报的 engine 是 onecore');
      ok(fs.readFileSync(r.path).subarray(0, 4).toString('ascii') === 'RIFF', '产物是 WAV');
      // 音量：设了 AudioVolume 会让 WinRT 合成 E_INVALIDARG，所以绝不能报「已应用」
      ok(r.volumeApplied === false, '不谎称已应用音量（OneCore 设不了音量）');
      try { fs.rmSync(path.dirname(r.path), { recursive: true, force: true }); } catch {}
    }

    // 男声：SAPI 里完全没有，只有 OneCore 有
    const male = oc.voices.find((v) => /male/i.test(v.gender) && !/female/i.test(v.gender));
    if (!male) {
      skip('男声合成', '本机 OneCore 里没有男声');
    } else {
      const m = await synthesizeSpeechOneCore('男声自检。', { voice: male.name, timeoutMs: 30000 });
      ok(m.ok === true && m.voice === male.name, `能用男声（${male.name}）合成`, m.error ?? '');
      if (m.ok) { try { fs.rmSync(path.dirname(m.path), { recursive: true, force: true }); } catch {} }
    }

    // auto 路由：默认走 OneCore；显式给 SAPI 名字时不能“名字找不到就悄悄用默认”
    const auto = await synthesizeSpeech('路由自检。', { engine: 'auto' });
    ok(auto.ok === true && auto.engine === 'onecore', 'engine=auto 走 OneCore', `${auto.engine ?? '?'} / ${auto.error ?? ''}`);
    if (auto.ok) { try { fs.rmSync(path.dirname(auto.path), { recursive: true, force: true }); } catch {} }

    const named = await synthesizeSpeech('名字路由自检。', { voice: 'Microsoft Huihui Desktop' });
    ok(named.ok === true && named.engine === 'sapi',
      '显式给 SAPI 音色名时退回 SAPI（而不是静默用 OneCore 默认音色）', `${named.engine ?? '?'}`);
    if (named.ok) { try { fs.rmSync(path.dirname(named.path), { recursive: true, force: true }); } catch {} }

    const forced = await synthesizeSpeech('强制 sapi。', { engine: 'sapi' });
    ok(forced.ok === true && forced.engine === 'sapi', 'engine=sapi 可以被强制指定');
    if (forced.ok) { try { fs.rmSync(path.dirname(forced.path), { recursive: true, force: true }); } catch {} }
  }
}

console.log('## 接线：桥接与 MCP');
{
  const bridge = read('src/bridge.js');
  // 入站：视频段必须被提取，否则模型只看到「[视频]」两个字
  ok(/seg\.type === 'video'/.test(bridge), 'extractMediaFromSegments 识别 video 段');
  ok(/kind: 'video'/.test(bridge), '视频有独立的 media kind（不与图片混用）');
  ok(/async function fetchOneBotVideo/.test(bridge), '有视频下载入口');
  ok(/fetchOneBotVideo/.test(bridge) && /safeFetchBuffer\(url, MAX_VIDEO_BYTES\)/.test(bridge),
    '视频下载走 safeFetchBuffer（不让网关/ffmpeg 自己抓 URL）');
  ok(/toModelVideo/.test(bridge), '视频走抽帧归一化出口');
  ok(/cfg\.socialV2\.video = \{/.test(bridge), '有 socialV2.video 默认配置');
  ok(/maxPerWake/.test(bridge) && /VIDEO_CFG\.maxPerWake/.test(bridge), '唤醒内联视频数量受 maxPerWake 限制');

  // 口播：路由 + 配置 + 开关
  ok(/cfg\.socialV2\.tts = \{/.test(bridge), '有 socialV2.tts 默认配置');
  ok(/engine: 'auto'/.test(bridge), 'tts.engine 默认 auto（音色多优先 OneCore）');
  ok(/synth\.volumeApplied === false/.test(bridge), 'OneCore 不设音量时由桥接用 ffmpeg 补音量');
  ok(/async function speakV2/.test(bridge), '有 speakV2 实现');
  ok(/url\.pathname === '\/api\/socialV2\/speak'/.test(bridge), '有 /api/socialV2/speak 路由');
  ok(/url\.pathname === '\/api\/socialV2\/tts-status'/.test(bridge), '有 /api/socialV2/tts-status 路由');
  ok(/v2ToolEnabled\('speak'\)/.test(bridge), '口播受 tools.speak 开关控制');
  ok(/voiceBudgetCheck\(key, \{ maxPerMinute: t\.maxPerMinute/.test(bridge),
    '口播与语音发送共用语音额度桶（防止两条通道各刷一套）');
  ok(/assertOutboundAuditOk\(key, text\)/.test(bridge), '口播内容过出站审计（念出来的字同样会进群）');
  ok(/speak: 'qq_say \/ qq_text_to_speech_status'/.test(bridge), 'qq_get_prompt 的 toolMap 含口播工具');
  ok(/speak: true/.test(bridge), 'tools.speak 默认开启');

  const mcp = read('src/mcp-snowluma-safe.js');
  ok(mcp.includes("'qq_say'"), 'MCP 注册 qq_say');
  ok(mcp.includes("'qq_text_to_speech_status'"), 'MCP 注册 qq_text_to_speech_status');
  ok(/qq_say: 'speak'/.test(mcp), 'qq_say 受 speak 开关控制（注册期就过滤）');
  const sayBlock = mcp.slice(mcp.indexOf("'qq_say'"), mcp.indexOf("'qq_text_to_speech_status'"));
  ok(sayBlock.includes('/api/socialV2/speak'), 'qq_say 调 /api/socialV2/speak');
  ok(/只念短句|40 字以内/.test(sayBlock), '工具描述里约束了长度（防止把整段回复念出来）');
}

console.log('## 预设提示词与配置样例');
{
  const preset = read(path.join('dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'));
  ok(preset.includes('【看视频】'), '人设说明视频能力');
  ok(/没有声音/.test(preset) && /绝不编造对白/.test(preset), '人设明确「拿不到音轨、不许编造对白」');
  ok(preset.includes('qq_say'), '人设说明口播能力');
  const example = JSON.parse(read('config.example.json'));
  ok(example?.socialV2?.video !== undefined, 'config.example.json 含 video 段');
  ok(example?.socialV2?.tts !== undefined, 'config.example.json 含 tts 段');
  ok(example?.socialV2?.tools?.speak !== false, 'config.example.json 的 tools.speak 默认不关闭');
}

cleanup();
console.log(`\n结果：${pass} 通过，${fail} 失败${skipped.length ? `，${skipped.length} 跳过` : ''}`);
if (skipped.length) console.log(`跳过项：${skipped.join(' / ')}`);
process.exit(fail === 0 ? 0 : 1);
