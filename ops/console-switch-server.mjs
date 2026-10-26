import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 本文件在 <repo>/ops/：HTML 与它同目录，但 state/ 在项目根下。
const REPO = path.resolve(here, '..');
const htmlPath = path.join(here, 'console-switch.html');
const bridgeTokenPath = path.join(REPO, 'qq-bridge-01', 'state', 'console-token');
const bridge2TokenPath = path.join(REPO, 'qq-bridge-02', 'state', 'console-token');
const port = 5110;

function readToken(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function consoleUrlFor(base, tokenPath) {
  const token = readToken(tokenPath);
  return token ? `${base}/?token=${encodeURIComponent(token)}` : `${base}/`;
}

function rewriteText(text, prefix) {
  return text
    .replaceAll('(/assets/', `(${prefix}/assets/`)
    .replaceAll('"/assets/', `"${prefix}/assets/`)
    .replaceAll("'/assets/", `'${prefix}/assets/`)
    .replaceAll('"/api/', `"${prefix}/api/`)
    .replaceAll("'/api/", `'${prefix}/api/`)
    .replaceAll('(/api/', `(${prefix}/api/`)
    .replaceAll('"/bridge/', '"/bridge/')
    .replaceAll('"/snow/', '"/snow/');
}

async function proxy(request, response, target, prefix) {
  const suffix = request.url.startsWith(prefix)
    ? request.url.slice(prefix.length)
    : '/';
  const targetUrl = new URL(suffix || '/', target);

  const headers = { ...request.headers };
  delete headers.host;
  delete headers.connection;
  headers.accept_encoding = 'identity';

  // 上游应用会校验 Origin 必须是自己（防 CSRF）。iframe 里发来的是外壳地址
  // 127.0.0.1:5110，会被判成「跨站请求被拒绝」，这里改写成目标应用自己的 origin。
  const targetOrigin = new URL(target).origin;
  if (headers.origin) headers.origin = targetOrigin;
  if (headers.referer) {
    try {
      const ref = new URL(headers.referer);
      headers.referer = targetOrigin + ref.pathname + ref.search;
    } catch {
      headers.referer = targetOrigin + '/';
    }
  }

  let body;
  if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
    body = [];
    for await (const chunk of request) body.push(chunk);
    body = Buffer.concat(body);
  }

  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
    duplex: body ? 'half' : undefined,
  });

  const upstreamHeaders = new Headers(upstream.headers);
  upstreamHeaders.delete('content-length');
  upstreamHeaders.delete('content-security-policy');
  upstreamHeaders.delete('x-frame-options');
  upstreamHeaders.delete('frame-options');

  const type = upstreamHeaders.get('content-type') || '';
  response.statusCode = upstream.status;
  for (const [key, value] of upstreamHeaders.entries()) {
    if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) response.setHeader(key, value);
  }
  if (type.includes('json')) response.setHeader('content-type', 'application/json; charset=utf-8');

  if (type.includes('text/html')) {
    let html = await upstream.text();
    html = rewriteText(html, prefix);
    html = html.replace(/<head[^>]*>/i, '$&<base href="' + prefix + '/">');
    if (prefix === '/bridge2') {
      // 两个桥接控制台同源（都是 5110），会共用 localStorage 的 consoleToken。
      // 后加载的实例会把前一个的令牌覆盖掉，导致另一方所有 /api 调用 401。
      // 这里给 /bridge2/ 下的 Storage 加实例前缀，隔离两边的令牌与主题设置。
      html = html.replace(
        /<head[^>]*>/i,
        '$&<script>(function(){'
        + 'if(location.pathname.indexOf("/bridge2/")!==0)return;'
        + 'var pre="bridge2::";'
        + 'var gp=Storage.prototype.getItem,sp=Storage.prototype.setItem,rp=Storage.prototype.removeItem;'
        + 'Storage.prototype.getItem=function(k){return gp.call(this,pre+k);};'
        + 'Storage.prototype.setItem=function(k,v){return sp.call(this,pre+k,v);};'
        + 'Storage.prototype.removeItem=function(k){return rp.call(this,pre+k);};'
        + '})();</script>'
      );
    }
    if (prefix === '/snow') {
      // [local patch] SnowLuma 已关闭登录：预置 token 并重写绝对 /api 路径，
      // 否则它在 iframe 里会打到外壳根路径，被桥接的 /api 抢先接走。
      html = html.replace(
        /<head[^>]*>/i,
        '$&<script>(function(){try{localStorage.setItem("snowluma_token","local-no-auth")}catch(e){}})();'
        + '<script>(function(){'
        + 'var fix=function(u){if(typeof u==="string"&&u.charAt(0)==="/"&&u.indexOf("/snow/")!==0&&u.indexOf("/api/")===0)return "/snow"+u;return u;};'
        + 'var of=window.fetch;window.fetch=function(i,o){try{if(typeof i==="string")i=fix(i);else if(i&&i.url)i=new Request(fix(i.url),i);}catch(e){}return of.call(this,i,o);};'
        + 'var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=fix(u);return oo.apply(this,a);};'
        + 'var os=EventSource;window.EventSource=function(u,c){return new os(fix(u),c);};'
        + '})();</script>'
      );
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.removeHeader('content-length');
    response.end(html);
  } else if (type.includes('javascript') || type.includes('css')) {
    let text = await upstream.text();
    text = rewriteText(text, prefix);
    response.removeHeader('content-length');
    response.end(text);
  } else {
    response.end(Buffer.from(await upstream.arrayBuffer()));
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    // 注意：/bridge2 必须先于 /bridge 判断，否则会被 /bridge 前缀吃掉。
    if (request.url.startsWith('/bridge2')) {
      await proxy(request, response, 'http://127.0.0.1:3200', '/bridge2');
      return;
    }
    if (request.url.startsWith('/bridge')) {
      await proxy(request, response, 'http://127.0.0.1:3100', '/bridge');
      return;
    }
    if (request.url.startsWith('/snow')) {
      await proxy(request, response, 'http://127.0.0.1:5099', '/snow');
      return;
    }

    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__BRIDGE_URL__', consoleUrlFor('/bridge', bridgeTokenPath));
    html = html.replace('__BRIDGE2_URL__', consoleUrlFor('/bridge2', bridge2TokenPath));
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "frame-src 'self' http://127.0.0.1:3100 http://127.0.0.1:3200 http://127.0.0.1:5099 http://localhost:3100 http://localhost:3200 http://localhost:5099; frame-ancestors 'self';",
    });
    response.end(html);
  } catch (error) {
    response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`Proxy error: ${error.message}`);
  }
});

server.on('upgrade', (_request, socket) => {
  socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  socket.destroy();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Unified console: http://127.0.0.1:${port}/`);
});
