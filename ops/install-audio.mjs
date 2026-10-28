// Binary-safe copy of an audio file into one or more bridge voice libraries, with an
// integrity check on the far side.
//
// Why this exists: `copy /y src\3-*.mp3 dest.mp3` in cmd silently truncates the copy.
// cmd's `copy` defaults to TEXT mode, and in text mode byte 0x1A (DOS Ctrl-Z / EOF) ends
// the stream. The 夏娜 sample happens to contain 0x1A at offset 94, so the "successful"
// copy came out 95 bytes long and ffprobe reported "Failed to find two consecutive MPEG
// audio frames". Use this instead of copy for anything that is not plain text.
//
//   node ops/install-audio.mjs <samplePrefix> <destName> [bridgeDir ...]
//
// Defaults: samplePrefix "3-", destName "xiaoyi-p18.mp3", all bridges.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = 'D:\\QQbot';
const SAMPLE_DIR = path.join(ROOT, 'voice-samples', 'persona');

const prefix = process.argv[2] || '3-';
const destName = process.argv[3] || 'xiaoyi-p18.mp3';
const bridges = process.argv.length > 4 ? process.argv.slice(4) : ['qq-bridge-01', 'qq-bridge-02'];

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const srcName = fs.readdirSync(SAMPLE_DIR).find((f) => f.startsWith(prefix) && f.toLowerCase().endsWith('.mp3'));
if (!srcName) {
  console.log(`no sample matching "${prefix}*.mp3" under voice-samples/persona`);
  process.exit(1);
}

const src = path.join(SAMPLE_DIR, srcName);
const srcHash = sha(src);
const srcSize = fs.statSync(src).size;
console.log(`source ${srcName}  ${srcSize}B  sha256=${srcHash.slice(0, 16)}...`);

let failed = 0;
for (const b of bridges) {
  const dir = path.join(ROOT, b, 'audio');
  if (!fs.existsSync(dir)) {
    console.log(`[fail] ${b}: no audio dir`);
    failed++;
    continue;
  }
  const dest = path.join(dir, destName);
  fs.copyFileSync(src, dest); // binary, no text-mode EOF games
  const gotSize = fs.statSync(dest).size;
  const gotHash = sha(dest);
  const ok = gotSize === srcSize && gotHash === srcHash;
  console.log(`${ok ? '[ok]' : '[MISMATCH]'} ${b}/audio/${destName}  ${gotSize}B  sha256=${gotHash.slice(0, 16)}...`);
  if (!ok) failed++;
}

console.log(failed === 0 ? 'RESULT: byte-identical in all bridges' : `RESULT: ${failed} bridge(s) failed`);
process.exit(failed === 0 ? 0 : 1);
