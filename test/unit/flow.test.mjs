import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSlot, parseTicketLines, planTickets, checkProfile, describeProfileProblem, classifyError } from '../../lib/flow.js';
import { siteOf, targetUrlOf, poolListUrl, pageKindOf, siteKey, siteLabel } from '../../lib/sites.js';

const slot = (id, text, status = 'available', remaining = 80) => ({ id, text, status, remaining });
const SLOTS = [
  slot('a', '11/20（五） 06:00–08:00'),
  slot('b', '11/20（五） 08:00–10:00', 'limited', 3),
  slot('c', '11/20（五） 10:00–12:00', 'full', 0),
  slot('d', '11/21（六） 06:00–08:00'),
];

test('網址判斷：只認本機的一般票券模擬站', () => {
  assert.equal(siteOf('http://127.0.0.1:3300/pool/'), 'pool');
  assert.equal(siteOf('http://localhost:3300/pool/select/x'), 'pool');
  assert.equal(siteOf('https://aipxa.kktix.cc/events/twspopupinkkh'), null);
  assert.equal(siteOf('http://192.168.1.5:3300/pool/'), null);
  assert.equal(siteOf('https://example.com/pool/'), null);
  assert.equal(targetUrlOf('http://127.0.0.1:3300/pool/info?x=1'), 'http://127.0.0.1:3300/pool/');
  assert.equal(poolListUrl('http://127.0.0.1:3300/other'), null);
  assert.equal(siteKey('pool', 'http://127.0.0.1:3300/pool/confirm'), 'pool@http://127.0.0.1:3300');
  assert.equal(siteKey('nope', 'http://127.0.0.1:3300/pool/'), null);
  assert.equal(siteLabel('pool'), '一般票券模擬站');
  assert.deepEqual(['/pool/', '/pool/select/x', '/pool/info', '/pool/confirm', '/pool/done/T1', '/pool/queue', '/pool/about'].map((p) => pageKindOf('pool', 'http://127.0.0.1:3300' + p)),
    ['list', 'select', 'info', 'confirm', 'done', 'queue', 'other']);
});

test('選時段：照偏好順序，額滿或剩不夠就換下一組，還沒開放就等', () => {
  assert.equal(pickSlot(SLOTS, ['11/20 08:00', '11/21'], { need: 2 }).slot.id, 'b');
  assert.equal(pickSlot(SLOTS, ['11/20 08:00', '11/21'], { need: 4 }).slot.id, 'd');
  assert.equal(pickSlot(SLOTS, ['11/20 10:00', '11/21'], { need: 1 }).slot.id, 'd');
  assert.equal(pickSlot(SLOTS, ['11/20 06:00', '11/21'], { need: 1, skip: ['a'] }).slot.id, 'd');
  const wait = pickSlot([slot('x', '11/20 06:00', 'not-open', null), slot('y', '11/21 06:00')], ['11/20', '11/21']);
  assert.equal(wait.kind, 'not-open');
  const sold = pickSlot(SLOTS, ['11/20 10:00'], { need: 1 });
  assert.equal(sold.kind, 'sold-out');
  assert.deepEqual(sold.names, ['11/20（五） 10:00–12:00']);
  const short = pickSlot(SLOTS, ['11/20 08:00'], { need: 5 });
  assert.equal(short.kind, 'sold-out');
  assert.deepEqual(short.short, { text: '11/20（五） 08:00–10:00', remaining: 3 });
  assert.equal(pickSlot(SLOTS, ['12/25'], { need: 1 }).kind, 'no-match');
  const fb = pickSlot(SLOTS, ['12/25'], { need: 1, fallback: true });
  assert.equal(fb.slot.id, 'a');
  assert.equal(fb.fallback, true);
  assert.equal(pickSlot([slot('c', 'x', 'full', 0)], [], { need: 1, fallback: true }).kind, 'sold-out');
});

test('時段關鍵字：只寫一個時間代表開始時間；各種破折號都當成一樣', () => {
  assert.equal(pickSlot(SLOTS, ['11/20 08:00']).slot.id, 'b');
  assert.equal(pickSlot(SLOTS, ['11/20 8:00']).slot.id, 'b');
  assert.equal(pickSlot(SLOTS, ['11/20 06:00-08:00']).slot.id, 'a');
  assert.equal(pickSlot(SLOTS, ['11/20 06:00～08:00']).slot.id, 'a');
  assert.equal(pickSlot([slot('s', '11/20 18:30 入場')], ['18:30']).slot.id, 's');
});

test('票種張數：一行一筆，名稱對到頁面上的票種', () => {
  assert.deepEqual(parseTicketLines('全票 2\n兒童票：1\n\n優待票 0'), [{ name: '全票', qty: 2 }, { name: '兒童票', qty: 1 }, { name: '優待票', qty: 0 }]);
  assert.deepEqual(parseTicketLines(['全票2張']), [{ name: '全票', qty: 2 }]);
  assert.ok(Number.isNaN(parseTicketLines('全票').at(0).qty));
  const types = [{ id: 'adult', name: '全票', price: 110 }, { id: 'concession', name: '優待票', price: 80 }, { id: 'child', name: '兒童票', price: 60 }];
  const p = planTickets(types, parseTicketLines('全票 2\n兒童 1'), 6);
  assert.equal(p.ok, true);
  assert.deepEqual(p.plan.map((x) => [x.id, x.qty]), [['adult', 2], ['child', 1]]);
  assert.equal(p.total, 3);
  assert.equal(p.amount, 280);
  assert.match(planTickets(types, parseTicketLines('敬老票 1'), 6).msg, /沒有「敬老票」.*全票、優待票、兒童票/);
  assert.match(planTickets(types, parseTicketLines('全票 7'), 6).msg, /超過每筆上限 6 張/);
  assert.match(planTickets(types, parseTicketLines('全票 0'), 6).msg, /至少設定 1 張/);
  assert.match(planTickets(types, [], 6).msg, /還沒設定/);
  assert.match(planTickets(types, parseTicketLines('全票'), 6).msg, /張數看不懂/);
});

test('購票人資料：缺什麼、格式不對都講清楚', () => {
  assert.equal(checkProfile({ name: '王小明', phone: '0912-345-678', email: 'a@b.tw' }).ok, true);
  assert.equal(checkProfile({ name: '王小明', phone: '0912-345-678', email: 'a@b.tw' }).profile.phone, '0912345678');
  const r = checkProfile({ name: ' ', phone: '12345', email: '' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['name', 'email']);
  assert.equal(describeProfileProblem(r), '還沒填：姓名、Email；手機：手機要是 09 開頭共 10 碼');
});

test('網站錯誤的處理方式', () => {
  assert.equal(classifyError('TRANSIENT'), 'retry');
  assert.equal(classifyError('INTERNAL'), 'retry');
  assert.equal(classifyError('', 503), 'retry');
  assert.equal(classifyError('SOLD_OUT'), 'next-slot');
  assert.equal(classifyError('INSUFFICIENT'), 'next-slot');
  assert.equal(classifyError('NOT_ON_SALE'), 'wait');
  assert.equal(classifyError('HOLD_EXPIRED'), 'restart');
  assert.equal(classifyError('TOKEN_EXPIRED'), 'reload');
  assert.equal(classifyError('QUEUE_REQUIRED'), 'gate');
  assert.equal(classifyError('CAPTCHA_WRONG'), 'gate');
  assert.equal(classifyError('BOTCHECK_REQUIRED'), 'gate');
  assert.equal(classifyError('DUPLICATE_SUBMIT'), 'duplicate');
  assert.equal(classifyError('VALIDATION'), 'stop');
  assert.equal(classifyError('WHATEVER'), 'stop');
});
