// 把 ops/vscode-extension/open-console 装进 VS Code 的扩展目录。
//
// 为什么不用 .vsix：本地小扩展没必要打包，VS Code 会直接加载扩展目录里的**文件夹**
// （`--install-extension` 装出来的其实也是解包后的文件夹）。
//
// 用法：
//   node ops\install-vscode-extension.mjs           安装 / 更新
//   node ops\install-vscode-extension.mjs --check   只看状态，不改文件
//   node ops\install-vscode-extension.mjs --remove  卸载
//
// 装完要**重载 VS Code 窗口**（Ctrl+Shift+P → Reload Window）才会加载新扩展。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SRC = path.join(ROOT, 'ops', 'vscode-extension', 'open-console');

const check = process.argv.includes('--check');
const remove = process.argv.includes('--remove');

// VS Code 的扩展目录：Windows 在 %USERPROFILE%\.vscode\extensions。
// 也考虑便携版（在 VS Code 安装目录下 data\extensions），存在就优先用便携版。
function extensionsDirs() {
  const dirs = [];
  const portable = path.join(process.env.LOCALAPPDATA ?? '', '..', '');
  void portable;
  const candidates = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft VS Code', 'data', 'extensions'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft VS Code', 'data', 'extensions'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) dirs.push(c);
  }
  return dirs;
}

const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
const folderName = `${pkg.publisher}.${pkg.name}-${pkg.version}`;

const dirs = extensionsDirs();
if (!dirs.length) {
  console.error('找不到 VS Code 扩展目录（预期 %USERPROFILE%\\.vscode\\extensions）');
  process.exit(1);
}

const target = path.join(dirs[0], folderName);

if (check) {
  console.log(`扩展目录: ${dirs[0]}`);
  console.log(`目标位置: ${target}`);
  console.log(`已安装: ${fs.existsSync(target) ? '是' : '否'}`);
  if (fs.existsSync(target)) {
    const installed = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    console.log(`已安装版本: ${installed.version}`);
  }
  process.exit(0);
}

if (remove) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`已卸载 ${folderName}`);
  } else {
    console.log('没有安装，无需卸载');
  }
  process.exit(0);
}

// 安装：先删旧目录（版本号变了目录名也会变，所以顺带清掉同名的旧版本）
for (const dir of dirs) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { continue; }
  for (const name of entries) {
    if (name.startsWith(`${pkg.publisher}.${pkg.name}-`) && name !== folderName) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      console.log(`已移除旧版本 ${name}`);
    }
  }
}

fs.mkdirSync(target, { recursive: true });
for (const file of ['package.json', 'extension.js']) {
  fs.copyFileSync(path.join(SRC, file), path.join(target, file));
  console.log(`已复制 ${file}`);
}

console.log(`\n已安装到 ${target}`);
console.log('⚠ 需要重载 VS Code 窗口才会加载：Ctrl+Shift+P → "Reload Window"');
console.log('  （之后 `node ops/stack-control.mjs start` 就会用 VS Code 内置浏览器打开 5110）');
