// 从**本地**桥接配置里读令牌与账号，供 ops/ 下的运维脚本使用。
//
// 为什么要有这个模块：这些脚本原先各自把 consoleToken / OneBot accessToken /
// 真实 QQ 号写死在源码里。那些值一旦进 Git（哪怕私有仓库）就等于公开 ——
// 而 .gitignore 只排除了 `config.json` 和 `state/`，**排不掉写进 .mjs 的字面量**。
// 所以统一改成运行时读取：源码里只留"去哪个文件读"，不留值。
//
// 取值顺序与桥接自身完全一致（见 src/bridge.js 的 startConsoleServer）：
//   1. config.json 的 consoleToken（要求长度 16~128、只含 [A-Za-z0-9_-]）
//   2. 否则退回 state/console-token
//
// 用法：
//   import { bridgeEnv } from './lib/local-env.mjs';
//   const env = bridgeEnv('qq-bridge-01');
//   env.consoleToken / env.onebotToken / env.onebotPort / env.ownerQQ / env.selfQQ

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function validToken(value) {
  const t = String(value ?? '').trim();
  return t.length >= 16 && t.length <= 128 && /^[A-Za-z0-9_-]+$/.test(t) ? t : '';
}

/**
 * 读一个桥接实例的本地凭据。
 * @param {string} instanceDir 例如 'qq-bridge-01'（相对仓库根）或绝对路径
 */
export function bridgeEnv(instanceDir = 'qq-bridge-01') {
  const dir = path.isAbsolute(instanceDir) ? instanceDir : path.join(REPO_ROOT, instanceDir);
  const cfg = readJson(path.join(dir, 'config.json')) ?? {};

  let consoleToken = validToken(cfg.consoleToken);
  if (!consoleToken) {
    try {
      consoleToken = fs.readFileSync(path.join(dir, 'state', 'console-token'), 'utf8').trim();
    } catch {
      consoleToken = '';
    }
  }

  // 会话 agentToken 只存在于 state/social-v2.json（每个会话一个）。
  let conversations = {};
  const social = readJson(path.join(dir, 'state', 'social-v2.json'));
  if (social && typeof social.conversations === 'object' && social.conversations) {
    conversations = social.conversations;
  }

  return {
    dir,
    cfg,
    consoleToken,
    consolePort: Number(cfg.consolePort) || 3100,
    onebotPort: (() => {
      try {
        return Number(new URL(String(cfg.snowluma?.httpUrl ?? '')).port) || 0;
      } catch {
        return 0;
      }
    })(),
    onebotToken: String(cfg.snowluma?.accessToken ?? ''),
    ownerQQ: String(cfg.ownerQQ ?? ''),
    selfQQ: String(cfg.selfQQ ?? ''),
    role: typeof cfg.role === 'string' ? cfg.role : String(cfg.role?.name ?? ''),
    conversations,
  };
}

/** 取某个会话的 agentToken；没有就返回空串。 */
export function agentTokenFor(env, key) {
  return String(env?.conversations?.[key]?.agentToken ?? '');
}

/** 仓库根下第一个存在的 `group:<群号>` 会话 key。 */
export function firstGroupKey(env) {
  for (const key of Object.keys(env?.conversations ?? {})) {
    if (String(key).startsWith('group:')) return key;
  }
  return '';
}

/** 缺关键凭据时统一报错退出，避免脚本带着空令牌去请求然后给出误导性结论。 */
export function requireEnv(env, fields) {
  const missing = fields.filter((f) => !env?.[f]);
  if (missing.length) {
    console.error(`缺少本地凭据：${missing.join(', ')}（从 ${env?.dir ?? '?'} 读不到）`);
    console.error('提示：确认该实例已启动过（会生成 state/console-token），且 config.json 里配了 snowluma.accessToken');
    process.exit(1);
  }
  return env;
}
