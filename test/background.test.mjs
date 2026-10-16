// 背景程式（background.js）的任務流程測試：假冒 chrome.* API（儲存、鬧鐘、分頁、通知），
// 用訊息一步一步走完「排程 → 倒數 → 開賣 → 選票區 → 座位/數量 → 填資料 → 確認」，檢查階段與重試額度。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
const alarms = new Map();
const tabs = new Map();
const notes = [];
const sent = [];
let nextTab = 100;
const listeners = {};
const ev = (name) => ({ addListener: (fn) => { (listeners[name] ||= []).push(fn); } });
globalThis.chrome = {
  runtime: { id: 'testext', onMessage: ev('msg'), onStartup: ev('startup'), onInstalled: ev('installed'), getManifest: () => ({ version: 't' }), lastError: null },
  storage: { local: {
    get: async (k) => {
      const keys = k == null ? Object.keys(store) : Array.isArray(k) ? k : typeof k === 'string' ? [k] : Object.keys(k);
      return Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, structuredClone(store[x])]));
    },
    set: async (o) => { Object.assign(store, structuredClone(o)); },
  } },
  alarms: {
    create: async (name, info) => { alarms.set(name, info); },
    clear: async (name) => alarms.delete(name),
    clearAll: async () => alarms.clear(),
    get: async (name) => alarms.get(name),
    onAlarm: ev('alarm'),
  },
  tabs: {
    create: async (o) => { const t = { id: nextTab++, url: o.url, status: 'complete' }; tabs.set(t.id, t); return t; },
    get: async (id) => { if (!tabs.has(id)) throw new Error('no tab'); return tabs.get(id); },
    update: async (id, o) => { const t = tabs.get(id); if (t && o.url) t.url = o.url; return t; },
    reload: async () => {},
    remove: async (id) => { tabs.delete(id); },
    query: async () => [...tabs.values()],
    sendMessage: async (id, msg) => { sent.push({ id, msg }); },
    onUpdated: ev('tabUpdated'),
    onRemoved: ev('tabRemoved'),
  },
  windows: { create: async (o) => { const t = { id: nextTab++, url: o.url, status: 'complete' }; tabs.set(t.id, t); return { id: 7, tabs: [t] }; }, update: async () => ({}) },
  notifications: { create: (id, o, cb) => { notes.push(o); if (cb) cb(); } },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
};

await import('../background.js');

const URL_EVENT = 'https://ticket.ibon.com.tw/ActivityInfo/Details/39998';
const URL_AREA = 'https://orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=1';
const URL_QTY = 'https://orders.ibon.com.tw/application/UTK02/UTK0202_.aspx?PERFORMANCE_ID=1';
const URL_BUYER = 'https://orders.ibon.com.tw/application/UTK02/UTK0206_.aspx';
const URL_CONFIRM = 'https://orders.ibon.com.tw/application/UTK02/UTK0207_.aspx';

function dispatch(msg, sender) {
  return new Promise((resolve) => {
    const fn = listeners.msg[0];
    fn(msg, sender, resolve);
  });
}
const popup = (type, extra = {}) => dispatch({ type, ...extra }, { id: 'testext', url: 'chrome-extension://testext/popup.html' });
const page = (tabId, type, payload = {}, url = URL_EVENT, openerTabId) => dispatch({ type, payload }, { id: 'testext', url, tab: { id: tabId, url, openerTabId } });
const task = () => store.task;

const FORM = { eventUrl: URL_EVENT, sessionWhen: '2026/10/24 13:00', keywords: '2F 一般席', qty: 2 };

function reset() {
  for (const k of Object.keys(store)) delete store[k];
  alarms.clear(); tabs.clear(); notes.length = 0; sent.length = 0;
}

test('排程：沒選場次、沒關鍵字、開賣時間已過都擋下來', async () => {
  reset();
  const t = Date.now() + 3600e3;
  assert.match((await popup('schedule', { cfg: { ...FORM, sessionWhen: '', targetTs: t } })).error, /場次/);
  assert.match((await popup('schedule', { cfg: { ...FORM, keywords: '', targetTs: t } })).error, /關鍵字/);
  assert.match((await popup('schedule', { cfg: { ...FORM, eventUrl: 'https://kktix.com/events/x', targetTs: t } })).error, /活動網址/);
  assert.match((await popup('schedule', { cfg: { ...FORM, targetTs: Date.now() - 1000 } })).error, /已經過了/);
  assert.equal(task(), undefined);
});

test('排程：提前 90 秒開頁的鬧鐘、到點保險；開頁時間已過就馬上開', async () => {
  reset();
  const target = Date.now() + 3600e3;
  const r = await popup('schedule', { cfg: { ...FORM, targetTs: target } });
  assert.equal(r.ok, true);
  assert.equal(task().phase, 'armed');
  assert.equal(task().slug, '39998');
  assert.equal(task().openAt, target - 90000);
  assert.equal(alarms.get('ith-open').when, target - 90000);
  // 開頁時間已過：馬上在新視窗開活動頁
  reset();
  const soon = Date.now() + 30e3;
  await popup('schedule', { cfg: { ...FORM, targetTs: soon } });
  assert.equal(task().tabId != null, true);
  assert.equal(tabs.get(task().tabId).url, URL_EVENT);
});

test('完整流程：倒數 → 開賣 → 活動頁重試額度 → 選票區 → 驗證碼交給你 → 繼續 → 確認頁成功', async () => {
  reset();
  const target = Date.now() + 30e3;
  await popup('schedule', { cfg: { ...FORM, targetTs: target } });
  const tab = task().tabId;

  // 活動頁報到：還沒開賣 → 倒數
  let d = await page(tab, 'hello', { kind: 'event', url: URL_EVENT });
  assert.equal(d.mode, 'countdown');
  assert.equal(d.targetTs, target);
  // 別的分頁問：不是任務的分頁，什麼都不做
  assert.equal((await page(999, 'hello', { kind: 'event', url: URL_EVENT }, URL_EVENT)).mode, 'idle');

  // 到點：fired → 階段變成 fired；重新整理後活動頁再報到 → run
  assert.equal((await page(tab, 'fired', { at: Date.now(), drift: 5 })).ok, true);
  assert.equal(task().phase, 'fired');
  d = await page(tab, 'hello', { kind: 'event', url: URL_EVENT });
  assert.equal(d.mode, 'run');
  assert.equal(d.cfg.sessionWhen, '2026/10/24 13:00');

  // 「線上購票」還不能按：尚未開賣重試，額度 30 次，間隔 1000ms
  const r1 = await page(tab, 'retry', { reason: 'not-open', msg: '還不能買' });
  assert.deepEqual([r1.allow, r1.count, r1.max, r1.delayMs], [true, 1, 30, 1000]);
  assert.equal(task().notOpen, 1);

  // 點了線上購票，進到選票區頁：任務的分頁沿用，助手接著動作
  d = await page(tab, 'hello', { kind: 'area', url: URL_AREA }, URL_AREA);
  assert.equal(d.mode, 'run');

  // 座位/數量頁有驗證碼：交給你 → waiting-user
  d = await page(tab, 'hello', { kind: 'qty', url: URL_QTY }, URL_QTY);
  assert.equal(d.mode, 'run');
  await page(tab, 'result', { ok: false, kind: 'captcha', msg: '請自己輸入驗證碼', handOff: true }, URL_QTY);
  assert.equal(task().phase, 'waiting-user');
  assert.match(notes.at(-1).title, /需要你接手/);

  // 你輸入驗證碼、按下一步，進到填資料頁：助手接著動作，階段回到 running
  d = await page(tab, 'hello', { kind: 'buyer', url: URL_BUYER }, URL_BUYER);
  assert.equal(d.mode, 'run');
  assert.equal(task().phase, 'running');

  // 購票確認頁：名額已保留，任務完成並通知
  d = await page(tab, 'hello', { kind: 'confirm', url: URL_CONFIRM }, URL_CONFIRM);
  assert.equal(d.mode, 'success');
  assert.equal(task().phase, 'done');
  assert.equal(task().result.ok, true);
});

test('重試額度：尚未開賣最多 30 次、被拒絕最多 3 次，用完就不再給', async () => {
  reset();
  await popup('schedule', { cfg: { ...FORM, targetTs: Date.now() + 30e3 } });
  const tab = task().tabId;
  await page(tab, 'fired', { at: Date.now() });
  for (let i = 1; i <= 3; i++) assert.equal((await page(tab, 'retry', { reason: 'fail' })).allow, true, `第 ${i} 次`);
  const over = await page(tab, 'retry', { reason: 'fail' });
  assert.equal(over.allow, false);
  assert.equal(over.max, 3);
  assert.equal((await page(tab, 'retry', { reason: 'not-open' })).allow, true);   // 兩種額度分開算
});

test('活動頁按「線上購票」另開分頁：任務跟著搬到新分頁', async () => {
  reset();
  await popup('schedule', { cfg: { ...FORM, targetTs: Date.now() + 30e3 } });
  const tab = task().tabId;
  await page(tab, 'fired', { at: Date.now() });
  // 從別的分頁（不是任務的、也不是它開出來的）來的購票頁：不理
  assert.equal((await page(500, 'hello', { kind: 'area', url: URL_AREA }, URL_AREA, 999)).mode, 'idle');
  // 任務分頁開出來的新分頁：接手
  const d = await page(501, 'hello', { kind: 'area', url: URL_AREA }, URL_AREA, tab);
  assert.equal(d.mode, 'run');
  assert.equal(task().tabId, 501);
});

test('開賣前不在任務階段的購票頁：不動作；取消後什麼都不做', async () => {
  reset();
  await popup('schedule', { cfg: { ...FORM, targetTs: Date.now() + 3600e3 } });
  const tab = task().tabId ?? 42;
  store.task.tabId = tab;
  assert.equal((await page(tab, 'hello', { kind: 'qty', url: URL_QTY }, URL_QTY)).mode, 'idle');   // 還在 armed
  await popup('cancel');
  assert.equal(task().phase, 'cancelled');
  assert.equal((await page(tab, 'hello', { kind: 'event', url: URL_EVENT })).mode, 'idle');
  assert.equal(alarms.size, 0);
});

test('頁面只能送頁面該送的訊息，不能排程或取消', async () => {
  reset();
  await popup('schedule', { cfg: { ...FORM, targetTs: Date.now() + 3600e3 } });
  const tab = task().tabId ?? 42;
  assert.equal((await page(tab, 'schedule', { cfg: FORM })).ok, false);
  assert.equal((await page(tab, 'cancel')).ok, false);
  assert.equal(task().phase, 'armed');
  // 彈出視窗的訊息不能由網頁偽造（沒有擴充功能網址的來源）
  assert.equal((await dispatch({ type: 'cancel' }, { id: 'someone-else', url: 'https://evil.com/', tab: { id: 1, url: 'https://evil.com/' } })).ok, false);
});

test('黑盒子與紀錄：只收任務分頁送的，欄位整理過', async () => {
  reset();
  await popup('schedule', { cfg: { ...FORM, targetTs: Date.now() + 30e3 } });
  const tab = task().tabId;
  await page(tab, 'blackbox', { kind: 'no-match', msg: 'x', text: 't'.repeat(5000), evil: 1 });
  assert.equal(store.blackbox.length, 1);
  assert.equal(store.blackbox[0].text.length, 800);
  assert.equal('evil' in store.blackbox[0], false);
  assert.equal((await page(777, 'blackbox', { kind: 'x' })).ok, false);
  const st = await popup('status');
  assert.ok(st.logs.length > 0);
});
