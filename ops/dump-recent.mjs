// 导出 state/social-v2.json 里 recentMessages（带发言人，含 AI 自己发的），
// 用来整理「自我演变」记录 —— 归档文件里只有时间不详的碎片，这里能看到上下文。
// 用法：node ops\dump-recent.mjs <bridgeDir> [keyRegex] [条数] [outFile]

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/QQbot';
const dir = process.argv[2] || 'qq-bridge-01';
const keyRe = new RegExp(process.argv[3] || '.');
const limit = Number(process.argv[4]) || 120;
const outFile = process.argv[5] || path.join(ROOT, 'ops', `_recent-${dir}.txt`);

const file = path.join(ROOT, dir, 'state', 'social-v2.json');
const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const out = [];

for (const [key, st] of Object.entries(raw.conversations || {})) {
  if (!keyRe.test(key)) continue;
  const msgs = Array.isArray(st.recentMessages) ? st.recentMessages : [];
  const picked = msgs.slice(-limit);
  out.push(`\n########## ${key}  (共 ${msgs.length} 条，导出 ${picked.length}) ##########`);
  for (const m of picked) {
    const t = Number(m.time) || 0;
    const when = t ? new Date(t).toISOString().replace('T', ' ').slice(5, 16) : '?     ';
    const who = m.isSelf ? '★AI' : String(m.sender || '?');
    const text = String(m.text ?? m.plain ?? '').replace(/\s+/g, ' ').slice(0, 220);
    out.push(`[${when}] ${who}: ${text}`);
  }
}

fs.writeFileSync(outFile, out.join('\n'), 'utf8');
console.log('written ' + outFile);
