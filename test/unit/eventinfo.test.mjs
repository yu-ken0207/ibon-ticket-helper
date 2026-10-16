import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDateTime, sessionStatus, parseSessionNote, parseSaleTimes, parsePrices, parseLimits, buildEventInfo, sanitizeInfo } from '../../lib/eventinfo.js';
import { activityUrl, eventSlug, pageKindOf, offTrackKind } from '../../lib/urls.js';

test('日期時間：各種寫法；只看日期後面一小段的時間', () => {
  assert.deepEqual(parseDateTime('2026/11/14(六) 15:30 '), { date: '2026-11-14', time: '15:30' });
  assert.deepEqual(parseDateTime('售票時間 On Sale Time：2026 年 10 月 04 日 (日) 下午 14:00 (當地時間)'), { date: '2026-10-04', time: '14:00' });
  assert.deepEqual(parseDateTime('2026.10.04 下午 2:00 開賣'), { date: '2026-10-04', time: '14:00' });
  assert.deepEqual(parseDateTime('2026-12-01 上午 12:30'), { date: '2026-12-01', time: '00:30' });
  assert.deepEqual(parseDateTime('2026/11/13'), { date: '2026-11-13', time: null });
  assert.deepEqual(parseDateTime('2026/11/13 截止，詳見說明，客服 09:00–18:00 服務'), { date: '2026-11-13', time: null });
  assert.equal(parseDateTime('11/14 15:30'), null);        // 沒有年份：不猜
  assert.equal(parseDateTime('2026/13/40 10:00'), null);
});

test('場次狀態只看按鈕上的字；能不能按也算進去', () => {
  assert.equal(sessionStatus('線上購票').status, 'on-sale');
  assert.equal(sessionStatus('已售完', true).status, 'sold-out');
  assert.equal(sessionStatus('尚未開賣', true).status, 'not-open');
  assert.equal(sessionStatus('即將開賣').status, 'not-open');
  assert.equal(sessionStatus('停止販售', true).status, 'closed');
  assert.equal(sessionStatus('線上購票', true).status, 'unknown');   // 字是能買、按鈕卻不能按
  const u = sessionStatus('洽主辦單位');
  assert.equal(u.status, 'unknown');
  assert.match(u.label, /洽主辦單位/);
  assert.equal(sessionStatus('').status, 'unknown');
});

test('場次備註：截止時間或開賣時間', () => {
  assert.deepEqual(parseSessionNote('2026/11/13 12:00截止'), { saleEnd: '2026-11-13T12:00' });
  assert.deepEqual(parseSessionNote('2026/10/20 12:00 開賣'), { saleStart: '2026-10-20T12:00' });
  assert.deepEqual(parseSessionNote('限會員購買'), {});
  assert.deepEqual(parseSessionNote(''), {});
});

test('開賣時間：節目介紹裡每個階段都列出來，附原文', () => {
  const text = [
    '演出日期 Date：2026 年 11 月 14 日 (六) 15:30',
    '票價資訊 Ticket Price：MVP $8000 | VIP區 $7000',
    '售票時間 On Sale Time：2026 年 10 月 04 日 (日) 下午 14:00 (當地時間) ',
    '會員預購 啟售時間：2026/10/02(五) 12:00',
  ].join('\n');
  const s = parseSaleTimes(text);
  assert.deepEqual(s.map((x) => x.at), ['2026-10-04T14:00', '2026-10-02T12:00']);
  assert.match(s[0].text, /^售票時間 On Sale Time/);
  assert.deepEqual(parseSaleTimes('演出日期：2026/11/14 15:30'), []);   // 演出時間不是開賣時間
});

test('票價：有名稱的、元結尾的、只有數字的；原文一起留著', () => {
  const a = parsePrices('票價資訊 Ticket Price：MVP $8000 | VIP區 $7000 | A區 $5800 | 2樓B區 $4200 | 愛心席 $2000');
  assert.deepEqual(a.prices, [
    { name: 'MVP', price: 8000 }, { name: 'VIP區', price: 7000 }, { name: 'A區', price: 5800 },
    { name: '2樓B區', price: 4200 }, { name: '愛心席', price: 2000 },
  ]);
  assert.equal(a.lines.length, 1);
  assert.deepEqual(parsePrices('票價：全票 NT$500、優待票 NT$250').prices, [{ name: '全票', price: 500 }, { name: '優待票', price: 250 }]);
  assert.deepEqual(parsePrices('票價：\n搖滾區 3,880 元／看台區 2,880 元').prices, [{ name: '搖滾區', price: 3880 }, { name: '看台區', price: 2880 }]);
  assert.deepEqual(parsePrices('票價：$1,200 / $800').prices, [{ name: '', price: 1200 }, { name: '', price: 800 }]);
  const none = parsePrices('票價：請見座位圖');
  assert.deepEqual(none.prices, []);
  assert.deepEqual(none.lines, ['票價：請見座位圖']);
  assert.deepEqual(parsePrices('演出地點：新店圓頂劇場').lines, []);
});

test('限購規定：照原文列出', () => {
  const t = '【網站購票提醒】\n每位會員限購4張(支援行動裝置網頁購票)。\n機台每筆交易限購4張。\n退票手續費為票價10%';
  assert.deepEqual(parseLimits(t), ['每位會員限購4張(支援行動裝置網頁購票)。', '機台每筆交易限購4張。']);
});

test('票價與開賣時間先看節目介紹，節目介紹沒寫才看其他說明；退票規則的「票價 10%」不會被當成票價', () => {
  const a = buildEventInfo({ description: '票價：A區 $5800', fullText: '票價：A區 $5800\n退票手續費為票價 10%，最低 $50' });
  assert.deepEqual(a.prices, [{ name: 'A區', price: 5800 }]);
  const b = buildEventInfo({ description: '一段介紹', fullText: '售票時間：2026/10/04 14:00\n票價：全票 NT$500' });
  assert.deepEqual(b.prices, [{ name: '全票', price: 500 }]);
  assert.deepEqual(b.saleTimes.map((x) => x.at), ['2026-10-04T14:00']);
});

test('限購先看購票須知，不混進其他說明（例如周邊商品的限購）', () => {
  const info = buildEventInfo({ notice: '每位會員限購4張。', fullText: '商品：每筆訂單總限購 4 件\n每位會員限購4張。' });
  assert.deepEqual(info.limits, ['每位會員限購4張。']);
  assert.deepEqual(buildEventInfo({ fullText: '每位會員限購2張。' }).limits, ['每位會員限購2張。']);
});

test('整理活動資訊：場次、狀態、截止時間、票價、開賣時間', () => {
  const info = buildEventInfo({
    url: 'https://ticket.ibon.com.tw/ActivityInfo/Details/1',
    title: ' 測試活動 ',
    offers: [{ label: '售票平台：', value: 'ibon機台、線上購票' }],
    sessions: [
      { when: '2026/11/14(六) 15:30 ', name: '測試活動', venue: '測試場館', button: '線上購票', disabled: false, note: '2026/11/13 12:00截止' },
      { when: '2026/11/14(六) 15:30', name: '測試活動－周邊商品', venue: '測試場館', button: '已售完', disabled: true, note: '' },
    ],
    description: '票價資訊 Ticket Price：A區 $5800\n售票時間：2026 年 10 月 04 日 下午 14:00',
  }, 1000);
  assert.equal(info.title, '測試活動');
  assert.equal(info.readAt, 1000);
  assert.deepEqual(info.sessions.map((s) => [s.date, s.time, s.status, s.saleEnd || null]), [
    ['2026-11-14', '15:30', 'on-sale', '2026-11-13T12:00'],
    ['2026-11-14', '15:30', 'sold-out', null],
  ]);
  assert.deepEqual(info.prices, [{ name: 'A區', price: 5800 }]);
  assert.deepEqual(info.saleTimes.map((x) => x.at), ['2026-10-04T14:00']);
});

test('頁面交回來的資訊先過濾：只留認得的欄位，長度與數量有上限，格式不對的丟掉', () => {
  const s = sanitizeInfo({
    title: 'x'.repeat(500), evil: '<img src=x onerror=alert(1)>',
    sessions: [{ when: '2026/11/14 15:30', date: '2026-11-14', time: '15:30', status: 'pwned', saleEnd: 'tomorrow', extra: 1 }, 'not-an-object'],
    prices: [{ name: 'A區', price: 5800 }, { name: 'B', price: -1 }, { name: 'C', price: 'NaN' }, { name: 'D', price: 1e9 }],
    saleTimes: [{ at: '2026-10-04T14:00', text: '售票時間' }, { at: 'soon', text: 'x' }],
    priceLines: Array(50).fill('票價：$1'),
  }, 7);
  assert.equal(s.title.length, 200);
  assert.equal('evil' in s, false);
  assert.equal(s.sessions.length, 2);
  assert.equal(s.sessions[0].status, 'unknown');
  assert.equal(s.sessions[0].saleEnd, null);
  assert.equal('extra' in s.sessions[0], false);
  assert.deepEqual(s.prices, [{ name: 'A區', price: 5800 }]);
  assert.deepEqual(s.saleTimes.map((x) => x.at), ['2026-10-04T14:00']);
  assert.equal(s.priceLines.length, 10);
  assert.equal(s.readAt, 7);
  assert.deepEqual(sanitizeInfo(null, 1).sessions, []);
  assert.deepEqual(sanitizeInfo({ login: { state: 'logged-out', verified: true, msg: 'x', extra: 1 } }).login, { state: 'logged-out', verified: true, msg: 'x' });
  assert.equal(sanitizeInfo({ login: { state: 'admin' } }).login.state, 'unknown');
  assert.equal(sanitizeInfo({}).login, null);
});

test('ibon 活動頁網址：只認活動頁；不屬於任何能自動選購的網站', () => {
  assert.equal(activityUrl('https://ticket.ibon.com.tw/ActivityInfo/Details/39972'), 'https://ticket.ibon.com.tw/ActivityInfo/Details/39972');
  assert.equal(activityUrl(' https://ticket.ibon.com.tw/ActivityInfo/Details/39972/?x=1 '), 'https://ticket.ibon.com.tw/ActivityInfo/Details/39972');
  assert.equal(activityUrl('http://ticket.ibon.com.tw/ActivityInfo/Details/39972'), null);
  assert.equal(activityUrl('https://orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx'), null);
  assert.equal(activityUrl('https://ticket.ibon.com.tw.example.com/ActivityInfo/Details/1'), null);
  assert.equal(eventSlug('https://ticket.ibon.com.tw/ActivityInfo/Details/39972'), '39972');
  assert.equal(pageKindOf('https://ticket.ibon.com.tw/ActivityInfo/Details/39972'), 'event');
});
