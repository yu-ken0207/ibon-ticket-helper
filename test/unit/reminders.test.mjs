// 保留倒數與開賣提醒（純函式）：讀數可靠才提醒、同一段只通知一次、看不出來就是未知。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCountdown, updateHold, holdDue, holdAlarms, holdRemaining, taipeiTime, saleTimesOf, saleDue, saleAlarms, taipeiText } from '../../lib/reminders.js';

const T0 = Date.UTC(2026, 9, 16, 1, 0, 0);

test('倒數字樣', () => {
  assert.equal(parseCountdown('剩餘時間09:33'), 573);
  assert.equal(parseCountdown('剩餘時間 9：05'), 545);
  assert.equal(parseCountdown('剩餘時間09:73'), null);
  assert.equal(parseCountdown('倒數 09:33'), null);
  assert.equal(parseCountdown(null), null);
});

test('倒數照時間走：可靠，截止時間固定；兩次讀數對上才算核對過', () => {
  let h = updateHold(null, { secs: 300, at: T0 });
  assert.equal(h.status, 'ok');
  assert.equal(h.checked, false);
  assert.equal(h.deadline, T0 + 300000);
  h = updateHold(h, { secs: 290, at: T0 + 10000 });
  assert.equal(h.status, 'ok');
  assert.equal(h.checked, true);
  assert.equal(holdRemaining(h, T0 + 100000), 200000);
  assert.deepEqual(holdAlarms(h, T0 + 10000).map((a) => [a.stage, a.when]), [[120, T0 + 180000], [60, T0 + 240000]]);
});

test('倒數停住或亂跳：未知、不排提醒；沒看到倒數也是未知', () => {
  let h = updateHold(null, { secs: 300, at: T0 });
  h = updateHold(h, { secs: 300, at: T0 + 10000 });
  assert.equal(h.status, 'unknown');
  assert.match(h.reason, /停住/);
  assert.deepEqual(holdAlarms(h, T0 + 10000), []);
  assert.equal(holdDue(h, T0 + 250000), null);
  const fast = updateHold(updateHold(null, { secs: 300, at: T0 }), { secs: 200, at: T0 + 10000 });
  assert.equal(fast.status, 'unknown');
  const none = updateHold(updateHold(null, { secs: 300, at: T0 }), { secs: null, at: T0 + 5000 });
  assert.equal(none.status, 'unknown');
  assert.match(none.reason, /沒看到/);
  // 換頁後又讀到、跟之前對得上：恢復
  const back = updateHold(none, { secs: 280, at: T0 + 20000 });
  assert.equal(back.status, 'ok');
});

test('提醒：剩 2 分鐘、1 分鐘各一次；不重複；一開始就剩不到 1 分鐘只發 1 分鐘那一次', () => {
  let h = updateHold(null, { secs: 300, at: T0 });
  assert.equal(holdDue(h, T0 + 100000), null);
  const d1 = holdDue(h, T0 + 181000);
  assert.deepEqual(d1, { stage: 120, mark: [120] });
  h = { ...h, notified: { 120: true } };
  assert.equal(holdDue(h, T0 + 200000), null, '同一段不重複');
  assert.deepEqual(holdDue(h, T0 + 241000), { stage: 60, mark: [120, 60] });
  h = { ...h, notified: { 120: true, 60: true } };
  assert.equal(holdDue(h, T0 + 280000), null);
  assert.equal(holdDue(h, T0 + 400000), null, '過了截止不再發');
  const late = updateHold(null, { secs: 50, at: T0 });
  assert.deepEqual(holdDue(late, T0), { stage: 60, mark: [120, 60] });
});

test('網站重新保留（倒數往上跳）：重新開始、通知紀錄清空', () => {
  let h = updateHold(null, { secs: 100, at: T0 });
  h = { ...h, notified: { 120: true } };
  h = updateHold(h, { secs: 600, at: T0 + 10000 });
  assert.equal(h.status, 'ok');
  assert.deepEqual(h.notified, {});
  assert.equal(h.deadline, T0 + 610000);
});

test('開賣時間：台灣時間；只有日期不猜；已過的標出來；場次小字標未驗證', () => {
  assert.equal(taipeiTime('2026-10-20T12:00'), Date.UTC(2026, 9, 20, 4, 0));
  assert.ok(Number.isNaN(taipeiTime('2026-10-20')));
  assert.equal(taipeiText(Date.UTC(2026, 9, 20, 4, 0)), '2026/10/20 12:00');
  const info = {
    saleTimes: [{ at: '2026-10-20T12:00', text: '售票時間：2026/10/20(二) 12:00' }, { at: '2026-10-01T12:00', text: '會員預購：2026/10/01 12:00' }],
    sessions: [{ when: '2026/11/14 15:30', name: 'A', saleStart: '2026-10-21T12:00' }],
  };
  const r = saleTimesOf(info, T0);
  assert.equal(r.unknown, null);
  assert.deepEqual(r.items.map((x) => [x.at, x.past, x.verified]), [['2026-10-01T12:00', true, true], ['2026-10-20T12:00', false, true], ['2026-10-21T12:00', false, false]]);
  assert.match(saleTimesOf({ saleTimes: [{ at: '2026-10-20', text: '售票日期：2026/10/20' }] }, T0).unknown, /只寫了日期/);
  assert.match(saleTimesOf({}, T0).unknown, /沒有認得的開賣時間/);
  assert.match(saleTimesOf({ saleTimes: [{ at: '2026-10-01T12:00', text: 'x' }] }, T0).unknown, /都已經過了/);
});

test('開賣提醒：5 分鐘、1 分鐘各一次；已開賣不發；錯過 5 分鐘那段時只補最急的', () => {
  const ms = T0 + 3600000;
  const rem = { ms, notified: {} };
  assert.deepEqual(saleAlarms(rem, T0).map((a) => [a.stage, a.when]), [[300, ms - 300000], [60, ms - 60000]]);
  assert.equal(saleDue(rem, ms - 400000), null);
  assert.deepEqual(saleDue(rem, ms - 290000), { stage: 300, mark: [300] });
  assert.equal(saleDue({ ms, notified: { 300: true } }, ms - 200000), null);
  assert.deepEqual(saleDue({ ms, notified: { 300: true } }, ms - 59000), { stage: 60, mark: [300, 60] });
  assert.deepEqual(saleDue(rem, ms - 30000), { stage: 60, mark: [300, 60] });
  assert.equal(saleDue(rem, ms + 1000), null);
  assert.deepEqual(saleAlarms({ ms, notified: { 300: true, 60: true } }, T0), []);
});
