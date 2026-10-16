import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionsForPlan, activityFields, purchaseFields, guideActivity, guidePurchase, guideOther } from '../../lib/guide.js';

const INFO = {
  title: '（測試）示範活動',
  sessions: [
    { when: '2026/12/05(六) 18:00', name: '第一梯', venue: '示範館', status: 'on-sale', statusLabel: '販售中', saleEnd: '2026-12-04T12:00' },
    { when: '2026/12/05(六) 20:00', name: '第二梯', venue: '示範館', status: 'sold-out', statusLabel: '已售完' },
  ],
  prices: [{ name: '全票', price: 300 }, { name: '2樓看台', price: 150 }],
  limits: ['每位會員限購4張。'],
  saleTimes: [{ at: '2026-11-20T12:00', text: '售票時間：2026/11/20 12:00' }],
  login: { state: 'logged-out', verified: true, msg: '沒有登入' },
};
const cfg = (o = {}) => ({ keywords: ['12/05 20:00', '12/05 18:00'], tickets: [{ name: '全票', qty: 2 }], areas: ['看台'], maxUnitPrice: 250, ...o });
const byField = (fields) => Object.fromEntries(fields.map((f) => [f.field, f]));

test('活動頁的場次 → 規劃格式：狀態對應，剩餘一律不知道', () => {
  const s = sessionsForPlan([...INFO.sessions, { when: 'x', name: 'y', status: 'not-open' }, { when: 'z', status: 'unknown' }]);
  assert.deepEqual(s.map((x) => x.status), ['available', 'full', 'not-open', 'unknown']);
  assert.ok(s.every((x) => x.remaining === null));
});

test('活動頁欄位：讀到、真站沒看過的寫法、沒讀到、這一頁沒有，分清楚', () => {
  const f = byField(activityFields(INFO));
  assert.equal(f['場次'].status, 'ok');
  assert.equal(f['場次狀態'].status, 'ok');
  assert.equal(f['剩餘數量'].status, 'unavailable');
  assert.equal(f['驗證碼'].status, 'unavailable');
  assert.equal(f['張數限制'].value, '每位會員限購 4 張');
  assert.equal(f['登入'].status, 'ok');
  const g = byField(activityFields({ ...INFO, sessions: [{ ...INFO.sessions[0], status: 'not-open', statusLabel: '尚未開賣' }], prices: [], login: { state: 'unknown' } }));
  assert.equal(g['場次狀態'].status, 'unverified');
  assert.equal(g['票區與價格'].status, 'fail');
  assert.equal(g['登入'].status, 'unverified');
  assert.equal(byField(activityFields({ ...INFO, sessions: [{ status: 'unknown' }] }))['場次狀態'].status, 'fail');
  assert.equal(byField(activityFields({}))['場次'].status, 'fail');
});

test('活動頁建議：照偏好、附每個場次的理由；沒登入先登入；由你自己按', () => {
  const g = guideActivity(INFO, cfg());
  assert.match(g.recommendation, /^先登入.*自己按「2026\/12\/05\(六\) 18:00 第一梯」那一列的「線上購票」/);
  assert.equal(g.expect.sessionText, '2026/12/05(六) 18:00 第一梯');
  assert.ok(g.basis.plan.ranked.some((r) => /第二梯/.test(r.text) && r.reason === '已額滿'));
  assert.match(g.basis.policy, /由你自己做（CONFIRMATION_REQUIRED/);
  assert.ok(g.basis.match.areas.some((m) => /2樓看台 NT\$150/.test(m)));
  assert.match(g.basis.match.qty, /2 張，在限購 4 張以內/);
  assert.match(guideActivity({ ...INFO, sessions: [{ ...INFO.sessions[0], status: 'not-open' }] }, cfg({ keywords: ['12/05 18:00'] })).recommendation, /還沒開賣.*不自動重新整理/);
});

test('購票頁：結構還沒驗證，欄位一律尚未驗證，不猜；核對照實說核對不了', () => {
  const prev = guideActivity(INFO, cfg());
  const g = guidePurchase({ kind: 'purchase-entry', hints: [{ state: 'captcha', msg: 'x', evidence: '驗證碼' }], login: { state: 'unknown' } }, prev);
  const f = byField(g.fields);
  for (const k of ['票區', '價格', '剩餘數量', '張數限制']) assert.equal(f[k].status, 'unverified', k);
  assert.match(f['驗證碼區域'].value, /驗證碼/);
  assert.match(f['驗證碼區域'].note, /不讀、不填/);
  assert.equal(g.verify.status, 'unverified');
  assert.match(g.verify.msg, /無法確認是不是「2026\/12\/05\(六\) 18:00 第一梯」/);
  assert.match(g.recommendation, /助手不點、不填、不送出/);
  assert.equal(guideOther('orders-other').verify.status, 'fail');
});
