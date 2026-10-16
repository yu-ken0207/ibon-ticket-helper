// 頁面程式（page-agent.js）的行為測試：用 Playwright 開真的 Chromium，網址攔截後回測試用的假頁面，
// 背景程式用測試裡的函式假冒（記下頁面送出的每一則訊息，並照劇本回覆）。不連到真的網站。
// Playwright 不在專案相依裡：用環境變數 PLAYWRIGHT_PATH，或預設找 ticket-sim 裡裝好的；都找不到就略過這個檔案。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PW_PATHS = [process.env.PLAYWRIGHT_PATH, path.resolve(ROOT, '..', 'ticket-sim', 'tools', 'node_modules', 'playwright')].filter(Boolean);
let chromium = null;
for (const p of PW_PATHS) {
  try { chromium = createRequire(import.meta.url)(p).chromium; break; } catch (_) { /* 換下一個 */ }
}
const skip = chromium ? false : '找不到 Playwright（設定 PLAYWRIGHT_PATH）';

const AGENT = fs.readFileSync(path.join(ROOT, 'page-agent.js'), 'utf8');
const ACTIVITY = fs.readFileSync(path.join(ROOT, 'test/fixtures/ibon-activity.html'), 'utf8').replace('<a class="hv">快速登入</a>', '<a>登出</a>');
const ACTIVITY_GUEST = fs.readFileSync(path.join(ROOT, 'test/fixtures/ibon-activity.html'), 'utf8');
const BUYER = fs.readFileSync(path.join(ROOT, 'test/fixtures/ibon-buyer-info.html'), 'utf8');

const U = {
  event: 'https://ticket.ibon.com.tw/ActivityInfo/Details/39998',
  area: 'https://orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=1',
  qty: 'https://orders.ibon.com.tw/application/UTK02/UTK0202_.aspx?PERFORMANCE_ID=1&GROUP_ID=2&PERFORMANCE_PRICE_AREA_ID=3',
  buyer: 'https://orders.ibon.com.tw/application/UTK02/UTK0206_.aspx',
};

const AREA = `<table><thead><tr><th>顏色</th><th>票區</th><th>票價(NT$)</th><th>空位</th></tr></thead><tbody>
  <tr onclick="document.title='row-iron'"><td>■</td><td>1F 鐵粉席</td><td>1,000</td><td>熱賣中</td></tr>
  <tr onclick="document.title='row-wheel'"><td>■</td><td>1F 身障票</td><td>500</td><td>熱賣中</td></tr>
  <tr onclick="document.title='row-general'"><td>■</td><td>2F 一般席</td><td>350</td><td>熱賣中</td></tr>
  <tr onclick="document.title='row-sold'"><td>■</td><td>2F 優待票</td><td>200</td><td>已售完</td></tr></tbody></table>`;

// 座位/數量頁：結構照 2026-10-16 真站快照（#…_PRICE、#…_DataGrid 裡的數量下拉、#…_AddShopingCart）
const qtyPage = ({ priceSelected = false, captcha = false, max = 3 } = {}) => `
  <div id="ctl00_ContentPlaceHolder1_td_area_price"><select id="ctl00_ContentPlaceHolder1_PRICE" class="form-control form-control-sm" onchange="document.title='price:'+this.value">
    <option value="">-請選擇-</option><option value="a"${priceSelected ? ' selected' : ''}>1F 鐵粉席 1,000</option><option value="b">1F 身障票 500</option><option value="c">2F 一般席 350</option></select></div>
  <table id="ctl00_ContentPlaceHolder1_DataGrid" class="table table-sm rwdtable"><tbody><tr><th>內容</th><th>購買數量</th></tr>
    <tr><td data-title="內容">鐵粉席</td><td data-title="購買數量"><select id="q" class="form-control form-control-sm">${Array.from({ length: max + 1 }, (_, i) => `<option>${i}</option>`).join('')}</select></td></tr></tbody></table>
  ${captcha ? '<input id="ctl00_ContentPlaceHolder1_CHK" type="text">' : ''}
  <a id="ctl00_ContentPlaceHolder1_AddShopingCart" class="btn btn-primary btn-block" href="#" onclick="document.title='NEXT q='+document.getElementById('q').value;return false">下一步</a>`;

const CFG = { sessionWhen: '2026/12/05 18:00', keywords: ['一般席'], qty: 2, exclude: undefined, fallback: false };

let browser = null;
async function run({ url, html, directive, extra = {}, wait = 1500, alertAfter = null }) {
  if (!browser) browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const calls = [];
  await page.exposeFunction('__bg', (type, payload) => {
    calls.push({ type, payload });
    if (type === 'hello') return directive;
    if (type === 'retry') return { allow: true, delayMs: 100000, count: 1, max: 30 };
    return { ok: true };
  });
  await page.route('**/*', (r) => (r.request().url().startsWith('https://ticket.ibon.com.tw/ActivityInfo/Details') || r.request().url().startsWith('https://orders.ibon.com.tw/application')
    ? r.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
    : r.fulfill({ status: 204, body: '' })));
  await page.addInitScript(`
    // 擴充功能才有的 chrome.dom.openOrClosedShadowRoot：測試裡先攔住 attachShadow，把封閉的 shadow root 也記下來
    const __roots = new WeakMap();
    const __attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) { const r = __attach.call(this, init); __roots.set(this, r); return r; };
    window.chrome = { runtime: { id: 'x', lastError: null, onMessage: { addListener() {} },
      sendMessage: (msg, cb) => { window.__bg(msg.type, msg.payload).then((r) => cb && cb(r)); } },
      dom: { openOrClosedShadowRoot: (el) => __roots.get(el) || null } };`);
  await page.addInitScript(AGENT);
  await page.goto(url);
  if (alertAfter) await page.evaluate(alertAfter);
  await page.waitForTimeout(wait);
  const out = { calls, title: await page.title(), q: await page.evaluate(() => (document.getElementById('q') || {}).value), page };
  Object.assign(out, extra);
  return out;
}
const kinds = (r) => r.calls.map((c) => c.type);
const result = (r) => (r.calls.find((c) => c.type === 'result') || {}).payload;
const RUN = (cfg = {}) => ({ mode: 'run', cfg: { ...CFG, ...cfg }, since: Date.now() });
test.after(async () => { if (browser) await browser.close(); });

test('活動頁：場次可以買 → 點「線上購票」', { skip }, async () => {
  const r = await run({ url: U.event, html: ACTIVITY.replace('<button class="btn-buy">線上購票</button>', '<button class="btn-buy" onclick="document.title=\'clicked\'">線上購票</button>'), directive: RUN() });
  assert.equal(r.title, 'clicked');
});

test('活動頁：場次還不能買（灰按鈕）→ 向背景程式要求「尚未開賣」重試，不點', { skip }, async () => {
  const r = await run({ url: U.event, html: ACTIVITY, directive: RUN({ sessionWhen: '2026/12/06 18:00' }) });
  const retry = r.calls.find((c) => c.type === 'retry');
  assert.ok(retry && retry.payload.reason === 'not-open', JSON.stringify(kinds(r)));
  assert.ok(!r.calls.some((c) => c.type === 'result'));
});

test('活動頁：場次已售完 → 結束，不重試', { skip }, async () => {
  const r = await run({ url: U.event, html: ACTIVITY, directive: RUN({ sessionWhen: '2026/12/05 20:00' }) });
  assert.equal(result(r).kind, 'sold-out');
  assert.ok(!r.calls.some((c) => c.type === 'retry'));
});

test('活動頁：場次不在清單裡 → 交給你，並列出頁面上的場次', { skip }, async () => {
  const r = await run({ url: U.event, html: ACTIVITY, directive: RUN({ sessionWhen: '2027/01/01 10:00' }) });
  assert.equal(result(r).kind, 'no-session');
  assert.equal(result(r).handOff, true);
  assert.match(result(r).msg, /2026\/12\/05 18:00/);
});

test('活動頁：沒登入 → 不點，交給你', { skip }, async () => {
  const r = await run({ url: U.event, html: ACTIVITY_GUEST.replace('<button class="btn-buy">線上購票</button>', '<button class="btn-buy" onclick="document.title=\'clicked\'">線上購票</button>'), directive: RUN() });
  assert.equal(result(r).kind, 'guest');
  assert.notEqual(r.title, 'clicked');
});

test('讀取活動：回報場次、開賣時間與票價，不點任何東西', { skip }, async () => {
  const r = await run({ url: U.event, html: ACTIVITY, directive: { mode: 'check', cfg: { sessionWhen: '2026/12/05 18:00' } } });
  const rep = r.calls.find((c) => c.type === 'check-result').payload;
  assert.equal(rep.ok, true);
  assert.equal(rep.sessions.length, 3);
  assert.equal(rep.sessions[0].when.includes('2026/12/05'), true);
  assert.ok(rep.msg.includes('3 個場次'));
});

test('讀取活動：選的場次不在清單裡 → 提醒', { skip }, async () => {
  const r = await run({ url: U.event, html: ACTIVITY, directive: { mode: 'check', cfg: { sessionWhen: '2030/01/01 00:00' } } });
  const rep = r.calls.find((c) => c.type === 'check-result').payload;
  assert.equal(rep.ok, false);
  assert.match(rep.msg, /不在這個清單裡/);
});

test('健檢：場次表、日期、按鈕、狀態、你選的場次都檢查', { skip }, async () => {
  const r = await run({ url: U.event, html: ACTIVITY, directive: { mode: 'health', cfg: { sessionWhen: '2026/12/05 18:00' } } });
  const rep = r.calls.find((c) => c.type === 'health-result').payload;
  const by = Object.fromEntries(rep.items.map((i) => [i.key, i]));
  assert.equal(by.rows.status, 'ok');
  assert.equal(by.dates.status, 'ok');
  assert.equal(by.session.status, 'ok');
  assert.equal(by.buttons.status, 'ok');
});

test('票區頁：照關鍵字選，跳過身障與已售完；列沒有連結就點整列', { skip }, async () => {
  const r = await run({ url: U.area, html: AREA, directive: RUN({ keywords: ['一般席'] }) });
  assert.equal(r.title, 'row-general');
  const r2 = await run({ url: U.area, html: AREA, directive: RUN({ keywords: [], fallback: true }) });
  assert.equal(r2.title, 'row-iron');   // 遞補：第一個還能買的
});

test('票區頁：關鍵字對不到 / 只對到身障 / 只對到售完 → 不選，交給你', { skip }, async () => {
  for (const [kw, kind] of [['貴賓', 'no-match'], ['身障', 'blocked'], ['優待', 'sold-out']]) {
    const r = await run({ url: U.area, html: AREA, directive: RUN({ keywords: [kw] }) });
    assert.equal(result(r).kind, kind, kw);
    assert.equal(r.title, '', kw);
  }
});

test('票區頁：出現流量控管字樣 → 整頁不動', { skip }, async () => {
  const r = await run({ url: U.area, html: `<p>流量控管中，請耐心等候</p>`, directive: RUN() });
  assert.equal(result(r).kind, 'blocked-page');
});

test('座位/數量頁：票區價格還沒選 → 照關鍵字選（排除身障），之後頁面重載再選張數', { skip }, async () => {
  const r = await run({ url: U.qty, html: qtyPage(), directive: RUN({ keywords: ['一般席'] }) });
  assert.equal(r.title, 'price:c');
  assert.equal(r.q, '0');   // 重載前先不選張數
});

test('座位/數量頁：票區已選 → 選張數、按下一步（用真實的 AddShopingCart）', { skip }, async () => {
  const r = await run({ url: U.qty, html: qtyPage({ priceSelected: true }), directive: RUN({ qty: 2 }) });
  assert.equal(r.title, 'NEXT q=2');
});

test('座位/數量頁：張數超過這個票區的上限 → 不選，交給你', { skip }, async () => {
  const r = await run({ url: U.qty, html: qtyPage({ priceSelected: true, max: 1 }), directive: RUN({ qty: 3 }) });
  assert.equal(result(r).kind, 'qty-limit');
  assert.equal(r.q, '0');
});

test('座位/數量頁：有驗證碼 → 選好張數就停手，不按下一步', { skip }, async () => {
  const r = await run({ url: U.qty, html: qtyPage({ priceSelected: true, captcha: true }), directive: RUN({ qty: 2 }) });
  assert.equal(r.q, '2');
  assert.equal(result(r).kind, 'captcha');
  assert.equal(result(r).handOff, true);
  assert.equal(r.title.startsWith('NEXT'), false);
});

test('座位/數量頁：按下一步後網站用 alert 拒絕 → 向背景程式要求重試', { skip }, async () => {
  const html = qtyPage({ priceSelected: true }).replace("document.title='NEXT q='+document.getElementById('q').value;return false", "alert('此票區已售完');return false");
  const r = await run({ url: U.qty, html: html.replace('</table>', '</table><script>/* 模擬 alert-hook */const _a=window.alert;window.alert=function(m){window.postMessage({__ith:"alert",msg:String(m)},location.origin);};</script>'), directive: RUN({ qty: 1 }) });
  const retry = r.calls.find((c) => c.type === 'retry');
  assert.ok(retry && retry.payload.reason === 'fail', JSON.stringify(kinds(r)));
  assert.match(retry.payload.msg, /已售完/);
});

test('填購票資訊頁：勾同意、按下一步', { skip }, async () => {
  let clicked = 0;
  const html = BUYER.replace("fetch('/__clicked', { method: 'POST' })", "window.__clicked=(window.__clicked||0)+1");
  const r = await run({ url: U.buyer, html, directive: RUN() });
  assert.equal(await r.page.evaluate(() => document.getElementById('agreen').checked), true);
  assert.equal(await r.page.evaluate(() => window.__clicked || 0), 1);
  void clicked;
});

test('填購票資訊頁：你設定不自動勾選 → 不動，交給你', { skip }, async () => {
  const r = await run({ url: U.buyer, html: BUYER, directive: RUN({ autoAgree: false }) });
  assert.equal(await r.page.evaluate(() => document.getElementById('agreen').checked), false);
  assert.equal(result(r).kind, 'agree');
});

test('倒數：先報備、到點前跟背景程式說 fired，再重新整理', { skip }, async () => {
  const target = Date.now() + 2500;
  const r = await run({ url: U.event, html: ACTIVITY, directive: { mode: 'countdown', targetTs: target, cfg: { ...CFG, syncClock: false, fireOffsetMs: 30 } }, wait: 4500 });
  const fired = r.calls.find((c) => c.type === 'fired');
  assert.ok(fired, JSON.stringify(kinds(r)));
  assert.ok(r.calls.filter((c) => c.type === 'hello').length >= 2, '重新整理後頁面又報到一次');
});

test('沒有任務（idle）：什麼都不做', { skip }, async () => {
  const r = await run({ url: U.event, html: ACTIVITY.replace('<button class="btn-buy">線上購票</button>', '<button class="btn-buy" onclick="document.title=\'clicked\'">線上購票</button>'), directive: { mode: 'idle' } });
  assert.notEqual(r.title, 'clicked');
  assert.deepEqual(kinds(r).filter((t) => t !== 'hello'), []);
});
