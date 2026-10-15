// 共用的小工具：補零與日期時間格式。背景程式直接 import，頁面程式由 tools/build.mjs 內嵌。
export const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 毫秒時間戳記 → 「10/15 13:00:00」 */
export function fmt(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 轉成整數並限制在 min～max 之間；看不懂就用預設值 */
export function int(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
