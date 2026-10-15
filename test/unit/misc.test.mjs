import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDelay, loadGaveUp, LOAD_FAIL_MAX_MS } from '../../lib/backoff.js';
import { probeOffset, crossingOffset } from '../../lib/clock.js';
import { worstOf, summarizeHealth } from '../../lib/health.js';
import { sanitizeBox } from '../../lib/box.js';
import { int } from '../../lib/format.js';

test('載入失敗的重試間隔：連續失敗才拉長，最長 3 秒；請求太多至少 3 秒', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((n) => loadDelay(n, 503)), [500, 1000, 2000, 3000, 3000, 3000]);
  assert.equal(loadDelay(0, 429), 3000);
  assert.equal(loadDelay(undefined, 0), 500);
  assert.equal(loadDelay(-2, 0), 500);
});

test('連續失敗超過 5 分鐘就放棄', () => {
  assert.equal(loadGaveUp(null, Date.now()), false);
  assert.equal(loadGaveUp(1000, 1000 + LOAD_FAIL_MAX_MS), false);
  assert.equal(loadGaveUp(1000, 1001 + LOAD_FAIL_MAX_MS), true);
});

test('對時：伺服器在請求來回正中間產生 Date', () => {
  assert.equal(probeOffset({ t0: 1000, t1: 1100, sec: 2000 }), 950);
});

test('對時第二段：找第一個跨秒的探測，沒有跨秒回傳 null', () => {
  const p = (t0, sec) => ({ t0, t1: t0 + 40, sec });
  assert.equal(crossingOffset([p(1040, 1000), p(1000, 1000), null, p(1080, 2000), p(1120, 2000)]), 2000 - 1100);
  assert.equal(crossingOffset([p(1000, 1000), p(1020, 1000)]), null);
  assert.equal(crossingOffset([]), null);
  assert.equal(crossingOffset(undefined), null);
});

test('健檢等級與摘要', () => {
  assert.equal(worstOf([{ status: 'ok' }, { status: 'skip' }]), 'ok');
  assert.equal(worstOf([{ status: 'ok' }, { status: 'warn' }]), 'warn');
  assert.equal(worstOf([{ status: 'warn' }, { status: 'fail' }]), 'fail');
  assert.equal(summarizeHealth({ items: [{ status: 'ok', label: 'A' }] }), '全部正常');
  assert.equal(summarizeHealth({ items: [{ status: 'warn', label: 'B' }] }), '大致正常，要注意：B');
  assert.equal(summarizeHealth({ items: [{ status: 'fail', label: 'C' }, { status: 'fail', label: 'D' }] }), '有問題：C、D');
  assert.equal(summarizeHealth({ error: '讀不到' }), '讀不到');
});

test('黑盒子只留認得的欄位並限制長度', () => {
  assert.equal(sanitizeBox(null), null);
  assert.equal(sanitizeBox('字串'), null);
  const b = sanitizeBox({ kind: 'no-match', text: 'x'.repeat(5000), buttons: Array(30).fill('按鈕'), secret: 'drop me', data: { kind: 'failed', status: '503', extra: 1 } });
  assert.equal(b.text.length, 800);
  assert.equal(b.buttons.length, 15);
  assert.equal('secret' in b, false);
  assert.deepEqual(b.data, { kind: 'failed', status: 503, which: '' });
});

test('數字設定：看不懂用預設，超出範圍就夾住', () => {
  assert.equal(int('abc', 90, 5, 110), 90);
  assert.equal(int('300', 90, 5, 110), 110);
  assert.equal(int('1', 90, 5, 110), 5);
  assert.equal(int('45', 90, 5, 110), 45);
});
