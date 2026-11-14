/* 校招星图 · 每日定时任务（Netlify Scheduled Function）
 * 每天 00:00 UTC（北京时间 08:00）自动执行：
 *  1. 采集公开公告（中国公共招聘网央企校招专栏）→ 新公司全自动入库上架（省份自动推断），已有公司补链接
 *  2. 自动下架已过期岗位（截止日期早于今天）
 * 调度在 netlify.toml 的 [functions."daily-harvest"] 配置。
 */
import { getStore } from '@netlify/blobs';
import { collectAll, mergeIntoDb } from '../../shared/harvester.js';
import SEED from '../../shared/seed.json' with { type: 'json' };

export default async (req) => {
  const store = getStore({ name: 'starmap', consistency: 'strong' });
  let db = await store.get('db', { type: 'json' });
  if (!db || !db.companies) {
    db = { adminHash: null, adminSalt: null, companies: SEED.companies, requests: [], grants: [], sessions: {}, autoAdded: [], harvest: null, log: [], createdAt: Date.now() };
  }
  db.autoAdded = db.autoAdded || [];
  db.log = db.log || [];
  const now = Date.now();
  const today = new Date(new Date().toDateString());

  // 1. 自动采集
  let harvest = { items: 0, added: 0, linked: 0, errors: [] };
  try {
    const { items, errors } = await collectAll();
    const merged = mergeIntoDb(db, items, now);
    harvest = { items: items.length, ...merged, errors };
  } catch (e) {
    harvest.errors.push(String(e && e.message || e));
  }

  // 2. 自动下架过期岗位
  let expired = 0;
  for (const c of db.companies) {
    for (const j of c.jobs) {
      if (j.status !== 'off' && new Date(j.ddl + 'T00:00:00') < today) { j.status = 'off'; j.updatedAt = now; expired++; }
    }
  }

  db.harvest = { lastRun: now, ...harvest, expired };
  db.log.unshift({ t: now, m: `每日自动任务：采集公告 ${harvest.items} 条，自动入库新公司 ${harvest.added} 家 / 补充链接 ${harvest.linked}，自动下架过期岗位 ${expired} 个` });
  if (db.log.length > 300) db.log.length = 300;
  await store.setJSON('db', db);

  return new Response(JSON.stringify({ ok: true, ...db.harvest }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
