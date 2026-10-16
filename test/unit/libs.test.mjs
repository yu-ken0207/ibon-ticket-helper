import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDelay, loadGaveUp, LOAD_FAIL_MAX_MS } from '../../lib/backoff.js';
import { probeOffset, crossingOffset } from '../../lib/clock.js';
import { worstOf, summarizeHealth } from '../../lib/health.js';
import { sanitizeBox, BLACKBOX_MAX } from '../../lib/box.js';
import { int, fmt } from '../../lib/format.js';

test('載入失敗的重新整理間隔：連續失敗才逐步拉長，最長 3 秒；429 至少 3 秒；超過 5 分鐘交給你', () => {
  assert.equal(loadDelay(0, 0), 500);
  assert.equal(loadDelay(1, 0), 1000);
  assert.equal(loadDelay(9, 0), 3000);
  assert.equal(loadDelay(0, 429), 3000);
  assert.equal(loadGaveUp(1000, 1000 + LOAD_FAIL_MAX_MS + 1), true);
  assert.equal(loadGaveUp(1000, 2000), false);
  assert.equal(loadGaveUp(null, 99999999), false);
});

test('對時：假設伺服器在請求來回正中間產生 Date；跨秒的探測才可信', () => {
  assert.equal(probeOffset({ t0: 1000, t1: 1100, sec: 5000 }), 5000 - 1050);
  assert.equal(crossingOffset([]), null);
  assert.equal(crossingOffset([{ t0: 0, t1: 10, sec: 5000 }, { t0: 20, t1: 30, sec: 5000 }]), null);
  assert.equal(crossingOffset([{ t0: 0, t1: 10, sec: 5000 }, { t0: 20, t1: 30, sec: 6000 }]), probeOffset({ t0: 20, t1: 30, sec: 6000 }));
});

test('健檢摘要', () => {
  assert.equal(worstOf([{ status: 'ok' }, { status: 'warn' }]), 'warn');
  assert.equal(worstOf([{ status: 'ok' }, { status: 'fail' }, { status: 'warn' }]), 'fail');
  assert.equal(worstOf([{ status: 'skip' }]), 'ok');
  assert.equal(summarizeHealth({ items: [{ status: 'ok' }] }, {}), '全部正常');
  assert.match(summarizeHealth({ items: [{ status: 'fail', label: '場次表' }] }, {}), /有問題：場次表/);
  assert.match(summarizeHealth({ items: [] }, { first: true }), /已記下 ibon 活動頁程式的版本/);
  assert.equal(summarizeHealth({ error: '壞了' }, {}), '壞了');
});

test('黑盒子：只留認得的欄位並限制長度', () => {
  assert.equal(sanitizeBox(null), null);
  const b = sanitizeBox({ kind: 'x'.repeat(100), msg: 'm', buttons: new Array(50).fill('b'), evil: '<script>', text: 't'.repeat(5000) });
  assert.equal(b.kind.length, 40);
  assert.equal(b.buttons.length, 15);
  assert.equal(b.text.length, 800);
  assert.equal('evil' in b, false);
  assert.ok(BLACKBOX_MAX >= 10);
});

test('整數與時間格式', () => {
  assert.equal(int('abc', 5, 1, 10), 5);
  assert.equal(int('99', 5, 1, 10), 10);
  assert.equal(int('0', 5, 1, 10), 1);
  assert.equal(fmt(0), '-');
});
