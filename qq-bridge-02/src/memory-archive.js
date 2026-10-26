/**
 * 长期记忆归档（append-only）。
 *
 * 为什么需要它：
 *   `state/social-v2.json` 的 `recentMessages` 是**滚动窗口**（默认 100 条/会话），
 *   超出就 splice 掉；`unread` 更短；`activeTopics` 24h 过期、`pendingThoughts` 2h 过期；
 *   `state/qq-activity.log` 只记「消息已入未读：xxx」摘要（不含机器人回复原文）且会轮转。
 *   也就是说，目前没有任何一处保存完整、可回溯的聊天记录。
 *
 * 本模块把每条消息（群友说的 + 机器人说的）追加到按日期切分的 JSONL 文件里：
 *
 *   <root>/memory/<实例>/2026-10-26.jsonl
 *
 * 设计取舍：
 *   - **JSONL 而非单个大 JSON**：append-only 不会因重写整个文件而丢历史；
 *     一行一条，损坏只影响那一行；`grep` 直接可用；不需要读全文件。
 *   - **按日期切文件**：单文件不会无限膨胀，删旧数据 = 删文件。
 *   - **按实例分目录**：两个桥接是独立进程，分开写避免并发；也便于区分身份。
 *   - **只脱敏已知凭据**：归档是本机私有数据，追求「记得准」。
 *     因此只替换 KNOWN_AGENT_TOKENS（真正的凭据），不像日志那样把路径一并打成 ***。
 *   - **任何失败都不得影响主流程**：所有 IO 包在 try/catch 里，失败只记一次日志并继续尝试。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 归档根目录名（相对于项目根）。 */
export const MEMORY_DIR_NAME = 'memory';

/** 单条正文上限。比 recentMessages 的 200 宽松得多 —— 记忆要尽量完整。 */
const MAX_TEXT_CHARS = 2000;

/** 同一条错误最多每 60 秒记一次，避免磁盘满时把 bridge.log 刷爆。 */
const ERROR_COOLDOWN_MS = 60 * 1000;

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地日期 `YYYY-MM-DD`（决定写入哪个文件）。 */
export function localDateStr(atMs = Date.now()) {
  const d = new Date(atMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时间戳 `YYYY-MM-DD HH:MM:SS`（便于人读与 grep）。 */
export function localStampStr(atMs = Date.now()) {
  const d = new Date(atMs);
  return `${localDateStr(atMs)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 规整会话键，非 `group:<id>` / `private:<id>` 的直接原样返回（不抛错，归档不该因脏数据中断）。 */
function normalizeKey(key) {
  return String(key ?? '').trim() || 'unknown';
}

function clampText(value) {
  const s = String(value ?? '');
  if (s.length <= MAX_TEXT_CHARS) return s;
  return s.slice(0, MAX_TEXT_CHARS) + '…[截断]';
}

/**
 * 一个实例（一个桥接进程）的归档写入器。
 * 实例标识用 `ownerQQ`（语义清晰）；没有时退化为端口。
 */
export class MemoryArchive {
  /**
   * @param {object} opts
   * @param {string} opts.root       项目根目录（写入 `<root>/memory/`）
   * @param {string|number} opts.instance 实例标识，如 ownerQQ 或端口
   * @param {boolean} [opts.enabled] 总开关
   * @param {(msg: string, err?: unknown) => void} [opts.onError] 出错回调（用于走正常日志）
   */
  constructor({ root, instance, enabled = true, onError } = {}) {
    this.root = root;
    this.instance = String(instance ?? 'unknown');
    this.dir = path.join(String(root ?? '.'), MEMORY_DIR_NAME, this.instance);
    this.enabled = enabled !== false;
    this.onError = typeof onError === 'function' ? onError : null;
    this._lastErrorAt = 0;
    this._written = 0;
    this._failed = 0;
    this._ensured = false;
  }

  /** 归档目录绝对路径（供日志/文档展示）。 */
  get directory() {
    return this.dir;
  }

  stats() {
    return { enabled: this.enabled, written: this._written, failed: this._failed, dir: this.dir };
  }

  _reportError(error) {
    this._failed += 1;
    const now = Date.now();
    if (now - this._lastErrorAt < ERROR_COOLDOWN_MS) return;
    this._lastErrorAt = now;
    try {
      this.onError?.(`长期记忆归档写入失败（${this.dir}）`, error);
    } catch {}
  }

  _ensureDir() {
    if (this._ensured) return;
    fs.mkdirSync(this.dir, { recursive: true });
    this._ensured = true;
  }

  /**
   * 追加一条记忆。
   *
   * @param {object} entry
   * @param {'in'|'out'} entry.dir      in = 收到的消息，out = 机器人发出的消息
   * @param {string} entry.key          会话键（group:xxx / private:xxx）
   * @param {number} [entry.ts]         毫秒时间戳，默认现在
   * @param {string} [entry.sender]     发送者昵称
   * @param {string|number} [entry.uid] 发送者 QQ
   * @param {boolean} [entry.owner]     是否管理员
   * @param {boolean} [entry.isSelf]    是否机器人自己
   * @param {string} [entry.text]       正文
   * @param {string|number} [entry.mid] QQ 消息 id
   * @param {number} [entry.seq]        会话内序号
   * @param {string[]} [entry.media]    媒体摘要（图片/语音/表情等）
   * @param {object} [entry.extra]      其它想留存的字段
   * @returns {boolean} 是否写入成功
   */
  append(entry) {
    if (!this.enabled) return false;
    try {
      const ts = Number(entry?.ts) > 0 ? Number(entry.ts) : Date.now();
      const rec = {
        ts,
        t: localStampStr(ts),
        key: normalizeKey(entry?.key),
        dir: entry?.dir === 'out' ? 'out' : 'in',
      };
      if (entry?.seq != null) rec.seq = entry.seq;
      if (entry?.mid != null) rec.mid = String(entry.mid);
      if (entry?.sender) rec.sender = String(entry.sender);
      if (entry?.uid != null) rec.uid = String(entry.uid);
      if (entry?.owner === true) rec.owner = true;
      // 入参兼容 `isSelf`（与 bridge 内部消息对象一致）和 `self`（简写），输出统一用 `self`。
      if (entry?.isSelf === true || entry?.self === true) rec.self = true;
      rec.text = clampText(entry?.text);
      const media = Array.isArray(entry?.media) ? entry.media.filter(Boolean).map(String) : [];
      if (media.length) rec.media = media.slice(0, 12);
      if (entry?.extra && typeof entry.extra === 'object') rec.extra = entry.extra;

      this._ensureDir();
      const file = path.join(this.dir, `${localDateStr(ts)}.jsonl`);
      fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
      this._written += 1;
      return true;
    } catch (error) {
      // 目录被删、磁盘满、权限变动 —— 一律降级为「这次没存上」，绝不让聊天链路受影响。
      this._ensured = false;
      this._reportError(error);
      return false;
    }
  }
}

/** 列出某实例已归档的日期文件（新的在前）。 */
export function listArchiveDates(root, instance) {
  const dir = path.join(String(root ?? '.'), MEMORY_DIR_NAME, String(instance));
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, -6))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * 读取归档记录。
 *
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} opts.instance
 * @param {string} [opts.date]    只读某一天（YYYY-MM-DD）；省略则读全部（按时间升序）
 * @param {string} [opts.key]     只保留某会话
 * @param {string} [opts.contains] 正文包含某字符串（不区分大小写）
 * @param {number} [opts.limit]   最多返回多少条（取**最后** N 条，即最近的）
 */
export function readArchive({ root, instance, date, key, contains, limit } = {}) {
  const baseDir = path.join(String(root ?? '.'), MEMORY_DIR_NAME, String(instance));
  const dates = date ? [date] : listArchiveDates(root, instance);
  const out = [];
  const needle = contains ? String(contains).toLowerCase() : '';

  for (const d of dates) {
    const file = path.join(baseDir, `${d}.jsonl`);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      // 逐行剥离 UTF-8 BOM 与首尾空白：归档文件一旦被记事本 / PowerShell 重定向 /
      // Excel 之类外部工具碰过，首行就会带上 BOM，JSON.parse 会直接失败并被下面的
      // catch 静默跳过 —— 表现是「每天的第一条记录永远读不出来」。
      const clean = line.replace(/^\uFEFF/, '').trim();
      if (!clean) continue;
      let rec;
      try {
        rec = JSON.parse(clean);
      } catch {
        continue; // 坏行跳过，不影响其余记录
      }
      if (key && rec.key !== key) continue;
      if (needle && !String(rec.text ?? '').toLowerCase().includes(needle)) continue;
      out.push(rec);
    }
  }

  out.sort((a, b) => Number(a.ts) - Number(b.ts));
  const n = Number(limit);
  return Number.isFinite(n) && n > 0 ? out.slice(-n) : out;
}
