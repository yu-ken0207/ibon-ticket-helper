import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ibonPageKind, isIbonPage, IBON_POLICY, validateEventInfo, memberLimit, parseIbonPrefs, matchIbonPrefs, maskText, maskUrl, stateHints, localTime, leakCheck } from '../../lib/ibon.js';

test('ibon 頁面分類：活動頁、線上購票轉址、購票入口（網址已驗證）、購票其他頁；不是 ibon 回 null', () => {
  assert.equal(ibonPageKind('https://ticket.ibon.com.tw/ActivityInfo/Details/39972'), 'activity');
  assert.equal(ibonPageKind('https://ticket.ibon.com.tw/ActivityInfo/GoTicketURL?GoUrl=x'), 'go-ticket');
  assert.equal(ibonPageKind('https://orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=1&PRODUCT_ID=2'), 'purchase-entry');
  assert.equal(ibonPageKind('https://orders.ibon.com.tw/application/UTK02/UTK0202_000.aspx'), 'purchase');
  assert.equal(ibonPageKind('https://ticket.ibon.com.tw/NewsInfo/Details/348'), 'ticket-other');
  assert.equal(ibonPageKind('http://ticket.ibon.com.tw/ActivityInfo/Details/1'), null);
  assert.equal(ibonPageKind('https://ticket.ibon.com.tw.example.com/ActivityInfo/Details/1'), null);
  assert.equal(isIbonPage('http://127.0.0.1:3300/pool/'), false);
});

test('操作政策：網站上的操作一律由你自己做或不做；每一項都附依據', () => {
  const by = Object.fromEntries(IBON_POLICY.map((p) => [p.action, p]));
  for (const a of ['select', 'quantity', 'submit', 'refresh']) assert.equal(by[a].mode, 'manual', a);
  for (const a of ['captcha', 'queue', 'limit', 'payment']) assert.equal(by[a].mode, 'never', a);
  for (const a of ['read', 'compare', 'snapshot']) assert.equal(by[a].mode, 'auto', a);
  assert.ok(IBON_POLICY.every((p) => p.basis && p.label));
  assert.match(by.select.basis, /第十一條/);
});

test('活動資訊驗證：缺漏、全部售完、已截止、開賣時間、看不出狀態', () => {
  const now = localTime('2026-10-15T12:00');
  const msgs = (info) => validateEventInfo(info, now).map((x) => `${x.level}:${x.msg}`);
  const ok = msgs({ title: 'A', sessions: [{ date: '2026-11-14', status: 'on-sale', saleEnd: '2026-11-13T12:00' }], prices: [{ name: 'A區', price: 1 }], saleTimes: [{ at: '2026-10-04T14:00' }] });
  assert.deepEqual(ok, ['info:已經開賣（2026/10/04 14:00）']);
  const bad = msgs({ sessions: [], prices: [], saleTimes: [] });
  assert.ok(bad.includes('warn:沒有讀到活動名稱'));
  assert.ok(bad.some((m) => m.startsWith('warn:沒有讀到任何場次')));
  assert.ok(bad.some((m) => m.startsWith('warn:節目介紹裡沒有認得的票價')));
  const later = msgs({ title: 'A', sessions: [{ date: '2026-12-01', status: 'sold-out', saleEnd: '2026-10-01T12:00' }, { status: 'unknown' }], prices: [{ name: 'x', price: 1 }], saleTimes: [{ at: '2026-10-20T12:00' }] });
  assert.ok(later.includes('info:開賣時間 2026/10/20 12:00（還有 5 天）'));
  assert.ok(later.includes('info:1 個場次已過販售截止時間'));
  assert.ok(later.includes('warn:1 個場次看不出日期'));
  assert.ok(later.includes('warn:1 個場次的狀態看不出來（按鈕上的字沒見過）'));
});

test('限購：一般會員的上限；身障、陪同、周邊商品的規定不算', () => {
  assert.equal(memberLimit(['每筆交易限購4張。', '每位會員限購4張(支援行動裝置網頁購票)。', '身心障礙票、身心障礙陪同票每人限購各1張。']), 4);
  assert.equal(memberLimit(['每位會員限購 2 張', '每筆交易限購4張']), 2);
  assert.equal(memberLimit(['商品：每筆訂單總限購 4 件']), null);
  assert.equal(memberLimit([]), null);
});

test('需求比對：票區關鍵字對票價表、最高單價、張數對限購', () => {
  const info = {
    prices: [{ name: 'MVP', price: 8000 }, { name: 'VIP區', price: 7000 }, { name: 'A區', price: 5800 }, { name: '2樓B區', price: 4200 }],
    limits: ['每位會員限購4張(支援行動裝置網頁購票)。'],
    sessions: [{ status: 'on-sale' }, { status: 'sold-out' }],
  };
  const m = matchIbonPrefs(info, { areas: 'vip\nB區\n搖滾區', qty: '2', maxPrice: '7,500' });
  assert.deepEqual(m.areas.map((a) => [a.pref, a.ok, a.hits.map((h) => h.name).join()]), [['vip', true, 'VIP區'], ['B區', true, '2樓B區'], ['搖滾區', false, '']]);
  assert.match(m.areas[2].msg, /沒有這個票區/);
  assert.equal(m.qty.ok, true);
  assert.equal(m.onSale, 1);
  const over = matchIbonPrefs(info, { areas: 'MVP', qty: '6', maxPrice: '7000' });
  assert.equal(over.qty.ok, false);
  assert.match(over.qty.msg, /超過限購 4 張/);
  assert.match(over.areas[0].msg, /超過你設定的最高單價/);
  assert.deepEqual(parseIbonPrefs({ areas: ' A區 \n\n', qty: 'x', maxPrice: '' }), { areas: ['A區'], qty: null, maxPrice: null });
});

test('結構快照的遮罩：Email、手機、身分證、長數字遮掉；日期、時間、金額留著', () => {
  assert.equal(maskText('王小明 tester@example.com 0912-345-678'), '王小明 [email] [手機]');
  assert.equal(maskText('身分證 A123456789、卡號 4111 1111 1111 1111'), '身分證 [身分證]、卡號 [數字]');
  assert.equal(maskText('訂單編號 20261015001'), '訂單編號 [數字]');
  assert.equal(maskText('2026/11/14(六) 15:30｜2026-10-04｜NT$8,000｜剩 12 張'), '2026/11/14(六) 15:30｜2026-10-04｜NT$8,000｜剩 12 張');
  assert.equal(maskUrl('/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=123&PRODUCT_ID=456', 'https://orders.ibon.com.tw/x'),
    'https://orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=…&PRODUCT_ID=…');
});

test('快照遮罩：有固定說法的姓名、你自己的資料都遮掉', () => {
  assert.equal(maskText('王小明 您好｜登出'), '[姓名] 您好｜登出');
  assert.equal(maskText('購票人：陳小華／取票人: 林大同'), '購票人：[姓名]／取票人: [姓名]');
  assert.equal(maskText('訂購人 吳美麗 0987654321', ['吳美麗', '0987654321']), '訂購人 [你的資料] [你的資料]');
  assert.equal(maskText('選擇票區', ['吳']), '選擇票區');   // 太短的字不拿來比對
});

test('存檔前的掃描：還看得到個資就回報種類，日期、金額不算', () => {
  assert.deepEqual(leakCheck('2026/11/14 15:30 NT$8,000 剩 12 張'), []);
  assert.deepEqual(leakCheck('a@b.co 0912345678 A123456789 4111111111111111'), ['Email', '手機', '身分證字號', '長數字']);
  assert.deepEqual(leakCheck('購票人 吳美麗', ['吳美麗']), ['你的資料']);
});

test('購票頁的狀態提示：照頁面上的字給提示，一律標「未驗證」', () => {
  const h = stateHints('請輸入圖形驗證碼。目前人數眾多，請耐心等候。');
  assert.deepEqual(h.map((x) => x.state), ['captcha', 'queue']);
  assert.ok(h.every((x) => x.verified === false));
  assert.deepEqual(stateHints('選擇票區'), []);
});
