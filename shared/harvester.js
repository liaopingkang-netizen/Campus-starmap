/* 校招星图 · 公开公告采集器（全自动版，存储无关）
 * 数据源：人社部「中国公共招聘网」中央企业招聘应届高校毕业生信息公开专栏（政府公开数据）。
 * 全自动：采集到的新公司直接自动入库上架（省份自动推断并标注），已有公司补充公告链接；
 * 不编造岗位/截止日期——上架的是"公司 + 官方校招公告入口"，岗位明细以公告原文为准。
 */
import SEED from './seed.json' with { type: 'json' };

export const SOURCES = [
  { id: 'mohrss', name: '中国公共招聘网·央企校招', url: 'http://www.job.mohrss.gov.cn/qyzp/index.jhtml' }
];

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function clean(s) { return decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(); }

export function extractCompany(title) {
  let t = clean(title);
  t = t.replace(/^(【[^】]*】|\[[^\]]*\])\s*/, '');
  t = t.replace(/\d{4}[年届].*$/, '');
  t = t.replace(/(校园招聘|秋季招聘|春季招聘|全球招聘|招聘|诚聘|诚聘英才|公告|启事|启动|正式|火热).*$/, '');
  t = t.replace(/\d{4}$/, '');
  t = t.replace(/[·•\-—|｜:：,，\s]+$/, '');
  return t.trim();
}

// 省份自动推断：名称含地名 → 对应省；已知央企总部 → 对应省；其余默认北京并标注"推断"
const PROVINCE_KEYWORDS = [
  ['新疆', 65], ['西藏', 54], ['内蒙古', 15], ['广西', 45], ['宁夏', 64],
  ['黑龙江', 23], ['吉林', 22], ['辽宁', 21], ['河北', 13], ['山西', 14],
  ['山东', 37], ['河南', 41], ['湖北', 42], ['湖南', 43], ['广东', 44],
  ['海南', 46], ['四川', 51], ['贵州', 52], ['云南', 53], ['陕西', 61],
  ['甘肃', 62], ['青海', 63], ['江苏', 32], ['浙江', 33], ['安徽', 34],
  ['福建', 35], ['江西', 36], ['北京', 11], ['天津', 12], ['上海', 31], ['重庆', 50],
  ['深圳', 44], ['广州', 44], ['杭州', 33], ['南京', 32], ['武汉', 42], ['成都', 51],
  ['西安', 61], ['长沙', 43], ['郑州', 41], ['济南', 37], ['青岛', 37], ['合肥', 34],
  ['福州', 35], ['厦门', 35], ['南昌', 36], ['昆明', 53], ['贵阳', 52], ['兰州', 62],
  ['西宁', 63], ['银川', 64], ['乌鲁木齐', 65], ['拉萨', 54], ['呼和浩特', 15],
  ['南宁', 45], ['海口', 46], ['石家庄', 13], ['太原', 14], ['沈阳', 21], ['长春', 22],
  ['哈尔滨', 23]
];
const KNOWN_HQ = [
  ['华润', 44], ['招商局', 44], ['招商', 44], ['中国建材', 11], ['通用技术', 11],
  ['中国建研院', 11], ['中国国际工程咨询', 11], ['中资公司', 11], ['中国冶金地质', 11],
  ['中国资源循环', 12], ['中国保利', 11], ['保利', 11], ['中国中化', 11], ['中化', 11],
  ['中国五矿', 11], ['五矿', 11], ['中国铝业', 11], ['中铝', 11], ['中国远洋', 31],
  ['中远', 31], ['中国船舶', 31], ['中国一汽', 22], ['一汽', 22], ['东风', 42],
  ['中国宝武', 31], ['宝武', 31], ['鞍钢', 21], ['中国电子', 11], ['中国电科', 11],
  ['中国航天', 11], ['中国航空', 11], ['中国兵器', 11], ['中国核工业', 11], ['中核', 11],
  ['中国广核', 44], ['中广核', 44], ['国家电网', 11], ['南方电网', 44], ['中国华能', 11],
  ['中国大唐', 11], ['中国华电', 11], ['国家能源', 11], ['国家电投', 11], ['中国三峡', 42],
  ['三峡', 42], ['中国移动', 11], ['中国电信', 11], ['中国联通', 11], ['中国铁塔', 11],
  ['中国石化', 11], ['中国石油', 11], ['中国海油', 11], ['中国中车', 11], ['中国中铁', 11],
  ['中国铁建', 11], ['中国交建', 11], ['中国建筑', 11], ['中国电建', 11], ['中国能建', 11],
  ['中国化学', 11], ['中国中冶', 11], ['中国有色', 11], ['中国黄金', 11], ['中国稀土', 11],
  ['中国储备粮', 11], ['中储粮', 11], ['中粮', 11], ['中国中丝', 11], ['中国林业', 11],
  ['中国医药', 11], ['国药', 11], ['中国通用', 11], ['中国新兴', 11], ['中国融通', 11],
  ['中国物流', 11], ['中国数联', 11], ['中国资源', 12], ['中国国新', 11], ['中国诚通', 11],
  ['中国国投', 11], ['国家开发', 11], ['中国进出口', 11], ['中国出口信用', 11],
  ['工商银行', 11], ['农业银行', 11], ['中国银行', 11], ['建设银行', 11], ['交通银行', 31],
  ['中国人寿', 11], ['中国人保', 11], ['中国太平', 31], ['中国信保', 11], ['中信', 11],
  ['光大', 11], ['中国银河', 11], ['中国中金', 11], ['中国建投', 11]
];
export function inferProvince(name) {
  for (const [kw, code] of PROVINCE_KEYWORDS) if (name.includes(kw)) return { code, inferred: false };
  for (const [kw, code] of KNOWN_HQ) if (name.includes(kw)) return { code, inferred: true };
  return { code: 11, inferred: true }; // 央企总部多在北京，默认并标注推断
}

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

// 全自动合并：新公司直接入库上架（不编造岗位），已有公司补公告链接
export function mergeIntoDb(db, items, now) {
  db.autoAdded = db.autoAdded || [];
  db.companies = db.companies || [];
  let added = 0, linked = 0;
  const seenUrl = new Set(db.companies.map(c => c.url).filter(Boolean));
  const seenName = new Set(db.companies.map(c => c.name));
  for (const it of items) {
    if (seenName.has(it.company)) {
      const existing = db.companies.find(c => c.name === it.company);
      if (existing && !existing.url) { existing.url = it.url; existing.veri = 2; existing.channel = it.sourceName; existing.announcement = { title: it.title, url: it.url, date: it.date, source: it.sourceName }; existing.updatedAt = now; }
      linked++;
      continue;
    }
    if (seenUrl.has(it.url)) continue;
    seenUrl.add(it.url); seenName.add(it.company);
    const prov = inferProvince(it.company);
    const co = {
      id: 'c_auto_' + Math.random().toString(36).slice(2, 10),
      code: prov.code, name: it.company,
      nature: '央企/国企', industry: '互联网', city: '全国',
      url: it.url, veri: 2,
      intro: '来源：' + it.sourceName + '《' + it.title + '》。省份为自动推断' + (prov.inferred ? '（默认北京）' : '') + '，可在管理台修改；岗位明细以官方公告为准。',
      channel: it.sourceName,
      color: SEED.AV_COLORS[it.company.charCodeAt(0) % SEED.AV_COLORS.length],
      announcement: { title: it.title, url: it.url, date: it.date, source: it.sourceName },
      autoAdded: true, autoProvince: prov.inferred,
      addedAt: now, updatedAt: now, jobs: []
    };
    db.companies.push(co);
    db.autoAdded.unshift({ id: co.id, company: co.name, code: prov.code, inferred: prov.inferred, title: it.title, url: it.url, date: it.date, source: it.sourceName, addedAt: now });
    if (db.autoAdded.length > 100) db.autoAdded.length = 100;
    added++;
  }
  return { added, linked, total: items.length };
}
