// SnowLuma 连接自发现：解决「换 QQ 账号后 token 变了，工具就 401」的问题。
//
// 背景（实测确认）：
//   SnowLuma 的 OneBot 配置是**按账号分文件**的：<SnowLuma>/config/onebot_<QQ号>.json，
//   每个账号有各自的 httpServers[].accessToken（**HTTP 与 WebSocket 的 token 还是不同的**）。
//   换账号登录后，旧的 accessToken 直接 401（retcode 1401），
//   于是任何把它硬编码在 config.json 里的工具（独立工具、图形界面、甚至 qq-bridge）全部失效。
//
// 本模块的做法：**不猜**，而是拿候选 token 真去问一次 get_login_info，谁通就用谁，
// 并把"当前是哪个账号"一并回报出来。候选来源：
//   1) 显式传入的 token / 环境变量
//   2) config.json 里已配置的 token（保持兼容）
//   3) SnowLuma config 目录下所有 onebot_*.json 里的 HTTP token（真实来源）
//
// 这样换账号后无需手改任何配置，工具自动跟上。
import fs from 'node:fs';
import path from 'node:path';

/**
 * SnowLuma 主目录的常见位置。
 *
 * 同时接受两种 cfg 形状（踩过坑：图形界面传的是"窄对象"，没有 snowluma 这一层，
 * 于是 homeDir 被忽略、per-account token 一个都扫不到 → 换账号后界面显示未连接）：
 *   - 完整 config：{ snowluma: { homeDir, launcherPath, httpUrl, accessToken } }
 *   - 窄对象：    { homeDir, launcherPath, httpUrl, accessToken }
 */
export function snowLumaHomeCandidates({ cfg = null } = {}) {
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };
  const sl = cfg?.snowluma ?? cfg ?? {};
  if (sl.homeDir) push(String(sl.homeDir));
  if (sl.launcherPath) push(path.dirname(String(sl.launcherPath)));
  if (process.env.SNOWLUMA_HOME) push(process.env.SNOWLUMA_HOME);
  return out;
}

/**
 * 从 SnowLuma 的 per-account 配置里读出候选 token。
 *
 * 重要：**HTTP 与 WebSocket 是两个不同的 token**（各自的 server 配置里各有一份），
 * 桥接用 WS 连 3001、工具用 HTTP 连 3000，所以两边都要能取到。
 *
 * 返回 [{ uin, file, http: {token,host,port}, ws: {token,host,port} }]，按 uin 排序。
 */
export function readOneBotTokens(homeDir) {
  const dir = path.join(homeDir, 'config');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = /^onebot_(\d+)\.json$/i.exec(e.name);
    if (!m) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8'));
      const nets = j?.networks ?? {};
      const http = Array.isArray(nets.httpServers) ? nets.httpServers[0] : null;
      const ws = Array.isArray(nets.wsServers) ? nets.wsServers[0] : null;
      out.push({
        uin: m[1],
        file: path.join(dir, e.name),
        http: http ? { token: String(http.accessToken ?? ''), host: http.host || '127.0.0.1', port: Number(http.port) || 3000 } : null,
        ws: ws ? { token: String(ws.accessToken ?? ''), host: ws.host || '127.0.0.1', port: Number(ws.port) || 3001 } : null
      });
    } catch {
      // 单个文件坏了不影响其它账号
    }
  }
  return out.sort((a, b) => a.uin.localeCompare(b.uin));
}

/** 兼容旧调用：只取 HTTP token 的扁平列表。 */
export function readOneBotHttpTokens(homeDir) {
  return readOneBotTokens(homeDir)
    .filter((a) => a.http)
    .map((a) => ({ token: a.http.token, uin: a.uin, host: a.http.host, port: a.http.port, file: a.file }));
}

/**
 * 反查「本实例对应的机器人 QQ 号」。
 *
 * 为什么不直接用 `ownerQQ`：那是**管理员**（好几个实例都配同一个），
 * 拿它当实例标识会让两个桥接写进同一个目录。
 *
 * 做法：SnowLuma 的 `config/onebot_<QQ>.json` 里写着该账号的 OneBot 端口，
 * 而每个桥接的 `snowluma.wsUrl` / `httpUrl` 端口是唯一的，所以可以静态反查 ——
 * 不需要等 `getLoginInfo()` 的异步结果，启动瞬间就能确定目录名。
 *
 * 注意 `urlPort()` 返回的是**字符串**（见下方定义），这里统一按字符串比较。
 *
 * @returns {string|null} QQ 号字符串；查不到返回 null（调用方自行兜底）。
 */
export function resolveSelfUin({ cfg = null, homeDir = null, wsUrl = null, httpUrl = null } = {}) {
  const sl = cfg?.snowluma ?? cfg ?? {};
  const wsPort = urlPort(wsUrl ?? sl.wsUrl);
  const httpPort = urlPort(httpUrl ?? sl.httpUrl);
  if (!wsPort && !httpPort) return null;

  const homes = homeDir ? [homeDir] : snowLumaHomeCandidates({ cfg });
  for (const home of homes) {
    let accounts = [];
    try {
      accounts = readOneBotTokens(home);
    } catch {
      continue;
    }
    // WS 端口优先：那是桥接的主链路；HTTP 只是工具通道。
    let hit = wsPort ? accounts.find((a) => a.ws && String(a.ws.port) === wsPort) : null;
    if (!hit && httpPort) hit = accounts.find((a) => a.http && String(a.http.port) === httpPort);
    if (hit) return hit.uin;
  }
  return null;
}

/** 试一次 get_login_info；成功返回 data，失败返回 null。 */
async function probe(baseUrl, token, timeoutMs) {
  try {
    const res = await fetch(`${baseUrl}/get_login_info`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json().catch(() => ({}));
    if (body.status !== 'ok' || body.retcode !== 0) return { ok: false, status: res.status, retcode: body.retcode, wording: body.wording };
    return { ok: true, data: body.data };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 从 `http://host:port` / `ws://host:port` 里取出端口字符串；取不到返回 null。 */
function urlPort(u) {
  if (!u) return null;
  try {
    const p = new URL(String(u)).port;
    if (p) return p;
    return String(u).startsWith('https') || String(u).startsWith('wss') ? '443' : '80';
  } catch {
    return null;
  }
}

/**
 * 自动找出一条**能用**的连接（token + baseUrl + 账号信息）。
 *
 * @returns {Promise<{ok:boolean, token?:string, baseUrl?:string, self?:object,
 *                    tried?:Array, error?:string, source?:string}>}
 */
export async function discoverSnowLumaConnection({
  cfg = null,
  baseUrl = null,
  token = null,
  homeDirs = null,
  timeoutMs = 6000
} = {}) {
  const sl = cfg?.snowluma ?? cfg ?? {};
  const base = String(baseUrl || process.env.SNOWLUMA_HTTP_URL || sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const homes = homeDirs ?? snowLumaHomeCandidates({ cfg });
  const explicit = token || process.env.SNOWLUMA_TOKEN || sl.accessToken || '';

  // 候选顺序：显式配置优先（尊重用户选择），然后才是 per-account 文件里的其它账号
  const candidates = [];
  const seen = new Set();
  const add = (tk, source, url) => {
    const key = `${url}|${tk}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ token: tk, source, url });
  };
  if (explicit) add(explicit, 'config/env', base);

  // ⚠️ 端点约束（`snowluma.restrictToConfiguredEndpoint`，默认开）：
  //
  // 为什么必须有：SnowLuma 的 config 目录里放着**所有**账号的 onebot_<QQ>.json，
  // 而每个文件的 httpServers[].port 就是那个账号自己的端点。原实现把所有账号的
  // token 都当候选、并且各自去**它自己的端点**上试 —— 只要别的账号在线，探测就会
  // `ok:true`，于是把**另一个账号**的 token 采纳进来。实测踩过（双实例本机）：
  //   小黑实例在 3010 还没起来时，扫到 3000 上大肥鱼的 token 并写进了自己的 config.json，
  //   14 秒后端口就绪才纠正回来；这段时间里 cfg 是「httpUrl=3010 + 大肥鱼的 token」
  //   这种**必然 401 的错配组合**。若实例配了 followDiscoveredEndpoint=true，更糟：
  //   它会连端点一起改掉并**持久化**，两个实例抢同一个 OneBot 端点（用错账号发消息）。
  //
  // 判据很简单：本实例只跟**配置里的那个端点**说话，那么只接受端点一致的那个账号。
  // 端口变了（换账号且改了端口）可以先设 `restrictToConfiguredEndpoint: false` 再自愈。
  const restrict = sl.restrictToConfiguredEndpoint !== false;
  const wantHttpPort = urlPort(base);
  const wantWsPort = urlPort(sl.wsUrl || '');
  const mismatched = [];   // 端点与配置不符、被跳过的账号（只用于报错定位）

  // per-account 文件：同时收 HTTP token（工具用）与 WS 信息（桥接用）。
  // 两个 token 不同、端口也各自记录，不能混用。
  const wsInfo = new Map();   // uin -> { token, url }
  for (const home of homes) {
    for (const entry of readOneBotTokens(home)) {
      const httpUrlE = entry.http ? `http://${entry.http.host}:${entry.http.port}` : null;
      const wsUrlE = entry.ws ? `ws://${entry.ws.host}:${entry.ws.port}` : null;
      if (restrict) {
        // 只比对本实例确实配置了的端点；没配的那一侧不设限（例如只用 HTTP 的工具）。
        const httpOk = !wantHttpPort || !entry.http || urlPort(httpUrlE) === wantHttpPort;
        const wsOk = !wantWsPort || !entry.ws || urlPort(wsUrlE) === wantWsPort;
        if (!httpOk || !wsOk) {
          mismatched.push({ uin: entry.uin, httpUrl: httpUrlE, wsUrl: wsUrlE });
          continue;
        }
      }
      if (entry.http) add(entry.http.token, `onebot_${entry.uin}.json`, httpUrlE);
      if (entry.ws?.token) wsInfo.set(entry.uin, { token: entry.ws.token, url: wsUrlE });
    }
  }
  if (!explicit && candidates.length === 0) add('', 'no-token', base);

  const tried = [];
  for (const c of candidates) {
    const r = await probe(c.url, c.token, timeoutMs);
    const declaredUin = /onebot_(\d+)\.json/.exec(c.source)?.[1] ?? null;
    const actualUin = r.ok && r.data?.user_id != null ? String(r.data.user_id) : null;
    // 文件说这是 A 的端点，但那个端口上登录的却是 B —— 说明 SnowLuma 的 per-account
    // 配置本身串了（例如把 A 的 token 写进了 B 的文件）。采纳它就是采纳错账号，跳过。
    const uinMismatch = Boolean(declaredUin && actualUin && declaredUin !== actualUin);
    tried.push({
      source: c.source,
      url: c.url,
      token: c.token ? c.token.slice(0, 4) + '…' : '(空)',
      ok: r.ok && !uinMismatch,
      status: r.status,
      wording: uinMismatch ? `账号不符（文件 ${declaredUin} / 实际 ${actualUin}）` : r.wording
    });
    if (r.ok && !uinMismatch) {
      // 找到有效 HTTP token 后，把**同一个账号**的 WS 信息也带回去：
      // 桥接走 WebSocket，用另一个 token、另一个端口 —— 只修 HTTP 的话桥接仍然 1006 重连。
      const uin = declaredUin ?? actualUin ?? '';
      const w = wsInfo.get(uin) ?? null;
      return {
        ok: true,
        token: c.token,
        baseUrl: c.url,
        self: r.data,
        source: c.source,
        wsToken: w?.token ?? null,
        wsUrl: w?.url ?? null,
        tried
      };
    }
  }
  const last = tried[tried.length - 1];
  const skipHint = restrict && mismatched.length
    ? `；另有 ${mismatched.length} 个账号的端点与配置不符已跳过（${mismatched.map((m) => `${m.uin}→${m.httpUrl || m.wsUrl}`).join('、')}）。若确实换了端口，先设 snowluma.restrictToConfiguredEndpoint=false`
    : '';
  return {
    ok: false,
    tried,
    mismatched,
    baseUrl: base,
    error: (last?.status === 401
      ? `所有候选 token 都被拒绝（401）。当前账号的 token 可能还没写进 SnowLuma 的 config：请确认 SnowLuma 已登录目标 QQ，且 OneBot HTTP 服务已开启。`
      : `连不上 OneBot HTTP API（${base}）：${last?.wording ?? last?.status ?? '未知错误'}`) + skipHint
  };
}

/**
 * 把当前有效的 token 写回 config.json（可选动作，供 qq-bridge 这类"必须持久化 token"的组件用）。
 * 只在真的换过账号时才写，避免无谓改动。
 * 返回 { updated, from, to }。
 */
/**
 * 只写 accessToken（兼容旧调用）。返回 { updated, from, to } —— 保留 from/to 是因为
 * 既有调用方与测试按这个形状断言（重构时改成 changed 曾把测试打红）。
 */
export function persistToken(cfgPath, newToken) {
  let text = fs.readFileSync(cfgPath, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const old = String(JSON.parse(text).snowluma?.accessToken ?? '');
  const r = persistSnowLumaEndpoint(cfgPath, { accessToken: newToken });
  return { updated: r.updated, from: old, to: newToken };
}

/**
 * 把**已确认可用**的 SnowLuma 端点写回 config.json。
 * 只写传进来的字段，其它配置一律不动；全部一致时不写文件（幂等）。
 * 返回 { updated, changed: {...} }。
 */
export function persistSnowLumaEndpoint(cfgPath, { accessToken, wsUrl, httpUrl } = {}) {
  let text = fs.readFileSync(cfgPath, 'utf8');
  // 读的时候必须吃掉 BOM，否则 JSON.parse 会抛「Unexpected token」。
  const hadBom = text.charCodeAt(0) === 0xFEFF;
  if (hadBom) text = text.slice(1);
  const cfg = JSON.parse(text);
  const cur = cfg.snowluma ?? {};
  const next = { ...cur };
  const changed = {};
  const consider = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    if (String(cur[key] ?? '') === String(value)) return;
    changed[key] = { from: cur[key] ?? null, to: value };
    next[key] = value;
  };
  consider('accessToken', accessToken);
  consider('wsUrl', wsUrl);
  consider('httpUrl', httpUrl);
  if (Object.keys(changed).length === 0) return { updated: false, changed: {} };
  cfg.snowluma = next;
  // 原来 hadBom 只用于读、没用回写：用户文件带 UTF-8 BOM 时，我们改一个 token 就把 BOM 吞掉了
  // —— 那是对用户文件的**字节级**静默改动（Windows 编辑器/工具常写 BOM），会让文件在 git 里
  // 显示成整文件重写，也可能影响按字节读它的其它程序。只改该改的字段，编码原样保留。
  const serialized = JSON.stringify(cfg, null, 2) + '\n';
  fs.writeFileSync(cfgPath, hadBom ? `\uFEFF${serialized}` : serialized, 'utf8');
  return { updated: true, changed };
}
