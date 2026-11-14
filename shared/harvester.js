/* 校招星图 · 公开公告采集器（存储无关）
 * 数据源：人社部「中国公共招聘网」中央企业招聘应届高校毕业生信息公开专栏（政府公开数据）。
 * 仅采集"公司 + 公告标题 + 官方链接 + 发布日期"，不抓取微信正文（正文为图片/JS 渲染，不可靠）。
 * 采集结果作为"待审核"线索，由管理员在后台一键采纳，不直接污染已审核数据。
 */

export const SOURCES = [
  { id: 'mohrss', name: '中国公共招聘网·央企校招', url: 'http://www.job.mohrss.gov.cn/qyzp/index.jhtml' }
];

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function clean(s) { return decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(); }

// 从标题推断公司名（去掉校招相关后缀）
export function extractCompany(title) {
  let t = clean(title);
  t = t.replace(/^(【[^】]*】|\[[^\]]*\])\s*/, ''); // 去掉【校招】等前缀
  t = t.replace(/\d{4}[年届].*$/, ''); // 去掉 2027年/届 及之后
  t = t.replace(/(校园招聘|秋季招聘|春季招聘|全球招聘|招聘|诚聘|诚聘英才|公告|启事|启动|正式|火热).*$/, '');
  t = t.replace(/\d{4}$/, ''); // 去掉残留年份（如"中国建研院2027"）
  t = t.replace(/[·•\-—|｜:：,，\s]+$/, '');
  return t.trim();
}

// 解析公共招聘网列表页
export function parseMohrss(html) {
  const items = [];
  const re = /<li>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1].trim();
    const title = clean(m[2]);
    const date = clean(m[3]);
    if (!/招聘|校招|应届/.test(title)) continue;
    if (!/^https?:\/\//.test(url)) continue;
    const company = extractCompany(title);
    if (!company || company.length < 3) continue;
    items.push({ source: 'mohrss', sourceName: '中国公共招聘网·央企校招', company, title, url, date });
  }
  return items;
}

export async function fetchSource(src, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(src.url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CampusStarmap/1.0)' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    return parseMohrss(html);
  } finally { clearTimeout(t); }
}

export async function collectAll() {
  const results = [];
  const errors = [];
  for (const src of SOURCES) {
    try { results.push(...await fetchSource(src)); }
    catch (e) { errors.push({ source: src.id, error: String(e && e.message || e) }); }
  }
  return { items: results, errors };
}

// 合并到 db：新公司入"待审核"，已有公司补充公告链接；返回统计
export function mergeIntoDb(db, items, now) {
  db.pending = db.pending || [];
  let added = 0, linked = 0;
  const seen = new Set(db.pending.map(p => p.url));
  for (const it of items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    const existing = db.companies.find(c => c.name === it.company);
    if (existing) {
      // 已有公司：若尚无官方链接，补充公告链接（不覆盖已核实链接）
      if (!existing.url) { existing.url = it.url; existing.veri = 2; existing.channel = it.sourceName; existing.updatedAt = now; }
      linked++;
      continue;
    }
    db.pending.push({ id: 'p_' + Math.random().toString(36).slice(2, 10), company: it.company, title: it.title, url: it.url, date: it.date, source: it.sourceName, fetchedAt: now });
    added++;
  }
  return { added, linked, total: items.length };
}
