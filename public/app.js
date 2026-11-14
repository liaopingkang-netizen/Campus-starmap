'use strict';
/* 校招星图 · 线上版前端 */

/* ---------------- 基础工具 ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function toast(msg, kind) {
  const t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 3000);
}
function copyText(text, okMsg) {
  function fb() { try { const ta = el('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(okMsg || '已复制', 'good'); } catch (e) { toast('复制失败，请手动选择复制', 'warn'); } }
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(okMsg || '已复制', 'good')).catch(fb); else fb();
}
function fmtTime(ts) { if (!ts) return '—'; const d = new Date(ts), p = n => String(n).padStart(2, '0'); return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
function fmtDate(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
function daysLeft(ddl) { return Math.ceil((new Date(ddl + 'T00:00:00') - TODAY) / 86400000); }
function isExpired(j) { return daysLeft(j.ddl) < 0; }
function activeJobs(co) { return co.jobs.filter(j => j.status !== 'off' && !isExpired(j)); }
function isNew(ts) { return Date.now() - ts < 7 * 86400000; }
function ddlText(ddl) { const d = daysLeft(ddl); if (d < 0) return '已截止'; if (d <= 14) return '剩 ' + d + ' 天'; return ddl.slice(5).replace('-', '月') + '日截止'; }

/* ---------------- API ---------------- */
const state = {
  token: localStorage.getItem('sm_token') || '', role: '', name: '',
  MAP: null, META: null, provName: {},
  companies: [], provStats: {}, totals: {}, updatedAt: 0,
  adminCompanies: [], requests: [], grants: [], log: [],
  view: 'map', prov: null, pNature: '', pIndustry: '',
  libQ: '', libProv: '', libNature: '', libIndustry: '', libSort: 'jobs',
  dCo: null, dCat: '', dType: '',
  adminQ: '', adminStatus: '', selected: new Set(),
  favs: new Set(), linkUrl: '', pollReq: null
};
try { JSON.parse(localStorage.getItem('sm_favs') || '[]').forEach(id => state.favs.add(id)); } catch (e) {}
function saveFavs() { try { localStorage.setItem('sm_favs', JSON.stringify([...state.favs])); } catch (e) {} }

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let data = null; try { data = await res.json(); } catch (e) {}
  if (!res.ok) { const err = new Error((data && data.error) || ('请求失败 ' + res.status)); err.status = res.status; throw err; }
  return data;
}
function isAdmin() { return state.role === 'admin'; }
function hasAccess() { return state.role === 'admin' || state.role === 'member'; }

/* ---------------- 门禁 ---------------- */
let gatePollTimer = null, contentPollTimer = null, adminPollTimer = null;
function setGateTab(name) {
  $$('.gate-tab').forEach(t => t.classList.toggle('active', t.dataset.gate === name));
  $$('.gate-panel').forEach(p => p.classList.remove('on'));
  $('#gate-' + name).classList.add('on');
}
function gateMsg(id, text, kind) { const m = $(id); m.textContent = text; m.className = 'gate-msg' + (kind ? ' ' + kind : ''); }
async function initGate() {
  try {
    const cfg = await api('/api/config');
    $('#gAdminSetup').hidden = cfg.hasAdmin;
    $('#gAdminLogin').hidden = !cfg.hasAdmin;
  } catch (e) { gateMsg('#gAdminMsg', '无法连接服务器，请确认服务已启动', 'err'); }
}
function startGatePoll(reqId, contact) {
  stopGatePoll();
  $('#gPollStatus').hidden = false;
  $('#gPollText').textContent = '已提交，等待管理员审批…通过后本页将自动解锁';
  gatePollTimer = setInterval(async () => {
    try {
      const r = await api('/api/requests/' + encodeURIComponent(reqId) + '/status?contact=' + encodeURIComponent(contact));
      if (r.status === 'approved' && r.token) {
        stopGatePoll();
        const auth = await api('/api/auth/grant', { method: 'POST', body: { code: r.token } });
        onAuthed(auth);
      } else if (r.status === 'rejected') {
        stopGatePoll(); $('#gPollStatus').hidden = true;
        gateMsg('#gApplyMsg', '管理员拒绝了本次申请，如有疑问请联系管理员', 'err');
      } else if (r.status === 'revoked') {
        stopGatePoll(); $('#gPollStatus').hidden = true;
        gateMsg('#gApplyMsg', '该授权已被管理员作废', 'err');
      }
    } catch (e) { /* 网络抖动忽略，继续轮询 */ }
  }, 4000);
}
function stopGatePoll() { if (gatePollTimer) { clearInterval(gatePollTimer); gatePollTimer = null; } }

async function onAuthed(auth) {
  state.token = auth.token; state.role = auth.role; state.name = auth.name;
  localStorage.setItem('sm_token', auth.token);
  stopGatePoll();
  await enterApp();
}
async function enterApp() {
  document.body.classList.remove('locked');
  $('#navAdmin').hidden = !isAdmin();
  $('#navAccess').hidden = !isAdmin();
  $('#logBtn').hidden = !isAdmin();
  $('#exitBtn').hidden = false;
  const rb = $('#roleBadge');
  if (isAdmin()) { rb.textContent = '管理员'; rb.className = 'badge role-admin'; }
  else { rb.textContent = '已授权 · ' + state.name; rb.className = 'badge role-member'; }
  await loadMeta();
  await refreshContent();
  switchView('map');
  startContentPoll();
  if (isAdmin()) { await refreshAdmin(); startAdminPoll(); }
}
function exitToGate() {
  stopContentPoll(); stopAdminPoll(); stopGatePoll();
  state.token = ''; state.role = ''; state.name = '';
  localStorage.removeItem('sm_token');
  api('/api/logout', { method: 'POST' }).catch(() => {});
  closeDrawer(); closeModal();
  document.body.classList.add('locked');
  $('#exitBtn').hidden = true;
  $('#gPollStatus').hidden = true;
  initGate();
}

/* ---------------- 数据加载 ---------------- */
async function loadMeta() {
  if (!state.MAP) state.MAP = await api('/api/map');
  if (!state.META) {
    state.META = await api('/api/meta');
    state.provName = state.META.provName;
    fillSelects();
    buildMap();
  }
}
async function refreshContent() {
  try {
    const s = await api('/api/stats');
    state.companies = s.companies; state.provStats = s.provStats; state.totals = s.totals; state.updatedAt = s.updatedAt;
    refreshMap(); buildChips(); renderPanel(); buildTicker(); updateStats();
    if (state.view === 'lib') renderLib();
    renderFavs();
    if ($('#drawer').classList.contains('on') && state.dCo) renderDrawerJobs();
    $('#onlineBadge').textContent = '● 实时在线';
  } catch (e) {
    if (e.status === 401) { toast('授权已失效，请重新进入', 'warn'); exitToGate(); }
    else $('#onlineBadge').textContent = '● 连接中断';
  }
}
function startContentPoll() { stopContentPoll(); contentPollTimer = setInterval(refreshContent, 12000); }
function stopContentPoll() { if (contentPollTimer) { clearInterval(contentPollTimer); contentPollTimer = null; } }
async function refreshAdmin() {
  if (!isAdmin()) return;
  try {
    const [c, r, g, l, h] = await Promise.all([
      api('/api/admin/companies'), api('/api/admin/requests'), api('/api/admin/grants'), api('/api/admin/log'), api('/api/admin/harvest/pending')
    ]);
    state.adminCompanies = c.companies; state.requests = r.requests; state.grants = g.grants; state.log = l.log;
    state.harvestAuto = h.autoAdded || []; state.harvestLast = h.last || null;
    if (state.view === 'admin') renderAdmin();
    if (state.view === 'access') renderAccess();
  } catch (e) { if (e.status === 401) exitToGate(); }
}
function startAdminPoll() {
  stopAdminPoll();
  let lastSig = '';
  adminPollTimer = setInterval(async () => {
    if (!isAdmin()) return;
    try {
      const v = await api('/api/admin/version');
      const sig = v.updatedAt + '|' + v.requests + '|' + v.pending + '|' + v.grants + '|' + v.logTop + '|' + (v.harvestAdded || 0) + '|' + (v.harvestLast || 0);
      if (sig !== lastSig) { lastSig = sig; await refreshAdmin(); await refreshContent(); }
    } catch (e) { if (e.status === 401) exitToGate(); }
  }, 8000);
}
function stopAdminPoll() { if (adminPollTimer) { clearInterval(adminPollTimer); adminPollTimer = null; } }

/* ---------------- 地图 ---------------- */
const HEAT = ['#102540', '#1b4a7a', '#2f9dd8', '#ffc24b', '#ff7847'];
const LABEL_OFF = { 11: [0, -10], 12: [20, 6], 31: [18, 4], 81: [18, 6], 82: [-18, 12] };
const pathEls = {}, chipEls = {};
function maxJobs() { return Math.max(1, ...Object.values(state.provStats).map(s => s.jobs)); }
function heatColor(n) { if (!n) return '#0d1830'; return HEAT[Math.min(HEAT.length - 1, Math.floor(n / maxJobs() * HEAT.length))]; }
function buildMap() {
  const svg = $('#chinaMap'), NS = 'http://www.w3.org/2000/svg', MAP = state.MAP;
  svg.setAttribute('viewBox', '0 0 ' + MAP.w + ' ' + MAP.h);
  svg.textContent = '';
  MAP.provs.forEach(p => {
    const g = document.createElementNS(NS, 'g');
    p.d.forEach(d => {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d); path.setAttribute('class', 'province');
      path.setAttribute('tabindex', '0'); path.setAttribute('role', 'button'); path.dataset.code = p.c;
      path.addEventListener('click', () => selectProv(p.c));
      path.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectProv(p.c); } });
      path.addEventListener('mouseenter', e => showTip(p.c, e));
      path.addEventListener('mousemove', moveTip);
      path.addEventListener('mouseleave', hideTip);
      g.appendChild(path);
    });
    const off = LABEL_OFF[p.c] || [0, 0];
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('x', p.lx + off[0]); label.setAttribute('y', p.ly + off[1]); label.setAttribute('class', 'prov-label');
    label.textContent = p.n; g.appendChild(label);
    svg.appendChild(g); pathEls[p.c] = g.querySelectorAll('.province');
  });
  const iw = MAP.inset.w, ih = MAP.inset.h, bx = MAP.w - iw - 18, by = MAP.h - ih - 46;
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', bx - 8); rect.setAttribute('y', by - 22); rect.setAttribute('width', iw + 16); rect.setAttribute('height', ih + 40);
  rect.setAttribute('class', 'inset-box'); rect.setAttribute('rx', '6'); svg.appendChild(rect);
  const it = document.createElementNS(NS, 'text'); it.setAttribute('x', bx); it.setAttribute('y', by - 8); it.setAttribute('class', 'inset-label'); it.textContent = '南海诸岛'; svg.appendChild(it);
  const ig = document.createElementNS(NS, 'g'); ig.setAttribute('transform', 'translate(' + bx + ',' + by + ')');
  MAP.inset.d.forEach(d => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('class', 'inset-ring'); ig.appendChild(p); });
  svg.appendChild(ig);
}
function refreshMap() {
  state.MAP.provs.forEach(p => {
    const st = state.provStats[p.c], fill = heatColor(st ? st.jobs : 0);
    pathEls[p.c].forEach(path => {
      path.setAttribute('fill', fill);
      path.setAttribute('aria-label', p.n + (st ? '，' + st.co + ' 家企业，' + st.jobs + ' 个岗位' : '，暂无在招企业'));
    });
  });
  const svg = $('#chinaMap'), NS = 'http://www.w3.org/2000/svg';
  svg.querySelectorAll('.pulse').forEach(n => n.remove());
  Object.keys(state.provStats).sort((a, b) => state.provStats[b].jobs - state.provStats[a].jobs).slice(0, 5).forEach(code => {
    const p = state.MAP.provs.find(x => x.c === +code); if (!p) return;
    const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'pulse');
    [0, 1.3].forEach(delay => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', p.lx); c.setAttribute('cy', p.ly); c.setAttribute('r', '3'); c.style.animationDelay = delay + 's'; g.appendChild(c); });
    svg.appendChild(g);
  });
}
function showTip(code, e) {
  const st = state.provStats[code], tip = $('#mapTip');
  tip.textContent = ''; tip.appendChild(el('b', null, state.provName[code]));
  tip.appendChild(el('div', 'tip-row', st ? st.co + ' 家企业 · ' + st.jobs + ' 个在招岗位' : '暂无在招企业'));
  tip.style.opacity = '1'; moveTip(e);
}
function moveTip(e) {
  const wrap = $('#mapWrap').getBoundingClientRect(), tip = $('#mapTip');
  let x = e.clientX - wrap.left + 14, y = e.clientY - wrap.top + 14;
  if (x + tip.offsetWidth > wrap.width - 6) x = e.clientX - wrap.left - tip.offsetWidth - 10;
  if (y + tip.offsetHeight > wrap.height - 6) y = e.clientY - wrap.top - tip.offsetHeight - 10;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function hideTip() { $('#mapTip').style.opacity = '0'; }
function buildChips() {
  const box = $('#provChips'); box.textContent = '';
  state.MAP.provs.forEach(p => {
    const st = state.provStats[p.c];
    const chip = el('button', 'prov-chip' + (state.prov === p.c ? ' sel' : '')); chip.type = 'button';
    const dot = el('i'); dot.style.background = heatColor(st ? st.jobs : 0); chip.appendChild(dot);
    chip.appendChild(el('span', null, p.n)); if (st) chip.appendChild(el('span', null, String(st.jobs)));
    chip.addEventListener('click', () => selectProv(p.c));
    box.appendChild(chip); chipEls[p.c] = chip;
  });
}
function selectProv(code) {
  state.prov = (state.prov === code) ? null : code;
  Object.keys(pathEls).forEach(c => pathEls[c].forEach(p => { p.classList.toggle('sel', +c === state.prov); p.classList.toggle('dim', state.prov != null && +c !== state.prov); }));
  Object.keys(chipEls).forEach(c => chipEls[c].classList.toggle('sel', +c === state.prov));
  renderPanel();
  if (window.innerWidth <= 1020 && state.prov != null) { const sp = $('.side-panel'); if (sp && sp.scrollIntoView) sp.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

/* ---------------- 企业卡片 / 面板 / 总库 ---------------- */
function natureTagClass(n) { return n === '央企/国企' ? 't-soe' : n === '民企' ? 't-priv' : n === '外企' ? 't-foreign' : 't-pub'; }
function veriTag(co) { return co.veri === 1 ? el('span', 'tag t-veri', '入口已核实') : co.veri === 2 ? el('span', 'tag t-src', '公开转载') : el('span', 'tag t-demo', '示例链接'); }
function coCard(co) {
  const act = activeJobs(co);
  const card = el('div', 'co-card'); card.tabIndex = 0; card.setAttribute('role', 'button');
  const top = el('div', 'co-top');
  const av = el('div', 'co-avatar', co.name.slice(0, 1)); av.style.background = 'linear-gradient(135deg,' + co.color + ',#3d7bff)';
  const info = el('div'); info.style.cssText = 'min-width:0;flex:1';
  info.appendChild(el('div', 'co-name', co.name));
  const meta = el('div', 'co-meta');
  meta.appendChild(el('span', 'tag ' + natureTagClass(co.nature), co.nature));
  meta.appendChild(el('span', null, co.industry)); meta.appendChild(el('span', null, co.city));
  if (co.autoAdded) meta.appendChild(el('span', 'tag t-src', '自动采集'));
  info.appendChild(meta); top.appendChild(av); top.appendChild(info); card.appendChild(top);
  const jobs = el('div', 'co-jobs');
  act.slice(0, 3).forEach(j => { const pill = el('span', 'job-pill', j.name); if (isNew(j.addedAt)) pill.style.borderColor = 'rgba(255,194,75,.55)'; jobs.appendChild(pill); });
  if (act.length > 3) jobs.appendChild(el('span', 'job-pill', '+' + (act.length - 3)));
  if (!act.length && co.announcement) jobs.appendChild(el('span', 'job-pill', '📢 查看官方校招公告'));
  card.appendChild(jobs);
  const foot = el('div', 'co-foot');
  if (act.length) { foot.appendChild(el('b', null, String(act.length))); foot.appendChild(el('span', null, ' 个在招岗位')); }
  else { foot.appendChild(el('b', null, '校招')); foot.appendChild(el('span', null, ' 公告已收录')); }
  foot.appendChild(veriTag(co)); foot.appendChild(el('span', 'co-arrow', '→'));
  card.appendChild(foot);
  card.addEventListener('click', () => openDrawer(co.id));
  card.addEventListener('keydown', e => { if (e.key === 'Enter') openDrawer(co.id); });
  return card;
}
function renderPanel() {
  const list = $('#panelList'); list.textContent = '';
  let pool = state.companies;
  if (state.prov != null) {
    pool = pool.filter(c => c.code === state.prov);
    $('#panelTitle').textContent = state.provName[state.prov] + ' · 校招企业';
    const st = state.provStats[state.prov];
    $('#panelSub').textContent = st ? st.co + ' 家企业 · ' + st.jobs + ' 个在招岗位' : '该省暂无在招企业';
  } else {
    pool = [...pool].sort((a, b) => activeJobs(b).length - activeJobs(a).length);
    $('#panelTitle').textContent = '全国速览 · 热门企业';
    $('#panelSub').textContent = '点击地图省份或下方标签，查看该省校招企业';
  }
  if (state.pNature) pool = pool.filter(c => c.nature === state.pNature);
  if (state.pIndustry) pool = pool.filter(c => c.industry === state.pIndustry);
  if (!pool.length) list.appendChild(el('div', 'panel-empty', state.prov != null && !state.provStats[state.prov] ? '该省份暂无在招企业' : '没有匹配的企业，试试调整筛选'));
  else pool.forEach(c => list.appendChild(coCard(c)));
  $('#panelFoot').textContent = '共 ' + pool.length + ' 家企业 · 数据更新于 ' + fmtTime(state.updatedAt);
}
function renderLib() {
  const grid = $('#libGrid'); grid.textContent = '';
  let pool = [...state.companies];
  const q = state.libQ.trim().toLowerCase();
  if (q) pool = pool.filter(c => c.name.toLowerCase().includes(q) || c.city.toLowerCase().includes(q) || c.industry.toLowerCase().includes(q) || activeJobs(c).some(j => j.name.toLowerCase().includes(q) || j.city.toLowerCase().includes(q)));
  if (state.libProv) pool = pool.filter(c => String(c.code) === state.libProv);
  if (state.libNature) pool = pool.filter(c => c.nature === state.libNature);
  if (state.libIndustry) pool = pool.filter(c => c.industry === state.libIndustry);
  if (state.libSort === 'jobs') pool.sort((a, b) => activeJobs(b).length - activeJobs(a).length);
  else if (state.libSort === 'name') pool.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  else if (state.libSort === 'new') pool.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  else pool.sort((a, b) => Math.min(...activeJobs(a).map(j => daysLeft(j.ddl))) - Math.min(...activeJobs(b).map(j => daysLeft(j.ddl))));
  $('#libCount').textContent = '';
  $('#libCount').appendChild(el('b', null, String(pool.length)));
  $('#libCount').appendChild(document.createTextNode(' 家企业 · ' + pool.reduce((s, c) => s + activeJobs(c).length, 0) + ' 个在招岗位'));
  $('#libEmpty').hidden = pool.length > 0;
  pool.forEach(c => grid.appendChild(coCard(c)));
}

/* ---------------- 抽屉 ---------------- */
function findCo(id) { return state.companies.find(c => c.id === id) || state.adminCompanies.find(c => c.id === id); }
function openDrawer(id) {
  const co = findCo(id); if (!co) return;
  state.dCo = id; state.dCat = ''; state.dType = '';
  $('#dCat').value = ''; $('#dType').value = '';
  $('#dName').textContent = co.name;
  const av = $('#dAvatar'); av.textContent = co.name.slice(0, 1); av.style.background = 'linear-gradient(135deg,' + co.color + ',#3d7bff)';
  const tags = $('#dTags'); tags.textContent = '';
  tags.appendChild(el('span', 'tag ' + natureTagClass(co.nature), co.nature));
  tags.appendChild(el('span', 'tag', co.industry));
  tags.appendChild(el('span', 'tag', '总部 · ' + co.city));
  tags.appendChild(el('span', 'tag t-pub', state.provName[co.code] || ''));
  $('#dIntro').textContent = co.intro || '';
  const box = $('#dSiteBox'); box.classList.toggle('demo', co.veri === 0); box.classList.toggle('src', co.veri === 2);
  $('#dSiteLabel').textContent = co.veri === 1 ? '官方入口（已核实）' : co.veri === 2 ? '公开转载公告（来源已核对）' : '招聘链接（示例，待核实）';
  $('#dSiteUrl').textContent = co.url;
  const btn = $('#dSiteBtn'); btn.href = co.url; btn.textContent = co.veri === 1 ? '进入招聘官网 ↗' : co.veri === 2 ? '查看公告原文 ↗' : '打开示例链接 ↗';
  $('#dNote').textContent = co.veri === 1 ? '来源渠道：' + (co.channel || '企业官网 / 官方公众号') + '，入口经公开检索核实；具体岗位与截止时间请以官网实时信息为准。'
    : co.veri === 2 ? '来源渠道：' + (co.channel || '公开渠道') + '。此入口为公告 / 转载原文，投递入口与岗位详情以公告正文及企业官方渠道为准。'
    : '该企业链接与岗位为示例数据，投递前请自行核实官方渠道。';
  renderDrawerJobs();
  $('#scrim').classList.add('on'); $('#drawer').classList.add('on'); document.body.style.overflow = 'hidden';
}
function closeDrawer() { $('#scrim').classList.remove('on'); $('#drawer').classList.remove('on'); document.body.style.overflow = ''; }
function renderDrawerJobs() {
  const co = findCo(state.dCo); if (!co) return;
  const box = $('#dJobs'); box.textContent = '';
  let jobs = activeJobs(co);
  if (state.dCat) jobs = jobs.filter(j => j.cat === state.dCat);
  if (state.dType) jobs = jobs.filter(j => j.type === state.dType);
  $('#dJobCount').textContent = '';
  $('#dJobCount').appendChild(el('b', null, String(jobs.length)));
  $('#dJobCount').appendChild(document.createTextNode(' 个在招岗位'));
  if (!jobs.length) {
    if (co.announcement && !state.dCat && !state.dType) {
      const note = el('div', 'panel-empty');
      note.appendChild(document.createTextNode('该公司校招公告已自动收录，具体岗位明细请查看官方公告：'));
      note.appendChild(el('div', null, co.announcement.title));
      const a = el('a', 'btn btn-primary btn-sm', '打开官方校招公告 ↗'); a.href = co.announcement.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.style.marginTop = '10px';
      note.appendChild(a);
      box.appendChild(note);
    } else {
      box.appendChild(el('div', 'panel-empty', '暂无匹配的在招岗位'));
    }
    return;
  }
  jobs.forEach(j => {
    const card = el('div', 'job-card');
    const top = el('div', 'job-top'); top.appendChild(el('div', 'job-title', j.name));
    const star = el('button', 'star-btn' + (state.favs.has(j.id) ? ' on' : ''), state.favs.has(j.id) ? '★' : '☆'); star.type = 'button';
    star.setAttribute('aria-label', state.favs.has(j.id) ? '取消收藏' : '收藏岗位');
    star.addEventListener('click', () => toggleFav(j.id, star));
    top.appendChild(star); card.appendChild(top);
    const meta = el('div', 'job-meta');
    if (isNew(j.addedAt)) meta.appendChild(el('span', 'chip c-new', '新上架'));
    meta.appendChild(el('span', 'chip', j.cat)); meta.appendChild(el('span', 'chip', j.city));
    meta.appendChild(el('span', 'chip c-edu', j.edu)); meta.appendChild(el('span', 'chip c-type', j.type));
    if (j.hot) meta.appendChild(el('span', 'chip c-hot', '热招'));
    card.appendChild(meta);
    const foot = el('div', 'job-foot'); const d = daysLeft(j.ddl);
    foot.appendChild(el('span', 'ddl' + (d <= 14 ? ' soon' : d <= 45 ? ' mid' : ''), ddlText(j.ddl)));
    const apply = el('a', 'job-apply', '去投递 ↗'); apply.href = j.applyUrl || co.url; apply.target = '_blank'; apply.rel = 'noopener noreferrer';
    foot.appendChild(apply); card.appendChild(foot); box.appendChild(card);
  });
}
function toggleFav(jobId, starEl) {
  if (state.favs.has(jobId)) { state.favs.delete(jobId); toast('已取消收藏'); }
  else { state.favs.add(jobId); toast('已加入收藏 ★', 'good'); }
  saveFavs();
  if (starEl) { starEl.classList.toggle('on', state.favs.has(jobId)); starEl.textContent = state.favs.has(jobId) ? '★' : '☆'; }
  renderFavs();
}
function renderFavs() {
  const box = $('#favList'); box.textContent = '';
  const jobMap = {}; state.companies.forEach(c => c.jobs.forEach(j => jobMap[j.id] = { j, co: c }));
  const ids = [...state.favs].filter(id => jobMap[id]);
  $('#favEmpty').hidden = ids.length > 0;
  ids.forEach(id => {
    const { j, co } = jobMap[id];
    const row = el('div', 'fav-job');
    const info = el('div', 'fav-info');
    info.appendChild(el('div', 'fav-title', j.name));
    info.appendChild(el('div', 'fav-meta', co.name + ' · ' + j.city + ' · ' + j.edu + ' · ' + ddlText(j.ddl)));
    row.appendChild(info);
    const go = el('a', 'btn btn-primary btn-sm', '去投递 ↗'); go.href = j.applyUrl || co.url; go.target = '_blank'; go.rel = 'noopener noreferrer'; row.appendChild(go);
    const del = el('button', 'btn btn-danger btn-sm', '移除'); del.type = 'button';
    del.addEventListener('click', () => { state.favs.delete(id); saveFavs(); renderFavs(); toast('已移除收藏'); if (state.dCo === co.id) renderDrawerJobs(); });
    row.appendChild(del); box.appendChild(row);
  });
}

/* ---------------- 动态条 / 统计 ---------------- */
function buildTicker() {
  const track = $('#tickerTrack'); track.textContent = '';
  const items = [];
  state.companies.forEach(c => activeJobs(c).forEach(j => { const d = daysLeft(j.ddl); if (d > 0 && d <= 60) items.push({ co: c.name, job: j.name, d, fresh: isNew(j.addedAt) }); }));
  items.sort((a, b) => (b.fresh - a.fresh) || (a.d - b.d));
  const pick = items.slice(0, 16);
  const fill = () => pick.forEach(it => { const s = el('span', 'ticker-item'); s.appendChild(el('b', null, it.co)); s.appendChild(document.createTextNode(' 「' + it.job + '」')); s.appendChild(el('em', null, (it.fresh ? '新上架 · ' : '') + '剩 ' + it.d + ' 天截止')); track.appendChild(s); });
  fill(); fill();
}
function updateStats() {
  $('#statProv').textContent = String(state.totals.prov || 0);
  $('#statCo').textContent = String(state.totals.co || 0);
  $('#statJob').textContent = String(state.totals.jobs || 0);
}

/* ---------------- 视图切换 ---------------- */
function switchView(v) {
  if (!hasAccess()) { exitToGate(); return; }
  if ((v === 'admin' || v === 'access') && !isAdmin()) { toast('该区域仅管理员可访问', 'warn'); v = 'map'; }
  state.view = v;
  $$('.view').forEach(s => s.classList.remove('on'));
  $('#view-' + v).classList.add('on');
  $$('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
  if (v === 'lib') renderLib();
  if (v === 'fav') renderFavs();
  if (v === 'admin') renderAdmin();
  if (v === 'access') renderAccess();
}
function fillSelects() {
  const M = state.META;
  [['#pNature', M.NATURES], ['#libNature', M.NATURES], ['#pIndustry', M.INDUSTRIES], ['#libIndustry', M.INDUSTRIES], ['#dCat', M.CATS], ['#dType', M.TYPES]].forEach(([sel, list]) => {
    const node = $(sel); list.forEach(v => { const o = el('option', null, v); o.value = v; node.appendChild(o); });
  });
  state.MAP.provs.forEach(p => { const o = el('option', null, p.n); o.value = String(p.c); $('#libProv').appendChild(o); });
}

/* ---------------- 弹窗 ---------------- */
function closeModal() { $('#modalWrap').classList.remove('on'); }
function modalBase(title, wide) { const box = $('#modalBox'); box.textContent = ''; box.classList.toggle('wide', !!wide); box.appendChild(el('h3', null, title)); return box; }
function showConfirm(title, msg, onOk, okLabel) {
  const box = modalBase(title);
  box.appendChild(el('p', null, msg));
  const row = el('div', 'btn-row');
  const ok = el('button', 'btn btn-danger', okLabel || '确定'); ok.type = 'button';
  ok.addEventListener('click', () => { closeModal(); onOk(); });
  const cancel = el('button', 'btn btn-ghost', '取消'); cancel.type = 'button'; cancel.addEventListener('click', closeModal);
  row.appendChild(ok); row.appendChild(cancel); box.appendChild(row);
  $('#modalWrap').classList.add('on');
}
function formRow(label, node, full) { const r = el('div', 'form-row' + (full ? ' full' : '')); r.appendChild(el('label', 'form-label', label)); r.appendChild(node); return r; }
function textInput(ph, val, type) { const i = el('input', 'form-input'); i.type = type || 'text'; i.placeholder = ph || ''; if (val != null) i.value = val; return i; }
function selectInput(options, val) { const s = el('select', 'form-input'); options.forEach(o => { const op = el('option', null, typeof o === 'string' ? o : o.label); op.value = typeof o === 'string' ? o : o.value; s.appendChild(op); }); if (val != null) s.value = String(val); return s; }
function showLeave(url) {
  const box = modalBase('即将离开校招星图');
  box.appendChild(el('p', null, '你即将前往企业官方招聘页面或公告原文。请在官方页面核实岗位真实性与截止时间，谨防「付费内推、保录取」等招聘诈骗。'));
  const ok = el('a', 'btn btn-primary', '继续前往 ↗'); ok.href = url; ok.target = '_blank'; ok.rel = 'noopener noreferrer'; ok.addEventListener('click', closeModal);
  const cancel = el('button', 'btn btn-ghost', '取消'); cancel.type = 'button'; cancel.addEventListener('click', closeModal);
  const row = el('div', 'btn-row'); row.appendChild(ok); row.appendChild(cancel); box.appendChild(row);
  $('#modalWrap').classList.add('on');
}
function showLog() {
  const box = modalBase('更新日志');
  box.appendChild(el('p', null, '服务器记录的上架、下架、审批与授权操作。'));
  const ul = el('ul', 'log-list');
  state.log.forEach(item => { const li = el('li'); li.appendChild(el('span', 'log-t', fmtTime(item.t))); li.appendChild(el('span', 'log-m', item.m)); ul.appendChild(li); });
  if (!state.log.length) ul.appendChild(el('li', null, '暂无日志'));
  box.appendChild(ul);
  const row = el('div', 'btn-row'); const close = el('button', 'btn btn-ghost', '关闭'); close.type = 'button'; close.addEventListener('click', closeModal); row.appendChild(close); box.appendChild(row);
  $('#modalWrap').classList.add('on');
}

/* ---------------- 管理台 ---------------- */
function adminRows() {
  const rows = [], q = state.adminQ.trim().toLowerCase();
  state.adminCompanies.forEach(c => c.jobs.forEach(j => {
    if (q && !(j.name.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))) return;
    const st = j.status === 'off' ? 'off' : isExpired(j) ? 'expired' : 'on';
    if (state.adminStatus && st !== state.adminStatus) return;
    rows.push({ c, j, st });
  }));
  rows.sort((a, b) => (b.j.updatedAt || 0) - (a.j.updatedAt || 0));
  return rows;
}
function renderAdmin() {
  const stats = $('#adminStats'); stats.textContent = '';
  const all = state.adminCompanies.reduce((s, c) => s + c.jobs.length, 0);
  const on = state.adminCompanies.reduce((s, c) => s + activeJobs(c).length, 0);
  const off = state.adminCompanies.reduce((s, c) => s + c.jobs.filter(j => j.status === 'off').length, 0);
  const exp = state.adminCompanies.reduce((s, c) => s + c.jobs.filter(j => j.status !== 'off' && isExpired(j)).length, 0);
  const mk = (label, val, warn) => { const d = el('div', 'admin-stat' + (warn ? ' s-warn' : '')); d.appendChild(el('b', null, String(val))); d.appendChild(document.createTextNode(label)); return d; };
  stats.appendChild(mk('家企业', state.adminCompanies.length)); stats.appendChild(mk('个岗位', all));
  stats.appendChild(mk('在招上架', on)); stats.appendChild(mk('已下架', off, true)); stats.appendChild(mk('已截止', exp, true));
  const strip = $('#coStrip'); strip.textContent = '';
  [...state.adminCompanies].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')).forEach(c => {
    const chip = el('button', 'co-chip'); chip.type = 'button';
    const dot = el('i', 'co-dot'); dot.style.background = c.color; chip.appendChild(dot);
    chip.appendChild(document.createTextNode(c.name + ' ')); chip.appendChild(el('b', null, activeJobs(c).length + ' 岗'));
    chip.title = '点击编辑企业资料或删除企业'; chip.addEventListener('click', () => openCompanyForm(c));
    strip.appendChild(chip);
  });
  const body = $('#adminBody'); body.textContent = '';
  const rows = adminRows();
  rows.forEach(({ c, j, st }) => {
    const tr = el('tr');
    const tdSel = el('td'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = state.selected.has(j.id); cb.setAttribute('aria-label', '选择岗位 ' + j.name);
    cb.addEventListener('change', () => { if (cb.checked) state.selected.add(j.id); else state.selected.delete(j.id); renderBulkBar(); });
    tdSel.appendChild(cb); tr.appendChild(tdSel);
    const tdName = el('td', 'td-name'); tdName.appendChild(document.createTextNode(j.name + ' '));
    if (isNew(j.addedAt)) tdName.appendChild(el('span', 'chip c-new', '新'));
    if (j.hot) tdName.appendChild(el('span', 'chip c-hot', '热'));
    tr.appendChild(tdName);
    const tdCo = el('td'); tdCo.appendChild(document.createTextNode(c.name)); tdCo.appendChild(el('div', 'td-sub', c.nature + ' · ' + c.industry)); tr.appendChild(tdCo);
    tr.appendChild(el('td', null, state.provName[c.code] || ''));
    tr.appendChild(el('td', null, j.cat + ' / ' + j.city));
    const tdDdl = el('td'); tdDdl.appendChild(document.createTextNode(j.ddl)); tdDdl.appendChild(el('div', 'td-sub', j.type + ' · ' + j.edu)); tr.appendChild(tdDdl);
    const tdSt = el('td'); const pill = el('button', 'status-pill ' + st); pill.type = 'button'; pill.appendChild(el('i'));
    pill.appendChild(document.createTextNode(st === 'on' ? '在招上架' : st === 'off' ? '已下架' : '已截止'));
    pill.title = st === 'expired' ? '已截止岗位需编辑截止日期后才能重新上架' : '点击切换上架 / 下架';
    pill.addEventListener('click', async () => {
      if (st === 'expired') { toast('该岗位已截止，请先「编辑」修改截止日期', 'warn'); return; }
      try { await api('/api/admin/jobs/' + j.id, { method: 'PUT', body: { status: st === 'on' ? 'off' : 'on' } }); await afterAdminChange(); toast(st === 'on' ? '已下架，前台不再展示' : '已上架，地图与总库已同步', st === 'on' ? '' : 'good'); }
      catch (e) { toast(e.message, 'err'); }
    });
    tdSt.appendChild(pill); tr.appendChild(tdSt);
    tr.appendChild(el('td', 'td-sub', fmtTime(j.updatedAt || j.addedAt)));
    const tdAct = el('td'); const acts = el('div', 'row-actions');
    const edit = el('button', 'icon-btn', '编辑'); edit.type = 'button'; edit.addEventListener('click', () => openJobForm(j)); acts.appendChild(edit);
    const del = el('button', 'icon-btn danger', '删除'); del.type = 'button'; del.addEventListener('click', () => deleteJob(c, j)); acts.appendChild(del);
    tdAct.appendChild(acts); tr.appendChild(tdAct); body.appendChild(tr);
  });
  if (!rows.length) { const tr = el('tr'); const td = el('td'); td.colSpan = 9; td.appendChild(el('div', 'panel-empty', '没有匹配的岗位记录')); tr.appendChild(td); body.appendChild(tr); }
  renderBulkBar();
  renderHarvest();
}
function renderHarvest() {
  const stats = $('#harvestStats'); if (!stats) return;
  stats.textContent = '';
  const last = state.harvestLast;
  const mk = (label, val) => { const d = el('div', 'admin-stat'); d.appendChild(el('b', null, String(val))); d.appendChild(document.createTextNode(label)); return d; };
  stats.appendChild(mk('自动入库公司', (state.harvestAuto || []).length));
  stats.appendChild(mk('上次采集', last ? fmtTime(last.lastRun) : '尚未'));
  if (last) { stats.appendChild(mk('上次公告数', last.items || 0)); stats.appendChild(mk('上次下架过期', last.expired || 0)); }
  const box = $('#harvestPending'); box.textContent = '';
  const list = state.harvestAuto || [];
  if (!list.length) { box.appendChild(el('div', 'panel-empty', '暂无自动入库记录。点「立即采集」或等待每日 08:00 自动采集。')); return; }
  list.forEach(p => {
    const co = state.adminCompanies.find(c => c.id === p.id);
    const row = el('div', 'access-row');
    const who = el('div', 'access-who');
    const nameLine = el('b', null, p.company + ' ');
    nameLine.appendChild(el('span', 'chip c-new', '自动'));
    if (p.inferred) nameLine.appendChild(el('span', 'chip', '省份推断'));
    who.appendChild(nameLine);
    who.appendChild(el('div', 'sub', (state.provName[p.code] || '') + ' · ' + (p.source || '') + (p.date ? ' · ' + p.date : '')));
    who.appendChild(el('div', 'sub', p.title));
    row.appendChild(who);
    const acts = el('div', 'access-actions');
    if (co) { const edit = el('button', 'btn btn-ghost btn-sm', '编辑'); edit.type = 'button'; edit.addEventListener('click', () => openCompanyForm(co)); acts.appendChild(edit); }
    const link = el('a', 'btn btn-ghost btn-sm', '查看公告'); link.href = p.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    acts.appendChild(link);
    row.appendChild(acts); box.appendChild(row);
  });
}
async function runHarvest() {
  const btn = $('#harvestRunBtn'); btn.disabled = true; btn.textContent = '采集中…';
  try {
    const r = await api('/api/admin/harvest/run', { method: 'POST' });
    await afterAdminChange();
    toast('采集完成：公告 ' + r.items + ' 条，自动入库 ' + r.added + ' 家，下架过期 ' + r.expired, 'good');
  } catch (e) { toast('采集失败：' + e.message, 'err'); }
  btn.disabled = false; btn.textContent = '立即采集';
}
function renderBulkBar() {
  const n = state.selected.size;
  $('#bulkBar').classList.toggle('on', n > 0);
  $('#bulkCount').textContent = '已选 ' + n + ' 个岗位';
  const rows = adminRows();
  $('#selAll').checked = rows.length > 0 && rows.every(r => state.selected.has(r.j.id));
}
async function afterAdminChange() { await refreshAdmin(); await refreshContent(); }
async function bulkSet(status) {
  try { const r = await api('/api/admin/jobs/bulk', { method: 'POST', body: { ids: [...state.selected], status } }); state.selected.clear(); await afterAdminChange(); toast('已批量' + (status === 'on' ? '上架' : '下架') + ' ' + r.changed + ' 个岗位', 'good'); }
  catch (e) { toast(e.message, 'err'); }
}
async function deleteJob(co, j) {
  showConfirm('删除岗位', '确定删除「' + co.name + ' · ' + j.name + '」？删除后可撤销。', async () => {
    try {
      const r = await api('/api/admin/jobs/' + j.id, { method: 'DELETE' });
      state.selected.delete(j.id); state.favs.delete(j.id); saveFavs();
      await afterAdminChange();
      toastUndo('已删除岗位', async () => { await api('/api/admin/restore', { method: 'POST', body: { jobs: [r.removed] } }); await afterAdminChange(); toast('已恢复岗位', 'good'); });
    } catch (e) { toast(e.message, 'err'); }
  });
}
function toastUndo(msg, fn) {
  const t = el('div', 'toast'); t.appendChild(el('span', null, msg));
  const b = el('button', null, '撤销'); b.type = 'button';
  b.addEventListener('click', () => { t.remove(); fn(); });
  t.appendChild(b); $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 6000);
}
async function bulkDelete() {
  const n = state.selected.size;
  showConfirm('批量删除', '确定删除选中的 ' + n + ' 个岗位？删除后可撤销。', async () => {
    try {
      const r = await api('/api/admin/jobs/bulk-delete', { method: 'POST', body: { ids: [...state.selected] } });
      r.removed.forEach(x => { state.favs.delete(x.job.id); }); saveFavs(); state.selected.clear();
      await afterAdminChange();
      toastUndo('已删除 ' + r.removed.length + ' 个岗位', async () => { await api('/api/admin/restore', { method: 'POST', body: { jobs: r.removed } }); await afterAdminChange(); toast('已恢复岗位', 'good'); });
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ---------------- 企业 / 岗位表单 ---------------- */
function openCompanyForm(existing) {
  const box = modalBase(existing ? '编辑企业 · ' + existing.name : '新增企业', true);
  box.appendChild(el('p', null, '保存后立即出现在地图与总库；链接类型决定前台展示的信任标签。'));
  const grid = el('div', 'form-grid');
  const fName = textInput('如：某某科技有限公司', existing && existing.name);
  const fProv = selectInput(state.MAP.provs.map(p => ({ value: String(p.c), label: p.n })), existing ? existing.code : 44);
  const fNature = selectInput(state.META.NATURES, existing && existing.nature);
  const fIndustry = selectInput(state.META.INDUSTRIES, existing && existing.industry);
  const fCity = textInput('总部城市，如：深圳', existing && existing.city);
  const fUrl = textInput('https://…', existing && existing.url);
  const fVeri = selectInput([{ value: '1', label: '官方入口（已核实）' }, { value: '2', label: '公开转载公告' }, { value: '0', label: '示例链接（待核实）' }], existing ? existing.veri : 1);
  const fChannel = textInput('来源渠道，如：官方公众号 / 高校就业网', existing && existing.channel);
  const fIntro = el('textarea', 'form-input'); fIntro.placeholder = '一句话企业简介'; if (existing) fIntro.value = existing.intro || '';
  grid.appendChild(formRow('企业名称 *', fName)); grid.appendChild(formRow('所在省份 *', fProv));
  grid.appendChild(formRow('企业性质', fNature)); grid.appendChild(formRow('所属行业', fIndustry));
  grid.appendChild(formRow('总部城市 *', fCity)); grid.appendChild(formRow('链接类型', fVeri));
  grid.appendChild(formRow('招聘 / 公告链接 *', fUrl, true)); grid.appendChild(formRow('来源渠道', fChannel, true)); grid.appendChild(formRow('企业简介', fIntro, true));
  box.appendChild(grid);
  const err = el('div', 'form-err'); box.appendChild(err);
  const row = el('div', 'btn-row');
  const save = el('button', 'btn btn-primary', existing ? '保存修改' : '保存并上架'); save.type = 'button';
  save.addEventListener('click', async () => {
    const payload = { name: fName.value.trim(), code: +fProv.value, nature: fNature.value, industry: fIndustry.value, city: fCity.value.trim(), url: fUrl.value.trim(), veri: +fVeri.value, channel: fChannel.value.trim(), intro: fIntro.value.trim() };
    if (!payload.name || !payload.city) { err.textContent = '请填写企业名称与总部城市'; return; }
    if (!/^https?:\/\/.+/.test(payload.url)) { err.textContent = '链接需以 http:// 或 https:// 开头'; return; }
    save.disabled = true;
    try {
      if (existing) await api('/api/admin/companies/' + existing.id, { method: 'PUT', body: payload });
      else await api('/api/admin/companies', { method: 'POST', body: payload });
      closeModal(); await afterAdminChange(); toast(existing ? '企业信息已更新' : '企业已上架，去「新增岗位」为它添加岗位', 'good');
    } catch (e) { err.textContent = e.message; save.disabled = false; }
  });
  const cancel = el('button', 'btn btn-ghost', '取消'); cancel.type = 'button'; cancel.addEventListener('click', closeModal);
  row.appendChild(save); row.appendChild(cancel); box.appendChild(row);
  if (existing) {
    const del = el('button', 'btn btn-danger', '删除该企业'); del.type = 'button'; del.style.cssText = 'margin-top:10px;width:100%';
    del.addEventListener('click', () => { closeModal(); deleteCompany(existing); });
    box.appendChild(del);
  }
  $('#modalWrap').classList.add('on');
}
async function deleteCompany(co) {
  showConfirm('删除企业', '确定删除「' + co.name + '」及其全部 ' + co.jobs.length + ' 个岗位？删除后可撤销。', async () => {
    try {
      const r = await api('/api/admin/companies/' + co.id, { method: 'DELETE' });
      co.jobs.forEach(j => { state.selected.delete(j.id); state.favs.delete(j.id); }); saveFavs();
      await afterAdminChange();
      toastUndo('已删除企业「' + co.name + '」', async () => { await api('/api/admin/restore', { method: 'POST', body: { company: r.removed } }); await afterAdminChange(); toast('已恢复企业', 'good'); });
    } catch (e) { toast(e.message, 'err'); }
  });
}
function openJobForm(existing, presetCoId) {
  const box = modalBase(existing ? '编辑岗位 · ' + existing.name : '新增岗位', true);
  box.appendChild(el('p', null, '保存后即时上架（截止日未过期时），所有访客的地图热力、总库与动态条同步刷新。'));
  const grid = el('div', 'form-grid');
  const coOptions = [...state.adminCompanies].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')).map(c => ({ value: c.id, label: c.name + '（' + (state.provName[c.code] || '') + '）' }));
  const fCo = selectInput(coOptions, existing ? existing.coId : (presetCoId || (state.adminCompanies[0] && state.adminCompanies[0].id)));
  const fName = textInput('如：后端开发工程师', existing && existing.name);
  const fCat = selectInput(state.META.CATS, existing && existing.cat);
  const fCity = textInput('工作城市，如：深圳/杭州', existing && existing.city);
  const fEdu = selectInput(state.META.EDUS, existing && existing.edu);
  const fType = selectInput(state.META.TYPES, existing && existing.type);
  const fDdl = el('input', 'form-input'); fDdl.type = 'date'; fDdl.value = existing ? existing.ddl : fmtDate(Date.now() + 90 * 86400000);
  const fApply = textInput('可选：岗位专属投递链接', existing && existing.applyUrl);
  const hotWrap = el('label', 'form-check'); const fHot = el('input'); fHot.type = 'checkbox'; fHot.checked = existing ? !!existing.hot : false;
  hotWrap.appendChild(fHot); hotWrap.appendChild(document.createTextNode('标记为热招岗位'));
  grid.appendChild(formRow('所属企业 *', fCo, true)); grid.appendChild(formRow('岗位名称 *', fName)); grid.appendChild(formRow('岗位类别', fCat));
  grid.appendChild(formRow('工作城市 *', fCity)); grid.appendChild(formRow('学历要求', fEdu)); grid.appendChild(formRow('招聘类型', fType));
  grid.appendChild(formRow('截止日期 *', fDdl)); grid.appendChild(formRow('专属投递链接', fApply, true)); grid.appendChild(formRow('标记', hotWrap));
  box.appendChild(grid);
  const err = el('div', 'form-err'); box.appendChild(err);
  const row = el('div', 'btn-row');
  const save = el('button', 'btn btn-primary', existing ? '保存修改' : '保存并上架'); save.type = 'button';
  save.addEventListener('click', async () => {
    const payload = { name: fName.value.trim(), cat: fCat.value, city: fCity.value.trim(), edu: fEdu.value, type: fType.value, ddl: fDdl.value, hot: fHot.checked, applyUrl: fApply.value.trim() };
    if (!payload.name || !payload.city) { err.textContent = '请填写岗位名称与工作城市'; return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.ddl)) { err.textContent = '请选择有效的截止日期'; return; }
    if (payload.applyUrl && !/^https?:\/\/.+/.test(payload.applyUrl)) { err.textContent = '投递链接需以 http(s):// 开头'; return; }
    save.disabled = true;
    try {
      if (existing) await api('/api/admin/jobs/' + existing.id, { method: 'PUT', body: payload });
      else await api('/api/admin/companies/' + fCo.value + '/jobs', { method: 'POST', body: payload });
      closeModal(); await afterAdminChange(); toast(existing ? '岗位已更新' : '岗位已实时上架 ★', 'good');
    } catch (e) { err.textContent = e.message; save.disabled = false; }
  });
  const cancel = el('button', 'btn btn-ghost', '取消'); cancel.type = 'button'; cancel.addEventListener('click', closeModal);
  row.appendChild(save); row.appendChild(cancel); box.appendChild(row);
  $('#modalWrap').classList.add('on');
}

/* ---------------- 导入导出 ---------------- */
async function exportData() {
  try {
    const res = await fetch('/api/admin/export', { headers: { 'Authorization': 'Bearer ' + state.token } });
    if (!res.ok) throw new Error('导出失败');
    const blob = await res.blob(); const url = URL.createObjectURL(blob);
    const a = el('a'); a.href = url; a.download = '校招星图-数据-' + fmtDate(Date.now()) + '.json'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000); toast('已导出 JSON 数据快照', 'good');
  } catch (e) { toast(e.message, 'err'); }
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(String(reader.result));
      const r = await api('/api/admin/import', { method: 'POST', body: data });
      await afterAdminChange(); toast('导入完成：新增 ' + r.added + ' 家 / 更新 ' + r.updated + ' 家企业', 'good');
    } catch (e) { toast('导入失败：' + e.message, 'err'); }
  };
  reader.onerror = () => toast('文件读取失败', 'warn');
  reader.readAsText(file);
}

/* ---------------- 访问审批 ---------------- */
function renderAccess() {
  const stats = $('#accessStats'); stats.textContent = '';
  const pending = state.requests.filter(r => r.status === 'pending').length;
  const approved = state.requests.filter(r => r.status === 'approved').length;
  const active = state.grants.filter(g => g.status === 'active').length;
  const mk = (label, val, warn) => { const d = el('div', 'admin-stat' + (warn ? ' s-warn' : '')); d.appendChild(el('b', null, String(val))); d.appendChild(document.createTextNode(label)); return d; };
  stats.appendChild(mk('待审批', pending, pending > 0)); stats.appendChild(mk('已批准', approved)); stats.appendChild(mk('生效授权', active));
  const rl = $('#reqList'); rl.textContent = '';
  if (!state.requests.length) rl.appendChild(el('div', 'panel-empty', '暂无申请。访客在首页「申请访问」提交后会实时出现在这里。'));
  const order = { pending: 0, approved: 1, rejected: 2 };
  [...state.requests].sort((a, b) => (order[a.status] - order[b.status]) || (b.createdAt - a.createdAt)).forEach(req => {
    const row = el('div', 'access-row');
    const who = el('div', 'access-who');
    who.appendChild(el('b', null, req.name + ' '));
    who.appendChild(el('span', 'pill-st ' + req.status, req.status === 'pending' ? '待审批' : req.status === 'approved' ? '已批准' : '已拒绝'));
    who.appendChild(el('div', 'sub', req.contact + (req.note ? ' · ' + req.note : '') + ' · ' + fmtTime(req.createdAt)));
    row.appendChild(who);
    const acts = el('div', 'access-actions');
    if (req.status === 'pending') {
      const ok = el('button', 'btn btn-primary btn-sm', '同意'); ok.type = 'button';
      ok.addEventListener('click', async () => { try { const r = await api('/api/admin/requests/' + req.id + '/approve', { method: 'POST', body: {} }); await refreshAdmin(); copyText(r.grant.token, '已同意，授权码已复制（对方页面也会自动解锁）'); } catch (e) { toast(e.message, 'err'); } });
      const no = el('button', 'btn btn-danger btn-sm', '拒绝'); no.type = 'button';
      no.addEventListener('click', async () => { try { await api('/api/admin/requests/' + req.id + '/reject', { method: 'POST' }); await refreshAdmin(); toast('已拒绝该申请'); } catch (e) { toast(e.message, 'err'); } });
      acts.appendChild(ok); acts.appendChild(no);
    } else if (req.status === 'approved') {
      const g = state.grants.find(x => x.id === req.grantId);
      if (g && g.token) { const cp = el('button', 'btn btn-ghost btn-sm', '复制授权码'); cp.type = 'button'; cp.addEventListener('click', () => copyText(g.token, '授权码已复制')); acts.appendChild(cp); }
    } else {
      const re = el('button', 'btn btn-ghost btn-sm', '重新考虑'); re.type = 'button';
      re.addEventListener('click', async () => { try { await api('/api/admin/requests/' + req.id + '/approve', { method: 'POST', body: {} }); await refreshAdmin(); toast('已重新批准'); } catch (e) { toast(e.message, 'err'); } });
      acts.appendChild(re);
    }
    row.appendChild(acts); rl.appendChild(row);
  });
  const gl = $('#grantList'); gl.textContent = '';
  if (!state.grants.length) gl.appendChild(el('div', 'panel-empty', '暂无已发放授权。'));
  [...state.grants].sort((a, b) => b.createdAt - a.createdAt).forEach(g => {
    const row = el('div', 'access-row');
    const who = el('div', 'access-who');
    who.appendChild(el('b', null, g.name + ' '));
    who.appendChild(el('span', 'pill-st ' + (g.status === 'active' ? 'approved' : 'revoked'), g.status === 'active' ? '生效中' : '已作废'));
    who.appendChild(el('div', 'sub', (g.contact || '直接发放') + ' · 发放于 ' + fmtTime(g.createdAt) + (g.expiresAt ? ' · 到期 ' + fmtTime(g.expiresAt) : ' · 长期有效')));
    if (g.token) who.appendChild(el('span', 'req-code', g.token));
    row.appendChild(who);
    const acts = el('div', 'access-actions');
    if (g.status === 'active') {
      const cp = el('button', 'btn btn-ghost btn-sm', '复制授权码'); cp.type = 'button'; cp.addEventListener('click', () => copyText(g.token, '授权码已复制'));
      const rv = el('button', 'btn btn-danger btn-sm', '作废'); rv.type = 'button';
      rv.addEventListener('click', () => showConfirm('作废授权', '确定作废「' + g.name + '」的授权？对方在线会话将被立即踢出，授权码立即失效。', async () => { try { await api('/api/admin/grants/' + g.id + '/revoke', { method: 'POST' }); await refreshAdmin(); toast('已作废，对方授权立即失效', 'warn'); } catch (e) { toast(e.message, 'err'); } }));
      acts.appendChild(cp); acts.appendChild(rv);
    }
    row.appendChild(acts); gl.appendChild(row);
  });
}
function openDirectGrant() {
  const box = modalBase('直接发放授权', true);
  box.appendChild(el('p', null, '无需申请，直接为指定人生成授权码（适合熟人快速开通）。'));
  const grid = el('div', 'form-grid');
  const fName = textInput('对方称呼', ''); const fContact = textInput('联系方式（可选）', '');
  const fExp = selectInput([{ value: '0', label: '长期有效' }, { value: '30', label: '30 天' }, { value: '90', label: '90 天' }, { value: '365', label: '1 年' }], '0');
  grid.appendChild(formRow('对方称呼 *', fName)); grid.appendChild(formRow('联系方式', fContact)); grid.appendChild(formRow('有效期', fExp, true));
  box.appendChild(grid);
  const err = el('div', 'form-err'); box.appendChild(err);
  const row = el('div', 'btn-row');
  const ok = el('button', 'btn btn-primary', '生成授权码'); ok.type = 'button';
  ok.addEventListener('click', async () => {
    if (!fName.value.trim()) { err.textContent = '请填写对方称呼'; return; }
    ok.disabled = true;
    try { const r = await api('/api/admin/grants', { method: 'POST', body: { name: fName.value.trim(), contact: fContact.value.trim(), days: +fExp.value } }); closeModal(); await refreshAdmin(); copyText(r.grant.token, '授权码已复制，请发给 ' + r.grant.name); }
    catch (e) { err.textContent = e.message; ok.disabled = false; }
  });
  const cancel = el('button', 'btn btn-ghost', '取消'); cancel.type = 'button'; cancel.addEventListener('click', closeModal);
  row.appendChild(ok); row.appendChild(cancel); box.appendChild(row);
  $('#modalWrap').classList.add('on');
}
function openChangePass() {
  const box = modalBase('修改管理员口令');
  const grid = el('div', 'form-grid');
  const fOld = textInput('当前口令', '', 'password'); const fNew = textInput('新口令（至少 6 位）', '', 'password'); const fNew2 = textInput('确认新口令', '', 'password');
  grid.appendChild(formRow('当前口令 *', fOld, true)); grid.appendChild(formRow('新口令 *', fNew)); grid.appendChild(formRow('确认新口令 *', fNew2));
  box.appendChild(grid);
  const err = el('div', 'form-err'); box.appendChild(err);
  const row = el('div', 'btn-row');
  const ok = el('button', 'btn btn-primary', '确认修改'); ok.type = 'button';
  ok.addEventListener('click', async () => {
    if (fNew.value.length < 6) { err.textContent = '新口令至少 6 位'; return; }
    if (fNew.value !== fNew2.value) { err.textContent = '两次新口令不一致'; return; }
    ok.disabled = true;
    try { await api('/api/admin/password', { method: 'POST', body: { old: fOld.value, new: fNew.value } }); closeModal(); toast('管理员口令已更新', 'good'); }
    catch (e) { err.textContent = e.message; ok.disabled = false; }
  });
  const cancel = el('button', 'btn btn-ghost', '取消'); cancel.type = 'button'; cancel.addEventListener('click', closeModal);
  row.appendChild(ok); row.appendChild(cancel); box.appendChild(row);
  $('#modalWrap').classList.add('on');
}

/* ---------------- 星空背景 ---------------- */
function initStars() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = $('#stars'), ctx = cv.getContext('2d'); if (!ctx) return;
  let stars = [], W = 0, H = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.min(150, Math.floor(W * H / 14000));
    stars = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.3 + .3, p: Math.random() * Math.PI * 2, s: Math.random() * .9 + .3, vy: Math.random() * .05 + .01 }));
  }
  resize(); window.addEventListener('resize', resize);
  let last = 0;
  function loop(t) {
    requestAnimationFrame(loop);
    if (document.hidden || t - last < 40) return; last = t;
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      s.p += s.s * .04; s.y -= s.vy; if (s.y < -2) s.y = H + 2;
      const a = .25 + .55 * (Math.sin(s.p) * .5 + .5);
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(160,200,255,' + a.toFixed(2) + ')'; ctx.fill();
    }
  }
  requestAnimationFrame(loop);
}

/* ---------------- 事件绑定 ---------------- */
function bindUI() {
  // 门禁
  $$('.gate-tab').forEach(t => t.addEventListener('click', () => setGateTab(t.dataset.gate)));
  $('#gApplyBtn').addEventListener('click', async () => {
    const name = $('#gName').value.trim(), contact = $('#gContact').value.trim(), note = $('#gNote').value.trim();
    if (!name || !contact) { gateMsg('#gApplyMsg', '请填写称呼与联系方式', 'err'); return; }
    const btn = $('#gApplyBtn'); btn.disabled = true;
    try {
      const r = await api('/api/requests', { method: 'POST', body: { name, contact, note } });
      gateMsg('#gApplyMsg', r.reused ? '你已提交过申请，正在等待管理员审批…' : '申请已提交！管理员同意后将自动解锁。', 'ok');
      startGatePoll(r.request.id, contact);
    } catch (e) { gateMsg('#gApplyMsg', e.message, 'err'); }
    btn.disabled = false;
  });
  $('#gUnlockBtn').addEventListener('click', async () => {
    const code = $('#gKey').value.trim();
    if (!code) { gateMsg('#gUnlockMsg', '请输入授权码', 'err'); return; }
    const btn = $('#gUnlockBtn'); btn.disabled = true;
    try { const auth = await api('/api/auth/grant', { method: 'POST', body: { code } }); gateMsg('#gUnlockMsg', '验证通过，正在进入…', 'ok'); await onAuthed(auth); }
    catch (e) { gateMsg('#gUnlockMsg', e.message, 'err'); }
    btn.disabled = false;
  });
  $('#gSetupBtn').addEventListener('click', async () => {
    const p1 = $('#gPass1').value, p2 = $('#gPass2').value;
    if (p1.length < 6) { gateMsg('#gAdminMsg', '口令至少 6 位', 'err'); return; }
    if (p1 !== p2) { gateMsg('#gAdminMsg', '两次口令不一致', 'err'); return; }
    const btn = $('#gSetupBtn'); btn.disabled = true;
    try { const auth = await api('/api/admin/setup', { method: 'POST', body: { password: p1 } }); gateMsg('#gAdminMsg', '设置成功，正在进入…', 'ok'); await onAuthed(auth); }
    catch (e) { gateMsg('#gAdminMsg', e.message, 'err'); }
    btn.disabled = false;
  });
  $('#gLoginBtn').addEventListener('click', async () => {
    const btn = $('#gLoginBtn'); btn.disabled = true;
    try { const auth = await api('/api/admin/login', { method: 'POST', body: { password: $('#gPass').value } }); gateMsg('#gAdminMsg', '登录成功，正在进入…', 'ok'); await onAuthed(auth); }
    catch (e) { gateMsg('#gAdminMsg', e.message, 'err'); }
    btn.disabled = false;
  });
  $('#gPass').addEventListener('keydown', e => { if (e.key === 'Enter') $('#gLoginBtn').click(); });
  // 导航
  $$('nav button').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('#exitBtn').addEventListener('click', exitToGate);
  $('#logBtn').addEventListener('click', async () => { try { const l = await api('/api/admin/log'); state.log = l.log; showLog(); } catch (e) { toast(e.message, 'err'); } });
  // 面板 / 总库筛选
  $('#pNature').addEventListener('change', e => { state.pNature = e.target.value; renderPanel(); });
  $('#pIndustry').addEventListener('change', e => { state.pIndustry = e.target.value; renderPanel(); });
  $('#libSearch').addEventListener('input', e => { state.libQ = e.target.value; renderLib(); });
  $('#libProv').addEventListener('change', e => { state.libProv = e.target.value; renderLib(); });
  $('#libNature').addEventListener('change', e => { state.libNature = e.target.value; renderLib(); });
  $('#libIndustry').addEventListener('change', e => { state.libIndustry = e.target.value; renderLib(); });
  $('#libSort').addEventListener('change', e => { state.libSort = e.target.value; renderLib(); });
  $('#libReset').addEventListener('click', () => { state.libQ = state.libProv = state.libNature = state.libIndustry = ''; state.libSort = 'jobs'; $('#libSearch').value = ''; $('#libProv').value = ''; $('#libNature').value = ''; $('#libIndustry').value = ''; $('#libSort').value = 'jobs'; renderLib(); });
  $('#favGo').addEventListener('click', () => switchView('map'));
  // 抽屉
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#dCat').addEventListener('change', e => { state.dCat = e.target.value; renderDrawerJobs(); });
  $('#dType').addEventListener('change', e => { state.dType = e.target.value; renderDrawerJobs(); });
  // 弹窗 / 键盘 / 外链
  $('#modalWrap').addEventListener('click', e => { if (e.target === $('#modalWrap')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeDrawer(); } });
  document.addEventListener('click', e => {
    const a = e.target.closest('a[target="_blank"]');
    if (!a || !a.href || a.href === '#' || a.closest('#modalBox')) return;
    e.preventDefault(); showLeave(a.href);
  });
  // 管理台
  $('#adminSearch').addEventListener('input', e => { state.adminQ = e.target.value; state.selected.clear(); renderAdmin(); });
  $('#adminStatus').addEventListener('change', e => { state.adminStatus = e.target.value; state.selected.clear(); renderAdmin(); });
  $('#addCoBtn').addEventListener('click', () => openCompanyForm(null));
  $('#addJobBtn').addEventListener('click', () => openJobForm(null));
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) importData(f); e.target.value = ''; });
  $('#exportBtn').addEventListener('click', exportData);
  $('#resetBtn').addEventListener('click', () => showConfirm('重置初始数据', '将清除全部岗位修改（新增 / 编辑 / 上下架），恢复到初始收录数据。访问授权不受影响。确定重置？', async () => { try { await api('/api/admin/reset', { method: 'POST' }); state.selected.clear(); await afterAdminChange(); toast('已恢复初始数据', 'good'); } catch (e) { toast(e.message, 'err'); } }));
  $('#harvestRunBtn').addEventListener('click', runHarvest);
  $('#harvestRefreshBtn').addEventListener('click', async () => { await refreshAdmin(); toast('已刷新自动入库记录', 'good'); });
  $('#selAll').addEventListener('change', e => { state.selected.clear(); if (e.target.checked) adminRows().forEach(r => state.selected.add(r.j.id)); renderAdmin(); });
  $('#bulkOn').addEventListener('click', () => bulkSet('on'));
  $('#bulkOff').addEventListener('click', () => bulkSet('off'));
  $('#bulkDel').addEventListener('click', bulkDelete);
  $('#bulkClear').addEventListener('click', () => { state.selected.clear(); renderAdmin(); });
  // 访问审批
  $('#directGrantBtn').addEventListener('click', openDirectGrant);
  $('#refreshReqBtn').addEventListener('click', async () => { await refreshAdmin(); toast('已刷新', 'good'); });
  $('#changePassBtn').addEventListener('click', openChangePass);
}

/* ---------------- 启动 ---------------- */
async function boot() {
  bindUI();
  initStars();
  await initGate();
  if (state.token) {
    try { const me = await api('/api/me'); state.role = me.role; state.name = me.name; await enterApp(); return; }
    catch (e) { state.token = ''; localStorage.removeItem('sm_token'); }
  }
  document.body.classList.add('locked');
}
boot();
