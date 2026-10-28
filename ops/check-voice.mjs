// 端到端验证「机器人能正常发语音」：
//   1. 查 tts-status（engine / voice / edge 可用性）
//   2. 真调 /api/socialV2/speak，发一条语音到管理员私聊（不打扰群）
//   3. 查 /api/socialV2/voices（语音库条目）
//
// 用法：node ops\check-voice.mjs [--send]
//   不带 --send 只做只读检查。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, bridgeEnv, requireEnv } from './lib/local-env.mjs';

const ROOT = REPO_ROOT;
const SEND = process.argv.includes('--send');
// 令牌 / 端口 / 会话 key 一律从本地配置读（见 ops/lib/local-env.mjs）。
// 发语音走管理员私聊，但 QQ 号从配置取，不写在源码里。
const envA = requireEnv(bridgeEnv('qq-bridge-01'), ['consoleToken', 'ownerQQ']);
const envB = requireEnv(bridgeEnv('qq-bridge-02'), ['consoleToken']);
const KEY = `private:${envA.ownerQQ}`;   // 管理员私聊（自己的号，不打扰群）
const TEXT = '语音链路检查。';

const BRIDGES = [
  { name: `b1(:${envA.consolePort})`, dir: 'qq-bridge-01', port: envA.consolePort, token: envA.consoleToken },
  { name: `b2(:${envB.consolePort})`, dir: 'qq-bridge-02', port: envB.consolePort, token: envB.consoleToken }
];

function req(port, method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 原文 */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

for (const b of BRIDGES) {
  console.log(`\n===== ${b.name} =====`);
  const h = { 'x-console-token': b.token };

  const st = await req(b.port, 'GET', '/api/socialV2/tts-status', h);
  if (st.status !== 200) { console.log(`  tts-status ${st.status} ${st.text.slice(0, 150)}`); continue; }
  const s = st.json;
  console.log(`  tts       enabled=${s.enabled} engine=${s.engine}`);
  console.log(`  音色      ${s.configuredVoice}  pitch=${s.configuredPitch}`);
  console.log(`  edge      available=${s.edgeAvailable}  中文音色=${s.chineseVoice}`);
  console.log(`  roleVoice enabled=${s.roleVoicesEnabled} active=${s.activeRole ?? '-'} -> ${s.activeRoleVoice ?? '(固定声线)'}`);

  const v = await req(b.port, 'GET', '/api/socialV2/voices', h);
  const vj = v.json || {};
  console.log(`  语音库    ${vj.count} 条` + (vj.count ? `：${(vj.voices || []).map((x) => x.name + (x.ok ? '' : '(损坏)')).join(', ')}` : ''));

  if (!SEND) continue;

  // 真发一条：要带 agent token（走 AI 出站审计）+ 控制台令牌
  const stateFile = path.join(ROOT, b.dir, 'state', 'social-v2.json');
  let agentToken = '';
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
    agentToken = String(raw?.conversations?.[KEY]?.agentToken || '');
  } catch (e) {
    console.log(`  读取会话状态失败：${e.message}`);
  }
  if (!agentToken) { console.log(`  会话 ${KEY} 没有 agentToken，跳过发送`); continue; }

  const r = await req(b.port, 'POST', '/api/socialV2/speak', {
    ...h,
    'x-agent-token': agentToken,
    'x-agent-call': '1'
  }, { key: KEY, token: agentToken, text: TEXT });

  if (r.status === 200 && r.json?.ok) {
    console.log(`  发送      OK messageId=${r.json.messageId} engine=${r.json.engine} voice=${r.json.voice} ${r.json.chars}字`);
    console.log(`            text="${r.json.text}"`);
  } else {
    console.log(`  发送      FAIL ${r.status} ${(r.json?.error) || r.text.slice(0, 200)}`);
  }
}

console.log(SEND ? '\n（已尝试真实发送到管理员私聊）' : '\n（只读检查。加 --send 才真发一条）');
