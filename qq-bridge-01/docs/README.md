# 文档索引（qq-bridge-01/docs/README.md）

> **本目录属于上游项目（qq-bridge）的文档子集**，随本机部署一并收录。
> 本机**实际怎么跑**请看仓库根的 [`../../README.md`](../../README.md)；
> 每日操作、原理、排错分别在 `../../docs/` 下的三份运维文档里
> （`启动清单.md` / `QQBot运行手册.md` / `问题处理一览.md`）。

---

## 本目录实际有什么

```
qq-bridge-01/
├── README.md            上游项目中文说明（含本机适配说明）
├── README.en.md         上游项目英文说明
├── RULES.md             QQ 会话的权限边界与安全承诺
├── LICENSE              MIT
└── docs/
    ├── README.md        ← 本文件
    ├── FOLDER_MAP.md    目录结构与 scripts/ 命名约定
    └── guides/          7 份面向使用/运维的指南
```

---

## guides/ —— 面向使用者 / 运维

| 文档 | 一句话说明 |
| --- | --- |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 端安装说明：把 `qq-chat` / `qq-chat-v2` preset 与三个 MCP server 挂到目标设备的 DSH 上（本机等价于在 `qq-bridge-01` 下跑 `node scripts/setup-dsh.mjs`） |
| [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) | **DSH 0.2.1 适配记录**：两处真实断裂（`{{cwd}}` 变量被删导致每回合直接失败、`working_directory` 进全局层），以及协议面零漂移的实测结论 |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | **DSH 0.2.0 适配记录**：逐条列出为适配 0.2.0-rc.2 做的改动（现象 / 为什么必须改 / 证据 / 怎么验证）。升级 DSH 前先读 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | **安全基线与威胁模型**：已实现的边界、已知残余风险、发布前回归清单。改安全相关代码前必读 |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：数据来源、计价口径（峰谷分时）、API、配置 |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览（`npm run preview:console`）与离线浏览器回归（`npm run test:console-ui`）怎么用 |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 发布前隐私检查清单：哪些文件含令牌/真实账号、推送前要清什么 |

## 其它

| 文档 | 一句话说明 |
| --- | --- |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 目录结构与 `scripts/` 命名约定（本文写作时包含上游的 `design/` `research/` `audits/` `legacy/` 四目录，**本部署未引入**） |
| [../RULES.md](../RULES.md) | QQ 会话的权限边界与安全承诺（面向使用者） |
| [../README.md](../README.md) | 上游项目完整说明（含本机适配备注） |

---

## 上游有、本部署**没有**的（链接会读不到，属正常）

上游 `qq-bridge` 仓库还包含以下几组文档，**未随本机部署引入**。若某天需要，从上游仓库取：

| 上游目录 / 文件 | 内容 |
| --- | --- |
| `docs/guides/PROJECT_GUIDE.md` | 上游的权威项目说明书（约 113 KB / 1450+ 行） |
| `docs/guides/VOICE.md` | 语音发送全解的详细版（本项目语音规则已内联在 `../RULES.md` 第 4 条） |
| `docs/design/` | 设计与规划文档（`GEN2_SIMULATION_PLAN` / `SOCIAL_MODE_PLAN` / `DSH_QQ_TOOLS_PLAN` …） |
| `docs/research/` | 调研记录（SnowLuma 功能、QQ 免打扰、表情包能力、本地模型选型 …） |
| `docs/audits/` | 审查 / 体检 / 优化报告（按时间读，越新越权威） |
| `docs/legacy/` | 历史归档（**不要照着做**，留作背景与追溯） |
| 同级 `voice-tool/` | 独立的「发语音」命令行 + 图形界面工具（复用本仓库 `src/voice-core.js`） |

> `qq-bridge-01/.gitignore` 里仍留着上游「不公开这些文档」的忽略规则
> （`docs/audits/` `docs/design/` `docs/legacy/` `docs/research/` 等）——本部署根本没复制
> 那些目录，所以这些规则目前是空转的。

---

## 想找什么 → 去哪看

| 我想…… | 看这个 |
| --- | --- |
| **在本机把机器人跑起来** | [`../../README.md`](../../README.md) |
| **每天开机 / 重启的操作清单** | `../../docs/启动清单.md` |
| **搞懂整体原理、数据流、配置项** | `../../docs/QQBot运行手册.md` |
| **遇到具体报错** | `../../docs/问题处理一览.md` |
| **`ops/` 里那堆脚本各自干什么** | [`../../ops/README.md`](../../ops/README.md) |
| **查聊天记录归档** | [`../../memory/README.md`](../../memory/README.md) |
| 在新设备上把桥接接进 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 升级 DSH 前先了解有哪些坑 | [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md)、[guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) |
| 动安全相关代码 / 发布前检查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |
| 看 AI 烧了多少钱 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 权限边界与安全承诺 | [../RULES.md](../RULES.md) |
| 某个目录 / 脚本是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |
