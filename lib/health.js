// 健檢結果的整理：最嚴重的等級，以及給人看的一句話摘要。
import { fmt } from './format.js';

/** fail 最嚴重，其次 warn，都沒有就是 ok（skip 不算問題） */
export function worstOf(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.some((i) => i.status === 'fail')) return 'fail';
  if (list.some((i) => i.status === 'warn')) return 'warn';
  return 'ok';
}

/** p：頁面回報的健檢結果；fp：跟上次記下的 ibon 活動頁程式檔比對的結果 */
export function summarizeHealth(p, fp) {
  if (p.error) return p.error;
  const items = Array.isArray(p.items) ? p.items : [];
  const bad = items.filter((i) => i.status === 'fail').map((i) => i.label);
  const warn = items.filter((i) => i.status === 'warn').map((i) => i.label);
  let s = bad.length ? `有問題：${bad.join('、')}` : warn.length ? `大致正常，要注意：${warn.join('、')}` : '全部正常';
  if (fp && fp.changed) s += `。ibon 活動頁程式在上次檢查（${fmt(fp.changed.at)}）之後更新過`;
  else if (fp && fp.first) s += '。已記下 ibon 活動頁程式的版本，下次會比對有沒有更新';
  else if (fp && fp.same) s += '。ibon 活動頁程式和上次一樣';
  return s;
}
