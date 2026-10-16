// 提醒（純函式，不碰網頁）：保留倒數（購票流程頁上的「剩餘時間 mm:ss」）與開賣提醒（活動頁讀到的開賣時間）。
// 這裡只算時間、決定該不該通知；不重新整理、不點擊、不購票。看不出來就是「未知」，不猜。

export const HOLD_STAGES = [120, 60];   // 保留剩 2 分鐘、1 分鐘
export const SALE_STAGES = [300, 60];   // 開賣前 5 分鐘、1 分鐘
const HOLD_TOLERANCE_MS = 5000;          // 兩次讀數推算的截止時間差多少以內算「倒數有照時間走」
const HOLD_RESET_SEC = 30;               // 倒數往上跳超過這麼多秒：網站重新保留

/** 「剩餘時間09:33」「剩餘時間 9：33」→ 秒數；認不得回 null */
export function parseCountdown(text) {
  const m = String(text || '').match(/剩餘時間\s*(\d{1,2})\s*[:：]\s*(\d{2})(?!\d)/);
  if (!m || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/**
 * 保留倒數：每讀到一次頁面就更新。reading = { secs（null＝這一頁沒看到倒數）, at（讀到的時間） }
 * hold = { status: 'ok' | 'unknown', reason, deadline, lastSecs, lastAt, lastEst, checked, notified: { 120: true, … } }
 *   - 沒看到倒數 → unknown
 *   - 第一次讀到、或倒數往上跳（網站重新保留）→ 新的保留，通知紀錄清空
 *   - 這次推算的截止跟上次差 5 秒以內 → ok（checked：至少兩次讀數對得上，確定倒數有在走）；截止取比較早的
 *   - 對不上（倒數停住、跳動）→ unknown，不排通知
 */
export function updateHold(hold, reading) {
  const at = Number(reading && reading.at);
  const secs = reading && Number.isInteger(reading.secs) && reading.secs >= 0 ? reading.secs : null;
  const h = hold || null;
  if (secs == null) return { ...(h || { notified: {} }), status: 'unknown', reason: '這一頁沒看到「剩餘時間」', lastAt: at, lastSecs: null, lastEst: null, checked: false };
  const est = at + secs * 1000;
  const base = { lastSecs: secs, lastAt: at, lastEst: est };
  if (!h || h.lastSecs == null && h.deadline == null) return { status: 'ok', reason: '', deadline: est, checked: false, notified: {}, ...base };
  if (h.lastSecs != null && secs > h.lastSecs + HOLD_RESET_SEC) return { status: 'ok', reason: '網站重新開始保留', deadline: est, checked: false, notified: {}, ...base };
  if (h.lastEst == null) return { ...h, status: 'ok', reason: '', deadline: est, checked: false, ...base };
  const drift = est - h.lastEst;
  if (Math.abs(drift) <= HOLD_TOLERANCE_MS) {
    const deadline = h.status === 'ok' && h.deadline ? Math.min(h.deadline, est) : est;
    return { ...h, status: 'ok', reason: '', deadline, checked: h.checked || at - h.lastAt >= 2000, ...base };
  }
  return { ...h, status: 'unknown', reason: drift > 0 ? '頁面上的倒數沒有照時間減少（可能停住了）' : '頁面上的倒數減少得比時間快', ...base };
}

/** 剩下的毫秒；看不出來回 null */
export function holdRemaining(hold, now) {
  return hold && hold.status === 'ok' && hold.deadline ? hold.deadline - now : null;
}

/**
 * 現在該發的保留通知：只發最急的那一段，比它早的段也記成已通知（不會一次跳兩個）。
 * 已經過了截止、或看不出來 → null。回 { stage, mark: [已通知的段] }
 */
export function holdDue(hold, now) {
  const left = holdRemaining(hold, now);
  if (left == null || left <= 0) return null;
  const n = hold.notified || {};
  const due = HOLD_STAGES.filter((s) => left <= s * 1000 && !n[s]);
  if (!due.length) return null;
  const stage = Math.min(...due);
  return { stage, mark: HOLD_STAGES.filter((s) => s >= stage) };
}

/** 還沒到、還沒通知的保留提醒時間點：[{ stage, when }] */
export function holdAlarms(hold, now) {
  if (!hold || hold.status !== 'ok' || !hold.deadline) return [];
  const n = hold.notified || {};
  return HOLD_STAGES.filter((s) => !n[s]).map((s) => ({ stage: s, when: hold.deadline - s * 1000 })).filter((x) => x.when > now);
}

/* ───────────── 開賣提醒 ───────────── */

/** 台灣時間（UTC+8，ibon 寫的時間）「2026-10-20T12:00」→ 毫秒；只有日期沒有時間回 NaN（不猜幾點） */
export function taipeiTime(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 8, Number(m[5]));
}

/**
 * 活動資訊 → 開賣時間：{ items: [{ ms, at, text, source, verified, past }], unknown: 原因 | null }
 *   節目介紹裡寫的開賣時間（附原文）；場次旁的「…開賣」小字（寫法還沒在真站看過，照實標）。
 *   只有日期沒有時間的不算（列在 unknown 的原因裡）。
 */
export function saleTimesOf(info, now) {
  const i = info || {};
  const items = [];
  const dateOnly = [];
  const add = (at, text, source, verified) => {
    const ms = taipeiTime(at);
    if (!Number.isFinite(ms)) { dateOnly.push(text || at); return; }
    if (items.some((x) => x.ms === ms)) return;
    items.push({ ms, at, text: String(text || '').slice(0, 120), source, verified, past: ms <= now });
  };
  for (const t of i.saleTimes || []) add(t.at, t.text, '節目介紹', true);
  for (const s of i.sessions || []) if (s.saleStart) add(s.saleStart, `${s.when || ''} ${s.name || ''}`.trim(), '場次旁的「開賣」小字（這種寫法還沒在真站看過）', false);
  items.sort((a, b) => a.ms - b.ms);
  let unknown = null;
  if (!items.length) unknown = dateOnly.length ? `只寫了日期、沒寫幾點（${dateOnly.slice(0, 2).join('；')}），不猜時間` : '活動頁上沒有認得的開賣時間';
  else if (items.every((x) => x.past)) unknown = '讀到的開賣時間都已經過了';
  return { items, unknown };
}

/** 開賣提醒現在該發的：只發最急的一段；已經開賣就不發。rem = { ms, notified } */
export function saleDue(rem, now) {
  if (!rem || !Number.isFinite(rem.ms) || now >= rem.ms) return null;
  const left = rem.ms - now;
  const n = rem.notified || {};
  const due = SALE_STAGES.filter((s) => left <= s * 1000 && !n[s]);
  if (!due.length) return null;
  const stage = Math.min(...due);
  return { stage, mark: SALE_STAGES.filter((s) => s >= stage) };
}

/** 還沒到、還沒通知的開賣提醒時間點 */
export function saleAlarms(rem, now) {
  if (!rem || !Number.isFinite(rem.ms)) return [];
  const n = rem.notified || {};
  return SALE_STAGES.filter((s) => !n[s]).map((s) => ({ stage: s, when: rem.ms - s * 1000 })).filter((x) => x.when > now);
}

/** 給人看的台灣時間「10/20 12:00」 */
export function taipeiText(ms) {
  const d = new Date(ms + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
