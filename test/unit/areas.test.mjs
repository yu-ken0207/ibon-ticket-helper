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
