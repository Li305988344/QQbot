// 把长期记忆归档里的最近消息导出成纯文本，方便人工整理「自我演变」记录。
// 用法：node ops\dump-dialogue.mjs <机器人QQ> [行数] [输出文件]

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, bridgeEnv } from './lib/local-env.mjs';

const ROOT = REPO_ROOT;
// 默认机器人 QQ 从配置读，不写在源码里（见 ops/lib/local-env.mjs）。
const uin = process.argv[2] || bridgeEnv('qq-bridge-01').selfQQ;
const limit = Number(process.argv[3]) || 200;
const outFile = process.argv[4] || path.join(ROOT, 'ops', `_dialogue-${uin || 'unknown'}.txt`);
if (!uin) {
  console.error('没有指定机器人 QQ，且 config.json 里没配 selfQQ。用法：node ops\\dump-dialogue.mjs <机器人QQ> [行数] [输出文件]');
  process.exit(1);
}

const dir = path.join(ROOT, 'memory', uin);
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
  : [];

const rows = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { /* 坏行跳过 */ }
  }
}

const picked = rows.slice(-limit);
const out = [];
out.push(`# 归档 ${uin}：共 ${rows.length} 条，导出最后 ${picked.length} 条`);
out.push('');
for (const r of picked) {
  const t = r.time || r.at || r.timestamp || 0;
  const when = t ? new Date(Number(t)).toISOString().replace('T', ' ').slice(0, 16) : '?';
  const who = r.sender || r.nickname || (r.isSelf ? 'AI' : '?');
  const key = r.key || r.conversation || '';
  const text = String(r.text ?? r.plain ?? r.content ?? '').replace(/\s+/g, ' ').slice(0, 300);
  if (!text) continue;
  out.push(`[${when}] ${key ? key + ' ' : ''}${who}: ${text}`);
}

fs.writeFileSync(outFile, out.join('\n'), 'utf8');
console.log('written ' + outFile + ' lines=' + out.length);
