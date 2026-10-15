// 健檢結果的整理：最嚴重的等級，以及給人看的一句話摘要。

/** fail 最嚴重，其次 warn，都沒有就是 ok（skip 不算問題） */
export function worstOf(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.some((i) => i.status === 'fail')) return 'fail';
  if (list.some((i) => i.status === 'warn')) return 'warn';
  return 'ok';
}

/** p：頁面回報的健檢結果 */
export function summarizeHealth(p) {
  if (p.error) return p.error;
  const items = Array.isArray(p.items) ? p.items : [];
  const bad = items.filter((i) => i.status === 'fail').map((i) => i.label);
  const warn = items.filter((i) => i.status === 'warn').map((i) => i.label);
  return bad.length ? `有問題：${bad.join('、')}` : warn.length ? `大致正常，要注意：${warn.join('、')}` : '全部正常';
}
