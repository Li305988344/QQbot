// Electron asar 归档只读访问（零依赖，只用 node:fs）。
//
// 为什么要它：本项目真正在跑的 DSH 是 `deepseek_harness` 这个 Electron 分发版，
// 它的全部包都在 `resources/app.asar` 里（归档内路径形如
// `dsh/node_modules/@deepseek-ai/<pkg>/…`），磁盘上看不到散开的 node_modules。
// 而 `scripts/dsh-tool-names.mjs` 需要**读源码**才能抽取真实注册的工具名，
// 所以必须能穿透 asar。仓库里没有 asar 依赖，也不该为此加一个。
//
// asar 文件布局（已用真实归档验证）：
//   0..3   uint32  = 4
//   4..7   uint32  = p1  → 数据区起点 = 8 + p1
//   8..11  uint32  = p2
//   12..15 uint32  = headerStringSize
//   16..   headerStringSize 字节的 JSON 目录树
//   文件内容位置 = dataStart + entry.offset（长度 entry.size）
import fs from 'node:fs';

const READ_CHUNK_LIMIT = 8 * 1024 * 1024; // 单个文件超过 8 MB 不读（源码/补丁不会这么大）

/**
 * 打开一个 asar 归档（只读，按需读片段，不整包载入内存）。
 *
 * @param {string} file
 * @returns {{file: string, entries: Array<{path: string, size: number, offset: number}>,
 *            has: (p: string) => boolean, read: (p: string) => string|null,
 *            list: (prefix: string) => Array<{path: string, size: number, offset: number}>}|null}
 */
export function openAsar(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const dataStart = 8 + head.readUInt32LE(4);
    const headerStrSize = head.readUInt32LE(12);
    if (!headerStrSize || headerStrSize > 64 * 1024 * 1024) return null;
    const hb = Buffer.alloc(headerStrSize);
    fs.readSync(fd, hb, 0, headerStrSize, 16);
    const header = JSON.parse(hb.toString('utf8'));

    const entries = [];
    const index = new Map();
    (function walk(node, prefix) {
      for (const [name, val] of Object.entries(node.files ?? {})) {
        const full = prefix ? `${prefix}/${name}` : name;
        if (val.files) walk(val, full);
        else {
          const entry = { path: full, size: Number(val.size ?? 0), offset: Number(val.offset ?? 0) };
          entries.push(entry);
          index.set(full, entry);
        }
      }
    })(header, '');

    return {
      file,
      entries,
      has: (p) => index.has(p),
      read(p) {
        const e = index.get(p);
        if (!e || e.size > READ_CHUNK_LIMIT) return null;
        const buf = Buffer.alloc(e.size);
        const f = fs.openSync(file, 'r');
        try {
          fs.readSync(f, buf, 0, e.size, dataStart + e.offset);
        } finally {
          fs.closeSync(f);
        }
        return buf.toString('utf8');
      },
      list(prefix) {
        const pre = prefix.endsWith('/') ? prefix : `${prefix}/`;
        return entries.filter((e) => e.path.startsWith(pre));
      },
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 已关或未开 */ }
    }
  }
}
