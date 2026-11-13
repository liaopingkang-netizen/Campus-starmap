'use strict';
/* 校招星图 · Netlify Function（v2）
 * 所有 /api/* 请求经 netlify.toml 重定向到此函数；数据存于 Netlify Blobs（强一致）。
 * 存储在请求内惰性初始化：生产环境由 Netlify 自动注入 siteID/token，
 * 本地 `netlify dev` 由 CLI 注入；避免模块加载期因缺少上下文而报错。
 */
const { getStore } = require('@netlify/blobs');
const { createCore } = require('../../shared/core');
const MAP = require('../../shared/map.json');
const SEED = require('../../shared/seed.json');

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

exports.handler = async (event) => {
  const method = event.httpMethod || 'GET';
  // 经重定向后 path 为原始 /api/...；兼容直接访问 /.netlify/functions/api 的情形
  let path = event.path || '/';
  const fnPrefix = '/.netlify/functions/api';
  if (path.startsWith(fnPrefix)) path = path.slice(fnPrefix.length) || '/';
  if (!path.startsWith('/')) path = '/' + path;

  let body;
  if (event.body) {
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
      if (raw.length > getCore().MAX_BODY) return { statusCode: 413, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: '请求体过大' }) };
      body = JSON.parse(raw);
    } catch (e) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: '请求体不是合法 JSON' }) };
    }
  }
  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (headers['x-session'] || '');
  const ip = headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) || 'unknown';
  const query = new URLSearchParams(event.queryStringParameters || {});

  let res;
  try {
    res = await getCore().handle({ method, path, query, body, token, ip });
  } catch (e) {
    console.error('函数初始化/处理错误:', e);
    const msg = /Blobs|environment/i.test(String(e && e.message)) ? '存储未就绪：请在 Netlify 环境或 netlify dev 中运行' : '服务器内部错误';
    return { statusCode: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: msg }) };
  }
  return { statusCode: res.status, headers: res.headers, body: res.body };
};
