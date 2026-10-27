// 文本转语音（TTS）：让机器人真的「开口说话」。
//
// ── 为什么需要这一层
//
// `qq_send_voice` 只能把**语音库里现成的音频文件**当语音条发出去。语音库是空的机器上，
// 那个工具等于完全不可用 —— 机器人没法「说出一句自己想说的话」。要让它按自己的话出声，
// 就必须有一个 TTS 引擎把文本合成音频。
//
// ── 为什么用 Windows 自带的 SAPI
//
// 候选方案与取舍：
//   · 在线 TTS（edge-tts / 各家云 API）：音质最好，但要装 Python 包 + 联网 + 可能需 Key，
//     而且**群里的聊天内容会发到第三方服务**。这个项目的基调是「不外发用户内容」
//     （见 asr 用 QQ 自己的转写而不是外部 ASR），所以排除。
//   · 本地神经网络 TTS（piper 等）：要多下一个 60–200 MB 的模型，装到 PATH 还得处理路径。
//   · **Windows 自带的语音引擎**：零安装、零 Key、不联网。
//     其中 **OneCore**（WinRT）比 System.Speech 多出音色 —— 本机 OneCore 有
//     Huihui（女）/ Yaoyao（女）/ Kangkang（男），而 System.Speech 只看得见 Huihui 一个。
//     所以默认（auto）走 OneCore，`sapi` 留作兼容退路。
//
// ── 实现约束（踩过的坑）
//
// ① **绝不把文本拼进命令行**：用 `-Command "...文字..."` 会因为引号、`$`、反引号、
//    中文标点、换行而长期出错（这个项目里已经有 cmd 引号把 DSH 引擎启动吞掉的先例，见手册 7.2）。
//    这里一律「文本写 UTF-8 文件 → 脚本读文件」，命令行上只有固定的 -File 路径。
// ② **stdio 全部 ignore，结果走文件**：受限沙箱里 spawn + stdio:'pipe' 会 EPERM
//    （voice-core.js 开头有同样的记录）。所以合成结果看「输出 wav 是否非空」，
//    错误原因看脚本自己写出的 err.txt。
// ③ 脚本每次现写现跑，用完即删：不改注册表、不留 ps1 垃圾。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const TTS_DEFAULTS = Object.freeze({
  // auto = OneCore 可用就用它（音色多），否则退回 SAPI。
  engine: 'auto',
  // 合成硬超时。实测 4 秒语音约 0.3 秒完成；30 秒是给「很长的句子 + 系统繁忙」的兜底。
  timeoutMs: 30000,
  // 一次最多念多少字。超长的朗读既不像聊天也很费时间。
  maxChars: 100
});

// ── edge-tts（可选引擎，**默认不启用**）─────────────────────────────────────
//
// ⚠️ 隐私提醒（这就是它没进 auto 链路的原因）：
//   edge-tts 会把**要念的文字**发到微软的在线语音服务（speech.platform.bing.com）。
//   本项目的基调是"不外发用户内容"，所以：
//     · `auto` **永远不会**选到 edge（只在 onecore/sapi 之间挑）；
//     · 只有把 `socialV2.tts.engine` 显式写成 `edge` 才会用它；
//     · 启用前请确认群里的人能接受"发出的语音文字会过一遍微软服务器"。
//
// 为什么还是加它：Windows 自带音色的中文只有 huihui/yaoyao/kangkang 三个，
// 想让机器人有"少女感/傲娇感"这类语感（动漫角色近似声线）只能靠 edge 的
// Neural 音色 + pitch 调整。音质差距非常大。
//
// 依赖：`<repo>/.venv-tts/Scripts/edge-tts.exe`（由 ops/gen-voice-samples.py 那套装好）。
// 找不到就报错，不会静默退化成 SAPI（否则用户以为换了引擎其实没换）。

const EDGE_CANDIDATES = (() => {
  const list = [];
  // ① 模块自身位置推导：src/ → qq-bridge-01/ → 项目根/.venv-tts
  //    这条最可靠（不受 spawn 时 cwd 影响）。
  try {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    list.push(path.join(here, '..', '..', '.venv-tts', 'Scripts', 'edge-tts.exe'));
    list.push(path.join(here, '..', '.venv-tts', 'Scripts', 'edge-tts.exe'));
  } catch { /* 忽略 */ }
  // ② cwd 推导（兼容从不同目录启动的旧脚本）
  list.push(path.join(process.cwd(), '..', '.venv-tts', 'Scripts', 'edge-tts.exe'));
  list.push(path.join(process.cwd(), '.venv-tts', 'Scripts', 'edge-tts.exe'));
  return list;
})();

/** 找到 edge-tts 可执行文件；找不到返回 null。 */
export function resolveEdgeTts() {
  const envPath = String(process.env.EDGE_TTS_PATH ?? '').trim();
  const list = [envPath, ...EDGE_CANDIDATES].filter(Boolean);
  for (const p of list) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* 忽略 */ }
  }
  return null;
}

/**
 * 把 `rate`（-10..10，与 SAPI/OneCore 同一套语义）换成 edge 的百分比字符串。
 *
 * 换算用 ×5：档位 1 → +5%（几乎听不出），3 → +15%（明显偏快），
 * 10 → +50%（上限）。**不用 ×10**：档位 8 会变成 +80%，快到听不清词。
 * 试听样本（voice-samples-anime）就是 +3%～+15% 这一带。
 */
function edgeRateArg(rate) {
  const n = Math.min(10, Math.max(-10, Math.round(Number(rate) || 0)));
  const pct = Math.round(n * 5);
  return (pct >= 0 ? '+' : '') + pct + '%';
}

/**
 * 规整 pitch 参数。接受 `+30Hz` / `-3Hz` / `30` / `30Hz` 几种写法。
 * edge 的合法范围实际很宽，这里保守限制在 ±100Hz（超了声音会失真得很怪）。
 */
function edgePitchArg(pitch) {
  if (pitch == null || pitch === '') return '+0Hz';
  const m = String(pitch).match(/^([+-]?)(\d+(?:\.\d+)?)\s*(?:Hz)?$/i);
  if (!m) return '+0Hz';
  const num = Math.min(100, Math.max(-100, Number(m[2])));
  const sign = m[1] === '-' ? '-' : '+';
  return sign + Math.round(num) + 'Hz';
}

/** edge 音色列表缓存：`--list-voices` 要联网，约 1–3 秒，不值得每条语音都跑。 */
let edgeVoiceCache = { at: 0, result: null };
const EDGE_VOICE_CACHE_MS = 30 * 60 * 1000;

/**
 * 列出 edge-tts 的音色。
 *
 * @returns {Promise<{ok:boolean, voices?:Array<{name:string,gender:string,locale:string,note:string}>, error?:string}>}
 */
export async function listEdgeVoices({ timeoutMs = 20000, force = false } = {}) {
  const exe = resolveEdgeTts();
  if (!exe) return { ok: false, error: '找不到 edge-tts.exe（可设 EDGE_TTS_PATH 指定路径）' };
  const now = Date.now();
  if (!force && edgeVoiceCache.result && now - edgeVoiceCache.at < EDGE_VOICE_CACHE_MS) return edgeVoiceCache.result;

  const result = await new Promise((resolve) => {
    let out = '';
    let child;
    try {
      // `--list-voices` 输出到 stdout，必须 pipe（这一步不涉及合成，沙箱限制通常是
      // 针对受限执行；桥接以普通用户跑 powershell 时 pipe 正常）。
      child = spawn(exe, ['--list-voices'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      resolve({ ok: false, error: `无法启动 edge-tts：${error?.message ?? error}` });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ ok: false, error: `枚举音色超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `edge-tts 执行失败：${error?.message ?? error}` });
    });
    child.on('exit', () => {
      clearTimeout(timer);
      const voices = [];
      for (const line of out.split(/\r?\n/)) {
        // 样例：`zh-CN-XiaoyiNeural  Female  Cartoon, Novel  Lively`
        const m = line.match(/^([a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural)\s+(\w+)\s+(.*)$/);
        if (!m) continue;
        voices.push({ name: m[1], gender: m[2], locale: m[1].slice(0, 5), note: m[3].trim() });
      }
      if (!voices.length) { resolve({ ok: false, error: '解析不到音色（输出格式可能变了）' }); return; }
      resolve({ ok: true, voices });
    });
  });

  if (result.ok) edgeVoiceCache = { at: now, result };
  return result;
}

/**
 * TTS 临时工作目录的父目录。
 *
 * ── 为什么不用 os.tmpdir()
 *
 * 本机 `%TEMP%`（C:\Users\<用户>\AppData\Local\Temp）的 ACL 里有个
 * `CodexSandboxUsers` 组只有 RX（读+执行、**没有写**），导致 Python 子进程
 * （edge-tts.exe）`open(..., 'wb')` 直接 PermissionError [Errno 13]，
 * 而 Node 自己的 fs.writeFileSync 却写得进去 —— 所以「能建目录 + 能写文本」
 * 并不能证明「Python 能写音频」。
 *
 * 结论：把工作目录放在项目自己下面，不依赖系统 Temp。
 * 可用环境变量 `TTS_TMP_DIR` 覆盖。
 */
function resolveTtsWorkRoot() {
  const envDir = String(process.env.TTS_TMP_DIR ?? '').trim();
  const candidates = [];
  if (envDir) candidates.push(envDir);
  try {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    // src/ → <bridge>/tmp/tts
    candidates.push(path.join(here, '..', 'tmp', 'tts'));
  } catch { /* 忽略 */ }
  candidates.push(path.join(process.cwd(), 'tmp', 'tts'));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      // 探针：真正写一次再删，避免「有目录但没写权限」的假阳性。
      const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return dir;
    } catch { /* 试下一个 */ }
  }
  return os.tmpdir();
}

/**
 * 用 edge-tts（微软在线 Neural 语音）把文本合成成 MP3。
 *
 * ⚠️ 文字会发到微软服务器，见文件头那段隐私说明。
 *
 * @param text  要念的内容
 * @param opts  { voice, rate, pitch, timeoutMs, dir }
 *        voice  edge 音色名（如 `zh-CN-XiaoyiNeural`）
 *        rate   -10..10 → `--rate ±N%`
 *        pitch  `+30Hz` 之类；这是 SAPI/OneCore 没有的维度，也是"少女感"的关键
 * @returns 同 synthesizeSpeech（path 指向 .mp3，后续由 ffmpeg 转 SILK）
 */
export async function synthesizeSpeechEdge(text, {
  voice = '',
  rate = 0,
  pitch = '',
  timeoutMs = TTS_DEFAULTS.timeoutMs,
  dir = null
} = {}) {
  const content = String(text ?? '').trim();
  if (!content) return { ok: false, error: '没有要念的文字' };
  const exe = resolveEdgeTts();
  if (!exe) return { ok: false, error: '找不到 edge-tts.exe（可设 EDGE_TTS_PATH 指定路径）' };

  const baseDir = dir ?? resolveTtsWorkRoot();
  let workDir;
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    workDir = fs.mkdtempSync(path.join(baseDir, 'tts-edge-out-'));
  } catch (error) {
    return { ok: false, error: `无法创建临时目录：${error?.message ?? error}` };
  }
  const outFile = path.join(workDir, 'speech.mp3');

  // 文本走文件而不是命令行：中文标点 / 引号 / 换行在 cmd 层会被吃掉（老坑）。
  // edge-tts 支持 `-f` 读文本文件。
  const textFile = path.join(workDir, 'text.txt');
  try {
    fs.writeFileSync(textFile, content, 'utf8');
  } catch (error) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: `无法写入文本文件：${error?.message ?? error}` };
  }

  const voiceName = String(voice || 'zh-CN-XiaoyiNeural').trim();
  const args = [
    '--voice', voiceName,
    '--rate', edgeRateArg(rate),
    '--pitch', edgePitchArg(pitch),
    '--file', textFile,
    '--write-media', outFile,
  ];

  const run = await new Promise((resolve) => {
    let child;
    let errText = '';
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, error: `无法启动 edge-tts：${error?.message ?? error}` });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ ok: false, error: `合成超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stderr.on('data', (d) => { errText += d.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `edge-tts 执行失败：${error?.message ?? error}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, error: errText.trim().slice(0, 400) || `退出码 ${code}` });
    });
  });

  let bytes = 0;
  try { bytes = fs.statSync(outFile).size; } catch {}
  if (!run.ok || bytes < 512) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: run.error || '合成没有产出音频' };
  }
  cleanup(textFile);
  return {
    ok: true,
    path: outFile,
    bytes,
    voice: voiceName,
    engine: 'edge',
    // edge 在合成时可调音高/语速，但**音量**仍要靠 ffmpeg 后处理
    volumeApplied: false,
    pitch: edgePitchArg(pitch),
    rate: edgeRateArg(rate),
  };
}

/** PowerShell 单引号字符串转义：把 ' 写成 ''。 */
function psQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

/**
 * 跑一个临时的 .ps1 脚本（stdio 全 ignore，结果看文件）。
 *
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function runPowerShellScript(script, { timeoutMs = TTS_DEFAULTS.timeoutMs, dir = null } = {}) {
  return new Promise((resolve) => {
    let scriptPath = null;
    try {
      const base = dir ?? os.tmpdir();
      fs.mkdirSync(base, { recursive: true });
      scriptPath = path.join(base, `tts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
      // UTF-8 BOM：PowerShell 5.1 读无 BOM 的 .ps1 会按系统 ANSI 解码，
      // 中文注释/字面量就变成乱码 —— 宁可多 3 个字节。
      fs.writeFileSync(scriptPath, '\uFEFF' + script, 'utf8');
    } catch (error) {
      resolve({ ok: false, error: `无法写入临时脚本：${error?.message ?? error}` });
      return;
    }
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath
      ], { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      cleanup(scriptPath);
      resolve({ ok: false, error: `无法启动 PowerShell：${error?.message ?? error}` });
      return;
    }
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup(scriptPath);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      settle({ ok: false, error: `合成超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.on('error', (error) => settle({ ok: false, error: `PowerShell 不可用：${error?.message ?? error}` }));
    child.on('close', (code) => settle(code === 0 ? { ok: true } : { ok: false, error: `PowerShell 退出码 ${code}` }));
  });
}

function cleanup(file) {
  try { if (file) fs.unlinkSync(file); } catch {}
}

function readTextIfExists(file) {
  try {
    const s = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    return s || null;
  } catch { return null; }
}

/**
 * 列出系统已启用的语音合成音色。
 * @returns {Promise<{ok:boolean, voices:Array<{name:string,culture:string,gender:string}>, error?:string}>}
 */
export async function listSapiVoices({ timeoutMs = 15000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-voices-'));
  const outFile = path.join(dir, 'voices.txt');
  const errFile = path.join(dir, 'err.txt');
  const script = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($v in $synth.GetInstalledVoices()) {
    if ($v.Enabled) {
      $info = $v.VoiceInfo
      $lines.Add(($info.Name + '|' + $info.Culture.Name + '|' + $info.Gender.ToString()))
    }
  }
  $synth.Dispose()
  [System.IO.File]::WriteAllLines(${psQuote(outFile)}, $lines, (New-Object System.Text.UTF8Encoding($false)))
  exit 0
} catch {
  [System.IO.File]::WriteAllText(${psQuote(errFile)}, $_.Exception.Message, (New-Object System.Text.UTF8Encoding($false)))
  exit 1
}
`;
  try {
    const run = await runPowerShellScript(script, { timeoutMs, dir });
    if (!run.ok) {
      return { ok: false, voices: [], error: readTextIfExists(errFile) || run.error };
    }
    const raw = readTextIfExists(outFile) ?? '';
    const voices = raw.split(/\r?\n/).map((line) => {
      const [name, culture, gender] = line.split('|');
      return name ? { name: name.trim(), culture: (culture ?? '').trim(), gender: (gender ?? '').trim() } : null;
    }).filter(Boolean);
    return { ok: true, voices };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/** 从音色列表里挑一个中文音色：优先 zh-CN，其次 zh*，都没有则 null。 */
export function pickChineseVoice(voices) {
  const list = Array.isArray(voices) ? voices : [];
  return list.find((v) => /^zh[-_]?CN/i.test(v.culture || ''))
    ?? list.find((v) => /^zh/i.test(v.culture || ''))
    ?? null;
}

// ── OneCore 引擎（WinRT）────────────────────────────────────────────────────
//
// 为什么还要第二个引擎（2026-10-25 实测）：
// `System.Speech` 只看得见 **SAPI5 传统音色**，这台机器上只有 `Microsoft Huihui Desktop`
// （一个中文女声）。而 Windows 自带的 **OneCore** 音色集里其实还有
// `Microsoft Kangkang`（男声）与 `Microsoft Yaoyao`（女声）—— 同一台机器、同一个系统，
// **零下载零联网**，只是 `System.Speech` 枚举不到它们。
//
// 所以这里走 WinRT 的 `Windows.Media.SpeechSynthesis.SpeechSynthesizer`（OneCore 的正式入口，
// 也是「讲述人」用的那一套）。音色数量从 1 个变 3 个，代价只是脚本长一点。
//
// 注意：WinRT 的 API 全是 async（IAsyncOperation），而 Windows PowerShell 5.1 没有 await，
// 所以脚本里要手写 AsTask + Wait（见 PS_WINRT_AWAIT）。

/** PowerShell 单引号里要用的反引号（JS 模板字符串里写不出来，只能拼）。 */
const PS_TICK = String.fromCharCode(96);

/**
 * WinRT 异步等待的 PowerShell 前置代码（**纯 ASCII**）。
 *
 * ⚠️ 必须保持纯 ASCII：脚本以 UTF-8 + BOM 落盘，但 PS 5.1 读 .ps1 时对无 BOM 文件按 ANSI
 * 解码；曾经因为这里混了中文，整段脚本被解成乱码 + 引号错配，报「字符串缺少终止符」。
 */
const PS_WINRT_AWAIT = [
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null',
  '[Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null',
  '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
  `  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${PS_TICK}1'`,
  '})[0]',
  'function Await($op, $type) {',
  '  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))',
  '  $task.Wait(-1) | Out-Null',
  '  $task.Result',
  '}'
].join('\n');

/** OneCore 音色列表缓存：每次 spawn PowerShell 要 ~300ms，不值得每条语音都枚举一遍。 */
let oneCoreCache = { at: 0, result: null };
const ONECORE_CACHE_MS = 10 * 60 * 1000;

/**
 * 列出 OneCore（WinRT）音色。
 *
 * @returns {Promise<{ok:boolean, voices:Array<{name:string,culture:string,gender:string}>, error?:string}>}
 */
export async function listOneCoreVoices({ timeoutMs = 20000, force = false } = {}) {
  const now = Date.now();
  if (!force && oneCoreCache.result && now - oneCoreCache.at < ONECORE_CACHE_MS) return oneCoreCache.result;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-onecore-'));
  const outFile = path.join(dir, 'voices.txt');
  const errFile = path.join(dir, 'err.txt');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    PS_WINRT_AWAIT,
    '$lines = New-Object System.Collections.Generic.List[string]',
    'foreach ($v in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) {',
    "  $lines.Add([string]$v.DisplayName + '|' + [string]$v.Language + '|' + $v.Gender.ToString())",
    '}',
    `[System.IO.File]::WriteAllLines(${psQuote(outFile)}, $lines, (New-Object System.Text.UTF8Encoding($false)))`,
    'exit 0',
    '} catch {',
    `[System.IO.File]::WriteAllText(${psQuote(errFile)}, $_.Exception.Message, (New-Object System.Text.UTF8Encoding($false)))`,
    'exit 1',
    '}'
  ].join('\n');
  try {
    const run = await runPowerShellScript(script, { timeoutMs, dir });
    let result;
    if (!run.ok) {
      result = { ok: false, voices: [], error: readTextIfExists(errFile) || run.error };
    } else {
      const raw = readTextIfExists(outFile) ?? '';
      const voices = raw.split(/\r?\n/).map((line) => {
        const [name, culture, gender] = line.split('|');
        return name ? { name: name.trim(), culture: (culture ?? '').trim(), gender: (gender ?? '').trim() } : null;
      }).filter(Boolean);
      result = { ok: true, voices };
    }
    // 只在成功时缓存：失败可能是临时的（PowerShell 繁忙），下次应该重试。
    if (result.ok) oneCoreCache = { at: now, result };
    return result;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 用 OneCore（WinRT）把文本合成成 WAV。
 *
 * @param text  要念的内容
 * @param opts  { voice, rate, volume, timeoutMs, dir }
 *        voice  OneCore 音色的 DisplayName（如 `Microsoft Kangkang`）；空 = 系统默认
 *        rate   -10..10 → SpeakingRate 倍数（0.5×–2×）
 * @returns 同 synthesizeSpeech
 */
export async function synthesizeSpeechOneCore(text, {
  voice = '',
  rate = 0,
  volume = 100,
  timeoutMs = TTS_DEFAULTS.timeoutMs,
  dir = null
} = {}) {
  const content = String(text ?? '').trim();
  if (!content) return { ok: false, error: '没有要念的文字' };

  const baseDir = dir ?? os.tmpdir();
  let workDir;
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    workDir = fs.mkdtempSync(path.join(baseDir, 'tts-onecore-out-'));
  } catch (error) {
    return { ok: false, error: `无法创建临时目录：${error?.message ?? error}` };
  }
  const textFile = path.join(workDir, 'text.txt');
  const outFile = path.join(workDir, 'speech.wav');
  const errFile = path.join(workDir, 'err.txt');
  // SpeakingRate 是倍数（合法 0.5–6.0，默认 1.0），不是 SAPI 的 -10..10 整数。
  const rateNum = Math.min(10, Math.max(-10, Math.round(Number(rate) || 0)));
  const speakingRate = Math.min(2, Math.max(0.5, 1 + rateNum * 0.1)).toFixed(2);
  // volume 收进结果里（供调用方知情），但**不**写进 WinRT：
  // 见下面 AudioVolume 那段注释 —— 设了它整条合成会失败。
  const volumeNum = Math.min(100, Math.max(0, Math.round(Number(volume ?? 100))));

  try {
    fs.writeFileSync(textFile, content, 'utf8');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      PS_WINRT_AWAIT,
      `$text = [System.IO.File]::ReadAllText(${psQuote(textFile)}, [System.Text.Encoding]::UTF8)`,
      '$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer',
      `$want = ${psQuote(voice)}`,
      "if ($want -ne '') {",
      '  $v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $want } | Select-Object -First 1',
      '  if ($v) { $synth.Voice = $v }',
      '}',
      `$synth.Options.SpeakingRate = ${speakingRate}`,
      // ⚠️ **不要**设 `Options.AudioVolume`（2026-10-25 实测，Windows 11 26200）：
      // 单独赋值本身不报错（0/1/50/100 都能写进去并读回来），但**只要它被设过**，
      // 随后的 `SynthesizeTextToStreamAsync` 就抛
      //   ArgumentException: 参数错误 (HRESULT 0x80070057 / E_INVALIDARG)
      // 复现极稳定（不设 → 68 KB 正常产出；设成 100 → 立即失败）。
      // 音量改为在桥接侧用 ffmpeg 调（sendVoiceV2 的 audio.volume，已有实现），
      // 免得为了一个可选参数把整条语音链路弄挂。
      '$stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])',
      '$reader = New-Object Windows.Storage.Streams.DataReader($stream)',
      'Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32]) | Out-Null',
      '$bytes = New-Object byte[] $stream.Size',
      '$reader.ReadBytes($bytes)',
      `[System.IO.File]::WriteAllBytes(${psQuote(outFile)}, $bytes)`,
      '$reader.Dispose(); $stream.Dispose(); $synth.Dispose()',
      'exit 0',
      '} catch {',
      // 只用 $_.Exception.Message 会得到「使用\"1\"个参数调用\"Wait\"时发生异常:发生一个或多个错误。」
      // —— 真正的原因（AggregateException 里的 WinRT 错误码 / 缺音色 / 音频设备问题）在 InnerException 里。
      // 不把 base exception 打出来，这种失败完全无法定位（实测）。
      '  $base = $_.Exception.GetBaseException()',
      '  $msg = $base.GetType().FullName + \": \" + $base.Message',
      '  if ($base.HResult) { $msg = $msg + \" (HRESULT 0x\" + $base.HResult.ToString(\"X8\") + \")\" }',
      '  if ($_.Exception.GetType().FullName -ne $base.GetType().FullName) { $msg = $msg + \" | via \" + $_.Exception.GetType().FullName }',
      `  [System.IO.File]::WriteAllText(${psQuote(errFile)}, $msg, (New-Object System.Text.UTF8Encoding($false)))`,
      '  exit 1',
      '}'
    ].join('\n');
    const run = await runPowerShellScript(script, { timeoutMs, dir: workDir });
    let bytes = 0;
    try { bytes = fs.statSync(outFile).size; } catch {}
    if (!run.ok || bytes <= 44) {
      const detail = readTextIfExists(errFile) || run.error || '合成没有产出音频';
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      return { ok: false, error: detail };
    }
    cleanup(textFile);
    cleanup(errFile);
    return {
      ok: true,
      path: outFile,
      bytes,
      voice: voice || '(系统默认)',
      engine: 'onecore',
      // 调用方据此知道「音量没在合成这一层生效」（需要的话用 ffmpeg 后处理）
      volumeApplied: false,
      requestedVolume: volumeNum
    };
  } catch (error) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 清洗要朗读的文本。
 *
 * 为什么不能直接念：Markdown 符号、URL、表情、代码片段念出来是噪音
 * （「星号 星号 你好 星号 星号」）。这里只做**低风险**的清理，
 * 不改写内容本身 —— TTS 应该念用户/模型想说的那句话。
 */
export function sanitizeSpeechText(text, { maxChars = TTS_DEFAULTS.maxChars } = {}) {
  let s = String(text ?? '');
  // 顺序很重要：**先**处理图片，再把 [文字](链接) 还原成文字，**最后**删裸 URL。
  // 反过来的话 URL 先被删掉，链接语法残缺（剩下 "[看这个]("），括号就会漏进朗读里；
  // 而链接规则会把 "![图](a.png)" 变成 "!图"，所以图片必须先吃掉。
  s = s.replace(/```[\s\S]*?```/g, '');             // 代码块不念
  s = s.replace(/`([^`]*)`/g, '$1');                // 行内代码去掉反引号
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');       // 图片 ![alt](src) 整个不念
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');    // [文字](链接) → 文字
  s = s.replace(/https?:\/\/\S+/gi, '');            // 裸 URL 不念
  s = s.replace(/[*_~#|>]+/g, '');                  // Markdown 装饰符号
  s = s.replace(/[[\]]/g, '');                      // 残留的方括号（如「[图片]」的壳）
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\s*\n+\s*/g, '，');                // 换行按停顿念，别念成空白
  s = s.replace(/^[，、。；：]+/, '').replace(/[，、；：]+$/, '');
  s = s.trim();
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.round(Number(maxChars)) : TTS_DEFAULTS.maxChars;
  if (s.length > limit) s = s.slice(0, limit);
  return s;
}

/**
 * 用 Windows SAPI（System.Speech）把文本合成成 WAV。
 *
 * 只认 **SAPI5 传统音色**（本机仅 `Microsoft Huihui Desktop`）。想要男声/更多女声走
 * `synthesizeSpeechOneCore`；对外统一入口是 `synthesizeSpeech`（按 engine 分发）。
 *
 * @param text     要念的内容（调用方应先用 sanitizeSpeechText 清洗）
 * @param opts     { voice, rate, volume, timeoutMs, dir }
 *        voice  音色名（空 = 自动挑中文音色；一个都没有时用系统默认）
 *        rate   -10..10
 *        volume 0..100
 * @returns {Promise<{ok:boolean, path?:string, bytes?:number, voice?:string, error?:string}>}
 *          调用方负责删除返回的临时文件（在 opts.dir 里）。
 */
export async function synthesizeSpeechSapi(text, {
  voice = '',
  rate = 0,
  volume = 100,
  timeoutMs = TTS_DEFAULTS.timeoutMs,
  dir = null
} = {}) {
  const content = String(text ?? '').trim();
  if (!content) return { ok: false, error: '没有要念的文字' };

  const baseDir = dir ?? os.tmpdir();
  let workDir;
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    workDir = fs.mkdtempSync(path.join(baseDir, 'tts-out-'));
  } catch (error) {
    return { ok: false, error: `无法创建临时目录：${error?.message ?? error}` };
  }
  const textFile = path.join(workDir, 'text.txt');
  const outFile = path.join(workDir, 'speech.wav');
  const errFile = path.join(workDir, 'err.txt');
  const rateNum = Math.min(10, Math.max(-10, Math.round(Number(rate) || 0)));
  const volumeNum = Math.min(100, Math.max(0, Math.round(Number(volume ?? 100))));

  try {
    // 文本单独写文件：不经过命令行（见文件头 ①）。
    // UTF-8 无 BOM 即可，脚本用 ReadAllText + UTF8 显式解码。
    fs.writeFileSync(textFile, content, 'utf8');
    const script = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  $text = [System.IO.File]::ReadAllText(${psQuote(textFile)}, [System.Text.Encoding]::UTF8)
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.Rate = ${rateNum}
  $synth.Volume = ${volumeNum}
  $want = ${psQuote(voice)}
  if ($want -ne '') {
    try { $synth.SelectVoice($want) } catch { }
  }
  $synth.SetOutputToWaveFile(${psQuote(outFile)})
  $synth.Speak($text)
  $synth.Dispose()
  exit 0
} catch {
  [System.IO.File]::WriteAllText(${psQuote(errFile)}, $_.Exception.Message, (New-Object System.Text.UTF8Encoding($false)))
  exit 1
}
`;
    const run = await runPowerShellScript(script, { timeoutMs, dir: workDir });
    let bytes = 0;
    try { bytes = fs.statSync(outFile).size; } catch {}
    if (!run.ok || bytes <= 44) {
      // 44 字节 = WAV 头本身，等于一个采样都没有
      const detail = readTextIfExists(errFile) || run.error || '合成没有产出音频';
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      return { ok: false, error: detail };
    }
    // 清掉中间文件，只留 wav（调用方用完自己删整个目录）
    cleanup(textFile);
    cleanup(errFile);
    return { ok: true, path: outFile, bytes, voice: voice || '(系统默认)', engine: 'sapi' };
  } catch (error) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 统一的合成入口：按 `engine` 分发。
 *
 * · `onecore` —— WinRT（音色多：本机有 Huihui 女 / Yaoyao 女 / Kangkang 男）
 * · `sapi`    —— System.Speech（音色少，但兼容性最好）
 * · `edge`    —— 微软在线 Neural 语音（音质最好、可调音高，**但文字会外发**；需显式指定）
 * · `auto`    —— OneCore 有中文音色就用 OneCore，否则退回 SAPI。**默认**。
 *
 * 为什么要留 `sapi`：OneCore 依赖 WinRT + PowerShell 的异步桥，在精简系统/受限沙箱里
 * 可能被拦；那种情况下 `auto` 会发现 OneCore 不可用并自动退回 SAPI，不至于完全发不出语音。
 *
 * 为什么 `auto` **不包括** `edge`：edge 把文字发到微软服务器，与项目"不外发用户内容"
 * 的基调冲突。要它必须显式写 `engine: 'edge'`。
 *
 * @param opts 同 synthesizeSpeechSapi，另加 `engine` 与 `pitch`（仅 edge 用）
 */
export async function synthesizeSpeech(text, opts = {}) {
  const engine = String(opts.engine ?? 'auto').toLowerCase();
  if (engine === 'edge') return synthesizeSpeechEdge(text, opts);
  if (engine === 'onecore') return synthesizeSpeechOneCore(text, opts);
  if (engine === 'sapi') return synthesizeSpeechSapi(text, opts);

  // auto：先探一次 OneCore（有 10 分钟缓存），不可用或没有音色就退回 SAPI。
  const oc = await listOneCoreVoices({ timeoutMs: 20000 });
  // 显式指定了音色名，但那个名字不在 OneCore 里（例如写的是 SAPI 的
  // `Microsoft Huihui Desktop`，OneCore 里叫 `Microsoft Huihui`）—— 直接走 SAPI，
  // 不要"名字找不到就悄悄用默认音色"，那会让人以为设置生效了其实没生效。
  const namedVoiceMissing = Boolean(opts.voice) && oc.ok && !oc.voices.some((v) => v.name === opts.voice);
  if (oc.ok && pickChineseVoice(oc.voices) && !namedVoiceMissing) {
    const r = await synthesizeSpeechOneCore(text, { ...opts, voice: opts.voice || pickChineseVoice(oc.voices).name });
    if (r.ok) return r;
    // OneCore 报了错（而不是"没有音色"）：把原因带上，但**仍然**退回 SAPI 试一次 ——
    // 语音发不出去比音色不对更糟。失败原因两者都记下来，方便定位。
    const sapi = await synthesizeSpeechSapi(text, opts);
    if (sapi.ok) return { ...sapi, fallbackFrom: `onecore: ${r.error}` };
    return { ok: false, error: `onecore: ${r.error}；sapi: ${sapi.error}` };
  }
  const sapi = await synthesizeSpeechSapi(text, opts);
  if (sapi.ok && namedVoiceMissing) return sapi;
  return sapi;
}

/** 供日志/提示用：一句话说明 TTS 是否可用（不产生文件）。 */
export async function describeTtsSupport({ includeEdge = false } = {}) {
  const [sapi, onecore] = await Promise.all([
    listSapiVoices({ timeoutMs: 15000 }),
    listOneCoreVoices({ timeoutMs: 20000 })
  ]);
  const voices = [
    ...(onecore.ok ? onecore.voices.map((v) => ({ ...v, engine: 'onecore' })) : []),
    ...(sapi.ok ? sapi.voices.map((v) => ({ ...v, engine: 'sapi' })) : [])
  ];
  const zh = pickChineseVoice(voices);
  // edge 要联网枚举，只在显式要求时才查（tts-status 接口会带上，避免每次启动都拖慢）
  const edge = includeEdge ? await listEdgeVoices({ timeoutMs: 20000 }) : null;
  const edgeVoices = edge?.ok ? edge.voices.filter((v) => v.locale.startsWith('zh')) : [];
  return {
    ok: voices.length > 0,
    voices,
    chineseVoice: zh?.name ?? null,
    engines: {
      onecore: onecore.ok ? onecore.voices.length : (onecore.error ?? 'unavailable'),
      sapi: sapi.ok ? sapi.voices.length : (sapi.error ?? 'unavailable'),
      ...(includeEdge ? { edge: edge?.ok ? edge.voices.length : (edge?.error ?? 'unavailable') } : {})
    },
    ...(includeEdge ? {
      edgeAvailable: Boolean(resolveEdgeTts()),
      edgeVoices: edgeVoices.map((v) => ({ name: v.name, gender: v.gender, note: v.note })),
    } : {})
  };
}
