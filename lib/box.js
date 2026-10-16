// 黑盒子紀錄的整理：只留認得的欄位，並限制每個欄位的長度，避免頁面送來的東西把儲存空間塞爆。
export const BLACKBOX_MAX = 20;

export function sanitizeBox(p) {
  if (!p || typeof p !== 'object') return null;
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const arr = (v, n, m) => (Array.isArray(v) ? v : []).slice(0, n).map((x) => str(x, m));
  return {
    at: Number(p.at) || Date.now(), kind: str(p.kind, 40), msg: str(p.msg, 300), url: str(p.url, 300), title: str(p.title, 80),
    page: str(p.page, 20), login: str(p.login, 20),
    rows: Number(p.rows) || 0, rowSample: arr(p.rowSample, 4, 60), buttons: arr(p.buttons, 15, 30), modals: arr(p.modals, 5, 200),
    alerts: arr(p.alerts, 3, 200), text: str(p.text, 2000), html: str(p.html, 4000),
  };
}
