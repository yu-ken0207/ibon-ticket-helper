import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOption, sessionKey, validateCfg, parseKeywords, parseList, DEFAULT_EXCLUDE } from '../../lib/areas.js';

// 票區下拉的選項，照 2026-10-16 真站快照（活動 39998 的 10/24 場）
const OPTS = [{ text: '1F 鐵粉席 1,000' }, { text: '1F 身障票 500' }, { text: '2F 一般席 350' }, { text: '2F 優待票 200 已售完' }, { text: '2F 身障票 150' }];

test('場次識別：去掉星期、空白正規化', () => {
  assert.equal(sessionKey('2026/10/24(六) 13:00'), '2026/10/24 13:00');
  assert.equal(sessionKey(' 2026/10/24 （六）  13:00 '), '2026/10/24 13:00');
  assert.equal(sessionKey('2026/10/24 13:00'), '2026/10/24 13:00');
});

test('關鍵字：一行一組、越上面越優先；同一行每一段都要出現', () => {
  assert.deepEqual(parseKeywords('一般席\n\n 1F 鐵粉 \n'), ['一般席', '1F 鐵粉']);
  assert.equal(pickOption(OPTS, { keywords: '鐵粉\n一般席' }).text, '1F 鐵粉席 1,000');
  assert.equal(pickOption(OPTS, { keywords: '一般席\n鐵粉' }).text, '2F 一般席 350');
  assert.equal(pickOption(OPTS, { keywords: '2F 一般' }).index, 2);
  assert.equal(pickOption(OPTS, { keywords: '1F 一般' }).kind, 'no-match');
});

test('排除字：預設排除身障，對到的都在排除清單就回 blocked，不會偷選', () => {
  assert.ok(DEFAULT_EXCLUDE.includes('身障'));
  const p = pickOption(OPTS, { keywords: '身障' });
  assert.equal(p.kind, 'blocked');
  assert.deepEqual(p.names, ['1F 身障票 500', '2F 身障票 150']);
  // 你刻意清空排除字：照你的意思不排除
  assert.equal(pickOption(OPTS, { keywords: '身障', exclude: '' }).kind, 'match');
  // 自訂排除字，大小寫不分
  assert.equal(pickOption([{ text: 'Restricted View 看台' }, { text: '看台 B' }], { keywords: '看台' }).text, '看台 B');
});

test('賣完的票區不選；對到的都賣完回 sold-out', () => {
  const p = pickOption(OPTS, { keywords: '優待' });
  assert.equal(p.kind, 'sold-out');
  assert.deepEqual(p.names, ['2F 優待票 200 已售完']);
  assert.equal(pickOption(OPTS, { keywords: '優待\n一般席' }).text, '2F 一般席 350');
});

test('遞補：只有開了才選第一個還能買的，而且一樣套用排除字', () => {
  assert.equal(pickOption(OPTS, { keywords: '貴賓' }).kind, 'no-match');
  const f = pickOption(OPTS, { keywords: '貴賓', fallback: true });
  assert.equal(f.kind, 'fallback');
  assert.equal(f.text, '1F 鐵粉席 1,000');
  const onlyBad = pickOption([{ text: '1F 身障票 500' }, { text: '2F 優待票 已售完' }], { keywords: '貴賓', fallback: true });
  assert.equal(onlyBad.kind, 'no-match');
  // 沒有關鍵字但開了遞補：直接選第一個還能買的
  assert.equal(pickOption(OPTS, { keywords: '', fallback: true }).text, '1F 鐵粉席 1,000');
});

test('表單檢查：沒場次、沒關鍵字（也沒開遞補）不開跑', () => {
  const ok = { regUrl: 'https://ticket.ibon.com.tw/ActivityInfo/Details/1', sessionWhen: '2026/10/24 13:00', keywords: ['一般席'] };
  assert.equal(validateCfg(ok), null);
  assert.match(validateCfg({ ...ok, regUrl: null }), /活動網址/);
  assert.match(validateCfg({ ...ok, sessionWhen: '' }), /場次/);
  assert.match(validateCfg({ ...ok, keywords: [] }), /關鍵字/);
  assert.equal(validateCfg({ ...ok, keywords: [], fallback: true }), null);
});

test('清單：逗號、頓號、換行都能分', () => {
  assert.deepEqual(parseList('輪椅\n身障, 愛心、障礙'), ['輪椅', '身障', '愛心', '障礙']);
});

import { extractAnswer } from '../../lib/areas.js';

test('驗證問題答案截取：末N碼／前N碼；支援中文數字；沒匹配到就整段', () => {
  // 末 N 碼
  assert.equal(extractAnswer('0912345678', '請輸入手機末 3 碼'), '678');
  assert.equal(extractAnswer('0912345678', '請輸入手機末三碼'), '678');
  assert.equal(extractAnswer('0912345678', '請輸入手機最後3碼'), '678');
  assert.equal(extractAnswer('0912345678', '請輸入手機後3碼'), '678');
  assert.equal(extractAnswer('0912345678', '請輸入手機末3位'), '678');
  // 前 N 碼
  assert.equal(extractAnswer('A123456789', '請輸入身分證前 4 碼'), 'A123');
  assert.equal(extractAnswer('A123456789', '請輸入身分證首4碼'), 'A123');
  assert.equal(extractAnswer('A123456789', '請輸入身分證前4位'), 'A123');
  // 沒指示：整段
  assert.equal(extractAnswer('1234567890', '請輸入會員編號'), '1234567890');
  // 答案不夠長：取現有長度
  assert.equal(extractAnswer('AB', '請輸入末 5 碼'), 'AB');
  // 空答案
  assert.equal(extractAnswer('', '請輸入手機末 3 碼'), '');
  assert.equal(extractAnswer(null, '請輸入會員編號'), '');
});

test('關鍵字比對：票價千分位逗號兩邊都正規化（6980 ↔ 6,980 都能對）', () => {
  const opts = [
    { text: 'VIP 6,980' },
    { text: 'A 6,380' },
    { text: '2F 5,980' },
    { text: '4F 4,980' },
  ];
  // 使用者填不帶逗號：ibon 顯示帶逗號也能對到
  assert.equal(pickOption(opts, { keywords: 'VIP 6980' }).text, 'VIP 6,980');
  assert.equal(pickOption(opts, { keywords: '6380' }).text, 'A 6,380');
  assert.equal(pickOption(opts, { keywords: '4980' }).text, '4F 4,980');
  // 使用者填帶逗號：ibon 顯示不帶逗號也能對到
  const opts2 = [{ text: '鐵粉席 5880' }, { text: '一般席 350' }];
  assert.equal(pickOption(opts2, { keywords: '5,880' }).text, '鐵粉席 5880');
  // 多層千分位：1,234,567 → 1234567
  const opts3 = [{ text: '金卡 1,234,567' }];
  assert.equal(pickOption(opts3, { keywords: '1234567' }).text, '金卡 1,234,567');
  // 全形逗號也處理
  const opts4 = [{ text: 'A 6，380' }];
  assert.equal(pickOption(opts4, { keywords: '6380' }).text, 'A 6，380');
  // 排除字含數字時也走同一套正規化（這條目前不太會真的發生，但保險起見）
  assert.equal(pickOption([{ text: 'VIP 6,980' }], { keywords: 'VIP', exclude: '6980' }).kind, 'blocked');
});
