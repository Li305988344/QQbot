// QQBot 总控制台 —— 在 VS Code 内置的 Simple Browser 里打开统一切换页。
//
// 为什么需要这个扩展：
//   VS Code 的编辑器「内置浏览器」不是 URI scheme，也不能从命令行直接调；
//   只有扩展 API 能执行 `simpleBrowser.show`。所以启动脚本没法直接让 VS Code 开页面。
//
// 怎么和外部脚本通信（不引入任何依赖）：
//   `node ops/stack-control.mjs start` 会往 ops/.open-console.request 写一个 id，
//   本扩展轮询这个文件，发现 id 变了就开页面，然后把同一个 id 写进 ops/.open-console.ack。
//   脚本等 ack 超时（默认 1.6 秒）就退回系统默认浏览器 —— 这样不开 VS Code 时行为不变。

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const CONSOLE_URL = 'http://127.0.0.1:5110/';
const POLL_MS = 400;

let timer = null;
let lastSeenId = '';

function repoRoot() {
  // 触发文件放在 <repo>/ops/ 下，所以以工作区第一个文件夹为仓库根。
  // 找不到工作区时（例如空窗口）就不轮询，命令仍然可用。
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return null;
  return folders[0].uri.fsPath;
}

function readTrim(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function writeTrim(file, text) {
  try {
    fs.writeFileSync(file, text, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 打开总控制台。
 *
 * `simpleBrowser.show` 的行为：已有同名标签就复用（reuse），否则新开一个。
 * 传 URL 时会记住最后一次地址，所以重复调用不会叠出一堆面板。
 */
async function openConsole(url = CONSOLE_URL) {
  try {
    await vscode.commands.executeCommand('simpleBrowser.show', url);
    return true;
  } catch (error) {
    // 少数版本（或个别策略配置下）Simple Browser 不可用，明确报出来而不是静默失败。
    vscode.window.showErrorMessage(`打不开 VS Code 内置浏览器：${error?.message ?? error}`);
    return false;
  }
}

function startWatching(context) {
  const root = repoRoot();
  if (!root) return;

  const opsDir = path.join(root, 'ops');
  const reqFile = path.join(opsDir, '.open-console.request');
  const ackFile = path.join(opsDir, '.open-console.ack');

  // 启动时记住现有的 id：避免 VS Code 重载后把上一次的旧请求又执行一遍。
  lastSeenId = readTrim(reqFile);

  timer = setInterval(() => {
    const id = readTrim(reqFile);
    if (!id || id === lastSeenId) return;
    lastSeenId = id;
    openConsole().then((ok) => {
      // 只有真的开成功才回 ack，否则脚本会以为 VS Code 接管了、不退回浏览器。
      writeTrim(ackFile, ok ? id : '');
    });
  }, POLL_MS);

  context.subscriptions.push({ dispose: () => { if (timer) clearInterval(timer); } });
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('qqbot.openConsole', () => openConsole())
  );
  startWatching(context);
}

function deactivate() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { activate, deactivate };
