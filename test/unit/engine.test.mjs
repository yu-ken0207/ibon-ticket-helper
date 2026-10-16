import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, canTransition, transition, newWorkflow, stateOfResult, composeHandoff, isTerminal } from '../../lib/workflow.js';
import { D, ACTIONS, policyDecision, policyTable } from '../../lib/policy.js';
import { requirementOf, matchTickets, planSession, planArea, reviewOrder } from '../../lib/planner.js';

/* ───── 流程狀態機 ───── */

test('狀態機：每個狀態都有進入條件、允許的動作、完成條件、錯誤處理、下一步', () => {
  for (const [k, s] of Object.entries(STATES)) {
    assert.ok(s.label && s.entry && s.done && s.errors && Array.isArray(s.actions) && Array.isArray(s.next), k);
    for (const n of s.next) assert.ok(STATES[n], `${k} → ${n} 不存在`);
    for (const a of s.actions) assert.ok(ACTIONS[a], `${k} 的動作 ${a} 不在操作政策裡`);
  }
});

test('狀態機：正常的購票路徑每一步都合法', () => {
  const path = ['IDLE', 'PAGE_DETECTION', 'ACTIVITY_READ', 'REQUIREMENT_CHECK', 'SESSION_SELECTION', 'PAGE_DETECTION', 'TICKET_AREA_SELECTION',
    'QUANTITY_SELECTION', 'PAGE_DETECTION', 'BUYER_INFO', 'PAGE_DETECTION', 'ORDER_REVIEW', 'PAYMENT_HANDOFF', 'COMPLETED'];
  let wf = newWorkflow();
  for (const to of path.slice(1)) {
    const r = transition(wf, to, { now: 1 });
    assert.equal(r.ok, true, `${wf.state} → ${to}`);
    wf = r.wf;
  }
  assert.equal(wf.state, 'COMPLETED');
  assert.equal(wf.history.length, path.length - 1);
});

test('狀態機：排程、尚未開放、暫停、交接、取消', () => {
  assert.equal(canTransition('IDLE', 'WAITING_FOR_SALE'), true);
  assert.equal(canTransition('WAITING_FOR_SALE', 'PAGE_DETECTION'), true);
  assert.equal(canTransition('REQUIREMENT_CHECK', 'WAITING_FOR_SALE'), true);
  assert.equal(canTransition('WAITING_FOR_SALE', 'ACTIVITY_READ'), true);
  assert.equal(canTransition('QUANTITY_SELECTION', 'PAUSED'), true);
  assert.equal(canTransition('PAUSED', 'PAGE_DETECTION'), true);
  assert.equal(canTransition('PAUSED', 'QUANTITY_SELECTION'), false);   // 繼續一定先重新判斷頁面
  assert.equal(canTransition('QUANTITY_SELECTION', 'RATE_LIMIT_HANDOFF'), true);
  assert.equal(canTransition('MANUAL_CONFIRMATION', 'PAGE_DETECTION'), true);
  assert.equal(canTransition('PAUSED', 'CANCELLED'), true);
});

test('狀態機：不合法的轉移被拒絕；結束的狀態不能再動；付款前交接只能從核對訂單來', () => {
  assert.equal(canTransition('ACTIVITY_READ', 'QUANTITY_SELECTION'), false);
  assert.equal(canTransition('SESSION_SELECTION', 'PAYMENT_HANDOFF'), false);
  assert.equal(canTransition('ORDER_REVIEW', 'PAYMENT_HANDOFF'), true);
  assert.equal(canTransition('PAYMENT_HANDOFF', 'PAGE_DETECTION'), false);
  assert.equal(canTransition('PAYMENT_HANDOFF', 'COMPLETED'), true);
  for (const t of ['FAILED', 'COMPLETED', 'CANCELLED']) {
    assert.equal(isTerminal(t), true);
    assert.equal(canTransition(t, 'PAGE_DETECTION'), false);
  }
  const r = transition({ ...newWorkflow(), state: 'ACTIVITY_READ' }, 'BUYER_INFO');
  assert.equal(r.ok, false);
  assert.match(r.msg, /不能從「讀取活動與場次」直接到「填購票人資料」/);
  assert.equal(r.wf.state, 'ACTIVITY_READ');
  const f = transition({ ...newWorkflow(), state: 'ACTIVITY_READ' }, 'BUYER_INFO', { force: true });
  assert.equal(f.wf.history.at(-1).forced, true);
});

test('狀態機：同一個狀態再進一次（重讀列表）不記歷程；歷程有上限', () => {
  let wf = transition(newWorkflow(), 'PAGE_DETECTION').wf;
  wf = transition(wf, 'ACTIVITY_READ').wf;
  const again = transition(wf, 'ACTIVITY_READ');
  assert.equal(again.ok, true);
  assert.equal(again.wf.history.length, wf.history.length);
  for (let i = 0; i < 100; i++) wf = transition(transition(wf, 'REQUIREMENT_CHECK').wf, 'WAITING_FOR_SALE').wf, wf = transition(wf, 'ACTIVITY_READ').wf;
  assert.ok(wf.history.length <= 60);
});

test('結果 → 狀態：付款前交接、排隊、驗證、請求太多、其他交給你、失敗、完成', () => {
  assert.equal(stateOfResult({ ok: true, kind: 'ready', handOff: true }), 'PAYMENT_HANDOFF');
  assert.equal(stateOfResult({ ok: false, kind: 'queue', handOff: true }), 'QUEUE_HANDOFF');
  assert.equal(stateOfResult({ ok: false, kind: 'captcha_required', handOff: true }), 'CHALLENGE_HANDOFF');
  assert.equal(stateOfResult({ ok: false, kind: 'rate-limited', handOff: true }), 'RATE_LIMIT_HANDOFF');
  assert.equal(stateOfResult({ ok: false, kind: 'login-required', handOff: true }), 'MANUAL_CONFIRMATION');
  assert.equal(stateOfResult({ ok: false, kind: 'budget', handOff: false }), 'FAILED');
  assert.equal(stateOfResult({ ok: true, kind: 'ordered' }), 'COMPLETED');
});

test('交接內容：原因、頁面、已確認的內容、下一步', () => {
  const wf = { ...newWorkflow(), done: { hold: { at: 1 }, buyer: { at: 2 } }, selection: { sessionText: '11/20 06:00', items: [{ name: '全票', qty: 2 }], amount: 220 } };
  const h = composeHandoff('PAYMENT_HANDOFF', { kind: 'ready', msg: '已到確認頁', page: { kind: 'confirm', url: 'x' }, wf, summary: { session: '11/20 06:00', area: '戶外池', items: [{ name: '全票', qty: 2 }], amount: 280, holdLeftSec: 590 } });
  assert.equal(h.label, '付款前交接');
  assert.deepEqual(h.confirmed.steps, ['hold', 'buyer']);
  assert.equal(h.confirmed.area, '戶外池');
  assert.equal(h.confirmed.amount, 280);
  assert.match(h.next, /自己按「確認建立訂單」/);
  assert.match(composeHandoff('MANUAL_CONFIRMATION', { kind: 'unknown-result' }).next, /不會自己重送/);
});

/* ───── 操作政策 ───── */

test('操作政策（模擬站）：選擇與保留可以自動；建立訂單要你確認；驗證、排隊、付款不做；沒列的停下來', () => {
  const d = (a, cfg) => policyDecision('pool', a, { cfg }).decision;
  for (const a of ['read-page', 'select-session', 'select-area', 'set-quantity', 'submit-hold', 'fill-profile', 'submit-buyer']) assert.equal(d(a), D.ALLOWED, a);
  assert.equal(d('confirm-order'), D.CONFIRMATION_REQUIRED);
  assert.equal(d('agree-terms', { autoAgree: false }), D.CONFIRMATION_REQUIRED);
  assert.equal(d('agree-terms', { autoAgree: true }), D.ALLOWED);
  for (const a of ['solve-challenge', 'bypass-queue', 'payment']) assert.equal(d(a), D.BLOCKED, a);
  assert.equal(d('click-anything'), D.UNKNOWN);
  assert.equal(policyDecision('somewhere', 'read-page').decision, D.UNKNOWN);
});

test('操作政策（ibon）：只讀可以；選擇、張數、送出要網站規則確認；驗證、排隊、付款不做', () => {
  const t = Object.fromEntries(policyTable('ibon').map((x) => [x.action, x]));
  assert.equal(t['read-page'].decision, D.ALLOWED);
  assert.equal(t['select-session'].decision, D.ALLOWED);
  assert.match(t['select-session'].reason, /客服中心 2026-10-16/);
  for (const a of ['select-area', 'set-quantity', 'submit-hold', 'submit-buyer', 'refresh-list']) {
    assert.equal(t[a].decision, D.ALLOWED, a);
    assert.ok(t[a].reason, a);
  }
  assert.equal(t['confirm-order'].decision, D.CONFIRMATION_REQUIRED);
  for (const a of ['solve-challenge', 'bypass-queue', 'payment']) assert.equal(t[a].decision, D.BLOCKED, a);
  assert.match(t['select-area'].reason, /第二封回覆/);
});

/* ───── 需求比對與規劃 ───── */

const SLOTS = [
  { id: 'a', text: '11/20（五） 06:00–08:00', status: 'available', remaining: 80 },
  { id: 'b', text: '11/20（五） 08:00–10:00', status: 'limited', remaining: 2 },
  { id: 'c', text: '11/20（五） 10:00–12:00', status: 'full', remaining: 0 },
  { id: 'd', text: '11/20（五） 14:00–16:00', status: 'unknown', remaining: null },
  { id: 'e', text: '11/21（六） 06:00–08:00', status: 'not-open', remaining: null },
  { id: 'f', text: '11/21（六） 08:00–10:00', status: 'available', remaining: 30 },
];
const req = (o = {}) => requirementOf({ keywords: ['11/20 06:00'], tickets: [{ name: '全票', qty: 2 }, { name: '兒童票', qty: 1 }], ...o });

test('需求：從設定整理出來；張數合計', () => {
  const r = req({ areas: ['戶外', ''], maxUnitPrice: '150', maxTotal: '1,000' });
  assert.equal(r.need, 3);
  assert.deepEqual(r.areas, ['戶外']);
  assert.equal(r.maxUnitPrice, 150);
  assert.equal(r.maxTotal, 1000);
});

test('規劃場次：照偏好選、附理由；剩不夠、額滿跳過；看不出狀態就停下來問；還沒開放就等', () => {
  const ok = planSession(SLOTS, req({ keywords: ['11/20 10:00', '11/20 08:00', '11/21 08:00'] }));
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.slot.id, 'f');
  assert.deepEqual(ok.ranked.map((r) => [r.id, r.verdict]), [['c', 'skip'], ['b', 'skip'], ['f', 'chosen']]);
  assert.match(ok.ranked[1].reason, /只剩 2 張，不夠 3 張/);
  assert.match(ok.msg, /第 3 個偏好/);
  const unk = planSession(SLOTS, req({ keywords: ['11/20 14:00', '11/21 08:00'] }));
  assert.equal(unk.kind, 'unknown');
  assert.match(unk.msg, /看不出能不能買/);
  assert.equal(planSession(SLOTS, req({ keywords: ['11/21 06:00', '11/21 08:00'] })).kind, 'not-open');
  const so = planSession(SLOTS, req({ keywords: ['11/20 10:00', '11/20 08:00'] }));
  assert.equal(so.kind, 'sold-out');
  assert.deepEqual(so.short, { text: '11/20（五） 08:00–10:00', remaining: 2 });   // 給 describePick 用
  assert.equal(planSession(SLOTS, req({ keywords: ['12/25'] })).names.length, SLOTS.length);
  assert.equal(planSession(SLOTS, req({ keywords: ['12/25'] })).kind, 'no-match');
  const fb = planSession(SLOTS, req({ keywords: ['11/20 10:00'], fallback: true }));
  assert.equal(fb.kind, 'ok');
  assert.equal(fb.slot.id, 'a');
  assert.equal(planSession(SLOTS, req({ keywords: ['11/20 06:00'] }), { skip: ['a'] }).kind, 'sold-out');
});

const TYPES = [{ id: 'adult', name: '全票', price: 110 }, { id: 'child', name: '兒童票', price: 60 }];

test('票種與預算：最高單價、總金額上限；票種名稱對不到', () => {
  assert.equal(matchTickets(req(), TYPES).ok, true);
  assert.equal(matchTickets(req(), TYPES).plan.amount, 280);
  const unit = matchTickets(req({ maxUnitPrice: 100 }), TYPES);
  assert.equal(unit.kind, 'budget');
  assert.match(unit.msg, /全票每張 NT\$110超過你設定的最高單價 NT\$100/);
  assert.equal(matchTickets(req({ maxTotal: 250 }), TYPES).kind, 'budget');
  assert.equal(matchTickets(req({ maxUnitPrice: 140 }), TYPES, { surcharge: 30 }).ok, true);
  assert.equal(matchTickets(req({ maxUnitPrice: 139 }), TYPES, { surcharge: 30 }).kind, 'budget');
  assert.equal(matchTickets(req({ tickets: [{ name: '敬老票', qty: 1 }] }), TYPES).kind, 'tickets');
});

const AREAS = [
  { id: 'indoor', name: '室內池', surcharge: 0, remaining: 0, soldOut: true },
  { id: 'outdoor', name: '戶外池', surcharge: 30, remaining: 30, soldOut: false },
  { id: 'family', name: '親子池', surcharge: 50, remaining: 2, soldOut: false },
];

test('規劃票區：偏好的售完就換下一個；超過預算、剩不夠的跳過；都不行就說明', () => {
  const a = planArea(AREAS, req({ areas: ['室內', '戶外'] }), TYPES);
  assert.equal(a.kind, 'ok');
  assert.equal(a.area.id, 'outdoor');
  assert.deepEqual(a.ranked.map((r) => [r.id, r.verdict]), [['indoor', 'skip'], ['outdoor', 'chosen']]);
  assert.equal(a.tickets.plan.amount, (110 + 30) * 2 + (60 + 30));
  const budget = planArea(AREAS, req({ areas: ['親子', '戶外'], tickets: [{ name: '全票', qty: 1 }], maxUnitPrice: 150 }), TYPES);
  assert.equal(budget.area.id, 'outdoor');
  assert.match(budget.ranked[0].reason, /超過你設定的最高單價/);
  const none = planArea(AREAS, req({ areas: ['親子'] }), TYPES);
  assert.equal(none.kind, 'none');
  assert.match(none.msg, /只剩 2 張，不夠 3 張/);
  assert.equal(planArea(AREAS, req(), TYPES).area.id, 'outdoor');   // 沒設偏好：照頁面順序第一個能買的
  assert.equal(planArea(AREAS, req({ areas: ['戶外'] }), TYPES, { skip: ['outdoor'] }).kind, 'none');
});

test('核對訂單：一致才交接；張數、票區、場次、金額不一樣都列出來', () => {
  const expect = { sessionText: '11/20（五） 06:00–08:00', areaName: '戶外池', items: [{ name: '全票', qty: 2 }, { name: '兒童票', qty: 1 }], amount: 370 };
  const same = { session: '11/20（五） 06:00-08:00', area: '戶外池', items: [{ name: '全票', qty: 2 }, { name: '兒童票', qty: 1 }], amount: 370 };
  assert.equal(reviewOrder(same, expect).ok, true);
  const diff = reviewOrder({ ...same, items: [{ name: '全票', qty: 1 }, { name: '兒童票', qty: 1 }], amount: 230 }, expect);
  assert.equal(diff.ok, false);
  assert.match(diff.msg, /全票：預計 2 張，確認頁是 1 張/);
  assert.match(diff.msg, /金額：預計 NT\$370，確認頁是 NT\$230/);
  assert.match(reviewOrder({ ...same, area: '室內池' }, expect).msg, /票區/);
  assert.match(reviewOrder({ ...same, items: [] }, expect).msg, /讀不到票種與張數/);
  assert.equal(reviewOrder(same, { sessionText: same.session }).ok, true);   // 沒有計畫的票種：不比對張數
});
