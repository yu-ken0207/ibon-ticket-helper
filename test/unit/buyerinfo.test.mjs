// 填寫購票資訊（UTK0206）：照真站快照結構的解析與核對。內容都是虛構的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ibonPageKind, parseTicketOption, parseBuyerInfo, sameSessionTime } from '../../lib/ibon.js';
import { guideBuyerInfo, buyerInfoFields } from '../../lib/guide.js';

const RAW = {
  steps: [{ n: '3', text: '座位/數量', active: false }, { n: '4', text: '填寫購票資訊', active: true }],
  title: '示範音樂會',
  rows: [{ name: '示範音樂會', time: '2026/12/05 18:00', venue: '示範展演廳', seat: '2樓看台_3排-12號', type: '全票-NT$1,500', qty: '2', price: '3,000' }],
  total: '$3,000', countdown: '剩餘時間09:33', discount: '本場次票區無折扣優惠',
  phoneFilled: true, emailShown: true,
  pay: [{ label: '信用卡', checked: true }, { label: 'ATM 轉帳', checked: false }],
  get: [{ label: 'ibon紙票', checked: true }], agree: false,
  buttons: ['取消', '繼續選購', '下一步，核對資料'], captchaText: null,
};
const PREV = { expect: { step: 'session', sessionText: '2026/12/05(六) 18:00 夜間入場（第一梯）' } };
const field = (fs, k) => fs.find((f) => f.field === k);

test('UTK0206 是填寫購票資訊頁；其他 UTK02 頁照舊', () => {
  assert.equal(ibonPageKind('https://orders.ibon.com.tw/application/UTK02/UTK0206_.aspx'), 'buyer-info');
  assert.equal(ibonPageKind('https://orders.ibon.com.tw/application/UTK02/UTK0202_.aspx'), 'purchase');
  assert.equal(ibonPageKind('https://orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=1'), 'purchase-entry');
});

test('票種選項與場次時間', () => {
  assert.deepEqual(parseTicketOption('全票-NT$5,800'), { name: '全票', price: 5800 });
  assert.deepEqual(parseTicketOption('愛心票 - NT$ 900'), { name: '愛心票', price: 900 });
  assert.equal(parseTicketOption('全票'), null);
  assert.equal(sameSessionTime('2026/11/14 15:30', '2026/11/14(六) 15:30 Fan Meeting'), true);
  assert.equal(sameSessionTime('2026/11/14 15:30', '2026/11/15(日) 15:30'), false);
  assert.equal(sameSessionTime('2026/11/14 15:30', '第一梯'), null);
});

test('解析：步驟、訂單、總計、保留時間、選項；讀不到的是 null', () => {
  const d = parseBuyerInfo(RAW);
  assert.deepEqual(d.step, { n: 4, text: '填寫購票資訊' });
  assert.deepEqual(d.rows[0], { name: '示範音樂會', time: '2026/12/05 18:00', venue: '示範展演廳', seat: '2樓看台_3排-12號', ticketType: '全票', unitPrice: 1500, qty: 2, price: 3000 });
  assert.equal(d.total, 3000);
  assert.deepEqual(d.holdLeft, { text: '09:33', seconds: 573 });
  assert.equal(d.pay.chosen, '信用卡');
  assert.equal(d.next, '下一步，核對資料');
  const empty = parseBuyerInfo({});
  assert.equal(empty.step, null); assert.equal(empty.total, null); assert.equal(empty.phoneFilled, null); assert.equal(empty.agree, null);
  const f = buyerInfoFields(empty);
  assert.equal(field(f, '目前步驟').status, 'fail');
  assert.equal(field(f, '訂單內容').status, 'fail');
  assert.equal(field(f, '剩餘數量').status, 'unavailable');
});

test('核對：跟建議與需求一致', () => {
  const g = guideBuyerInfo(parseBuyerInfo(RAW), PREV, { tickets: [{ name: '全票', qty: 2 }], maxUnitPrice: 2000 });
  assert.equal(g.verify.status, 'ok', g.verify.msg);
  assert.match(g.recommendation, /剩 09:33/);
  assert.match(g.recommendation, /自己勾選同意/);
  assert.match(g.recommendation, /自己按「下一步，核對資料」。助手不點、不填、不送出/);
  assert.equal(field(g.fields, '張數').value, '2 張');
  assert.equal(field(g.fields, '驗證碼區域').status, 'unverified');
});

test('核對：場次、張數、票種、單價、總額不一致都列出來；看不出來的不猜', () => {
  const raw = { ...RAW, rows: [{ ...RAW.rows[0], time: '2026/12/06 18:00', type: '愛心票-NT$1,500', qty: '1', price: '1,500' }], total: '$1,500' };
  const g = guideBuyerInfo(parseBuyerInfo(raw), PREV, { tickets: [{ name: '全票', qty: 2 }], maxUnitPrice: 1000, maxTotal: 1200 });
  assert.equal(g.verify.status, 'fail');
  for (const re of [/場次時間是 2026\/12\/06 18:00/, /張數是 1 張，你的需求是 2 張/, /票種是「愛心票」/, /超過你設定的最高單價 NT\$1000/, /超過你設定的總金額上限 NT\$1200/]) assert.match(g.verify.msg, re);
  assert.match(g.recommendation, /要不要繼續或按「取消」由你決定/);
  const g2 = guideBuyerInfo(parseBuyerInfo(RAW), null, { tickets: [{ name: '全票', qty: 2 }] });
  assert.equal(g2.verify.status, 'unverified');
  assert.match(g2.verify.msg, /沒有上一步的場次建議/);
});
