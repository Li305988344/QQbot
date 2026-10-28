// Probe the persona voice samples and the copies installed into each bridge's voice
// library. Exists because cmd/PowerShell mangle the Chinese paths in this workspace and
// ffprobe does not accept wildcards — spawning with an argv array sidesteps both.
//
//   node ops/verify-voice.mjs [prefix]
//
// `prefix` selects which persona sample to look at (default "3-").

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = 'D:\\QQbot';
const PREFIX = process.argv[2] || '3-';
const SAMPLES = path.join(ROOT, 'voice-samples', 'persona');

function findFfprobe() {
  const link = 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffprobe.exe';
  if (fs.existsSync(link)) return link;
  const guess = 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe';
  if (fs.existsSync(guess)) return path.join(path.dirname(guess), 'ffprobe.exe');
  return 'ffprobe';
}

const FFPROBE = findFfprobe();

function probe(file) {
  const size = fs.statSync(file).size;
  const out = execFileSync(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration,format_name',
     '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate',
     '-of', 'default=noprint_wrappers=1', file],
    { encoding: 'utf8' },
  );
  const kv = {};
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  return { bytes: size, ...kv };
}

const sampleName = fs.readdirSync(SAMPLES).find((f) => f.startsWith(PREFIX) && f.toLowerCase().endsWith('.mp3'));
if (!sampleName) {
  console.log(`no sample matching "${PREFIX}*.mp3" in voice-samples/persona`);
  process.exit(1);
}

const targets = [
  ['source  ', path.join(SAMPLES, sampleName)],
  ...['qq-bridge-01', 'qq-bridge-02'].map((b) => [
    b.padEnd(8),
    path.join(ROOT, b, 'audio', 'xiaoyi-p18.mp3'),
  ]),
  // 参考基准：同一段文字在 persona 目录里的原始样本（语音库现在只留 xiaoyi 这一条，
  // 早期那套 01-在的.mp3 已经删了 —— 源文件仍归档在 voice-samples/own/ 下）。
  ['ref-own ', path.join(ROOT, 'voice-samples', 'own', 'ready', '01-\u5728\u7684.mp3')], // 01-在的
];

for (const [label, file] of targets) {
  if (!fs.existsSync(file)) {
    console.log(`${label} MISSING ${file}`);
    continue;
  }
  try {
    const r = probe(file);
    console.log(
      `${label} ${String(r.bytes).padStart(7)}B  ${r.codec_name || '?'}  ` +
      `${r.sample_rate || '?'}Hz  ${r.channels || '?'}ch  ` +
      `${r.bit_rate ? Math.round(Number(r.bit_rate) / 1000) + 'kbps' : '?kbps'}  ` +
      `${r.duration ? Number(r.duration).toFixed(2) + 's' : '?s'}  ${r.format_name || '?'}`,
    );
  } catch (e) {
    const msg = String(e.stderr || e.message || '').split(/\r?\n/).filter(Boolean)[0] || 'probe failed';
    console.log(`${label} ERROR ${msg}`);
  }
}
