'use strict';
/* 校招星图 · 核心业务逻辑（存储无关）
 * 由 Netlify Function（Netlify Blobs 存储）与本地测试模拟器（文件存储）共同复用。
 * 通过注入的 store { get(key), set(key, value) } 读写持久化数据。
 */
import crypto from 'crypto';
import { collectAll, mergeIntoDb } from './harvester.js';

const SESSION_TTL = 7 * 24 * 3600 * 1000;
const MAX_BODY = 4 * 1024 * 1024;
const DB_KEY = 'db';
const RL_KEY = 'ratelimit';

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function hashPassword(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pass), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(pass, salt, hash) {
  if (!salt || !hash) return false;
  try { const h = crypto.scryptSync(String(pass), salt, 64); const b = Buffer.from(hash, 'hex'); return h.length === b.length && crypto.timingSafeEqual(h, b); }
  catch (e) { return false; }
}
function randId(p) { return p + crypto.randomBytes(8).toString('hex'); }
function now() { return Date.now(); }
function pickEnum(v, list, fallback) { return list.includes(v) ? v : fallback; }
function isExpired(j) { return new Date(j.ddl + 'T00:00:00') < new Date(new Date().toDateString()); }

function json(status, obj, extraHeaders) {
  return { status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extraHeaders || {}), body: JSON.stringify(obj) };
}

function createCore({ store, MAP, SEED }) {
  const META = SEED;
  const PROV_NAME = {}; MAP.provs.forEach(p => PROV_NAME[p.c] = p.n);

  async function loadDb() {
    let db = await store.get(DB_KEY);
    if (!db || !db.companies) {
      db = {
        adminHash: null, adminSalt: null,
        companies: SEED.companies, requests: [], grants: [], sessions: {},
        log: [{ t: now(), m: '线上版初始化：载入 ' + SEED.companies.length + ' 家企业种子数据' }],
        createdAt: now()
      };
      await store.set(DB_KEY, db);
    }
    db.requests = db.requests || []; db.grants = db.grants || [];
    db.sessions = db.sessions || {}; db.log = db.log || [];
    db.pending = db.pending || []; db.harvest = db.harvest || null;
    return db;
  }
  async function saveDb(db) { await store.set(DB_KEY, db); }
  function addLog(db, m) { db.log.unshift({ t: now(), m }); if (db.log.length > 300) db.log.length = 300; }
  function activeJobs(co) { return co.jobs.filter(j => j.status !== 'off' && !isExpired(j)); }
  function publicCompanies(db) { return db.companies.filter(c => activeJobs(c).length > 0); }
  function findCo(db, id) { return db.companies.find(c => c.id === id); }
  function findJob(db, id) { for (const c of db.companies) { const j = c.jobs.find(x => x.id === id); if (j) return { co: c, job: j }; } return null; }
  function findGrant(db, id) { return db.grants.find(g => g.id === id); }
  function findReq(db, id) { return db.requests.find(r => r.id === id); }

  function sanitizeCompany(c) {
    return {
      id: c.id, code: c.code, name: c.name, nature: c.nature, industry: c.industry, city: c.city, url: c.url,
      veri: c.veri, intro: c.intro, channel: c.channel, color: c.color, addedAt: c.addedAt, updatedAt: c.updatedAt,
      jobs: c.jobs.map(j => ({ id: j.id, coId: j.coId, name: j.name, cat: j.cat, city: j.city, edu: j.edu, type: j.type, ddl: j.ddl, hot: j.hot, applyUrl: j.applyUrl || '', status: j.status, addedAt: j.addedAt, updatedAt: j.updatedAt }))
    };
  }
  function sanitizePublicCompany(c) { const s = sanitizeCompany(c); s.jobs = s.jobs.filter(j => j.status !== 'off' && !isExpired(j)); return s; }
  function statsPayload(db) {
    const pub = publicCompanies(db), provStats = {};
    pub.forEach(c => { const n = activeJobs(c).length; if (!provStats[c.code]) provStats[c.code] = { co: 0, jobs: 0 }; provStats[c.code].co++; provStats[c.code].jobs += n; });
    return {
      companies: pub.map(sanitizePublicCompany), provStats,
      totals: { prov: Object.keys(provStats).length, co: pub.length, jobs: pub.reduce((s, c) => s + activeJobs(c).length, 0) },
      updatedAt: db.companies.reduce((t, c) => Math.max(t, c.updatedAt || 0, ...c.jobs.map(j => j.updatedAt || 0)), 0)
    };
  }
  function makeGrantFor(db, req, days) {
    let grant = db.grants.find(g => g.reqId === req.id && g.status === 'active');
    if (!grant) {
      grant = { id: randId('g_'), reqId: req.id, name: req.name, contact: req.contact, status: 'active', createdAt: now(), expiresAt: days ? now() + days * 86400000 : 0, key: crypto.randomBytes(12).toString('hex') };
      db.grants.unshift(grant);
    }
    req.status = 'approved'; req.grantId = grant.id;
    return grant;
  }

  // 会话
  function createSession(db, data) { const token = crypto.randomBytes(24).toString('hex'); db.sessions[token] = Object.assign({ createdAt: now() }, data); return token; }
  function getSession(db, token) {
    if (!token) return null;
    const s = db.sessions[token];
    if (!s) return null;
    if (now() - s.createdAt > SESSION_TTL) { delete db.sessions[token]; return null; }
    if (s.role === 'member') {
      const g = findGrant(db, s.gid);
      if (!g || g.status !== 'active' || (g.key && s.key && g.key !== s.key)) { delete db.sessions[token]; return null; }
      if (g.expiresAt && now() > g.expiresAt) { delete db.sessions[token]; return null; }
    }
    return { token, data: s };
  }

  // 限流（best-effort，单管理员场景足够）
  async function rateLimit(key, max, windowMs) {
    let rl = (await store.get(RL_KEY)) || {};
    const t = now();
    let b = rl[key];
    if (!b || t - b.start > windowMs) { b = { start: t, count: 0 }; }
    b.count++; rl[key] = b;
    for (const k of Object.keys(rl)) if (t - rl[k].start > 600000) delete rl[k];
    await store.set(RL_KEY, rl);
    return b.count <= max;
  }

  /* ---- 路由处理 ---- */
  const routes = [];
  function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }
  function matchRoute(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const keys = [];
      const re = new RegExp('^' + r.pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
      const m = pathname.match(re);
      if (m) { const params = {}; keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1])); return { handler: r.handler, params }; }
    }
    return null;
  }

  route('GET', '/api/config', async (ctx) => json(200, { hasAdmin: !!ctx.db.adminHash, site: '校招星图', version: 'netlify-1.0' }));
  route('GET', '/api/map', async () => ({ status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' }, body: JSON.stringify(MAP) }));
  route('GET', '/api/meta', async () => json(200, { NATURES: META.NATURES, INDUSTRIES: META.INDUSTRIES, CATS: META.CATS, EDUS: META.EDUS, TYPES: META.TYPES, AV_COLORS: META.AV_COLORS, provName: PROV_NAME }));

  route('POST', '/api/requests', async (ctx) => {
    if (!await rateLimit('req:' + ctx.ip, 20, 3600000)) return json(429, { error: '提交过于频繁，请稍后再试' });
    const b = ctx.body || {};
    const name = String(b.name || '').trim().slice(0, 40), contact = String(b.contact || '').trim().slice(0, 80), note = String(b.note || '').trim().slice(0, 200);
    if (!name || !contact) return json(400, { error: '请填写称呼与联系方式' });
    const existing = ctx.db.requests.find(r => r.contact === contact && r.status === 'pending');
    if (existing) return json(200, { request: existing, reused: true });
    const request = { id: randId('r_'), name, contact, note, status: 'pending', createdAt: now() };
    ctx.db.requests.unshift(request);
    addLog(ctx.db, '新访问申请：' + name + '（' + contact + '）');
    ctx.dirty = true;
    return json(200, { request });
  });
  route('GET', '/api/requests/:id/status', async (ctx) => {
    const r = findReq(ctx.db, ctx.params.id);
    if (!r) return json(404, { error: '申请不存在' });
    if (r.status !== 'approved') return json(200, { status: r.status });
    const g = findGrant(ctx.db, r.grantId);
    if (!g || g.status !== 'active') return json(200, { status: 'revoked' });
    const contact = ctx.query.get('contact') || '';
    if (contact !== r.contact) return json(200, { status: 'approved', token: null });
    return json(200, { status: 'approved', token: g.token || null, grantId: g.id, name: g.name });
  });
  route('POST', '/api/admin/setup', async (ctx) => {
    if (ctx.db.adminHash) return json(409, { error: '管理员已设置，请直接登录' });
    if (!await rateLimit('setup:' + ctx.ip, 10, 3600000)) return json(429, { error: '尝试过于频繁' });
    const pass = String((ctx.body || {}).password || '');
    if (pass.length < 6) return json(400, { error: '口令至少 6 位' });
    const h = hashPassword(pass); ctx.db.adminSalt = h.salt; ctx.db.adminHash = h.hash;
    addLog(ctx.db, '初始化管理员口令');
    const token = createSession(ctx.db, { role: 'admin', name: '管理员' });
    ctx.dirty = true;
    return json(200, { token, role: 'admin', name: '管理员' });
  });
  route('POST', '/api/admin/login', async (ctx) => {
    if (!await rateLimit('login:' + ctx.ip, 15, 900000)) return json(429, { error: '登录尝试过于频繁，请 15 分钟后再试' });
    if (!verifyPassword((ctx.body || {}).password, ctx.db.adminSalt, ctx.db.adminHash)) return json(401, { error: '口令不正确' });
    const token = createSession(ctx.db, { role: 'admin', name: '管理员' });
    addLog(ctx.db, '管理员登录'); ctx.dirty = true;
    return json(200, { token, role: 'admin', name: '管理员' });
  });
  route('POST', '/api/auth/grant', async (ctx) => {
    if (!await rateLimit('grant:' + ctx.ip, 30, 900000)) return json(429, { error: '验证过于频繁，请稍后再试' });
    const code = String((ctx.body || {}).code || '').trim();
    const g = ctx.db.grants.find(x => x.token === code);
    if (!g) return json(401, { error: '授权码无效' });
    if (g.status !== 'active') return json(403, { error: '该授权已被管理员作废' });
    if (g.expiresAt && now() > g.expiresAt) return json(403, { error: '授权码已过期' });
    const token = createSession(ctx.db, { role: 'member', name: g.name, gid: g.id, key: g.key });
    addLog(ctx.db, '授权解锁访问：' + g.name); ctx.dirty = true;
    return json(200, { token, role: 'member', name: g.name });
  });
  route('GET', '/api/me', async (ctx) => {
    const s = getSession(ctx.db, ctx.token);
    if (!s) return json(401, { error: '未登录' });
    return json(200, { role: s.data.role, name: s.data.name });
  });
  route('POST', '/api/logout', async (ctx) => {
    const s = getSession(ctx.db, ctx.token);
    if (s) { delete ctx.db.sessions[s.token]; ctx.dirty = true; }
    return json(200, { ok: true });
  });

  // 需授权
  function auth(ctx, role) {
    const s = getSession(ctx.db, ctx.token);
    if (!s) return { err: json(401, { error: '未登录或授权已失效，请重新进入' }) };
    if (role === 'admin' && s.data.role !== 'admin') return { err: json(403, { error: '该操作仅管理员可执行' }) };
    return { s };
  }
  route('GET', '/api/stats', async (ctx) => { const a = auth(ctx); if (a.err) return a.err; return json(200, statsPayload(ctx.db)); });
  route('GET', '/api/companies', async (ctx) => { const a = auth(ctx); if (a.err) return a.err; return json(200, { companies: publicCompanies(ctx.db).map(sanitizePublicCompany) }); });

  // 管理员：访问审批
  route('GET', '/api/admin/requests', async (ctx) => { const a = auth(ctx, 'admin'); if (a.err) return a.err; return json(200, { requests: ctx.db.requests }); });
  route('POST', '/api/admin/requests/:id/approve', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const r = findReq(ctx.db, ctx.params.id); if (!r) return json(404, { error: '申请不存在' });
    const days = +(ctx.body || {}).days || 0;
    const grant = makeGrantFor(ctx.db, r, days);
    if (!grant.token) grant.token = 'XK-' + crypto.randomBytes(9).toString('hex').toUpperCase();
    addLog(ctx.db, '批准访问申请：' + r.name); ctx.dirty = true;
    return json(200, { grant: { id: grant.id, name: grant.name, token: grant.token, status: grant.status, expiresAt: grant.expiresAt } });
  });
  route('POST', '/api/admin/requests/:id/reject', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const r = findReq(ctx.db, ctx.params.id); if (!r) return json(404, { error: '申请不存在' });
    r.status = 'rejected'; addLog(ctx.db, '拒绝访问申请：' + r.name); ctx.dirty = true;
    return json(200, { ok: true });
  });
  route('GET', '/api/admin/grants', async (ctx) => { const a = auth(ctx, 'admin'); if (a.err) return a.err; return json(200, { grants: ctx.db.grants.map(g => ({ id: g.id, name: g.name, contact: g.contact, status: g.status, createdAt: g.createdAt, expiresAt: g.expiresAt, token: g.token })) }); });
  route('POST', '/api/admin/grants', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const b = ctx.body || {}; const name = String(b.name || '').trim().slice(0, 40);
    if (!name) return json(400, { error: '请填写对方称呼' });
    const days = +b.days || 0;
    const g = { id: randId('g_'), reqId: '', name, contact: String(b.contact || '').trim().slice(0, 80), status: 'active', createdAt: now(), expiresAt: days ? now() + days * 86400000 : 0, key: crypto.randomBytes(12).toString('hex'), token: 'XK-' + crypto.randomBytes(9).toString('hex').toUpperCase() };
    ctx.db.grants.unshift(g); addLog(ctx.db, '直接发放授权：' + name); ctx.dirty = true;
    return json(200, { grant: { id: g.id, name: g.name, token: g.token, status: g.status, expiresAt: g.expiresAt } });
  });
  route('POST', '/api/admin/grants/:id/revoke', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const g = findGrant(ctx.db, ctx.params.id); if (!g) return json(404, { error: '授权不存在' });
    g.status = 'revoked';
    for (const t of Object.keys(ctx.db.sessions)) if (ctx.db.sessions[t].role === 'member' && ctx.db.sessions[t].gid === g.id) delete ctx.db.sessions[t];
    addLog(ctx.db, '作废授权：' + g.name); ctx.dirty = true;
    return json(200, { ok: true });
  });
  route('POST', '/api/admin/password', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const b = ctx.body || {};
    const oldOk = ctx.db.adminSalt ? verifyPassword(b.old, ctx.db.adminSalt, ctx.db.adminHash) : (sha256(String(b.old || '')) === ctx.db.adminHash);
    if (!oldOk) return json(401, { error: '当前口令不正确' });
    if (String(b.new || '').length < 6) return json(400, { error: '新口令至少 6 位' });
    const h = hashPassword(b.new); ctx.db.adminSalt = h.salt; ctx.db.adminHash = h.hash;
    addLog(ctx.db, '修改管理员口令'); ctx.dirty = true;
    return json(200, { ok: true });
  });
  route('GET', '/api/admin/log', async (ctx) => { const a = auth(ctx, 'admin'); if (a.err) return a.err; return json(200, { log: ctx.db.log }); });

  // 管理员：岗位管理
  route('GET', '/api/admin/companies', async (ctx) => { const a = auth(ctx, 'admin'); if (a.err) return a.err; return json(200, { companies: ctx.db.companies.map(sanitizeCompany) }); });
  route('POST', '/api/admin/companies', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const b = ctx.body || {}; const name = String(b.name || '').trim();
    if (!name || !b.city || !PROV_NAME[+b.code]) return json(400, { error: '请填写企业名称、城市与有效省份' });
    if (!/^https?:\/\/.+/.test(String(b.url || ''))) return json(400, { error: '链接需以 http(s):// 开头' });
    if (ctx.db.companies.some(c => c.name === name)) return json(409, { error: '已存在同名企业' });
    const co = { id: randId('c_'), code: +b.code, name, nature: pickEnum(b.nature, META.NATURES, '民企'), industry: pickEnum(b.industry, META.INDUSTRIES, '互联网'), city: String(b.city).trim(), url: String(b.url).trim(), veri: [0, 1, 2].includes(+b.veri) ? +b.veri : 0, intro: String(b.intro || '').trim(), channel: String(b.channel || '').trim(), color: META.AV_COLORS[name.charCodeAt(0) % META.AV_COLORS.length], addedAt: now(), updatedAt: now(), jobs: [] };
    ctx.db.companies.push(co); addLog(ctx.db, '新增企业：' + name); ctx.dirty = true;
    return json(200, { company: sanitizeCompany(co) });
  });
  route('PUT', '/api/admin/companies/:id', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const co = findCo(ctx.db, ctx.params.id); if (!co) return json(404, { error: '企业不存在' });
    const b = ctx.body || {};
    if (b.name) co.name = String(b.name).trim();
    if (b.code && PROV_NAME[+b.code]) co.code = +b.code;
    if (b.nature) co.nature = pickEnum(b.nature, META.NATURES, co.nature);
    if (b.industry) co.industry = pickEnum(b.industry, META.INDUSTRIES, co.industry);
    if (b.city) co.city = String(b.city).trim();
    if (b.url && /^https?:\/\/.+/.test(b.url)) co.url = String(b.url).trim();
    if ([0, 1, 2].includes(+b.veri)) co.veri = +b.veri;
    if (b.intro != null) co.intro = String(b.intro).trim();
    if (b.channel != null) co.channel = String(b.channel).trim();
    co.updatedAt = now(); addLog(ctx.db, '编辑企业：' + co.name); ctx.dirty = true;
    return json(200, { company: sanitizeCompany(co) });
  });
  route('DELETE', '/api/admin/companies/:id', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const co = findCo(ctx.db, ctx.params.id); if (!co) return json(404, { error: '企业不存在' });
    ctx.db.companies.splice(ctx.db.companies.indexOf(co), 1);
    addLog(ctx.db, '删除企业：' + co.name); ctx.dirty = true;
    return json(200, { ok: true, removed: sanitizeCompany(co) });
  });
  route('POST', '/api/admin/companies/:id/jobs', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const co = findCo(ctx.db, ctx.params.id); if (!co) return json(404, { error: '企业不存在' });
    const b = ctx.body || {};
    if (!String(b.name || '').trim() || !String(b.city || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.ddl || ''))) return json(400, { error: '请填写岗位名称、城市与有效截止日期' });
    const j = { id: randId('j_'), coId: co.id, name: String(b.name).trim(), cat: pickEnum(b.cat, META.CATS, '研发'), city: String(b.city).trim(), edu: pickEnum(b.edu, META.EDUS, '本科'), type: pickEnum(b.type, META.TYPES, '秋招'), ddl: b.ddl, hot: !!b.hot, applyUrl: String(b.applyUrl || '').trim(), status: 'on', addedAt: now(), updatedAt: now() };
    co.jobs.push(j); co.updatedAt = now(); addLog(ctx.db, '上架新岗位：' + co.name + '「' + j.name + '」'); ctx.dirty = true;
    return json(200, { job: j });
  });
  route('PUT', '/api/admin/jobs/:id', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const found = findJob(ctx.db, ctx.params.id); if (!found) return json(404, { error: '岗位不存在' });
    const b = ctx.body || {}; const j = found.job;
    ['name', 'city'].forEach(k => { if (b[k] != null) j[k] = String(b[k]).trim(); });
    if (b.cat != null) j.cat = pickEnum(b.cat, META.CATS, j.cat);
    if (b.edu != null) j.edu = pickEnum(b.edu, META.EDUS, j.edu);
    if (b.type != null) j.type = pickEnum(b.type, META.TYPES, j.type);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.ddl || ''))) j.ddl = b.ddl;
    if (b.hot != null) j.hot = !!b.hot;
    if (b.applyUrl != null) j.applyUrl = String(b.applyUrl).trim();
    if (b.status === 'on' || b.status === 'off') j.status = b.status;
    j.updatedAt = now(); found.co.updatedAt = now(); addLog(ctx.db, '编辑岗位：' + found.co.name + '「' + j.name + '」'); ctx.dirty = true;
    return json(200, { job: j });
  });
  route('DELETE', '/api/admin/jobs/:id', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const found = findJob(ctx.db, ctx.params.id); if (!found) return json(404, { error: '岗位不存在' });
    found.co.jobs.splice(found.co.jobs.indexOf(found.job), 1); found.co.updatedAt = now();
    addLog(ctx.db, '删除岗位：' + found.co.name + '「' + found.job.name + '」'); ctx.dirty = true;
    return json(200, { ok: true, removed: { coId: found.co.id, job: found.job } });
  });
  route('POST', '/api/admin/jobs/bulk', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const b = ctx.body || {}; const ids = Array.isArray(b.ids) ? b.ids : []; const status = b.status === 'off' ? 'off' : 'on';
    let changed = 0;
    ids.forEach(id => { const f = findJob(ctx.db, id); if (!f) return; if (status === 'on' && isExpired(f.job)) return; if (f.job.status !== status) { f.job.status = status; f.job.updatedAt = now(); f.co.updatedAt = now(); changed++; } });
    addLog(ctx.db, '批量' + (status === 'on' ? '上架' : '下架') + ' ' + changed + ' 个岗位'); ctx.dirty = true;
    return json(200, { changed });
  });
  route('POST', '/api/admin/jobs/bulk-delete', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const ids = Array.isArray((ctx.body || {}).ids) ? ctx.body.ids : []; const removed = [];
    ids.forEach(id => { const f = findJob(ctx.db, id); if (!f) return; const index = f.co.jobs.indexOf(f.job); f.co.jobs.splice(index, 1); f.co.updatedAt = now(); removed.push({ coId: f.co.id, job: f.job, index }); });
    addLog(ctx.db, '批量删除 ' + removed.length + ' 个岗位'); ctx.dirty = true;
    return json(200, { removed });
  });
  route('POST', '/api/admin/restore', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const b = ctx.body || {}; let restored = 0;
    if (b.company && b.company.id && !findCo(ctx.db, b.company.id)) {
      const c = b.company; c.updatedAt = now();
      c.jobs = (c.jobs || []).map(j => Object.assign({}, j, { coId: c.id, updatedAt: now() }));
      ctx.db.companies.splice(Math.min(+b.index || ctx.db.companies.length, ctx.db.companies.length), 0, c);
      addLog(ctx.db, '撤销删除企业：' + c.name); restored++;
    }
    if (Array.isArray(b.jobs)) {
      b.jobs.forEach(item => {
        const co = findCo(ctx.db, item.coId);
        if (!co || !item.job || co.jobs.some(j => j.id === item.job.id)) return;
        const j = Object.assign({}, item.job, { coId: co.id, updatedAt: now() });
        co.jobs.splice(Math.min(+item.index || co.jobs.length, co.jobs.length), 0, j);
        co.updatedAt = now(); restored++;
      });
      if (restored) addLog(ctx.db, '撤销删除 ' + restored + ' 条记录');
    }
    ctx.dirty = true;
    return json(200, { restored });
  });
  route('POST', '/api/admin/import', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const b = ctx.body; const arr = Array.isArray(b) ? b : (Array.isArray(b && b.companies) ? b.companies : null);
    if (!arr) return json(400, { error: '格式不符：需为企业数组或含 companies 数组' });
    let added = 0, updated = 0;
    arr.forEach(c => {
      if (!c || !c.name || !PROV_NAME[+c.code]) return;
      const clean = { id: c.id || randId('c_'), code: +c.code, name: String(c.name).trim(), nature: c.nature || '民企', industry: c.industry || '互联网', city: String(c.city || ''), url: String(c.url || ''), veri: [0, 1, 2].includes(+c.veri) ? +c.veri : 0, intro: String(c.intro || ''), channel: String(c.channel || ''), color: META.AV_COLORS[(String(c.name).charCodeAt(0) || 0) % META.AV_COLORS.length], addedAt: +c.addedAt || now(), updatedAt: now(), jobs: [] };
      (Array.isArray(c.jobs) ? c.jobs : []).forEach(j => {
        if (!j || !j.name || !/^\d{4}-\d{2}-\d{2}$/.test(String(j.ddl || ''))) return;
        clean.jobs.push({ id: j.id || randId('j_'), coId: clean.id, name: String(j.name).trim(), cat: j.cat || '研发', city: String(j.city || clean.city), edu: j.edu || '本科', type: j.type || '秋招', ddl: j.ddl, hot: !!j.hot, applyUrl: String(j.applyUrl || ''), status: j.status === 'off' ? 'off' : 'on', addedAt: +j.addedAt || now(), updatedAt: now() });
      });
      const idx = ctx.db.companies.findIndex(x => x.id === clean.id);
      if (idx >= 0) { ctx.db.companies[idx] = clean; updated++; } else { ctx.db.companies.push(clean); added++; }
    });
    addLog(ctx.db, '导入数据：新增 ' + added + ' 家 / 更新 ' + updated + ' 家企业'); ctx.dirty = true;
    return json(200, { added, updated });
  });
  route('GET', '/api/admin/export', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    return { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="starmap-data.json"' }, body: JSON.stringify({ site: '校招星图', version: 'netlify-1.0', exportedAt: new Date().toISOString(), companies: ctx.db.companies }, null, 2) };
  });
  route('POST', '/api/admin/reset', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    ctx.db.companies = SEED.companies; addLog(ctx.db, '重置为初始收录数据'); ctx.dirty = true;
    return json(200, { ok: true });
  });
  route('POST', '/api/admin/factory-reset', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    ctx.db.adminHash = null; ctx.db.adminSalt = null;
    ctx.db.companies = SEED.companies;
    ctx.db.requests = []; ctx.db.grants = []; ctx.db.sessions = {};
    ctx.db.pending = []; ctx.db.harvest = null;
    ctx.db.log = [{ t: now(), m: '站点已重置为初始状态（管理员口令、授权与申请已清空）' }];
    ctx.dirty = true;
    return json(200, { ok: true });
  });
  route('GET', '/api/admin/version', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    return json(200, {
      updatedAt: ctx.db.companies.reduce((t, c) => Math.max(t, c.updatedAt || 0, ...c.jobs.map(j => j.updatedAt || 0)), 0),
      requests: ctx.db.requests.length, pending: ctx.db.requests.filter(r => r.status === 'pending').length,
      grants: ctx.db.grants.filter(g => g.status === 'active').length, logTop: ctx.db.log.length ? ctx.db.log[0].t : 0,
      harvestPending: (ctx.db.pending || []).length, harvestLast: ctx.db.harvest ? ctx.db.harvest.lastRun : 0
    });
  });

  /* ---- 自动采集管理 ---- */
  route('POST', '/api/admin/harvest/run', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const { items, errors } = await collectAll();
    const merged = mergeIntoDb(ctx.db, items, now());
    let expired = 0;
    const today = new Date(new Date().toDateString());
    for (const c of ctx.db.companies) for (const j of c.jobs) {
      if (j.status !== 'off' && new Date(j.ddl + 'T00:00:00') < today) { j.status = 'off'; j.updatedAt = now(); expired++; }
    }
    ctx.db.harvest = { lastRun: now(), items: items.length, ...merged, errors, expired };
    addLog(ctx.db, `手动采集：公告 ${items.length} 条（新增待审核 ${merged.added} / 补充链接 ${merged.linked}），下架过期岗位 ${expired} 个`);
    ctx.dirty = true;
    return json(200, ctx.db.harvest);
  });
  route('GET', '/api/admin/harvest/pending', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    return json(200, { pending: ctx.db.pending || [], last: ctx.db.harvest || null });
  });
  route('POST', '/api/admin/harvest/approve', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const b = ctx.body || {};
    const p = (ctx.db.pending || []).find(x => x.id === b.id);
    if (!p) return json(404, { error: '待审核条目不存在' });
    if (!PROV_NAME[+b.code]) return json(400, { error: '请选择有效省份' });
    const name = String(b.name || p.company).trim();
    if (ctx.db.companies.some(c => c.name === name)) return json(409, { error: '已存在同名企业，请直接编辑该企业' });
    const co = {
      id: randId('c_'), code: +b.code, name, nature: pickEnum(b.nature, META.NATURES, '央企/国企'),
      industry: pickEnum(b.industry, META.INDUSTRIES, '互联网'), city: String(b.city || '').trim() || '全国',
      url: p.url, veri: 2, intro: String(b.intro || '').trim() || ('来源：' + p.source + '《' + p.title + '》'),
      channel: p.source, color: META.AV_COLORS[name.charCodeAt(0) % META.AV_COLORS.length],
      addedAt: now(), updatedAt: now(), jobs: []
    };
    // 可选：同时创建一个岗位
    if (b.job && b.job.name && /^\d{4}-\d{2}-\d{2}$/.test(String(b.job.ddl || ''))) {
      co.jobs.push({ id: randId('j_'), coId: co.id, name: String(b.job.name).trim(), cat: pickEnum(b.job.cat, META.CATS, '研发'), city: String(b.job.city || co.city), edu: pickEnum(b.job.edu, META.EDUS, '本科'), type: pickEnum(b.job.type, META.TYPES, '秋招'), ddl: b.job.ddl, hot: false, applyUrl: '', status: 'on', addedAt: now(), updatedAt: now() });
    }
    ctx.db.companies.push(co);
    ctx.db.pending = ctx.db.pending.filter(x => x.id !== p.id);
    addLog(ctx.db, '采纳采集线索：' + name + '（' + (PROV_NAME[co.code] || '') + '）');
    ctx.dirty = true;
    return json(200, { company: sanitizeCompany(co) });
  });
  route('POST', '/api/admin/harvest/dismiss', async (ctx) => {
    const a = auth(ctx, 'admin'); if (a.err) return a.err;
    const id = (ctx.body || {}).id;
    ctx.db.pending = (ctx.db.pending || []).filter(x => x.id !== id);
    ctx.dirty = true;
    return json(200, { ok: true });
  });

  /* ---- 请求分发 ---- */
  async function handle({ method, path, query, body, token, ip }) {
    const m = matchRoute(method, path);
    if (!m) return json(404, { error: '接口不存在' });
    const db = await loadDb();
    const ctx = { db, params: m.params, query: query || new URLSearchParams(), body, token, ip: ip || 'unknown', dirty: false };
    let res;
    try { res = await m.handler(ctx); }
    catch (e) { console.error('接口错误:', e); return json(500, { error: '服务器内部错误' }); }
    if (ctx.dirty) await saveDb(db);
    return res;
  }

  return { handle, MAX_BODY };
}

export { createCore };
