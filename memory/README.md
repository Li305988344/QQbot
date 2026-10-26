# 长期记忆归档

这里存放两个 QQ 机器人的**完整聊天记录**，由桥接进程自动、逐条、永久追加。

## 为什么要有这个目录

桥接里原本的记忆都是**短期**的，各有保留上限：

| 机制 | 位置 | 保留 | 期限 |
| --- | --- | --- | --- |
| `recentMessages` | `state/social-v2.json` | 100 条/会话 | 滚动覆盖，超出即丢 |
| `unread` | `state/social-v2.json` | 30 条/会话 | 读完清空 |
| `activeTopics` | `state/social-v2.json` | 20 条 | 24 小时过期 |
| `pendingThoughts` | `state/social-v2.json` | 20 条 | 2 小时过期 |
| `memberImpressions` | `state/social-v2.json` | 有上限 | 只有标签，无原文 |
| `qq-activity.log` | `state/` | 500 行 | 会轮转，且**只有摘要**（`消息已入未读：xxx`），不含机器人回复原文 |

也就是说，超过 100 条之后，聊天内容就再也找不回来了。本目录补的就是这个空白。

## 目录结构

```
memory/
├── README.md              ← 本文件
├── <机器人A的QQ>/          ← 目录名 = 机器人自己的 QQ
│   ├── 2026-10-26.jsonl
│   └── 2026-10-25.jsonl
└── <机器人B的QQ>/
    └── 2026-10-26.jsonl
```

- **按实例分目录**：两个桥接是独立进程，分开写避免并发，也便于区分身份。
  目录名是**机器人自己的 QQ 号**，不是 `ownerQQ`。
  （`ownerQQ` 是「管理员」，多个实例配的往往是同一个号，不能当实例标识。）
- **QQ 号怎么来的**：桥接启动时用自己 `snowluma.wsUrl` 的端口去 SnowLuma 的
  `config/onebot_<QQ>.json` 里反查（见 `resolveSelfUin()`），不靠运行时异步。
  实在查不到时才退回控制台端口（`3100`/`3200`）。
- **按日期切文件**：单文件不会无限膨胀；删旧数据 = 删文件；查「某天聊了什么」直接定位。
- **JSONL 格式**：一行一条 JSON。append-only 不会因重写整个文件而丢历史，损坏只影响那一行，`grep` 直接可用。

## 记录格式

```json
{"ts":1793025822206,"t":"2026-10-26 22:17:02","key":"group:100000000","dir":"in","seq":173,"mid":"654733047","sender":"某群友","uid":"100000001","owner":false,"text":"示例收到的消息","media":[]}
{"ts":1793025825000,"t":"2026-10-26 22:17:05","key":"group:100000000","dir":"out","sender":"我","self":true,"owner":true,"text":"示例回复"}
```

| 字段 | 含义 |
| --- | --- |
| `ts` / `t` | 毫秒时间戳 / 本地时间（`YYYY-MM-DD HH:MM:SS`） |
| `key` | 会话：`group:<群号>` 或 `private:<QQ号>` |
| `dir` | `in` = 收到的消息，`out` = 机器人发出的消息 |
| `seq` | 会话内序号（仅入站） |
| `mid` | QQ 消息 id（仅入站） |
| `sender` / `uid` | 发送者昵称 / QQ（机器人自己发的记作 `我`） |
| `owner` | 是否管理员（`ownerQQ`） |
| `self` | 是否机器人自己说的 |
| `text` | 正文（最多 2000 字，超出截断并标记） |
| `media` | 媒体摘要，如 `["image:…"]`、`["sticker:…"]`、`["face:14"]` |

> 正文用的是**未截断原文**（`recentMessages` 里存的是截到 200 字的副本）。
> 只脱敏已知的 agent 凭据（`KNOWN_AGENT_TOKENS`）；路径等信息原样保留 ——
> 归档是本机私有数据，"记得准"比"打得全"更重要。

## 怎么查

```powershell
cd D:\QQbot

node ops/memory-query.mjs                          # 列出实例与可用日期
node ops/memory-query.mjs --date 2026-10-26        # 看某一天全部
node ops/memory-query.mjs --all                    # 看全部日期
node ops/memory-query.mjs --key group:100000000    # 只看某个会话
node ops/memory-query.mjs --grep 关键词            # 正文包含关键词
node ops/memory-query.mjs --limit 30               # 只看最近 30 条
node ops/memory-query.mjs --instance <机器人QQ>    # 只看某个机器人
node ops/memory-query.mjs --json                   # 输出原始 JSONL
```

条件可组合：

```powershell
node ops/memory-query.mjs --date 2026-10-26 --key group:100000000 --limit 50
```

也可以直接用 grep：

```powershell
Select-String -Path "D:\QQbot\memory\<机器人QQ>\2026-10-26.jsonl" -Pattern "关键词"
```

## 开关

`config.json`：

```json
"memory": {
  "archive": true
}
```

设为 `false` 后重启桥接即停止写入（已归档的内容不受影响）。

## 注意

- **不会自动清理**。这是有意的：长期记忆的价值就在于不被丢弃。真需要清理时手动删日期文件即可。
- **写入失败绝不影响聊天**。归档出任何错（磁盘满、权限变动、目录被删）只记一行日志，消息照常收发；同一条错误 60 秒内只报一次，避免刷爆 `bridge.log`。
- **不要手动编辑这些 `.jsonl`**。追加式文件一旦改坏某行，那条记录就读不出来了（其余行不受影响）。要改内容请在聊天里说，或先备份再动。
- 重启桥接后日志里会出现一行 `长期记忆归档: memory\<机器人QQ>`，确认已启用。
