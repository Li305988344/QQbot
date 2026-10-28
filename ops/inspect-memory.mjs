// 只读巡检：把两个桥接的「记忆」结构打出来，方便人工整理成自我演变记录。
// 用法：node ops/inspect-memory.mjs [--json]
//
// 输出（每个会话）：
//   最近活跃时间 / 未读数 / 消息数
//   activeTopics（进行中的话题）
//   memberImpressions（对群友的印象 + 互动次数）
//   affection（感情值 + 阶段）
//   selfGrowth（已有的自我演变记录，含权重）

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/QQbot';
const BRIDGES = [
  { name: 'b1(大肥鱼)', dir: 'qq-bridge-01' },
  { name: 'b2(小黑)', dir: 'qq-bridge-02' }
];
const asJson = process.argv.includes('--json');

const STAGES = [
  [88, '特别'], [70, '亲近'], [50, '熟客'], [30, '眼熟'], [15, '生分'], [0, '反感']
];

function stageOf(v) {
  for (const [min, label] of STAGES) if (v >= min) return label;
  return '反感';
}

function ago(ms) {
  if (!ms) return '未知';
  const d = Date.now() - Number(ms);
  if (!Number.isFinite(d) || d < 0) return '刚刚';
  const min = Math.round(d / 60000);
  if (min < 60) return min + '分钟前';
  const h = Math.round(min / 60);
  if (h < 48) return h + '小时前';
  return Math.round(h / 24) + '天前';
}

const out = {};

for (const b of BRIDGES) {
  const file = path.join(ROOT, b.dir, 'state', 'social-v2.json');
  if (!fs.existsSync(file)) {
    console.log(`\n===== ${b.name} =====\n  (没有 ${file})`);
    continue;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.log(`\n===== ${b.name} =====\n  解析失败: ${e.message}`);
    continue;
  }
  out[b.name] = {};
  console.log(`\n===== ${b.name} ===== (${path.basename(file)})`);
  const convs = raw.conversations || {};
  for (const [key, st] of Object.entries(convs)) {
    const msgs = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const others = msgs.filter((m) => m && !m.isSelf);
    const lastAt = Math.max(
      Number(st.lastIncomingAt) || 0,
      Number(st.lastAiReplyAt) || 0,
      ...msgs.slice(-1).map((m) => Number(m?.time) || 0),
      0
    );
    console.log(`\n-- ${key} --  最近活跃 ${ago(lastAt)}  消息 ${msgs.length}  未读 ${(st.unread || []).length}`);

    const topics = Array.isArray(st.activeTopics) ? st.activeTopics : [];
    if (topics.length) {
      console.log('  [话题]');
      for (const t of topics) console.log(`    - ${t.text}（${ago(t.lastMentionAt)}）`);
    }
    const imps = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    if (Object.keys(imps).length) {
      console.log('  [印象]');
      for (const [name, im] of Object.entries(imps)) {
        console.log(`    - ${name}: ${(im.traits || []).join('、') || '无'}  互动 ${im.interactionCount || 0} 次  最后 ${ago(im.lastSeenAt)}`);
      }
    }
    const aff = st.affection && typeof st.affection === 'object' ? st.affection : {};
    if (Object.keys(aff).length) {
      console.log('  [感情值]');
      for (const [name, a] of Object.entries(aff)) {
        const v = Number(a?.value) || 0;
        console.log(`    - ${name}: ${v}（${stageOf(v)}）  最后 ${ago(a?.updatedAt || a?.at)}`);
      }
    }
    const growth = st.selfGrowth && typeof st.selfGrowth === 'object' ? st.selfGrowth : {};
    if (Object.keys(growth).length) {
      console.log('  [自我演变]');
      for (const [role, list] of Object.entries(growth)) {
        console.log(`    ${role}:`);
        for (const e of list || []) {
          console.log(`      - w=${e?.w ?? '-'} hits=${e?.hits ?? '-'} ${ago(e?.at)}  ${e?.text}`);
        }
      }
    }
    // 群友发言样本：帮助整理「谁常聊」
    if (others.length) {
      const counts = new Map();
      for (const m of others) counts.set(m.sender, (counts.get(m.sender) || 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      console.log('  [发言分布] ' + top.map(([n, c]) => `${n}×${c}`).join('  '));
    }
    out[b.name][key] = {
      lastActiveAt: lastAt, messages: msgs.length, others: others.length,
      topics: topics.map((t) => t.text),
      impressions: imps, affection: aff, selfGrowth: growth
    };
  }
}

if (asJson) {
  const f = path.join(ROOT, 'ops', '_memory-snapshot.json');
  fs.writeFileSync(f, JSON.stringify(out, null, 2), 'utf8');
  console.log('\n[saved] ' + f);
}
