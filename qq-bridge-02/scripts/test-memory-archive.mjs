// 长期记忆归档模块自测：写入 / 读取 / 过滤 / 容错
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryArchive, readArchive, listArchiveDates, localDateStr, localStampStr } from '../src/memory-archive.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m ?? ''} 期望 ${JSON.stringify(b)} 实得 ${JSON.stringify(a)}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memtest-'));

console.log('== 写入 ==');
const ar = new MemoryArchive({ root: tmp, instance: '999', onError: () => {} });
t('目录延迟创建', () => { if (fs.existsSync(ar.directory)) throw new Error('不应提前创建'); });
t('写第一条', () => eq(ar.append({ dir: 'in', key: 'group:1', text: '你好', sender: '某群友', uid: '100000001', owner: true }), true));
t('写第二条（机器人）', () => eq(ar.append({ dir: 'out', key: 'group:1', text: '在', isSelf: true }), true));
t('写第三条（私聊）', () => eq(ar.append({ dir: 'in', key: 'private:2', text: '私聊内容' }), true));
t('目录已创建', () => { if (!fs.existsSync(ar.directory)) throw new Error('未创建'); });
t('统计已记数', () => eq(ar.stats().written, 3));

console.log('== 读取 ==');
t('读全部', () => eq(readArchive({ root: tmp, instance: '999' }).length, 3));
t('按会话过滤', () => eq(readArchive({ root: tmp, instance: '999', key: 'group:1' }).length, 2));
t('按关键词过滤', () => eq(readArchive({ root: tmp, instance: '999', contains: '私聊' }).length, 1));
t('limit 取最近', () => {
  const r = readArchive({ root: tmp, instance: '999', limit: 1 });
  eq(r.length, 1);
  eq(r[0].text, '私聊内容');
});
t('日期列表', () => eq(listArchiveDates(tmp, '999').length, 1));

console.log('== 字段 ==');
t('in 方向', () => {
  const r = readArchive({ root: tmp, instance: '999', key: 'group:1' });
  eq(r[0].dir, 'in');
  eq(r[0].sender, '某群友');
  eq(r[0].uid, '100000001');
  eq(r[0].owner, true);
  eq(r[1].dir, 'out');
  eq(r[1].self, true);
  if (!r[0].t || r[0].t.length !== 19) throw new Error(`时间戳格式异常: ${r[0].t}`);
});

console.log('== 边界 ==');
t('禁用时返回 false 且不写', () => {
  const off = new MemoryArchive({ root: tmp, instance: 'off', enabled: false });
  eq(off.append({ dir: 'in', key: 'group:1', text: 'x' }), false);
  if (fs.existsSync(off.directory)) throw new Error('禁用仍创建了目录');
});
t('超长文本被截断但有标记', () => {
  const a2 = new MemoryArchive({ root: tmp, instance: 'long' });
  a2.append({ dir: 'in', key: 'group:1', text: 'x'.repeat(5000) });
  const r = readArchive({ root: tmp, instance: 'long' })[0];
  if (!r.text.endsWith('…[截断]')) throw new Error('未标记截断');
  if (r.text.length > 2100) throw new Error(`截断失效: ${r.text.length}`);
});
t('空文本不报错', () => {
  const a3 = new MemoryArchive({ root: tmp, instance: 'empty' });
  eq(a3.append({ dir: 'in', key: 'group:1' }), true);
  eq(readArchive({ root: tmp, instance: 'empty' })[0].text, '');
});
t('坏行不影响其它记录', () => {
  const dir = path.join(tmp, 'memory', 'bad');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${localDateStr()}.jsonl`), '{坏JSON\n' + JSON.stringify({ ts: Date.now(), t: localStampStr(), key: 'group:1', dir: 'in', text: '好的' }) + '\n', 'utf8');
  eq(readArchive({ root: tmp, instance: 'bad' }).length, 1);
});
// 回归：归档文件被记事本 / PowerShell 重定向 / Excel 碰过时首行会带 UTF-8 BOM，
// 早期实现用 JSON.parse(line) 直接失败并被坏行 catch 吞掉，导致「每天第一条记录消失」。
t('首行带 BOM 仍可读（不被当成坏行丢弃）', () => {
  const dir = path.join(tmp, 'memory', 'bom');
  fs.mkdirSync(dir, { recursive: true });
  const rec = (text) => JSON.stringify({ ts: Date.now(), t: localStampStr(), key: 'group:1', dir: 'in', text });
  fs.writeFileSync(
    path.join(dir, `${localDateStr()}.jsonl`),
    '\uFEFF' + rec('带BOM的第一条') + '\n' + rec('第二条') + '\n',
    'utf8',
  );
  const r = readArchive({ root: tmp, instance: 'bom' });
  eq(r.length, 2, 'BOM 行不应丢');
  eq(r[0].text, '带BOM的第一条');
  eq(r[1].text, '第二条');
});
t('CRLF 行尾仍可读', () => {
  const dir = path.join(tmp, 'memory', 'crlf');
  fs.mkdirSync(dir, { recursive: true });
  const rec = (text) => JSON.stringify({ ts: Date.now(), t: localStampStr(), key: 'group:1', dir: 'in', text });
  fs.writeFileSync(path.join(dir, `${localDateStr()}.jsonl`), rec('a') + '\r\n' + rec('b') + '\r\n', 'utf8');
  const r = readArchive({ root: tmp, instance: 'crlf' });
  eq(r.length, 2);
  eq(r[1].text, 'b');
});
t('目录不存在时读取返回空数组', () => eq(readArchive({ root: tmp, instance: 'nope' }).length, 0));
t('磁盘错误只上报一次', () => {
  let errors = 0;
  // 用一个不可能创建的路径（文件当目录用）
  const blocker = path.join(tmp, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const bad = new MemoryArchive({ root: path.join(blocker, 'sub'), instance: 'x', onError: () => errors++ });
  bad.append({ dir: 'in', key: 'g', text: 'a' });
  bad.append({ dir: 'in', key: 'g', text: 'b' });
  bad.append({ dir: 'in', key: 'g', text: 'c' });
  eq(errors, 1, '错误应被冷却去重');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
