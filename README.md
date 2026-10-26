# QQ Bot — QQ ↔ DeepSeek Harness 桥接

在本机把 **QQ 群/私聊** 接给 **DeepSeek Harness（DSH）** 的 LLM agent 当聊天对象。
本仓库当前跑 **两个机器人**（下称「大肥鱼」和「小黑」），共用一个 DSH 引擎。

```
QQ 客户端 ──(hook DLL)──▶ SnowLuma ──(OneBot v11)──▶ qq-bridge ──(RPC)──▶ DeepSeek Harness
                                                        │
                                                        └──(控制台)──▶ 浏览器
```

> 本文只讲**怎么跑起来**。
> 原理与组件细节见 `docs/QQBot运行手册.md`，每天的开机步骤见 `docs/启动清单.md`，
> 已知故障对照表见 `docs/问题处理一览.md`，脚本清单见 `ops/README.md`。

---

## 快速开始（每天就这三步）

```
①  双击  start-all.bat
②  打开  http://127.0.0.1:5099/processes   →  给两个机器人各点一次「加载」
③  打开  http://127.0.0.1:5110/            →  控制台都在这里
```

**第 ② 步不能省。** `SnowLuma/config/runtime.json` 里是 `hookAutoLoad: false`，
SnowLuma **不会自动挂接 QQ**，必须手动点「加载」。不点的话 OneBot 端口永远不监听，
两个桥接会一直以 `code=1006` 重连（症状：`SnowLuma 连接断开` / `token 自愈失败`）。

点哪两个：**排除名单之外**的那两个机器人账号。
排除名单在 `SnowLuma/config/hook-exclude-uins.json`（里面列的是**日常号**，不是机器人，别点）。

---

## 前置条件

| 需要 | 说明 |
| --- | --- |
| **Node.js ≥ 22.13** | 本机实测 v24.15.0。`node -v` 自查（桥接 `engines` 字段要求 ≥22.13） |
| **QQ 客户端已登录** | SnowLuma 是注入进 QQ 进程工作的；两个机器人号都要在线 |
| **DSH 已登录** | 凭据在 `C:\Users\<你>\.dsh\.credentials.yaml`。没有则先在 DSH 里登录一次 |
| **两个桥接各有一份 `config.json`** | 见下节。它含令牌，**不进版本库** |

### 首次在新机器上要做的配置

仓库里**没有** `config.json`（被 `.gitignore` 排除，因为它含明文令牌）。从模板复制：

```powershell
cd D:\QQbot
Copy-Item qq-bridge-01\config.example.json  qq-bridge-01\config.json
Copy-Item qq-bridge-01\config.example.json  qq-bridge-02\config.json   # 两份都用①的模板
```

> ⚠️ 两份**都从 `qq-bridge-01` 的模板**复制，别用 `qq-bridge-02` 自己那份。
> 实测②的模板曾落后于①（缺 `memory`、`imageSearch`、`socialV2.{avatar,asr,video,tts}`），
> 用它复制出来的配置会少字段。模板已同步，但**以①为准**是更安全的习惯 ——
> 和 `src\*.js` 每次启动自动从①同步到②是同一个道理。

然后按实际环境改这几个字段（两份都要改，且**不能一样**）：

| 字段 | 实例① | 实例② | 含义 |
| --- | --- | --- | --- |
| `consolePort` | `3100` | `3200` | 各自的控制台端口 |
| `snowluma.wsUrl` | `ws://127.0.0.1:3001` | `ws://127.0.0.1:3011` | 各自的 OneBot WS |
| `snowluma.httpUrl` | `http://127.0.0.1:3000` | `http://127.0.0.1:3010` | 各自的 OneBot HTTP |
| `snowluma.homeDir` | SnowLuma 目录 | 同左 | 用来反查令牌与账号 |
| `ownerQQ` | 你的号 | 你的号 | **主人**（不是机器人号），两份相同 |
| `allow.groups` / `allow.private` | 群号 / 允许私聊的号 | 同左 | 白名单，空则默认全拒 |
| `dsh.baseUrl` | `http://127.0.0.1:3080` | 同左 | DSH 引擎固定地址 |

`snowluma.accessToken` 可以留空 —— 桥接启动时会自动从
`SnowLuma/config/onebot_<QQ>.json` 里发现并回写。

DSH 自己的模型/API Key 在 DSH 侧配（本机是 `deepseek-flash`），桥接只填 `dsh.baseUrl`。

---

## 目录结构

```
D:\QQbot\
├── start-all.bat / stop-all.bat    ← 仅有的两个入口，双击即可
├── ops\                            全部运维脚本（见 ops\README.md）
│   ├── stack-control.mjs            主控：start / stop / status
│   ├── memory-query.mjs             查长期记忆归档
│   ├── console-switch-server.mjs    5110 统一切换页
│   └── reset-stack.* / stop-loops.ps1 / …
├── qq-bridge-01\                   桥接实例①（大肥鱼，控制台 3100）
│   ├── src\bridge.js               主程序
│   ├── config.json                 ← 含令牌，不进版本库
│   ├── roles\                      人格卡（不进版本库）
│   └── state\                      运行态（不进版本库）
├── qq-bridge-02\                   桥接实例②（小黑，控制台 3200）
│   └── node_modules → qq-bridge-01\node_modules   ← 目录联接，依赖只装一份
├── SnowLuma\                       QQ 注入器（第三方发行版，含 QQ 消息库）
├── deepseek_harness\               DeepSeek Harness（Electron，DSH 引擎唯一来源）
├── memory\<机器人QQ>\<日期>.jsonl   长期聊天归档（不进版本库）
├── docs\                           运维文档（含真实账号，默认不进版本库）
└── voice-samples*\                 音量样本（一次性产出）
```

**两个桥接目录为什么不能合并**：桥接只支持**单个** OneBot 端点（`snowluma.wsUrl` 是单值），
所以多机器人 = 多份桥接目录 + 多组端口。`src\` 是各自一份拷贝，
`ops/stack-control.mjs start` 每次会把实例①的 `src\*.js` 同步到实例②。

> ⚠️ **不要**把实例②的 `src` 改成目录联接：`node src/bridge.js` 经联接会 realpath 到真实目录，
> `__dirname` 变成实例①的路径 ⇒ 两边抢同一个 `state/bridge.lock`，第二个实例直接退出。
> （`node_modules` 是联接是安全的，因为它不参与 `__dirname` 推导。）

---

## 端口一览

| 端口 | 谁 | 用途 |
| --- | --- | --- |
| **3000 / 3001** | SnowLuma | 实例①的 OneBot HTTP / WS |
| **3010 / 3011** | SnowLuma | 实例②的 OneBot HTTP / WS |
| **3080** | DSH 引擎 | 两个桥接共用（地址写死，不能改端口） |
| **3100** | qq-bridge-01 | 控制台 + API |
| **3200** | qq-bridge-02 | 控制台 + API |
| **5099** | SnowLuma | Web UI，**「加载」按钮在这里** |
| **5110** | 统一切换页 | 一个页面切三个控制台 |

---

## 命令行方式（不想双击）

都在项目根执行，PowerShell / cmd 都行：

```powershell
cd D:\QQbot

node ops\stack-control.mjs start            # 启动（幂等，已在跑的会跳过）
node ops\stack-control.mjs start --no-open  # 启动且不自动开浏览器
node ops\stack-control.mjs stop             # 停止
node ops\stack-control.mjs status           # 只看端口，不改任何东西
```

启动顺序是严格按依赖来的：
**SnowLuma → DSH(3080) → 桥接①(3100) → 桥接②(3200) → 切换页(5110)**，每步等端口就绪再继续。

停止只会关软件，**不会关掉 QQ 客户端**，只是解除挂接。

---

## 确认真的跑起来了

```powershell
node ops\stack-control.mjs status
```

期望 **9 个 ✔**（3000/3001/3010/3011/5099/3080/3100/3200/5110）。

> ⚠️ `status` 有小概率**误报**（`isOpen()` 的判定受残留套接字影响），
> 所以别只信它。下面两条才是硬判据。

```powershell
# ① SnowLuma 是否真的接管了 QQ（日志文件名是当天日期）
Select-String -Path "SnowLuma\logs\snowluma-<今天>.log" -Pattern "login detected|exclude list hit" | Select-Object -Last 6

# ② 两个桥接是否连上了 SnowLuma 与 DSH
Get-Content qq-bridge-01\state\bridge.log -Tail 12
Get-Content qq-bridge-02\state\bridge.log -Tail 12
```

两份日志里都应该出现这三行（`3011` 那份属于实例②）：

```
[bridge] SnowLuma 已连接：ws://127.0.0.1:3001
[bridge] 机器人昵称: <昵称>
[bridge] DSH 已就绪（模式: reserved2）
```

---

## 控制台

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| **统一入口（推荐）** | <http://127.0.0.1:5110/> | 左上角切换 大肥鱼 / 小黑 / SnowLuma |
| 实例① | <http://127.0.0.1:3100/> | 需要 token，地址在 `qq-bridge-01\state\console-token` |
| 实例② | <http://127.0.0.1:3200/> | 需要 token，地址在 `qq-bridge-02\state\console-token` |
| SnowLuma | <http://127.0.0.1:5099/processes> | 「加载 / 卸载」QQ 在这里 |

---

## 数据存在哪

| 内容 | 位置 | 进版本库 |
| --- | --- | --- |
| 长期聊天归档 | `memory\<机器人QQ>\<YYYY-MM-DD>.jsonl` | ❌ |
| 人格卡 | `qq-bridge-01\roles\*.md` | ❌ |
| 令牌 / 白名单 / 运行态 | `**\config.json`、`**\state\`、`SnowLuma\config\onebot_*.json` | ❌ |
| 运维手册 | `docs\` | ❌（含真实账号，见 `.gitignore` 第 9 段） |

查归档：

```powershell
node ops\memory-query.mjs                    # 列出实例与可用日期
node ops\memory-query.mjs --all --limit 30   # 最近 30 条
node ops\memory-query.mjs --date 2026-10-27 --key group:<群号>
node ops\memory-query.mjs --grep 关键词
```

---

## 出常见问题先看这里

| 症状 | 大概率原因 |
| --- | --- |
| 3000/3001/3010/3011 一直不监听，桥接刷 `code=1006` | **忘记在 5099 点「加载」** |
| `token 自愈失败（401）` | 点「加载」后还没写回 token；重启桥接即可 |
| `status` 显示 ✔ 但机器人不回话 | `status` 误报，按上面「确认真的跑起来了」那两条判据查 |
| `preset "qq-chat-v2" 不在 DSH 可用清单` | DSH 侧 preset 没装上，跑 `node scripts\setup-dsh.mjs`（在 `qq-bridge-01` 下）后重启 DSH |
| 改了 `src\*.js` 但只有大肥鱼生效 | 实例②没同步 —— 重启整套栈（`start` 会自动同步），或手动 copy |
| 端口被占 / 进程杀不掉 | `node ops\stack-control.mjs stop`；仍不行用 `ops\stop-loops.ps1` |

完整 40+ 条对照表：`docs\问题处理一览.md`。

---

## 改代码后要注意什么

| 改了什么 | 要做什么 |
| --- | --- |
| `qq-bridge-01\src\*.js` | 重启整套栈，`start` 会自动同步到实例② |
| `qq-bridge-01\config.json`（白名单等） | 只重启对应桥接即可；白名单在控制台改是即时生效的 |
| `agent.cordis.yml` / `socialV2.tools.*` / MCP 脚本 | **必须重启 DSH**（工具 schema 在启动时读取） |
| `~\.dsh\profiles\*\cordis.patch.yml` 或插件联接 | 在 `qq-bridge-01` 下跑 `node scripts\setup-dsh.mjs` |
| 往 `ops\` 里搬脚本 | 注意脚本里的 `import.meta.url` / `__file__` 会以新位置算根目录 |

---

## 已知的环境坑（踩过，别再踩）

- **PowerShell 5.1 把无 BOM 的 `.ps1` 当 ANSI 读** —— 脚本里只要有中文就会报「字符串缺少终止符」。
  所以 `ops\` 下的 `.ps1` 一律只写 ASCII；需要中文的逻辑请写成 `.mjs`。
- **别用 `taskkill /IM <常见进程名>`** 批量杀 —— 会连自己的终端一起杀掉。按 PID 杀。
- **别把 `qq-bridge-01` 目录改名**（或改名后一定要重建联接）—— `qq-bridge-02\node_modules`
  与 DSH 的两个 plugin 联接都指向它，目录一动全部断链。
- **删 `dsh-engine\` 之类"看起来多余"的目录前先查进程** —— 3080 上真正跑的是
  `deepseek_harness` 里的 DSH，那个独立副本从来没被启用过。
