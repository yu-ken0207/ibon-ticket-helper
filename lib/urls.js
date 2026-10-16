// ibon 網址的判讀：活動頁、購票流程各步驟頁，以及不會自己恢復的頁面。只處理字串，不碰網頁。
// 購票流程各頁（orders.ibon.com.tw/application/UTK02/）：
//   UTK0201_000  第 2 步 選擇票區（2026-10-16 截圖看過，網頁結構還沒核對）
//   UTK0202_     第 3 步 座位/數量（2026-10-16 真站快照核對過）
//   UTK0206_     第 4 步 填寫購票資訊（2026-10-16 真站快照核對過）
//   UTK0207_     第 5 步 購票確認（網址取自 tickets_hunter，結構沒看過）

const ACTIVITY_HOST = 'ticket.ibon.com.tw';
const ORDERS_HOST = 'orders.ibon.com.tw';

/** 活動頁網址（整理過）。看不懂回傳 null */
export function activityUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.hostname !== ACTIVITY_HOST) return null;
  const m = u.pathname.match(/^\/ActivityInfo\/Details\/(\d+)\/?$/);
  return m ? `https://${ACTIVITY_HOST}/ActivityInfo/Details/${m[1]}` : null;
}

/** 網址裡的活動編號 */
export function eventSlug(url) {
  try {
    const m = new URL(url).pathname.match(/^\/ActivityInfo\/Details\/(\d+)/);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

export function isIbonHost(url) {
  try {
    const h = new URL(url).hostname;
    return h === ACTIVITY_HOST || h === ORDERS_HOST;
  } catch (_) { return false; }
}

/**
 * 網址 → 頁面種類：
 *   event 活動頁、transit 活動頁按「線上購票」的轉址、area 選票區、qty 座位/數量、buyer 填購票資訊、
 *   confirm 購票確認以後（名額已保留）、orders 購票流程的其他頁、other 其他
 */
export function pageKindOf(url) {
  let u;
  try { u = new URL(url); } catch (_) { return 'other'; }
  if (u.protocol !== 'https:') return 'other';
  if (u.hostname === ACTIVITY_HOST) {
    if (/^\/ActivityInfo\/Details\/\d+\/?$/.test(u.pathname)) return 'event';
    if (/^\/ActivityInfo\/GoTicketURL\/?$/i.test(u.pathname)) return 'transit';
    return 'other';
  }
  if (u.hostname === ORDERS_HOST) {
    const p = u.pathname;
    if (/^\/application\/UTK02\/UTK0201_000\.aspx$/i.test(p)) return 'area';
    if (/^\/application\/UTK02\/UTK0202_\.aspx$/i.test(p) || /^\/application\/UTK02\/UTK0201_001\.aspx$/i.test(p)) return 'qty';
    if (/^\/application\/UTK02\/UTK0206_\.aspx$/i.test(p)) return 'buyer';
    if (/^\/application\/UTK02\/UTK020[7-9]_?\.aspx$/i.test(p)) return 'confirm';
    if (/^\/application\/UTK02\//i.test(p)) return 'orders';
  }
  return 'other';
}

/** ibon 上不會自己恢復、助手也管不到的頁面：登入頁、錯誤頁，其他回傳 null */
export function offTrackKind(url) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (u.hostname === 'huiwan.ibon.com.tw' && /UserLogin/i.test(u.pathname)) return 'sign-in';
  if (!isIbonHost(url)) return null;
  if (/^\/(error|500|404)/i.test(u.pathname)) return 'error-page';
  return null;
}

/** 購票流程的頁面（任務進行時助手要接手的那幾頁） */
export const FLOW_KINDS = ['area', 'qty', 'buyer'];
