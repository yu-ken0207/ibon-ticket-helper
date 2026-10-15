// PolicyGate：每個網站操作執行前都要先問這裡（背景程式收到頁面程式的 gate 請求時呼叫）。
//   ALLOWED                有充分依據可以自動做
//   CONFIRMATION_REQUIRED  要你確認，或網站規則還沒確認：助手不做，停下來交給你
//   BLOCKED                不得執行（繞過驗證、排隊、限購、付款）
//   UNKNOWN                沒列在表上的操作、認不得的網站：一律停下來
// 只有 ALLOWED 會執行。被暫停、取消時，背景程式在這之前就會拒絕。
import { IBON_POLICY } from './ibon.js';

export const D = { ALLOWED: 'ALLOWED', CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED', BLOCKED: 'BLOCKED', UNKNOWN: 'UNKNOWN' };

/** 頁面程式會問的操作，給人看的名字 */
export const ACTIONS = {
  'read-page': '讀取頁面',
  'refresh-list': '重新讀取場次列表',
  'reload-page': '重新整理頁面',
  'select-session': '選場次',
  'select-area': '選票區',
  'set-quantity': '選張數',
  'submit-hold': '送出選購（保留名額）',
  'fill-profile': '填購票人資料',
  'agree-terms': '勾選同意使用須知',
  'submit-buyer': '送出購票人資料',
  'confirm-order': '確認建立訂單（不可逆）',
  'solve-challenge': '驗證碼、機器人驗證',
  'bypass-queue': '略過排隊',
  payment: '付款',
};

const SIM = '本機模擬站（ticket-sim）是自己的測試網站，允許自動操作';
/** 本機一般票券模擬站：除了不可逆與防護機制，都可以自動做 */
const POOL_POLICY = {
  'read-page': [D.ALLOWED, '只讀頁面'],
  'refresh-list': [D.ALLOWED, `${SIM}；間隔與次數由重試額度控制，遇到 429 照 Retry-After`],
  'reload-page': [D.ALLOWED, `${SIM}；次數由重試額度控制`],
  'select-session': [D.ALLOWED, SIM],
  'select-area': [D.ALLOWED, SIM],
  'set-quantity': [D.ALLOWED, SIM],
  'submit-hold': [D.ALLOWED, `${SIM}；保留名額不是成交，同一步只送一次`],
  'fill-profile': [D.ALLOWED, `${SIM}；填的是你提供的資料`],
  'agree-terms': (ctx) => (ctx.cfg && ctx.cfg.autoAgree === false
    ? [D.CONFIRMATION_REQUIRED, '你設定不自動勾選同意，請自己閱讀後勾選']
    : [D.ALLOWED, '你設定自動勾選同意']),
  'submit-buyer': [D.ALLOWED, SIM],
  'confirm-order': [D.CONFIRMATION_REQUIRED, '建立訂單是不可逆的操作，一定由你自己按'],
  'solve-challenge': [D.BLOCKED, '不繞過驗證碼與機器人驗證'],
  'bypass-queue': [D.BLOCKED, '不略過排隊'],
  payment: [D.BLOCKED, '付款一律由你自己處理，不保存付款資料'],
};

/** ibon：照 lib/ibon.js 的 IBON_POLICY（auto＝ALLOWED、manual＝CONFIRMATION_REQUIRED、never＝BLOCKED） */
const IBON_ACTION = {
  'read-page': 'read',
  'select-session': 'select',
  'select-area': 'select',
  'set-quantity': 'quantity',
  'submit-hold': 'submit',
  'fill-profile': 'submit',
  'agree-terms': 'submit',
  'submit-buyer': 'submit',
  'confirm-order': 'submit',
  'refresh-list': 'refresh',
  'reload-page': 'refresh',
  'solve-challenge': 'captcha',
  'bypass-queue': 'queue',
  payment: 'payment',
};
const MODE_TO_DECISION = { auto: D.ALLOWED, manual: D.CONFIRMATION_REQUIRED, never: D.BLOCKED };

/**
 * site：'pool'（本機模擬站）或 'ibon'；action：上面 ACTIONS 的鍵；ctx：{ cfg }。
 * 回 { decision, reason, label, site, action }。
 */
export function policyDecision(site, action, ctx = {}) {
  const lbl = ACTIONS[action] || String(action);
  const out = (decision, reason) => ({ decision, reason, label: lbl, site, action });
  if (!ACTIONS[action]) return out(D.UNKNOWN, '沒有列在操作政策裡的操作，一律先停下來');
  if (site === 'pool') {
    const rule = POOL_POLICY[action];
    const [decision, reason] = typeof rule === 'function' ? rule(ctx) : rule;
    return out(decision, reason);
  }
  if (site === 'ibon') {
    const p = IBON_POLICY.find((x) => x.action === IBON_ACTION[action]);
    if (!p) return out(D.UNKNOWN, 'ibon 的操作政策裡沒有這一項');
    return out(MODE_TO_DECISION[p.mode] || D.UNKNOWN, p.basis);
  }
  return out(D.UNKNOWN, '認不得的網站，一律先停下來');
}

/** 整張表（設定頁顯示、測試用）：site 的每個操作與結果 */
export function policyTable(site, ctx = {}) {
  return Object.keys(ACTIONS).map((a) => policyDecision(site, a, ctx));
}
