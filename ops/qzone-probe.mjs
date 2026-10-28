// 探测 QQ 空间说出权限（ugc_right）各值的真实含义。
//
// 做法：发一条 → 立刻读回（SnowLuma 的列表解析在 msglist 为 null 时会报错，
// 但错误信息里**带原始 JSON**，正好能让我们看到真实的权限字段）→ 立刻删除。
// 全程几秒，尽量缩短"存在一条真实说说"的窗口。
//
// 用法：node ops\qzone-probe.mjs [ugc_right]   （默认 4）
//   node ops\qzone-probe.mjs --list            只读列表，不发任何东西

import { bridgeEnv, requireEnv } from './lib/local-env.mjs';

// OneBot 端点与令牌从本地配置读（见 ops/lib/local-env.mjs）。
const env = requireEnv(bridgeEnv('qq-bridge-01'), ['onebotToken']);
const PORT = env.onebotPort;
const TOKEN = env.onebotToken;
const BASE = `http://127.0.0.1:${PORT}`;

const arg = process.argv[2];
const listOnly = process.argv.includes('--list');
const right = Number(arg) || 4;

async function action(name, params = {}) {
  const res = await fetch(`${BASE}/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(40000),
  });
  const json = await res.json().catch(() => ({}));
  return json;
}

// 把列表接口返回的原始结构（SnowLuma 会把它塞在 wording 里）抓出来
async function rawList(num = 5) {
  const r = await action('get_qzone_msg_list', { num });
  if (r.retcode === 100 && typeof r.wording === 'string') {
    const i = r.wording.indexOf('{');
    if (i >= 0) {
      try { return JSON.parse(r.wording.slice(i)); } catch { /* 不是纯 JSON */ }
    }
  }
  return r.data ?? r;
}

if (listOnly) {
  const raw = await rawList(5);
  console.log('=== 当前列表（原始结构）===');
  console.log(JSON.stringify(raw, null, 2).slice(0, 4000));
  process.exit(0);
}

const text = `【权限探测】ugc_right=${right}，发完即删。`;
console.log(`发出：ugc_right=${right}`);
const sent = await action('send_qzone_msg', { content: text, ugc_right: right });
console.log('发送结果：' + JSON.stringify(sent));
if (sent.status !== 'ok' || !sent.data?.tid) {
  console.log('发送失败，未做任何后续操作');
  process.exit(1);
}
const tid = sent.data.tid;

try {
  const raw = await rawList(5);
  const list = Array.isArray(raw?.msglist) ? raw.msglist : [];
  const hit = list.find((m) => String(m?.tid ?? '') === String(tid)) || list[0];
  console.log('\n=== 读回（原始结构）===');
  console.log(JSON.stringify(raw, null, 2).slice(0, 5000));
  if (hit) {
    console.log('\n=== 本条的关键字段 ===');
    for (const k of Object.keys(hit)) {
      const v = hit[k];
      if (v === null || typeof v !== 'object') console.log(`  ${k} = ${JSON.stringify(v)}`);
    }
  }
} finally {
  const del = await action('delete_qzone_msg', { tid });
  console.log('\n删除结果：' + JSON.stringify(del));
}
