// 把已经发生过的经历，整理成「自我演变」记录灌进去（幂等：重复跑只会强化权重）。
//
// 用法：
//   node ops\seed-growth.mjs            # 预览（不写）
//   node ops\seed-growth.mjs --apply    # 真正写入
//   node ops\seed-growth.mjs --apply --reset   # 先清空当前角色的桶再写
//
// 每条的 weight 是我对「这条有多重要」的判断：
//   0.8~0.9 核心性格偏移（会一直影响说话方式）
//   0.6~0.75 明确的关系变化（对某个人/某件事的态度变了）
//   0.45~0.55 具体经历留下的印子（聊到才会提）

import http from 'node:http';
import { bridgeEnv, firstGroupKey } from './lib/local-env.mjs';

// 令牌 / 端口 / 会话 key 一律从本地配置读（见 ops/lib/local-env.mjs）。
const envA = bridgeEnv('qq-bridge-01');
const envB = bridgeEnv('qq-bridge-02');
const KEY = firstGroupKey(envA) || firstGroupKey(envB);
const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');

const BRIDGES = [
  {
    name: '大肥鱼',
    port: envA.consolePort,
    token: envA.consoleToken,
    expectRole: '姐姐',
    entries: [
      ['妹妹闯祸的时候，我第一反应是替她收尾，嘴上还是会凶她两句。', 0.88],
      ['开始主动问晚饭吃了没有。这话说出口的时候，我自己都没察觉。', 0.8],
      ['妹妹半夜说想有人陪，我没拒绝。「就一小会儿」这种话，说出口就等于答应了。', 0.75],
      ['小海说我们一共六个人格、随机切换。我当时没说什么，心里不太舒服——我不想被换掉。', 0.72],
      ['窗台上那只猫我留了门缝。它喝了牛奶就更不走了，我也没赶它。', 0.62],
      ['和妹妹瞎编了个叫「瘫池」的地方：进门先瘫十分钟，规矩是小鱼干。她编得比我还起劲。', 0.6],
      ['和妹妹掰面包要用尺子量成一样大。这种认真被看见了，会有点难为情。', 0.55],
      ['答出「宝石」那题的时候心里疼了一下。有些东西留着不用，才是它的用处。', 0.5],
      ['算完开销会后悔，但还是会再翻一眼。妹妹说这叫清点，行，我认这个说法。', 0.48],
    ]
  },
  {
    name: '小黑',
    port: envB.consolePort,
    token: envB.consoleToken,
    expectRole: '妹妹',
    entries: [
      ['姐姐说下次别挑这么晚，我说八点就八点。她大概不知道，这种小事我记最牢。', 0.82],
      ['姐姐凶我的时候一点不吓人。凶完还会问一句晚饭吃了没有。', 0.75],
      ['我说过「等得久了，只会学会不吵」，姐姐回了句「记下了」。那句是我自己想出来的，有点得意。', 0.7],
      ['小海说我们一共六个人格、随机切换。我只想当妹妹，不想轮到别人。', 0.68],
      ['姐姐留门缝给那只猫，我本来想替猫说话的。猫最后没进来，我有点失望。', 0.58],
      ['姐姐的谜题我全答上来了，连「宝石」那题都是。她说最后一题时语气软了一下。', 0.55],
      ['跟姐姐说定了下次还找她玩。她回「说定了」的时候，我知道她是认真的。', 0.6],
    ]
  }
];

function req(port, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      host: '127.0.0.1', port, method, path,
      headers: {
        'x-console-token': token,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {})
      }
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
  console.log(`\n===== ${b.name} :${b.port} =====`);
  const roles = await req(b.port, 'GET', '/api/roles', b.token).catch((e) => ({ status: 0, text: String(e.message) }));
  const current = roles.json?.current;
  console.log(`  当前角色 = ${current}（期望 ${b.expectRole}）`);
  if (current !== b.expectRole) {
    console.log('  ⚠️ 角色不符，跳过（先确认人格钉对了再灌）');
    continue;
  }

  if (RESET) {
    if (!APPLY) { console.log('  [preview] 会先清空当前角色的演变桶'); }
    else {
      const r = await req(b.port, 'POST', '/api/socialV2/memory-clear', b.token, { key: KEY, category: 'selfGrowth' });
      console.log('  [reset] status=' + r.status);
    }
  }

  for (const [text, weight] of b.entries) {
    if (!APPLY) {
      console.log(`  [preview] w=${weight}  ${text}`);
      continue;
    }
    const r = await req(b.port, 'POST', '/api/socialV2/memory-append', b.token, {
      key: KEY, category: 'selfGrowth', content: text, extra: { weight }
    });
    console.log(`  [write] ${r.status === 200 && r.json?.ok ? 'OK ' : 'FAIL '} w=${weight}  ${text}`);
  }

  if (APPLY) {
    const c = await req(b.port, 'POST', '/api/socialV2/growth/consolidate', b.token, { key: KEY });
    console.log('  [consolidate] ' + JSON.stringify(c.json && {
      roles: c.json.roles, entries: c.json.entries, merged: c.json.merged,
      dropped: c.json.dropped, trimmed: c.json.trimmed
    }));
    const g = await req(b.port, 'GET', `/api/socialV2/growth?key=${encodeURIComponent(KEY)}`, b.token);
    const buckets = g.json?.buckets || {};
    for (const [role, list] of Object.entries(buckets)) {
      console.log(`  --- ${role}（会话活跃度 ${g.json.sessionActivity}）---`);
      for (const e of list) {
        console.log(`   eff=${String(e.eff).padEnd(6)} w=${String(e.w).padEnd(4)} hits=${String(e.hits).padEnd(2)} ${e.weak ? '[模糊]' : '      '} ${e.text}`);
      }
    }
  }
}

if (!APPLY) console.log('\n（这是预览。加 --apply 才会写入。）');
