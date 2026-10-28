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
  ⚠️ 拉起 DSH 时会带 `DSH_PERMISSION_MODE=danger-full-access` —— 这是 `dsh-base`
  自己读的部署级开关，决定 `sandbox-policy.mode` 与 `approval.policy`（`never`）。
  去掉它，进程级默认就退回 `workspace-write` + `ask`，旧会话会重新弹出逐次审批。

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

### 人格 / 自我演变
- **`pin-role.mjs`** — 按实例钉人格：`--b1=姐姐 --b2=妹妹 --no-random`。
- **`seed-growth.mjs`** — 把策划好的成长记录灌进去（带权重，幂等）。`--apply` 才写，`--reset` 先清空。
- **`verify-growth.mjs`** — 导出权重报告 + 渲染后的注入文本（写 UTF-8 文件，终端中文不可信）。
- **`probe-growth.mjs`** — 自检「自我演变」是否真的接进唤醒提示词（写测试记录→查 7 个标记→删掉）。
- **`inspect-memory.mjs`** — 只读巡检话题/印象/感情值/演变。`--json` 另存快照。
- **`backdate-growth.mjs`** — 把某条记录的时间改到 N 天前，验证时间衰减（**必须在桥接停止时跑**）。
- **`cleanup-growth-test.mjs`** — 删除含指定关键字的测试记录（走 HTTP，不用停桥接）。
- **`dump-prompt.mjs`** — 把 `/api/socialV2/prompt` 的返回结构打清楚（调试字段用）。
- **`dump-recent.mjs`** / **`dump-dialogue.mjs`** — 导出最近消息 / 长期归档，便于人工整理记忆。

### 音频
- **`check-voice.mjs`** — **最常用**：一条命令确认「机器人现在能不能正常发语音」。
  只读查 `tts-status` + 语音库；加 `--send` 会真发一条到管理员私聊（不打扰群）。
- **`install-audio.mjs`** — 二进制安全地把 `voice-samples/persona/` 里的样本装进两个 `audio/`（sha256 校验）。
- **`verify-voice.mjs`** — ffprobe 比对源样本 / 两处副本 / 归档原件的时长与编码。
- **`prep-voice.mjs`** — 处理 `voice-samples/own/raw/` 的自录录音并装进 `audio/`（裁首尾静音 + loudnorm）。

### QQ 空间说说
- **`check-qzone.mjs`** — 端到端验证发说说通道：经桥接发一条「仅自己可见」→ 查配额 →
  再发一条验证拦截 → 删掉说说 → 抹掉本地配额记录（不留痕迹）。`--keep` 保留那条。
- **`check-qzone-daily.mjs`** — 验证「每日下限字段 + 发完通知 owner」这条链路：
  查 `minPerDay`/`ensureDaily` → 发一条 → 等 3 秒看日志里有没有「已把发表结果私聊告知」→ 清理。
- **`check-qzone-agent.mjs`** — 验证**模型侧调用路径**：缺 token 应 403、带 token 应 200。
  这是抓「工具能注册但一调就未授权」那类 bug 的脚本。
- **`check-qzone-interact.mjs`** — 验证「小黑看大肥鱼空间 + 点赞」这条通道，四件事一次跑完：
  缺 token 被拒 → 带 token 能读 feed → 能点赞且服务端读回 `isLiked=true` → 重复赞幂等。
  **默认测完还原**（取消赞 + 清空 `qzone-likes.json`）—— 点赞是公开动作，运维脚本不该在
  别人空间留痕迹；`--keep` 保留那条。
- **`check-qzone-comment.mjs`** — 验证「回复TA的说说」这条通道。**默认只读**，因为上游
  **没有删除评论的接口**（评论不可撤回，是本仓库唯一不可逆的对外动作）：
  缺 token 被拒 → 能读待回复清单 → 对已回复过的再说一次应返回 `alreadyCommented` 且不重发。
  想真发一条得显式加 `--post`。
- **`qzone-probe.mjs`** — 探测某个 `ugc_right` 的真实权限（发→读回→立刻删），
  用来看 `is_private` 判断 1/4/64 分别是什么。`--list` 只读不发。

### MCP 工具审计
- **`list-mcp-tools.mjs`** — 绕过 DSH 直接和 `src/mcp-snowluma-safe.js` 走 JSON-RPC 握手，
  列出它**实际注册**的工具名。用于回答「这个工具到底有没有注册」，
  和「模型能不能调」是两件事（后者看 `state/tool-calls.jsonl` 的 result 行）。

### 画图
- **`check-draw.mjs`** — 验证「文字生成图片」这条通道。默认**只读**（配置/内容闸门/工具清单/
  缺 token 被拒）；`--gen` 多跑一步真生成但不发；`--send` 才经桥接真发到管理员私聊
  （不发群，避免打扰）。
- **`check-draw-throttle.mjs`** — 验证**免费档限速的跨进程排队**：同时发 2 个画图请求，
  期望两个都成功（第二个排队等约 45 秒）且**没有 402**。免费档是「每出口 IP 每 45 秒 1 张」，
  两个机器人共用一个 IP，所以排期必须走共享文件 `<repo>/.cache/image-gen.slot`。
- **`check-draw-provider.mjs`** — 换供应商时用它：打印当前 `imageGen` 配置、指出缺哪个凭据
  （`apiKey` / `accountId`），加 `--run` 则用你填的 key **真生成一张**并把结果存成
  `ops/_prov-<provider>.jpg`（可以直接打开看有没有角标）。我不可能替你验证只有你才有的 key，
  所以给你一条命令自己验。

### 环境 / 杂项
- **`fix-low-integrity.cmd`** — 把 SnowLuma 目录的完整性级别从 Low 改回 Medium（需管理员）。
- **`gen-voice-samples.py`** — 生成 edge-tts 中文音色对比样本，输出到 `voice-samples/edge/`。
  配套输入：`voice-sample-text.txt`（必须与脚本同目录）。

## 注意

- **PowerShell 5.1 会把无 BOM 的 `.ps1` 当 ANSI 读**，中文会变成「字符串缺少终止符」。
  所以 `reset-stack.ps1` / `stop-loops.ps1` 一律只写 ASCII；需要中文的脚本请用 `.mjs`。
- 脚本里的项目根大多靠 `import.meta.url` / `__file__` 退一级算出来，
  搬动文件前先确认那条路径推导，别只看硬编码的 `D:\QQbot`。
