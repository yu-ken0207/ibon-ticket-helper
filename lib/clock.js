// 對時的計算：從 HEAD 請求的送出時間 t0、收到時間 t1 和伺服器 Date 的秒數 sec，推算「伺服器 − 本機」毫秒數。

/** 假設伺服器在請求來回的正中間產生 Date */
export const probeOffset = (p) => Math.round(p.sec - (p.t1 - (p.t1 - p.t0) / 2));

/** 第二段對時：同時送出的探測裡，找第一個跨到下一秒的那一個。沒有跨秒就回傳 null */
export function crossingOffset(probes) {
  const got = (probes || []).filter(Boolean).sort((a, b) => a.t0 - b.t0);
  if (!got.length) return null;
  const firstSec = got[0].sec;
  const cross = got.findIndex((p) => p.sec > firstSec);
  return cross > 0 ? probeOffset(got[cross]) : null;
}
