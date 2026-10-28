// 调试用：把 /api/socialV2/prompt 的返回结构写清楚，便于确认自我演变段落在哪个字段里。
// 用法：node ops/dump-prompt.mjs <port> <token> <key> [outFile]

import http from 'node:http';
import fs from 'node:fs';

const [portArg, token, key, outFile] = process.argv.slice(2);
const port = Number(portArg) || 3100;

function req(path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: { 'x-console-token': token } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

const res = await req(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`);
console.log('status=' + res.status + ' bytes=' + res.text.length);
let json = null;
try { json = JSON.parse(res.text); } catch (e) { console.log('not json: ' + e.message); }

if (json) {
  const walk = (obj, prefix, depth) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') {
        console.log(`  ${p}  <string ${v.length}>`);
      } else if (v && typeof v === 'object') {
        console.log(`  ${p}  <${Array.isArray(v) ? 'array' : 'object'}>`);
        if (depth < 2) walk(v, p, depth + 1);
      } else {
        console.log(`  ${p}  = ${JSON.stringify(v)}`);
      }
    }
  };
  walk(json, '', 0);
}

const target = json?.prompt ?? json?.role?.hint ?? res.text;
const marker = '【你现在是什么样】';
const i = String(target).indexOf(marker);
console.log('\nmarker index in chosen target = ' + i);
if (i >= 0) console.log('context:\n' + String(target).slice(Math.max(0, i - 200), i + 400));

if (outFile) {
  fs.writeFileSync(outFile, res.text, 'utf8');
  console.log('\nwritten -> ' + outFile);
}
