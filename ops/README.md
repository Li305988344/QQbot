# ops/ — 运维脚本

根目录只保留两个用户入口：`start-all.bat` / `stop-all.bat`。
其余所有运维脚本都收在这里，免得根目录堆一堆散装单文件。

## 常用

| 想做什么 | 命令（在项目根执行） |
|---|---|
| 一键启动 / 停止整套服务 | 双击 `start-all.bat` / `stop-all.bat` |
| 看各端口状态 | `node ops/stack-control.mjs status` |
| 查长期记忆 | `node ops/memory-query.mjs --date 2026-10-27` |
| 强制重置栈 | `node ops/reset-stack.mjs` |
| 只起一个桥接 | `node ops/start-bridge-once.mjs` |
| 清掉残留的 start.bat 循环 / 桥接 | `powershell -File ops/stop-loops.ps1` |

## 文件说明

### 主控
- **`stack-control.mjs`** — 唯一的启动/停止/状态实现。`start-all.bat`、`stop-all.bat`
  都只是它的壳。启动顺序：SnowLuma → DSH 引擎 → 桥接 ×2 → 统一切换页。
  ⚠️ 它用 `import.meta.url` 退一级定位项目根，**不能挪到更深的地方**。

### 服务
- **`console-switch-server.mjs`** — 5110 统一切换页（`/bridge/`→3100、`/bridge2/`→3200、`/snow/`→5099）。
- **`console-switch.html`** — 上面那个服务的页面（必须与 `.mjs` 同目录）。

### 救急 / 重置
- **`reset-stack.mjs`** — 杀掉残留 + 起 DSH（3080）+ 起一个桥接，然后打印端口。
- **`reset-stack.ps1`** — 同上的 PowerShell 版（纯 ASCII，PowerShell 5.1 不会把中文解成乱码）。
- **`start-bridge-once.mjs`** — 独占 3100：先杀掉占用者，再起一个桥接。
- **`stop-loops.ps1`** — 只杀 `start.bat` 循环与 `bridge.js` 进程，不动其它 node。
- **`ensure-dsh.mjs`** — 单独确认/拉起 3080 上的 DSH 引擎。当前没有任何地方调用它
  （`stack-control.mjs` 与 `qq-bridge-01/ensure-dsh.ps1` 各自都做了这件事），留着当独立工具。

### 工具 / 诊断
- **`memory-query.mjs`** — 查 `memory/<机器人QQ>/<日期>.jsonl` 长期记忆归档。
  `--all` / `--date` / `--key` / `--grep` / `--limit` / `--json`，详见 `memory/README.md`。
- **`check-dsh-permissions.mjs`** — 按修改时间列出最近的 DSH 会话及其权限预设（排查「Allow once」类问题用）。

### 环境 / 杂项
- **`fix-low-integrity.cmd`** — 把 SnowLuma 目录的完整性级别从 Low 改回 Medium（需管理员）。
- **`gen-voice-samples.py`** — 生成 edge-tts 中文音色对比样本，输出到根目录 `voice-samples-edge/`。
  配套输入：`voice-sample-text.txt`（必须与脚本同目录）。

## 注意

- **PowerShell 5.1 会把无 BOM 的 `.ps1` 当 ANSI 读**，中文会变成「字符串缺少终止符」。
  所以 `reset-stack.ps1` / `stop-loops.ps1` 一律只写 ASCII；需要中文的脚本请用 `.mjs`。
- 脚本里的项目根大多靠 `import.meta.url` / `__file__` 退一级算出来，
  搬动文件前先确认那条路径推导，别只看硬编码的 `D:\QQbot`。
