#!/usr/bin/env node
/**
 * 长期记忆查询工具
 *
 * 归档由两个桥接进程自动写入（见 qq-bridge-01/src/memory-archive.js）：
 *
 *   D:\QQbot\memory\<实例>\<YYYY-MM-DD>.jsonl
 *
 * 用法：
 *   node memory-query.mjs                         列出实例与可用日期
 *   node memory-query.mjs --instance <机器人QQ>   只看某个机器人
 *   node memory-query.mjs --date 2026-10-26       看某一天（默认今天）
 *   node memory-query.mjs --all                   看全部日期
 *   node memory-query.mjs --key group:100000000   只看某个会话
 *   node memory-query.mjs --grep 关键词           正文包含关键词（不区分大小写）
 *   node memory-query.mjs --limit 30              只看最近 30 条
 *   node memory-query.mjs --json                  输出原始 JSONL（便于管道处理）
 *
 * 多条过滤条件可组合，例如：
 *   node memory-query.mjs --date 2026-10-26 --key group:100000000 --limit 50
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listArchiveDates, readArchive, MEMORY_DIR_NAME } from '../qq-bridge-01/src/memory-archive.js';

// 本文件在 <repo>/ops/：归档目录在项目根的 memory/ 下，模块在 qq-bridge-01/src/。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { all: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : undefined);
    if (a === '--instance') opts.instance = next();
    else if (a === '--date') opts.date = next();
    else if (a === '--key') opts.key = next();
    else if (a === '--grep') opts.grep = next();
    else if (a === '--limit') opts.limit = Number(next());
    else if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 列出 memory/ 下的实例目录。 */
function listInstances() {
  const base = path.join(ROOT, MEMORY_DIR_NAME);
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

const HELP = `长期记忆查询

  node memory-query.mjs                        列出实例与可用日期
  node memory-query.mjs --date 2026-10-26      看某一天
  node memory-query.mjs --all                  看全部日期
  node memory-query.mjs --key group:100000000  只看某个会话
  node memory-query.mjs --grep 关键词          正文包含关键词
  node memory-query.mjs --limit 30             只看最近 30 条
  node memory-query.mjs --instance <机器人QQ>  只看某个机器人（目录名 = 机器人 QQ）
  node memory-query.mjs --json                 输出原始 JSONL
`;

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

const instances = opts.instance ? [String(opts.instance)] : listInstances();

if (!instances.length) {
  console.log(`还没有任何归档。`);
  console.log(`归档目录：${path.join(ROOT, MEMORY_DIR_NAME)}`);
  console.log(`桥接收发消息后会自动创建（重启桥接即生效）。`);
  process.exit(0);
}

// 无过滤条件时只做总览。
const isOverview = !opts.date && !opts.all && !opts.key && !opts.grep && !opts.limit;
if (isOverview) {
  console.log(`归档根目录：${path.join(ROOT, MEMORY_DIR_NAME)}\n`);
  for (const inst of instances) {
    const dates = listArchiveDates(ROOT, inst);
    console.log(`实例 ${inst}：${dates.length} 天`);
    for (const d of dates.slice(0, 10)) {
      const recs = readArchive({ root: ROOT, instance: inst, date: d });
      const size = fs.statSync(path.join(ROOT, MEMORY_DIR_NAME, inst, `${d}.jsonl`)).size;
      const ins = recs.filter((r) => r.dir === 'in').length;
      console.log(`  ${d}  ${recs.length} 条（收到 ${ins} / 发出 ${recs.length - ins}）  ${(size / 1024).toFixed(1)} KB`);
    }
    if (dates.length > 10) console.log(`  …另有 ${dates.length - 10} 天`);
    console.log('');
  }
  console.log(`提示：加 --date ${todayStr()} 看今天全部内容。`);
  process.exit(0);
}

const dateFilter = opts.all ? undefined : (opts.date || todayStr());

for (const inst of instances) {
  const recs = readArchive({
    root: ROOT,
    instance: inst,
    date: dateFilter,
    key: opts.key,
    contains: opts.grep,
    limit: opts.limit,
  });

  if (opts.json) {
    for (const r of recs) console.log(JSON.stringify(r));
    continue;
  }

  const scope = [dateFilter ?? '全部日期', opts.key ?? '全部会话', opts.grep ? `含「${opts.grep}」` : null]
    .filter(Boolean)
    .join(' · ');
  console.log(`\n===== 实例 ${inst} · ${scope} · ${recs.length} 条 =====`);
  if (!recs.length) {
    console.log('（没有匹配的记录）');
    continue;
  }
  for (const r of recs) {
    const who = r.self ? '我' : (r.sender || r.uid || '?');
    const flag = r.owner && !r.self ? ' [管理员]' : '';
    const media = Array.isArray(r.media) && r.media.length ? ` ${r.media.map((m) => `[${m}]`).join('')}` : '';
    const arrow = r.dir === 'out' ? '→' : '←';
    const when = String(r.t ?? '').slice(11) || new Date(Number(r.ts)).toTimeString().slice(0, 8);
    console.log(`${when} ${arrow} ${r.key} | ${who}${flag}: ${r.text}${media}`);
  }
}
