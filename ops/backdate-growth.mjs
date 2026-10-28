// 把某条自我演变记录的时间改到 N 天前（用于验证时间衰减）。
// **必须在桥接停止时运行**，否则内存态会把你改的文件覆盖回去。
//
// 用法：
//   node ops\backdate-growth.mjs <bridgeDir> <matchText> <days> [newWeight]

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/QQbot';
const [dir, matchText, daysArg, weightArg] = process.argv.slice(2);
if (!dir || !matchText) {
  console.error('usage: node backdate-growth.mjs <bridgeDir> <matchText> <days> [newWeight]');
  process.exit(1);
}
const days = Number(daysArg) || 200;
const file = path.join(ROOT, dir, 'state', 'social-v2.json');
const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

let hit = 0;
const target = Date.now() - days * 86400000;
for (const [key, st] of Object.entries(raw.conversations || {})) {
  const buckets = st.selfGrowth || {};
  for (const [role, list] of Object.entries(buckets)) {
    for (const e of list || []) {
      if (String(e.text || '').includes(matchText)) {
        e.at = target;
        if (weightArg !== undefined) e.w = Number(weightArg);
        hit++;
        console.log(`patched ${key} / ${role}: at=${new Date(target).toISOString().slice(0, 10)} w=${e.w}`);
      }
    }
  }
}

if (!hit) {
  console.error('没找到匹配的记录');
  process.exit(2);
}
fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
console.log('saved ' + file);
