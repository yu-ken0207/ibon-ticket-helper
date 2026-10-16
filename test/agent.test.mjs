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
// MAIN world 的小程式：測試裡把它點擊的那一行標上「在頁面環境」，用來分辨誰點的
const HOOK = fs.readFileSync(path.join(ROOT, 'alert-hook.js'), 'utf8').replace('el.click();', 'window.__inMain = true; el.click(); window.__inMain = false;');
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
  <a id="ctl00_ContentPlaceHolder1_AddShopingCart" class="btn btn-primary btn-block" href="javascript:void(document.title='NEXT q='+document.getElementById('q').value)">下一步</a>`;

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
  await page.route('**/*', (r) => {
    const u = r.request().url();
    // 假的「背景更新」請求：/__update?ms=600 延遲 ms 毫秒才回，模擬 ibon 選了張數後回伺服器更新
    // /__hold：6 秒都不回，模擬「點了之後換頁、新頁面還在路上」，舊頁面留著讓測試檢查；之後中斷，免得瀏覽器關不掉
    if (u.includes('__hold')) return new Promise((done) => setTimeout(() => done(r.abort().catch(() => {})), 2000));
    const m = u.match(/__update\?ms=(\d+)/);
    if (m) return new Promise((done) => setTimeout(() => done(r.fulfill({ status: 200, body: 'ok' })), Number(m[1])));
    if (u.startsWith('https://ticket.ibon.com.tw/ActivityInfo/Details') || u.startsWith('https://orders.ibon.com.tw/application')) {
      return r.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    }
    return r.fulfill({ status: 204, body: '' });
  });
  await page.addInitScript(`
    // 擴充功能才有的 chrome.dom.openOrClosedShadowRoot：測試裡先攔住 attachShadow，把封閉的 shadow root 也記下來
    const __roots = new WeakMap();
    const __attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) { const r = __attach.call(this, init); __roots.set(this, r); return r; };
    window.__listeners = [];
    window.chrome = { runtime: { id: 'x', lastError: null, onMessage: { addListener(fn) { window.__listeners.push(fn); } },
      sendMessage: (msg, cb) => { window.__bg(msg.type, msg.payload).then((r) => cb && cb(r)); } },
      dom: { openOrClosedShadowRoot: (el) => __roots.get(el) || null } };`);
  // 模擬擴充功能環境的 CSP：不是從頁面環境（alert-hook.js）發出的 javascript: 連結點擊一律擋掉並記數
  await page.addInitScript(`
    window.__blocked = 0;
    const __click = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      if (this.tagName === 'A' && /^\\s*javascript:/i.test(this.getAttribute('href') || '') && !window.__inMain) { window.__blocked++; return; }
      return __click.call(this);
    };`);
  await page.addInitScript(HOOK);
  await page.addInitScript(AGENT);
  await page.goto(url);
  if (alertAfter) await page.evaluate(alertAfter);
  await page.waitForTimeout(wait);
  const out = { calls, blocked: await page.evaluate(() => window.__blocked || 0).catch(() => 0), title: await page.title(), q: await page.evaluate(() => (document.getElementById('q') || {}).value), page };
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

test('座位/數量頁：票區價格還沒選 → 照關鍵字選（排除身障）；選了之後 ibon 整頁換掉 → 舊頁面上不再動作', { skip }, async () => {
  // 模擬 ibon 選了票區價格就回傳換頁（ASP.NET 的 __doPostBack）：0.1 秒後離開這一頁
  const html = qtyPage().replace(`onchange="document.title='price:'+this.value"`, `onchange="document.title='price:'+this.value;setTimeout(()=>{location.href='about:blank'},100)"`);
  const r = await run({ url: U.qty, html, directive: RUN({ keywords: ['一般席'] }), wait: 2500 });
  assert.ok(r.calls.some((c) => c.type === 'log' && /選中票區：2F 一般席/.test(c.payload.msg)), JSON.stringify(r.calls.map((c) => c.type)));
  assert.ok(!r.calls.some((c) => c.type === 'log' && /已選張數|按下「下一步」/.test(c.payload.msg)), '頁面離開後沒有在舊頁面上選張數或按下一步');
});

test('座位/數量頁：票區價格選了之後 ibon 在背景更新（沒換頁）→ 等更新回來再選張數、按下一步', { skip }, async () => {
  const html = qtyPage().replace(`onchange="document.title='price:'+this.value"`, `onchange="fetch('/__update?ms=500')"`);
  const r = await run({ url: U.qty, html, directive: RUN({ keywords: ['一般席'], qty: 2 }), wait: 3500 });
  assert.equal(await r.page.evaluate(() => document.getElementById('ctl00_ContentPlaceHolder1_PRICE').value), 'c');
  assert.equal(r.title, 'NEXT q=2');
});

test('座位/數量頁：票區已選 → 選張數、按下一步（真站是 javascript:__doPostBack 連結，要由頁面環境代點，不然被擴充功能的 CSP 擋掉）', { skip }, async () => {
  const r = await run({ url: U.qty, html: qtyPage({ priceSelected: true }), directive: RUN({ qty: 2 }), wait: 3200 });
  assert.equal(r.title, 'NEXT q=2');
  assert.equal(r.blocked, 0, '助手沒有自己點 javascript: 連結');
});

test('座位/數量頁：張數超過這個票區的上限 → 不選，交給你', { skip }, async () => {
  const r = await run({ url: U.qty, html: qtyPage({ priceSelected: true, max: 1 }), directive: RUN({ qty: 3 }) });
  assert.equal(result(r).kind, 'qty-limit');
  assert.equal(r.q, '0');
});

test('座位/數量頁：有驗證碼 → 選好張數就停手，不按下一步', { skip }, async () => {
  const r = await run({ url: U.qty, html: qtyPage({ priceSelected: true, captcha: true }), directive: RUN({ qty: 2 }), wait: 3200 });
  assert.equal(r.q, '2');
  assert.equal(result(r).kind, 'captcha');
  assert.equal(result(r).handOff, true);
  assert.equal(r.title.startsWith('NEXT'), false);
});

test('座位/數量頁：按下一步後網站用 alert 拒絕 → 向背景程式要求重試', { skip }, async () => {
  const html = qtyPage({ priceSelected: true }).replace("javascript:void(document.title='NEXT q='+document.getElementById('q').value)", "javascript:alert('此票區已售完')");
  const r = await run({ url: U.qty, html: html.replace('</table>', '</table><script>/* 模擬 alert-hook */const _a=window.alert;window.alert=function(m){window.postMessage({__ith:"alert",msg:String(m)},location.origin);};</script>'), directive: RUN({ qty: 1 }), wait: 2500 });
  const retry = r.calls.find((c) => c.type === 'retry');
  assert.ok(retry && retry.payload.reason === 'fail', JSON.stringify(kinds(r)));
  assert.match(retry.payload.msg, /已售完/);
});

test('填購票資訊頁：勾同意、按下一步', { skip }, async () => {
  let clicked = 0;
  const html = BUYER.replace("fetch('/__clicked', { method: 'POST' })", "window.__clicked=(window.__clicked||0)+1");
  const r = await run({ url: U.buyer, html, directive: RUN(), wait: 2500 });
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

test('背景程式問「助手還在不在」（ping）：活動頁載入狀態再變一次也不會被誤判成錯誤頁', { skip }, async () => {
  const r = await run({ url: U.event, html: ACTIVITY, directive: { mode: 'idle' } });
  const reply = await r.page.evaluate(() => new Promise((resolve) => {
    let got = null;
    for (const fn of window.__listeners) fn({ cmd: 'ping' }, {}, (x) => { got = x; });
    resolve(got);
  }));
  assert.deepEqual(reply, { ok: true, kind: 'event' });
});

test('按下一步後 ibon 處理得慢：等到 45 秒才算沒反應，中間顯示「已等 N 秒」，不重新整理', { skip }, async () => {
  const r = await run({ url: U.qty, html: qtyPage({ priceSelected: true }), directive: RUN({ qty: 1 }), wait: 5600 });
  assert.equal(r.title, 'NEXT q=1');
  assert.ok(!r.calls.some((c) => c.type === 'result'), '5 秒時還不能判定失敗');
  assert.ok(!r.calls.some((c) => c.type === 'retry'));
});

test('座位/數量頁：選了張數後 ibon 在背景更新並把張數重置 → 等更新回來、重選，再按下一步（不撞在一起）', { skip }, async () => {
  // 模擬 ibon：張數一變就回伺服器更新（請求 0.6 秒才回），回來後重畫表格、數量被重置成 0；更新期間按下一步會卡住
  const html = qtyPage({ priceSelected: true }).replace('<select id="q" class="form-control form-control-sm">',
    `<select id="q" class="form-control form-control-sm" onchange="window.__busy=true;fetch('/__update?ms=600').then(()=>{const s=document.getElementById('q');if(!window.__reset){window.__reset=true;s.value='0';}document.body.appendChild(document.createElement('i'));window.__busy=false})">`)
    .replace("javascript:void(document.title='NEXT q='+document.getElementById('q').value)", "javascript:void(document.title=window.__busy?'COLLIDED':'NEXT q='+document.getElementById('q').value)");
  const r = await run({ url: U.qty, html, directive: RUN({ qty: 2 }), wait: 6500 });
  assert.equal(r.title, 'NEXT q=2', '重畫完才按、張數是重選過的');
  assert.ok(r.calls.some((c) => c.type === 'log' && /重置/.test(c.payload.msg)));
});

test('座位/數量頁：張數一直被頁面重置、選不住 → 不按下一步，交給你', { skip }, async () => {
  const html = qtyPage({ priceSelected: true }).replace('<select id="q" class="form-control form-control-sm">',
    `<select id="q" class="form-control form-control-sm" onchange="fetch('/__update?ms=300').then(()=>{document.getElementById('q').value='0';document.body.appendChild(document.createElement('i'))})">`);
  const r = await run({ url: U.qty, html, directive: RUN({ qty: 2 }), wait: 6000 });
  assert.equal(result(r).kind, 'fill-failed');
  assert.equal(r.title.startsWith('NEXT'), false);
});

test('等待改看網路請求：選張數後沒有背景更新時，不到 0.8 秒就按下一步（0.9.4 以前至少等 0.8 秒）', { skip }, async () => {
  const r = await run({ url: U.qty, html: qtyPage({ priceSelected: true }), directive: RUN({ qty: 2 }), wait: 2000 });
  assert.equal(r.title, 'NEXT q=2');
  const ms = (re) => { const c = r.calls.find((x) => x.type === 'log' && re.test(x.payload.msg)); return c ? Number(c.payload.msg.match(/載入後 (\d+) ms/)[1]) : NaN; };
  const gap = ms(/按下「下一步」/) - ms(/已選張數/);
  assert.ok(gap >= 250 && gap < 800, `選張數到按下一步隔 ${gap} ms`);
});

test('倒數：開賣前 3 秒先跟 orders.ibon.com.tw 建連線（preconnect）', { skip }, async () => {
  const r = await run({ url: U.event, html: ACTIVITY, directive: { mode: 'countdown', targetTs: Date.now() + 3500, cfg: { ...CFG, syncClock: false } }, wait: 1500 });
  const links = await r.page.evaluate(() => [...document.querySelectorAll('link[data-ith]')].map((l) => `${l.rel} ${l.href}`));
  assert.deepEqual(links.sort(), ['dns-prefetch https://orders.ibon.com.tw/', 'preconnect https://orders.ibon.com.tw/']);
});

test('活動頁開賣後一載入就先建連線', { skip }, async () => {
  const r = await run({ url: U.event, html: ACTIVITY, directive: RUN({ sessionWhen: '2026/12/06 18:00' }), wait: 1000 });
  assert.equal(await r.page.evaluate(() => document.querySelectorAll('link[rel="preconnect"][data-ith]').length), 1);
});

// 活動 39978（2026-10-16）：購票方式「自行選位 電腦配位」、點了票區 30 秒沒反應
const SEATMODE = (handlerOnSpan = false) => `<div id="ticket-info"><div><span>購票方式：</span>
  <label><input type="radio" name="mode" id="m1" checked>自行選位</label><label><input type="radio" name="mode" id="m2">電腦配位</label></div></div>
  <table><tbody><tr ${handlerOnSpan ? '' : 'onclick="go()"'}><td>■</td><td><span ${handlerOnSpan ? 'onclick="go()"' : ''}>2樓2B區5880</span></td><td>5,880</td><td>11</td></tr></tbody></table>
  <script>function go(){ document.title = document.getElementById('m2').checked ? 'row-auto' : 'seatmap'; }</script>`;

test('票區頁：購票方式可以選自行選位／電腦配位 → 先選電腦配位再點票區', { skip }, async () => {
  const r = await run({ url: U.area, html: SEATMODE(), directive: RUN({ keywords: ['2B區'] }), wait: 2000 });
  assert.equal(r.title, 'row-auto');
  assert.ok(r.calls.some((c) => c.type === 'log' && /改選「電腦配位」/.test(c.payload.msg)));
});

test('票區頁：點擊處理掛在列裡面的元素上 → 照 tickets_hunter 點列中央那一點，還是點得到', { skip }, async () => {
  const r = await run({ url: U.area, html: SEATMODE(true), directive: RUN({ keywords: ['2B區'] }), wait: 2000 });
  assert.equal(r.title, 'row-auto');
});

test('黑盒子：連 Shadow DOM 的字一起記，並記下購票方式與票區列的結構', { skip }, async () => {
  const r = await run({ url: U.area, html: SEATMODE(), directive: RUN({ keywords: ['貴賓'] }), wait: 1500 });
  const box = r.calls.find((c) => c.type === 'blackbox').payload;
  assert.match(box.html, /購票方式：/);
  assert.match(box.html, /票區列：<tr onclick="go\(\)">/);
  assert.match(box.html, /<input id="m1" type="radio" name="mode" checked>/);
  assert.doesNotMatch(box.html, /<body|ibon 訂票助手/);
});

// 2026-10-16 夢想音樂節（活動 39978 同樣）：票區表在封閉 Shadow DOM 裡，<tr id="票區代碼"> 沒有 onclick，
// ibon 在 DOMContentLoaded 之後才用程式掛上點擊處理；助手載入後 0.43 秒就點，30 秒沒反應
// 點到了：直接回報給測試（頁面接著換頁，換頁中讀不到頁面上的東西），然後換頁
const LATE_BIND = (bindMs, onClick = "window.__bg('test-click', tr.id); location.href = '/__hold'") => `<div id="host"></div><script>
  const root = document.getElementById('host').attachShadow({ mode: 'closed' });
  root.innerHTML = '<table class="table"><thead><tr><th>顏色</th><th>票區</th><th>票價(NT$)</th><th>空位</th></tr></thead><tbody>'
    + '<tr id="B0CDC082"><td><span class="color-tag"></span></td><td>超級搖滾座位區</td><td>3,999</td><td class="action"><span>熱賣中</span></td></tr>'
    + '<tr id="B0CDC086"><td><span class="color-tag"></span></td><td>搖滾座位區</td><td>2,999</td><td class="action"><span>熱賣中</span></td></tr></tbody></table>';
  window.__clicks = 0;
  document.addEventListener('DOMContentLoaded', () => setTimeout(() => {
    root.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => { window.__clicks++; ${onClick}; }));
  }, ${bindMs}));
</script>`;

const clicked = (r) => r.calls.filter((c) => c.type === 'test-click').map((c) => c.payload);

test('票區頁：點擊處理在 DOMContentLoaded 後才掛上 → 等表格穩定再點，一次就成功', { skip }, async () => {
  const r = await run({ url: U.area, html: LATE_BIND(0), directive: RUN({ keywords: ['超級搖滾'] }), wait: 1500 });
  assert.deepEqual(clicked(r), ['B0CDC082']);
  assert.ok(!r.calls.some((c) => c.type === 'log' && /換個方式再點一次/.test(c.payload.msg)), '一次就成功，沒有重點');
});

test('票區頁：點擊處理掛得很慢（0.9 秒）→ 第一次點沒反應，換個方式再點就成功', { skip }, async () => {
  const r = await run({ url: U.area, html: LATE_BIND(900), directive: RUN({ keywords: ['超級搖滾'] }), wait: 3500 });
  assert.deepEqual(clicked(r), ['B0CDC082']);
  assert.ok(r.calls.some((c) => c.type === 'log' && /換個方式再點一次（第 2 次）/.test(c.payload.msg)));
});

test('票區頁：點了之後頁面有送出請求 → 當成有反應繼續等，不會重複點', { skip }, async () => {
  const html = LATE_BIND(0, "fetch('/__update?ms=1800').then(() => { document.title = 'go:' + tr.id; })");
  const r = await run({ url: U.area, html, directive: RUN({ keywords: ['超級搖滾'] }), wait: 3000 });
  assert.equal(r.title, 'go:B0CDC082');
  assert.equal(await r.page.evaluate(() => window.__clicks), 1);
});
