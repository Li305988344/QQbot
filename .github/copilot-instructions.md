# 本仓库的 AI 助手约定

## 不要使用 `create_and_run_task` 工具

VS Code 把 `create_and_run_task` 硬编码为**永不自动批准**（源码证据）：

```js
dwo = new Set(["create_and_run_task"])
// shouldAutoConfirm() 里：
if (!u || dwo.has(u.data.id)) return;      // 直接返回，不自动确认
// 该工具自身的定义里：
confirmationMessages: { ..., allowAutoConfirm: false }
```

连 `chat.tools.global.autoApprove` / `chat.tools.terminal.autoApprove` 都无法覆盖它，
所以每次调用都会弹「Allow once」，非常打扰。

### 替代做法

需要跑命令时，**直接在终端执行**即可，这些走自动批准：

- 跑一次性命令 → 直接给终端命令（`cmd /c ...` 或 PowerShell 单行）
- 跑项目里已有的任务 → 用「运行已存在的任务」，不要「新建任务」
- 需要长期后台进程 → 用后台终端

同理，以下工具也永远需要人工点确认，尽量避免：

- `vscode_get_confirmation_with_options`
- `vscode_get_modified_files_confirmation`

## 本机命令注意事项

- **不要**在命令里写中文（PowerShell 5.1 经 cmd 层会解析失败），脚本里也不要
- 不要用 `node -e "..."` 内联脚本（引号会被剥掉），改成写 `.mjs` 文件再执行
- 不要用 `>` 重定向接 Node 输出（会写成 UTF-16LE）
- git 只能用绝对路径 `D:\github\bin\git.exe`
