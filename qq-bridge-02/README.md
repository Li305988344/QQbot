# qq-bridge-02 —— 桥接实例②（第二个机器人）

> **本目录是 [`../qq-bridge-01/`](../qq-bridge-01/) 的运行时副本，不是独立项目。**
> 它之所以单独存在，是因为桥接只支持**单个** OneBot 端点（`config.json` 里 `snowluma.wsUrl`
> 是单值），所以要跑第二个机器人就必须有第二个进程 + 第二份 `state/`。

---

## 与实例①的关系

| 项目 | 说明 |
| --- | --- |
| `src/` | **每次启动自动同步**：`ops/stack-control.mjs start` 会先跑 `syncBridge2Sources()`，把 `qq-bridge-01/src/*.js` 覆盖过来。所以改代码请改**实例①**，不要只改这里 |
| `node_modules` | **目录联接** → `..\qq-bridge-01\node_modules`。依赖只装一份 |
| `config.json` | **独立**：`consolePort` 3200、`snowluma.wsUrl` 指向 3011、`snowluma.httpUrl` 指向 3010 |
| `state/` | **独立**：自己的 `console-token`、`social-v2.json`、`activity.log` 等（两个实例不能共用，否则抢锁） |
| `roles/` | 独立副本（人格卡各自一份） |
| `RULES.md` | 与实例①内容相同的权限说明副本 |
| `docs/` | **不存在** —— 文档统一看 [`../qq-bridge-01/docs/README.md`](../qq-bridge-01/docs/README.md) |

> ⚠️ **不要把 `src` 也做成目录联接**：`node src/bridge.js` 经联接会 realpath 到真实目录，
> `__dirname` 变成实例①的路径 ⇒ 两边抢同一个 `state/bridge.lock`，第二个实例直接打印
> 「已有实例在运行」然后退出。（`node_modules` 是联接则安全，因为它不参与 `__dirname` 推导。）

---

## 本机部署的完整说明

启动方式、端口、排错一律看仓库根：

- 启动 / 配置 / 端口：[`../README.md`](../README.md)
- 每日操作清单：`../docs/启动清单.md`
- 原理与数据流：`../docs/QQBot运行手册.md`
- 报错对照：`../docs/问题处理一览.md`
- 权限边界：[`RULES.md`](RULES.md)（与实例①相同）
