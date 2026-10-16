// ibon 人工操作模式（純函式，不碰網頁）：每一頁讀到的資訊 → 各欄位的讀取結果、建議、判斷依據、核對上一步。
// 網站上的點擊、送出、付款一律由你自己做（ibon 的操作政策：選擇與送出是 CONFIRMATION_REQUIRED、驗證與付款是 BLOCKED）。
// 讀取結果分四種，不猜：
//   ok           讀到了，而且這種讀法在真站核對過
//   unverified   讀到了，但讀法或寫法還沒在真站核對過；或這種頁面的結構還沒取得真站快照
//   fail         這一頁應該有，但沒讀到
//   unavailable  這一頁本來就沒有這項資訊
import { memberLimit, matchIbonPrefs, IBON_PAGE_INFO, sameSessionTime } from './ibon.js';
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
    verify, expect: (prev && prev.expect) || null,   // 這一頁核對不了：留給之後讀得到場次的頁面（填寫購票資訊）核對
  };
}

const SNAP_NOTE = '讀法照 2026-10-16 的一次真站快照';

/** 填寫購票資訊（UTK0206）各欄位：d 是 lib/ibon.js parseBuyerInfo 的結果 */
export function buyerInfoFields(d) {
  const x = d || {};
  const row = (x.rows || [])[0] || null;
  const f = (field, status, value, note = '') => ({ field, status, value, note });
  const okOr = (field, v, fmt, failNote) => (v != null ? f(field, 'ok', fmt ? fmt(v) : v, SNAP_NOTE) : f(field, 'fail', null, failNote));
  const out = [];
  out.push(x.step ? f('目前步驟', 'ok', `第 ${x.step.n} 步：${x.step.text}`, SNAP_NOTE) : f('目前步驟', 'fail', null, '沒讀到步驟列'));
  if (!row) out.push(f('訂單內容', 'fail', null, '沒讀到訂單表格'));
  else {
    out.push(okOr('場次時間', row.time, null, '表格裡沒有活動時間'));
    out.push(okOr('場地', row.venue, null, '表格裡沒有場地'));
    // 多筆（例如全票、學生票各一筆）：座位、票種、單價逐筆列出，張數是合計；任何一筆讀不到就照實標
    const rows = x.rows;
    const all = (k) => rows.every((r) => r[k] != null);
    const list = (fn) => rows.map(fn).join('、');
    const multi = rows.length > 1 ? `（${rows.length} 筆，${SNAP_NOTE}只看過 1 筆的樣子）` : '';
    out.push(all('seat') ? f('票區／座位', 'ok', list((r) => r.seat), multi || SNAP_NOTE) : f('票區／座位', 'fail', null, '有一筆沒有區域/座位'));
    if (!rows.some((r) => r.ticketType)) out.push(f('票種', 'fail', null, '沒讀到票種'));
    else out.push(f('票種', all('unitPrice') ? 'ok' : 'unverified', list((r) => r.ticketType || '（沒讀到）'), all('unitPrice') ? (multi || SNAP_NOTE) : '選項的寫法跟快照不一樣，讀不出單價'));
    out.push(all('unitPrice') ? f('單價', 'ok', list((r) => `${rows.length > 1 ? `${r.ticketType} ` : ''}NT$${r.unitPrice}`), multi || SNAP_NOTE) : f('單價', 'fail', null, '票種選項裡沒有價格'));
    out.push(all('qty') ? f('張數', 'ok', `${rows.reduce((n, r) => n + r.qty, 0)} 張`, rows.length > 1 ? `合計${multi}` : SNAP_NOTE) : f('張數', 'fail', null, '沒讀到數量'));
  }
  out.push(okOr('總計', x.total, (v) => `NT$${v}`, '沒讀到總計'));
  out.push(x.holdLeft ? f('保留剩餘時間', 'ok', x.holdLeft.text, '讀到的當下；時間到網站會釋出') : f('保留剩餘時間', 'fail', null, '沒看到「剩餘時間」'));
  out.push(f('剩餘數量', 'unavailable', null, '這一頁沒有剩餘數量'));
  out.push(f('張數限制', 'unavailable', null, '這一頁沒有限購說明；看活動頁的購票須知'));
  out.push(x.phoneFilled == null ? f('聯絡電話', 'fail', null, '沒找到聯絡電話欄') : f('聯絡電話', 'ok', x.phoneFilled ? '已填（助手不讀內容）' : '還沒填', ''));
  out.push(x.pay ? f('付款方式', 'ok', x.pay.chosen ? `已選「${x.pay.chosen}」` : '還沒選', `頁面上的選項：${x.pay.options.join('、')}`) : f('付款方式', 'fail', null, '沒讀到付款方式'));
  out.push(x.get ? f('取票方式', 'ok', x.get.chosen ? `已選「${x.get.chosen}」` : '還沒選', `頁面上的選項：${x.get.options.join('、')}`) : f('取票方式', 'fail', null, '沒讀到取票方式'));
  out.push(x.agree == null ? f('同意條款', 'fail', null, '沒找到同意的勾選框') : f('同意條款', 'ok', x.agree ? '已勾選' : '還沒勾選', ''));
  out.push(x.captcha ? f('驗證碼區域', 'unverified', `頁面上有「${x.captcha}」`, '快照裡這一頁沒有驗證碼；只辨識有沒有，不讀、不填')
    : f('驗證碼區域', 'unverified', '沒看到驗證碼字樣', '快照裡這一頁沒有驗證碼（只看過一次）；只辨識有沒有，不讀、不填'));
  return out;
}

/**
 * 填寫購票資訊：核對訂單內容跟上一步的建議與你的需求（場次時間、張數、票種、單價、總金額），
 * 提醒保留時間，列出你要自己做的事。不一致只提醒，要不要按「取消」由你決定。
 */
export function guideBuyerInfo(d, prev, cfg) {
  const x = d || {};
  const req = requirementOf(cfg || {});
  const rows = x.rows || [];
  const fields = buyerInfoFields(x);
  const ok = [], bad = [], unknown = [];
  const want = prev && prev.expect && prev.expect.sessionText;
  if (want) {
    const same = rows.length ? sameSessionTime(rows[0].time, want) : null;
    if (same === true) ok.push(`場次時間 ${rows[0].time} 跟建議的「${want}」一致`);
    else if (same === false) bad.push(`場次時間是 ${rows[0].time}，建議的是「${want}」`);
    else unknown.push(`無法確認場次是不是「${want}」`);
  } else unknown.push('沒有上一步的場次建議可以核對（可能是中途才開始，或上一頁不是活動頁）');
  const qty = rows.reduce((a, r) => a + (r.qty || 0), 0);
  if (!rows.length || rows.some((r) => r.qty == null)) unknown.push('讀不出張數');
  else if (qty !== req.need) bad.push(`張數是 ${qty} 張，你的需求是 ${req.need} 張`);
  else ok.push(`張數 ${qty} 張跟需求一致`);
  const names = (req.tickets || []).map((t) => t.name).filter(Boolean);
  for (const r of rows) {
    if (r.ticketType && names.length && !names.includes(r.ticketType)) bad.push(`票種是「${r.ticketType}」，你的需求寫的是${names.map((n) => `「${n}」`).join('、')}`);
    if (r.unitPrice != null && req.maxUnitPrice && r.unitPrice > req.maxUnitPrice) bad.push(`${r.ticketType || '票'}每張 NT$${r.unitPrice}，超過你設定的最高單價 NT$${req.maxUnitPrice}`);
  }
  if (x.total != null && req.maxTotal && x.total > req.maxTotal) bad.push(`總計 NT$${x.total}，超過你設定的總金額上限 NT$${req.maxTotal}`);
  if (x.total != null && rows.length && rows.every((r) => r.price != null)) {
    const sum = rows.reduce((a, r) => a + r.price, 0);
    if (sum !== x.total) unknown.push(`表格價格加起來 NT$${sum}，總計寫 NT$${x.total}（可能有手續費或折扣，請自己看）`);
  }
  const verify = bad.length
    ? { status: 'fail', msg: `跟需求不一致：${bad.join('；')}${unknown.length ? `；另外${unknown.join('；')}` : ''}` }
    : { status: unknown.length ? 'unverified' : 'ok', msg: [...ok, ...unknown].join('；') || '沒有可以核對的內容' };
  const steps = [];
  if (bad.length) steps.push('內容跟你的需求不一致：要不要繼續或按「取消」由你決定');
  if (x.holdLeft) steps.push(`票已保留，剩 ${x.holdLeft.text}，時間到網站會釋出`);
  if (x.phoneFilled === false) steps.push('自己填聯絡電話');
  if (x.pay && !x.pay.chosen) steps.push('自己選付款方式');
  if (x.get && !x.get.chosen) steps.push('自己選取票方式');
  if (x.agree === false) steps.push('看過說明後自己勾選同意');
  if (x.captcha) steps.push('有驗證碼請自己輸入');
  steps.push(`自己按「${x.next || '下一步'}」。助手不點、不填、不送出`);
  return {
    pageKind: 'buyer-info', label: IBON_PAGE_INFO['buyer-info'].label, fields,
    recommendation: steps.join('；'),
    basis: { policy: manualBasis('submit-buyer'), checks: { ok, bad, unknown } },
    verify, expect: prev && prev.expect ? prev.expect : null,
  };
}

/** 認不得的頁面：不猜 */
export function guideOther(kind) {
  return { pageKind: kind || 'other', label: (IBON_PAGE_INFO[kind] || {}).label || '認不得的頁面', fields: [], recommendation: '這一頁助手認不得，請自己操作', basis: {}, verify: { status: 'fail', msg: '認不得這一頁' }, expect: null };
}

/**
 * 問題回報與測試案例用：用回報檔裡的 replay（這一頁交給助手的內容、上一步的預期、需求）原樣重跑，得到同樣的建議與欄位。
 * replay = { kind, input, prevExpect, req }
 */
export function replayGuide(replay) {
  const r = replay || {};
  const prev = r.prevExpect ? { expect: r.prevExpect } : null;
  if (r.kind === 'activity' && r.input) return guideActivity(r.input, r.req);
  if (r.kind === 'buyer-info' && r.input) return guideBuyerInfo(r.input, prev, r.req);
  if ((r.kind === 'purchase-entry' || r.kind === 'purchase') && r.input) return guidePurchase(r.input, prev);
  return guideOther(r.kind);
}
