// 定位「DSH 的安装位置」—— 供仓库脚本加载 / 扫描 DSH 自身的模块做校验。
//
// 本项目真正运行的 DSH 是 `deepseek_harness`（Electron 分发版），它的包全部在
// `resources/app.asar` 归档里，磁盘上没有散开的 node_modules。所以解析顺序是：
//   1. 环境变量 DSH_INSTALL_MODULES / DSH_MODULES（指向散开的 <DSH>/node_modules）
//   2. 仓库内 Electron 分发版的 app.asar（**真实运行时**，见 ASAR_RELATIVE_CANDIDATES）
//   3. 仓库内便携版散装安装（见 PORTABLE_RELATIVE_CANDIDATES）
//   4. 从 $DSH_HOME/profiles/<profile>/package.json 用 Node 模块解析反查
// 全部失败时抛出带指引的错误，不做任何写死路径的回退 —— 宁可显式报错，也不要静默用错版本。
//
// 历史坑：这里曾经把 `dsh-engine/` 排在候选第一位（理由只是"它有 300+ 个包更完整"）。
// 实测那是 `@deepseek-ai/dsh@0.2.1-rc.2` 的旧副本（583 MB / 61020 文件），
// 而 3080 端口上真正服务的是 harness 里的 **rc.3** —— stack-control 的 startDshEngine()
// 只在 harness 的 dsh.cmd 不存在时才会去启它，所以那份副本从未被启动过。
// 对着一个没运行的旧版本做工具名对账，是比"找不到"更危险的假绿，因此已删除该候选。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { openAsar } from './asar-read.mjs';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 仓库根目录（scripts/ 的上一级）
function repoRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  } catch {
    return '';
  }
}

// Electron 分发版的 asar 归档（相对仓库根）。归档内包路径为
// `dsh/node_modules/@deepseek-ai/<pkg>/…`。
const ASAR_RELATIVE_CANDIDATES = [
  'deepseek_harness/resources/app.asar',
];

// 散装（非 asar）安装位置（相对仓库根）。
const PORTABLE_RELATIVE_CANDIDATES = [
  'deepseek_harness/resources/app.asar.unpacked/dsh/node_modules',
  'deepseek_harness/resources/dsh/node_modules',
  'deepseek_harness/resources/app.asar.unpacked/node_modules',
];

// 这些脚本需要加载的包，任意一个能解析成功即可反推出 node_modules 位置。
const PROBE_SPECIFIERS = ['@deepseek-ai/dsh-persona', 'js-yaml'];

/** 仓库内 Electron 分发版的 app.asar 路径；不存在返回 ''。 */
export function dshAsarFile() {
  const root = repoRoot();
  if (!root) return '';
  for (const rel of ASAR_RELATIVE_CANDIDATES) {
    const file = path.join(root, rel);
    try {
      if (fs.statSync(file).isFile() && fs.statSync(file).size > 1024) return file;
    } catch { /* 换下一个 */ }
  }
  return '';
}

// 目录里真的有 DSH 的**工具包**才算命中。只看 `@deepseek-ai` 目录存在是不够的：
// Electron 的 app.asar.unpacked 里也会有一个只装了少量原生依赖的 `@deepseek-ai`，
// 扫描它得到 0 个工具名，会让「防拼错假名」那条断言静默走跳过分支（等于没测）。
function looksLikeDshModules(dir) {
  if (!dir) return false;
  let names = [];
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    names = fs.readdirSync(path.join(dir, '@deepseek-ai'));
  } catch {
    return false;
  }
  if (!names.some((n) => /^dsh-tool/.test(n))) return false;
  return PROBE_SPECIFIERS.some((spec) => fs.existsSync(path.join(dir, spec)))
    || names.some((n) => n === 'dsh-persona' || n === 'dsh-agent');
}

function findNodeModules(resolvedFile) {
  let dir = path.dirname(resolvedFile);
  for (;;) {
    if (path.basename(dir) === 'node_modules') return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function candidateProfiles(home) {
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  add(process.env.DSH_PROFILE);
  add('web');
  add('default');
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) add(e.name);
    }
  } catch { /* profiles 目录不存在时忽略 */ }
  return names;
}

export function dshModulesDir() {
  const override = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (override) return override;

  // 2) 仓库内散装安装
  const root = repoRoot();
  if (root) {
    for (const rel of PORTABLE_RELATIVE_CANDIDATES) {
      const dir = path.join(root, rel);
      if (looksLikeDshModules(dir)) return dir;
    }
  }

  // 3) 从 profile 反查
  const home = dshHome();
  for (const profile of candidateProfiles(home)) {
    const anchor = path.join(home, 'profiles', profile, 'package.json');
    if (!fs.existsSync(anchor)) continue;
    const req = createRequire(anchor);
    for (const spec of PROBE_SPECIFIERS) {
      try {
        const dir = findNodeModules(req.resolve(spec));
        if (dir) return dir;
      } catch { /* 换下一个 specifier，再换下一个 profile */ }
    }
  }

  // 4) 只有 Electron 分发版时：从 app.asar 抽出**最小闭包**到缓存目录。
  //    为什么需要：verify-persona-config / verify-dsh-021-adaptation / test-setup-dsh-idempotent
  //    这三个脚本要 import 磁盘上的 `@deepseek-ai/dsh-persona` 与 `js-yaml`，而 asar 归档
  //    里的文件不是散开的。抽出最小闭包（几 MB）比解整棵树（583 MB）或保留旧副本划算得多。
  const asar = dshAsarFile();
  if (asar) {
    const dir = extractMinimalDshModules(asar);
    if (dir) return dir;
  }

  throw new Error(
    '无法定位 DSH 安装目录下的 node_modules。\n'
    + '  请设置 DSH_INSTALL_MODULES=<DSH 安装目录>/node_modules 后重试；\n'
    + (asar
      ? `  已检测到 Electron 分发版归档 ${asar}，但最小闭包抽取失败；\n`
      : '  或确认 Electron 分发版在 <repo>/deepseek_harness/resources/app.asar；\n')
    + `  或设置 DSH_HOME 指向 DSH 根目录（当前解析为 ${home}）。`
  );
}

// ── asar 最小闭包抽取 ───────────────────────────────────────────────────────
//
// 只抽「这些脚本真正 import 的东西」：js-yaml + @deepseek-ai/dsh-persona 及其
// dependencies/peerDependencies 的传递闭包。有上限，超了就放弃（宁可用显式 env
// 覆盖，也不要在缓存目录里堆出第二个 583 MB）。

const EXTRACT_ROOTS = ['js-yaml', '@deepseek-ai/dsh-persona'];
const EXTRACT_MAX_PACKAGES = 60;
const EXTRACT_MAX_FILES = 4000;
const EXTRACT_MAX_BYTES = 40 * 1024 * 1024;

function extractMinimalDshModules(asarFile) {
  let st;
  try {
    st = fs.statSync(asarFile);
  } catch {
    return '';
  }
  // 缓存键带上归档大小与 mtime：harness 升级后自动换目录，不会拿旧版本冒充新版本。
  const key = `${st.size}-${Math.round(st.mtimeMs)}`;
  const cacheRoot = path.join(os.tmpdir(), 'qq-bridge-dsh-modules', key);
  const modulesDir = path.join(cacheRoot, 'node_modules');
  const readyMark = path.join(cacheRoot, '.ready');
  if (fs.existsSync(readyMark)) return modulesDir;

  let asar;
  try {
    asar = openAsar(asarFile);
  } catch {
    return '';
  }
  if (!asar) return '';

  // 归档内包前缀（形如 `dsh/node_modules/`），用 dsh-persona 的位置反推。
  const anchor = asar.entries.find((e) => /@deepseek-ai\/dsh-persona\/package\.json$/.test(e.path));
  if (!anchor) return '';
  const prefix = anchor.path.slice(0, anchor.path.indexOf('@deepseek-ai/'));

  const queue = [...EXTRACT_ROOTS];
  const seen = new Set();
  let files = 0;
  let bytes = 0;

  try {
    while (queue.length > 0) {
      if (seen.size >= EXTRACT_MAX_PACKAGES) return '';
      const spec = queue.shift();
      if (seen.has(spec)) continue;
      seen.add(spec);

      const pkgJsonPath = `${prefix}${spec}/package.json`;
      const raw = asar.read(pkgJsonPath);
      if (!raw) continue; // peer 没装：跳过（import 时若真缺会自然报错）
      let pkg;
      try {
        pkg = JSON.parse(raw);
      } catch {
        continue;
      }

      for (const entry of asar.list(`${prefix}${spec}/`)) {
        files += 1;
        bytes += entry.size;
        if (files > EXTRACT_MAX_FILES || bytes > EXTRACT_MAX_BYTES) return '';
        const rel = entry.path.slice(`${prefix}${spec}/`.length);
        const dest = path.join(modulesDir, spec, rel);
        const content = asar.read(entry.path);
        if (content === null) continue; // 超大文件（源码不会有）
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
      }

      for (const dep of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) })) {
        if (!seen.has(dep)) queue.push(dep);
      }
    }
    fs.writeFileSync(readyMark, `${new Date().toISOString()}\n`, 'utf8');
    return modulesDir;
  } catch {
    return '';
  }
}
