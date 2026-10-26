// SnowLuma 账号/token 自发现自检。
//
// 背景（实测确认的根因）：SnowLuma 的 OneBot 配置按账号分文件
// （<SnowLuma>/config/onebot_<QQ号>.json），每个账号一个 token，HTTP 与 WS 还各不相同。
// 换 QQ 账号登录后，任何把 token 写死在 config.json 里的工具都会 401 ——
// 这正是"换个账号登录，发语音工具就不行了"的原因。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverSnowLumaConnection, persistToken, readOneBotHttpTokens, readOneBotTokens, resolveSelfUin, snowLumaHomeCandidates
} from '../src/snowluma-conn.js';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from './voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
// 工具不在本仓库里时返回 null，让下面几条桥接侧断言仍能照跑（读源码不该因为
// 一个不在仓库里的目录而整个抛掉）。
const readTool = (rel) => (hasVoiceTool() ? fs.readFileSync(voiceToolPath(rel), 'utf8') : null);

console.log('## home 目录推断');
{
  const homes = snowLumaHomeCandidates({ cfg: { snowluma: { homeDir: 'X:/sl', launcherPath: 'X:/sl2/launcher.bat' } } });
  ok(homes.includes('X:/sl'), '优先用 homeDir');
  ok(homes.some((h) => h.replace(/\\/g, '/') === 'X:/sl2'), '其次用 launcherPath 所在目录');
  ok(snowLumaHomeCandidates({ cfg: {} }).length >= 0, '无配置时返回空或环境变量值（不抛错）');
}

console.log('## per-account token 解析（用临时目录造多账号场景）');
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-home-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const write = (uin, httpToken, port = 3000, wsToken = 'ws-' + uin) => fs.writeFileSync(
    path.join(home, 'config', `onebot_${uin}.json`),
    JSON.stringify({ networks: { httpServers: [{ name: 'http-default', accessToken: httpToken, host: '127.0.0.1', port }], wsServers: [{ accessToken: wsToken, port: 3001 }] } }),
    'utf8'
  );
  write('111', 'token-aaa');
  write('222', 'token-bbb');
  fs.writeFileSync(path.join(home, 'config', 'onebot_broken.json'), '{ not json', 'utf8');
  fs.writeFileSync(path.join(home, 'config', 'runtime.json'), '{}', 'utf8');

  const toks = readOneBotTokens(home);
  ok(toks.length === 2, '只解析出 onebot_<数字>.json', `得到 ${toks.length} 个`);
  ok(toks[0].uin === '111' && toks[1].uin === '222', '按 uin 稳定排序');
  ok(toks.every((t) => t.http?.token?.startsWith('token-')), 'HTTP token 取自 httpServers');
  ok(toks.every((t) => t.ws?.token?.startsWith('ws-')), 'WS token 取自 wsServers（与 HTTP 不同！）');
  ok(toks.every((t) => t.http.token !== t.ws.token), '两个 token 确实不同（不能混用的证据）');
  ok(toks.every((t) => t.http.port === 3000 && t.ws.port === 3001), '端口分别是 3000 / 3001');

  const flat = readOneBotHttpTokens(home);
  ok(flat.length === 2 && flat[0].token === 'token-aaa', 'readOneBotHttpTokens 兼容扁平形态');

  console.log('## 反查机器人自己的 QQ（记忆目录以此命名）');
  // 两个账号的 WS 端口不同，桥接靠自己的 wsUrl 端口反查自己是谁。
  fs.writeFileSync(
    path.join(home, 'config', 'onebot_333.json'),
    JSON.stringify({ networks: { httpServers: [{ accessToken: 'h333', host: '127.0.0.1', port: 3010 }], wsServers: [{ accessToken: 'w333', port: 3011 }] } }),
    'utf8'
  );
  ok(resolveSelfUin({ cfg: { snowluma: { homeDir: home, wsUrl: 'ws://127.0.0.1:3001' } } }) === '111',
    '按 ws 端口 3001 反查出 uin=111');
  ok(resolveSelfUin({ cfg: { snowluma: { homeDir: home, wsUrl: 'ws://127.0.0.1:3011' } } }) === '333',
    '按 ws 端口 3011 反查出 uin=333');
  ok(resolveSelfUin({ cfg: { snowluma: { homeDir: home, wsUrl: 'ws://127.0.0.1:9999', httpUrl: 'http://127.0.0.1:3010' } } }) === '333',
    'ws 端口对不上时回退到 http 端口');
  ok(resolveSelfUin({ cfg: { snowluma: { homeDir: home, wsUrl: 'ws://127.0.0.1:9999', httpUrl: 'http://127.0.0.1:9998' } } }) === null,
    '端口都对不上时返回 null（不瞎猜，调用方退回 consolePort）');
  ok(resolveSelfUin({ cfg: { snowluma: { homeDir: home } } }) === null,
    '没有 wsUrl/httpUrl 时返回 null');
  ok(resolveSelfUin({ cfg: { snowluma: { homeDir: 'X:/nonexistent-home', wsUrl: 'ws://127.0.0.1:3001' } } }) === null,
    'homeDir 不存在时返回 null（不抛错）');

  console.log('## 自动发现：按"谁能用"选择，而不是猜');
  // 用一个假 fetch 模拟：只有 token-bbb 有效
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const tk = String(init?.headers?.authorization ?? '').replace('Bearer ', '');
    if (tk === 'token-bbb') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 222, nickname: '第二账号' } }) };
    }
    return { ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 1401, wording: 'unauthorized' }) };
  };
  try {
    const r = await discoverSnowLumaConnection({ cfg: {}, baseUrl: 'http://127.0.0.1:3000', homeDirs: [home], timeoutMs: 500 });
    ok(r.ok === true, '发现成功');
    ok(r.token === 'token-bbb', '选中了有效的那个 token', r.token);
    ok(r.self?.user_id === 222, '回报当前账号', String(r.self?.user_id));
    ok(r.source === 'onebot_222.json', '标明 token 来源', r.source);
    ok(r.tried.length === 2, '记录了尝试过的候选', `${r.tried.length} 个`);

    // 全部无效时要给出可操作错误
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 1401 }) });
    const bad = await discoverSnowLumaConnection({ cfg: {}, baseUrl: 'http://127.0.0.1:3000', homeDirs: [home], timeoutMs: 300 });
    ok(bad.ok === false, '全部失效时失败');
    ok(/401|token/.test(bad.error), '错误信息指出 token 问题', bad.error.slice(0, 40));
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log('## 端点约束：绝不采纳别的账号的 token');
{
  // 复现实测场景（双实例本机）：
  //   · 3000/3001 = 实例 A，3010/3011 = 实例 B
  //   · 实例 B 启动时 3010 还没起来，但 3000 已经在线
  //   原实现会把 3000 上实例 A 的 token 当成"能用"而采纳，写进实例 B 的 config.json ——
  //   于是 cfg 变成「httpUrl=3010 + 实例 A 的 token」这种必然 401 的错配组合。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-multi-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const write = (uin, httpToken, httpPort, wsToken, wsPort) => fs.writeFileSync(
    path.join(home, 'config', `onebot_${uin}.json`),
    JSON.stringify({
      networks: {
        httpServers: [{ name: 'http-default', accessToken: httpToken, host: '127.0.0.1', port: httpPort }],
        wsServers: [{ accessToken: wsToken, host: '127.0.0.1', port: wsPort }]
      }
    }),
    'utf8'
  );
  // 测试只用虚构账号：不把真实 QQ 号写进仓库（公开仓库会泄露）。
  const UIN_A = '100000001';
  const UIN_B = '100000002';
  write(UIN_A, 'token-big', 3000, 'ws-big', 3001);
  write(UIN_B, 'token-small', 3010, 'ws-small', 3011);

  const realFetch = globalThis.fetch;
  // 只有 3000 在线（实例 A 的 token 有效）；3010 一律连接失败 —— 与真实启动瞬间一致。
  globalThis.fetch = async (url, init) => {
    const tk = String(init?.headers?.authorization ?? '').replace('Bearer ', '');
    if (String(url).includes(':3000') && tk === 'token-big') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: Number(UIN_A), nickname: '实例A' } }) };
    }
    const err = new Error('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    throw err;
  };
  try {
    const siblingCfg = {
      snowluma: { homeDir: home, httpUrl: 'http://127.0.0.1:3010', wsUrl: 'ws://127.0.0.1:3011', accessToken: 'token-small' }
    };
    const r = await discoverSnowLumaConnection({ cfg: siblingCfg, homeDirs: [home], timeoutMs: 300 });
    ok(r.ok === false, '自己端口没起来时**不会**改连别的账号');
    ok(!r.tried.some((t) => t.source === `onebot_${UIN_A}.json`), '压根没去试另一个账号的端点');
    ok(Array.isArray(r.mismatched) && r.mismatched.some((m) => m.uin === UIN_A), '把被跳过的账号记进 mismatched（便于定位）');
    ok(/restrictToConfiguredEndpoint/.test(r.error), '错误信息给出可操作提示', r.error.slice(0, 60));

    // 逃生口：显式关掉约束后恢复旧行为（换账号且端口一起变了时才该用）
    const loose = await discoverSnowLumaConnection({
      cfg: { snowluma: { ...siblingCfg.snowluma, restrictToConfiguredEndpoint: false } },
      homeDirs: [home],
      timeoutMs: 300
    });
    ok(loose.ok === true && loose.token === 'token-big', '关掉约束后可跨端点发现（逃生口仍可用）');

    // 端口对得上时正常拿到**自己**的 token 与 WS token
    globalThis.fetch = async (url, init) => {
      const tk = String(init?.headers?.authorization ?? '').replace('Bearer ', '');
      if (String(url).includes(':3010') && tk === 'token-small') {
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: Number(UIN_B), nickname: '实例B' } }) };
      }
      return { ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 1401 }) };
    };
    const self = await discoverSnowLumaConnection({ cfg: siblingCfg, homeDirs: [home], timeoutMs: 300 });
    ok(self.ok === true && self.token === 'token-small', '端口一致时选中自己的账号');
    ok(self.wsToken === 'ws-small', '带回来的 WS token 也是自己的（不串号）');
    ok(self.self?.user_id === Number(UIN_B), '回报的账号是自己的', String(self.self?.user_id));

    // per-account 文件与端口上实际登录的账号不符时也要拒绝（SnowLuma 配置被写串的场景）。
    // 这里刻意不填 accessToken，让候选只剩 onebot_<uin>.json 那条，才能走到 uin 校验分支。
    globalThis.fetch = async () => ({
      ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 999999, nickname: '别人' } })
    });
    const wrongUin = await discoverSnowLumaConnection({
      cfg: { snowluma: { homeDir: home, httpUrl: 'http://127.0.0.1:3010', wsUrl: 'ws://127.0.0.1:3011' } },
      homeDirs: [home],
      timeoutMs: 300
    });
    ok(wrongUin.ok === false, '文件说 A、端口上登录的是 B 时拒绝采纳');
    ok(/账号不符/.test(JSON.stringify(wrongUin.tried)), '标明"账号不符"原因');
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log('## token 写回 config.json');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'old-token' }, allow: { groups: [1] } }, null, 2), 'utf8');
  const r1 = persistToken(cfgPath, 'new-token');
  ok(r1.updated === true && r1.from === 'old-token', '换 token 时写入');
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok(after.snowluma.accessToken === 'new-token', 'config.json 已更新');
  ok(after.allow.groups[0] === 1, '其它配置字段未被破坏');
  const r2 = persistToken(cfgPath, 'new-token');
  ok(r2.updated === false, 'token 未变时不重复写（幂等）');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('## 独立工具确实用它（源码级）');
{
  // 独立工具的入口文件在仓库上一级的 voice-tool/；共享内核仍是本仓库 src/snowluma-conn.js
  for (const rel of ['voice-cli.mjs', 'voice-gui.mjs']) {
    const src = readTool(rel);
    if (src === null) { skipVoiceTool(`${rel} 是否引入自发现模块（snowluma-conn.js / discoverSnowLumaConnection）`); continue; }
    ok(/snowluma-conn\.js/.test(src), `${rel} 引入自发现模块`);
    ok(/discoverSnowLumaConnection/.test(src), `${rel} 调用自动发现`);
  }
  // ↓ 下面两条查的是本仓库的 bridge.js，与工具在不在无关，照跑。
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  ok(/healTokenIfStale/.test(bridge), 'bridge 有 token 自愈');
  ok(/persistToken/.test(bridge), 'bridge 会把有效 token 写回 config.json');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
