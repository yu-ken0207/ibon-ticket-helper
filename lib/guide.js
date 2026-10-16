// ibon 人工操作模式（純函式，不碰網頁）：每一頁讀到的資訊 → 各欄位的讀取結果、建議、判斷依據、核對上一步。
// 網站上的點擊、送出、付款一律由你自己做（ibon 的操作政策：選擇與送出是 CONFIRMATION_REQUIRED、驗證與付款是 BLOCKED）。
// 讀取結果分四種，不猜：
//   ok           讀到了，而且這種讀法在真站核對過
//   unverified   讀到了，但讀法或寫法還沒在真站核對過；或這種頁面的結構還沒取得真站快照
//   fail         這一頁應該有，但沒讀到
//   unavailable  這一頁本來就沒有這項資訊
import { memberLimit, matchIbonPrefs, IBON_PAGE_INFO } from './ibon.js';
import { requirementOf, planSession } from './planner.js';
import { policyDecision } from './policy.js';

const VERIFIED_STATUS = new Set(['on-sale', 'sold-out']);   // 真站看過的按鈕字：線上購票、已售完
const PLAN_STATUS = { 'on-sale': 'available', 'sold-out': 'full', closed: 'full', 'not-open': 'not-open' };

/** 活動頁的場次 → 規劃器的格式。活動頁沒有剩餘數量（remaining 一律 null） */
export function sessionsForPlan(sessions) {
  return (sessions || []).map((s, i) => ({
    id: String(i),
    text: [s.when, s.name].filter(Boolean).join(' '),
    status: PLAN_STATUS[s.status] || 'unknown',
    remaining: null,
  }));
}

/** 活動頁各欄位的讀取結果 */
export function activityFields(info) {
  const i = info || {};
  const ss = i.sessions || [];
  const f = (field, status, value, note = '') => ({ field, status, value, note });
  const out = [];
  out.push(i.title ? f('活動名稱', 'ok', i.title) : f('活動名稱', 'fail', null, '沒讀到標題'));
  out.push(ss.length ? f('場次', 'ok', `${ss.length} 個`) : f('場次', 'fail', null, '沒讀到場次表'));
  if (ss.length) {
    const odd = ss.filter((s) => !VERIFIED_STATUS.has(s.status));
    const unknown = ss.filter((s) => s.status === 'unknown');
    if (unknown.length) out.push(f('場次狀態', 'fail', null, `${unknown.length} 個場次的按鈕字沒見過，看不出狀態`));
    else if (odd.length) out.push(f('場次狀態', 'unverified', odd.map((s) => s.statusLabel).join('、'), '「尚未開賣」「停止販售」這類字是推測的寫法，真站還沒看過'));
    else out.push(f('場次狀態', 'ok', [...new Set(ss.map((s) => s.statusLabel))].join('、')));
    const ends = ss.filter((s) => s.saleEnd);
    out.push(ends.length ? f('販售截止', 'ok', ends.map((s) => s.saleEnd.replace('T', ' ')).join('、')) : f('販售截止', 'unavailable', null, '場次旁沒寫截止時間'));
  }
  out.push((i.prices || []).length
    ? f('票區與價格', 'ok', i.prices.map((p) => `${p.name || '（沒寫名稱）'} NT$${p.price}`).join('、'), '來自節目介紹的文字，不是購票頁的實際票區')
    : f('票區與價格', 'fail', null, '節目介紹裡沒有認得的票價'));
  out.push(f('剩餘數量', 'unavailable', null, '活動頁沒有剩餘數量；要在購票頁看（購票頁的結構還沒驗證）'));
  const limit = memberLimit(i.limits);
  out.push(limit != null ? f('張數限制', 'ok', `每位會員限購 ${limit} 張`, '來自購票須知') : f('張數限制', 'fail', null, '購票須知裡沒有認得的限購規定'));
  out.push((i.saleTimes || []).length ? f('開賣時間', 'ok', i.saleTimes.map((t) => t.at.replace('T', ' ')).join('、')) : f('開賣時間', 'fail', null, '節目介紹裡沒有認得的開賣時間'));
  out.push(f('驗證碼', 'unavailable', null, '活動頁沒有驗證碼'));
  const login = i.login || {};
  out.push(login.state === 'logged-out' ? f('登入', 'ok', '沒有登入', '頁首有「快速登入」（真站看過）') : f('登入', 'unverified', '看不出來', '頁首沒看到「快速登入」，可能已登入（登入後的頁首還沒在真站核對過）'));
  return out;
}

/** 購票頁（UTK02）各欄位：結構還沒取得真站快照，一律「尚未驗證」，只附頁面上看到的字樣提示 */
export function purchaseFields(state) {
  const hints = (state && state.hints) || [];
  const has = (k) => hints.find((h) => h.state === k);
  const pending = '購票頁的結構還沒取得真站快照，讀法還沒寫';
  return [
    { field: '票區', status: 'unverified', value: null, note: pending },
    { field: '價格', status: 'unverified', value: null, note: pending },
    { field: '剩餘數量', status: 'unverified', value: null, note: pending },
    { field: '張數限制', status: 'unverified', value: null, note: pending },
    { field: '驗證碼區域', status: 'unverified', value: has('captcha') ? `頁面上有「${has('captcha').evidence}」` : '沒看到驗證碼字樣', note: '只辨識有沒有，不讀、不填' },
    { field: '排隊／流量控管', status: 'unverified', value: has('queue') ? `頁面上有「${has('queue').evidence}」` : '沒看到排隊字樣', note: '只照字樣提示' },
    { field: '登入', status: state && state.login && state.login.state === 'logged-out' ? 'ok' : 'unverified', value: state && state.login ? state.login.msg : null, note: '' },
  ];
}

const manualBasis = (action) => {
  const d = policyDecision('ibon', action);
  return `這一步由你自己做（${d.decision}：${d.reason}）`;
};

/**
 * 活動頁：依你的需求排出建議的場次，附判斷依據（每個場次選或不選的理由）、需求比對、這一步由你自己做的依據。
 * expect 是做完這一步之後，下一頁要核對的內容。
 */
export function guideActivity(info, cfg) {
  const req = requirementOf(cfg || {});
  const fields = activityFields(info);
  const plan = planSession(sessionsForPlan(info.sessions), req);
  const match = matchIbonPrefs(info, { areas: (req.areas || []).join('\n'), qty: req.need, maxPrice: req.maxUnitPrice || '' });
  const steps = [];
  if (info.login && info.login.state === 'logged-out') steps.push('先登入（購票須知要求購票前登入）');
  let expect = null;
  if (plan.kind === 'ok') {
    steps.push(`自己按「${plan.slot.text}」那一列的「線上購票」`);
    expect = { step: 'session', sessionText: plan.slot.text };
  } else if (plan.kind === 'not-open') steps.push('偏好的場次還沒開賣：開賣時自己重新整理再選（助手不自動重新整理）');
  else if (plan.kind === 'unknown') steps.push('偏好的場次狀態看不出來：請自己確認能不能買');
  else steps.push('偏好的場次都買不到或對不到，請調整時段關鍵字');
  return {
    pageKind: 'activity', label: IBON_PAGE_INFO.activity.label, fields,
    recommendation: steps.join('；'),
    basis: { plan: { result: plan.kind, msg: plan.msg, ranked: plan.ranked }, match: { areas: match.areas.map((a) => a.msg), qty: match.qty.msg, msgs: match.msgs }, policy: manualBasis('select-session') },
    verify: null, expect,
  };
}

/**
 * 購票頁：結構還沒驗證，讀不出票區與張數；能核對的只有「你已經進到購票流程」。
 * prev 是上一頁的建議（核對用）：選了哪個場次這一頁還核對不了，照實說。
 */
export function guidePurchase(state, prev) {
  const kind = (state && state.kind) || 'purchase';
  const label = (IBON_PAGE_INFO[kind] || {}).label || '購票流程的頁面';
  const want = prev && prev.expect && prev.expect.sessionText;
  const verify = {
    status: 'unverified',
    msg: `你已經進到${label}。${want ? `這一頁的結構還沒在真站核對，無法確認是不是「${want}」；` : ''}讀不出票區、價格、剩餘與張數，不猜`,
  };
  const steps = [];
  if (state && state.login && state.login.state === 'logged-out') steps.push('先登入');
  steps.push('照頁面自己選票區、張數；遇到驗證碼請自己輸入。助手不點、不填、不送出');
  steps.push('可以按「記錄結構快照」交給開發，之後才能讀這一頁');
  return {
    pageKind: kind, label, fields: purchaseFields(state), recommendation: steps.join('；'),
    basis: { policy: manualBasis('select-area'), hints: ((state && state.hints) || []).map((h) => `${h.msg}（未驗證）`) },
    verify, expect: null,
  };
}

/** 認不得的頁面：不猜 */
export function guideOther(kind) {
  return { pageKind: kind || 'other', label: (IBON_PAGE_INFO[kind] || {}).label || '認不得的頁面', fields: [], recommendation: '這一頁助手認不得，請自己操作', basis: {}, verify: { status: 'fail', msg: '認不得這一頁' }, expect: null };
}
