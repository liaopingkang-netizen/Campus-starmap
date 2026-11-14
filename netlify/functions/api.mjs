/* 校招星图 · Netlify Function（v2 格式）
 * 所有 /api/* 请求经 netlify.toml 重定向到此函数；数据存于 Netlify Blobs（强一致）。
 * 采用 Functions 2.0 语法（默认导出 + 标准 Request/Response），
 * 生产环境由 Netlify 自动注入 Blobs 上下文（v1 的 exports.handler 不会自动注入）。
 */
import { getStore } from '@netlify/blobs';
import { createCore } from '../../shared/core.js';
import MAP from '../../shared/map.json' with { type: 'json' };
import SEED from '../../shared/seed.json' with { type: 'json' };

let core = null;
function getCore() {
  if (core) return core;
  // 站点级强一致存储：审批/授权/岗位改动对所有访客立即可见
  const blobStore = getStore({ name: 'starmap', consistency: 'strong' });
  const store = {
    async get(key) { return await blobStore.get(key, { type: 'json' }); },
    async set(key, value) { await blobStore.setJSON(key, value); }
  };
  core = createCore({ store, MAP, SEED });
  return core;
}

export default async (req) => {
  const url = new URL(req.url);
  let path = url.pathname;
  const fnPrefix = '/.netlify/functions/api';
  if (path.startsWith(fnPrefix)) path = path.slice(fnPrefix.length) || '/';
  if (!path.startsWith('/')) path = '/' + path;

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const raw = await req.text();
    if (raw) {
      if (raw.length > getCore().MAX_BODY) {
        return new Response(JSON.stringify({ error: '请求体过大' }), { status: 413, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
      }
      try { body = JSON.parse(raw); }
      catch (e) {
        return new Response(JSON.stringify({ error: '请求体不是合法 JSON' }), { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
      }
    }
  }
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers.get('x-session') || '');
  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown';

  let res;
  try {
    res = await getCore().handle({ method: req.method, path, query: url.searchParams, body, token, ip });
  } catch (e) {
    console.error('函数初始化/处理错误:', e);
    const msg = /Blobs|environment/i.test(String(e && e.message)) ? '存储未就绪：请在 Netlify 环境或 netlify dev 中运行' : '服务器内部错误';
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
  return new Response(res.body, { status: res.status, headers: res.headers });
};
