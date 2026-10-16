// 真站活動 39998（2026-10-16 你貼的讀取結果）發現的讀錯：加購條件被當票價、開賣前「線上購票」是灰的、全形數字的限購、當天開賣寫成「還有 0 天」。
// 文字照原文的寫法，場館與金額換成虛構的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrices, buildEventInfo } from '../../lib/eventinfo.js';

const ADDON = [
  '票價 注意事項',
  '◎示範體育館：高鐵到達站或出發站其中一站須為示範站。依每筆訂單內單張最低票價達200-399元票價可加購高鐵單程票，400元以上票價可加購高鐵來回票',
].join('\n');

test('加購條件的金額區間、門檻不是票價', () => {
  const p = parsePrices(ADDON);
  assert.deepEqual(p.prices, []);
  assert.ok(p.lines.length >= 1, '原文還是列出來給人看');
  // 一般票價照樣讀得到；區間與門檻拿掉
  assert.deepEqual(parsePrices('票價：全票 NT$500、學生票 NT$300').prices.map((x) => x.price), [500, 300]);
  assert.deepEqual(parsePrices('票價：200-399元；400元以上').prices, []);
});

const NOW = Date.UTC(2026, 9, 16, 1, 45);   // 台灣時間 10/16 09:45
const RAW = {
  title: '（測試）示範排球聯賽',
  sessions: [
    { when: '2026/10/24 13:00', name: '示範例行賽單日票', venue: '示範體育館', button: '線上購票', disabled: true, note: '' },
    { when: '2026/10/25 12:00', name: '示範例行賽單日票', venue: '示範體育館', button: '線上購票', disabled: false, note: '' },
  ],
  description: `●開賣時間｜2026年10月16日(五) 中午12:00\n${ADDON}`,
  notice: '每筆交易限購４張。',
};

test('開賣前「線上購票」是灰的：開賣時間還沒到才判斷尚未開賣，標推斷', () => {
  const info = buildEventInfo(RAW, NOW);
  assert.equal(info.sessions[0].status, 'not-open');
  assert.equal(info.sessions[0].inferred, true);
  assert.equal(info.sessions[1].status, 'on-sale');
  assert.equal(info.prices.length, 0, '加購條件不當票價');
  assert.deepEqual(info.limits[0], '每筆交易限購４張。');
  // 開賣時間過了還是灰的：看不出來，不猜
  const late = buildEventInfo(RAW, Date.UTC(2026, 9, 16, 5, 0));
  assert.equal(late.sessions[0].status, 'unknown');
  // 只有灰按鈕、沒有開賣時間：看不出來
  assert.equal(buildEventInfo({ ...RAW, description: '' }, NOW).sessions[0].status, 'unknown');
});

