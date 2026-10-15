// 支援哪些網站。每個網站要有兩樣東西：這裡的網址規則，以及 src/agent/ 裡的一支頁面轉接（例如 10-pool.js）。
// 目前只有本機的一般票券模擬站（ticket-sim 用 SIM_SITE=pool 啟動），還沒有接任何真實網站。
// 新增真實網站之前，先確認該票券的法律適用、網站服務條款與允許的自動化方式。

/** 本機一般票券模擬站：只認本機位址底下的 /pool/。看不懂回傳 null */
export function poolListUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return null;
  if (!/^\/pool(\/|$)/.test(u.pathname)) return null;
  return `${u.origin}/pool/`;
}

/** 模擬站各頁：list 時段列表、select 選票、info 填資料、confirm 確認、done 完成、queue 排隊，其他是 other */
export function poolPageKind(url) {
  let p;
  try { p = new URL(url).pathname; } catch (_) { return 'other'; }
  if (/^\/pool\/?$/.test(p)) return 'list';
  if (/^\/pool\/select\/[^/]+$/.test(p)) return 'select';
  if (p === '/pool/info') return 'info';
  if (p === '/pool/confirm') return 'confirm';
  if (/^\/pool\/done\/[^/]+$/.test(p)) return 'done';
  if (p === '/pool/queue') return 'queue';
  return 'other';
}

export const SITES = {
  pool: {
    id: 'pool',
    label: '一般票券模擬站',
    targetUrl: poolListUrl,
    pageKind: poolPageKind,
    key: (url) => { const t = poolListUrl(url); return t ? `pool@${new URL(t).origin}` : null; },
  },
};

/** 網址屬於哪個網站，看不懂回傳 null */
export function siteOf(url) {
  return Object.keys(SITES).find((id) => SITES[id].targetUrl(url)) || null;
}

/** 任務要開的頁面（模擬站是時段列表） */
export function targetUrlOf(url) {
  const s = siteOf(url);
  return s ? SITES[s].targetUrl(url) : null;
}

/** 判斷兩個網址是不是同一個站，用來綁定分頁 */
export function siteKey(site, url) {
  const s = SITES[site];
  return s ? s.key(url) : null;
}

/** 網址在這個站是哪一頁 */
export function pageKindOf(site, url) {
  const s = SITES[site];
  return s ? s.pageKind(url) : 'other';
}

export const siteLabel = (site) => (SITES[site] || { label: '未知網站' }).label;
