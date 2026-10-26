// 临时诊断：按修改时间列出最近的 DSH 会话及其权限预设
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
const rows = [];
for (const f of readdirSync(dir)) {
  const full = path.join(dir, f);
  const st = statSync(full);
  let text = '';
  try { text = readFileSync(full, 'utf8'); } catch { continue; }
  const m = text.match(/"permissions"[\s\S]{0,220}/);
  const preset = (m?.[0].match(/"preset":\s*"([^"]*)"/) ?? [])[1] ?? '?';
  const approval = (m?.[0].match(/"approval":\s*"([^"]*)"/) ?? [])[1] ?? '?';
  const cwd = (text.match(/"cwd":\s*"((?:[^"\\]|\\.)*)"/) ?? [])[1] ?? '?';
  rows.push({ f, mtime: st.mtime, preset, approval, cwd: cwd.replace(/\\\\/g, '\\') });
}
rows.sort((a, b) => b.mtime - a.mtime);
console.log('最近 8 个会话（mtime 从新到旧）:\n');
for (const r of rows.slice(0, 8)) {
  console.log(`${r.mtime.toISOString()}  preset=${r.preset}  approval=${r.approval}`);
  console.log(`    cwd=${r.cwd}`);
}
const bad = rows.filter((r) => r.approval !== 'never');
console.log(`\n共 ${rows.length} 个会话，其中 approval!=never 的 ${bad.length} 个:`);
for (const r of bad) console.log(`  ${r.f}  preset=${r.preset} approval=${r.approval}  cwd=${r.cwd}`);
