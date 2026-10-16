// 端對端測試：本機一般票券模擬站（ticket-sim 以 SIM_SITE=pool 啟動）＋ Playwright 的 Chromium 載入真的擴充功能。
// 每個情境除了看擴充功能的任務狀態，也用模擬站的統計核對：有沒有重複送出、有沒有替使用者按「確認建立訂單」。
//
// 用法：node test/run-tests.mjs [--only 情境[,情境…]] [--mode normal|hard|both] [--headed]
//   每個情境預設在模擬站的一般模式與困難模式（hard=1：沒有測試錨點、封閉 Shadow DOM、受控表單、表單權杖、canvas 驗證碼）各跑一次
//   需要 ticket-sim（預設 ../ticket-sim，可用 SIM_DIR 指定）；playwright 預設從 ticket-sim/tools 載入，可用 PW_DIR 指定
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { stale } from '../tools/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..');
const SIM_DIR = path.resolve(process.env.SIM_DIR || path.join(EXT, '..', 'ticket-sim'));
const PW_DIR = (process.env.PW_DIR || path.join(SIM_DIR, 'tools')).replace(/\/?$/, '/');
const { chromium } = createRequire(PW_DIR)('playwright');
const argv = process.argv.slice(2);
const ONLY = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
const HEADED = argv.includes('--headed');
const MODE = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : 'both';
const MODES = MODE === 'both' ? ['normal', 'hard'] : [MODE];
let HARD = false;   // 目前這一輪是不是困難模式
const PORT = Number(process.env.POOL_PORT || 3300 + Math.floor(Math.random() * 300));
const BASE = `http://127.0.0.1:${PORT}`;
const WORK = fs.mkdtempSync(path.join(process.env.ITH_TMP || process.env.KKH_TMP || os.tmpdir(), 'ith-test-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
function localDT(ts) {
  const d = new Date(ts);
  const sec = d.getSeconds() ? `:${pad(d.getSeconds())}` : '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}${sec}`;
}
const nextWholeSecond = (msAhead) => Math.ceil((Date.now() + msAhead) / 1000) * 1000;

// ibon 活動頁的測試樣本（虛構內容，只模擬結構）。測試瀏覽器用 --host-resolver-rules 把 *.ibon.com.tw 指到本機的 HTTPS 伺服器，
// 連網路層都到不了真的網站（擴充功能自己開的分頁也一樣）
const IBON_FIXTURE = fs.readFileSync(path.join(HERE, 'fixtures', 'ibon-activity.html'), 'utf8');
const IBON_URL = 'https://ticket.ibon.com.tw/ActivityInfo/Details/990001';
// 購票流程頁的樣本（虛構，結構是假設的）：網址照真站資料裡的格式
const IBON_PURCHASE_FIXTURE = fs.readFileSync(path.join(HERE, 'fixtures', 'ibon-purchase.html'), 'utf8');
const IBON_PURCHASE_URL = 'https://orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=TEST1&PRODUCT_ID=TEST2';
const IBON_BUYER_FIXTURE = fs.readFileSync(path.join(HERE, 'fixtures', 'ibon-buyer-info.html'), 'utf8');
const IBON_BUYER_URL = 'https://orders.ibon.com.tw/application/UTK02/UTK0206_.aspx';

const PROFILE = { name: '測試使用者', phone: '0912-345-678', email: 'tester@example.com', note: '' };

/* ───────────── 模擬站 ───────────── */

async function startSim() {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: SIM_DIR, env: { ...process.env, PORT: String(PORT), SIM_SITE: 'pool', SIM_MODE: 'test', SIM_DEPLOY: 'local' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (b) => process.stderr.write('[sim] ' + b));
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return child; } catch (_) { /* 還沒好 */ }
    await sleep(150);
  }
  child.kill();
  throw new Error('模擬站沒有啟動，請確認 SIM_DIR 指到 ticket-sim');
}

/** 用瀏覽器裡的 cookie 讀模擬站的流程狀態與統計 */
async function siteState(ctx) {
  const cookie = (await ctx.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join('; ');
  return (await fetch(`${BASE}/pool/api/_test/state`, { headers: { cookie, accept: 'application/json' } })).json();
}

/* ───────────── ibon 活動頁樣本（本機 HTTPS） ───────────── */

const IBON_PORT = PORT + 1000;
const ibonRequests = [];   // 樣本伺服器收到的每個請求「方法 路徑」

function startIbonFixture() {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(WORK, 'ibon-key.pem'), '-out', path.join(WORK, 'ibon-cert.pem'), '-days', '2',
    '-subj', '/CN=ticket.ibon.com.tw', '-addext', 'subjectAltName=DNS:ticket.ibon.com.tw,DNS:*.ibon.com.tw'], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(path.join(WORK, 'ibon-key.pem')), cert: fs.readFileSync(path.join(WORK, 'ibon-cert.pem')) }, (req, res) => {
    ibonRequests.push(`${req.method} ${req.url}`);
    const pages = { [new URL(IBON_URL).pathname]: IBON_FIXTURE, [new URL(IBON_PURCHASE_URL).pathname]: IBON_PURCHASE_FIXTURE, [new URL(IBON_BUYER_URL).pathname]: IBON_BUYER_FIXTURE };
    const body = req.method === 'GET' && pages[req.url.split('?')[0]];
    if (body) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(body);
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(IBON_PORT, '127.0.0.1', () => resolve(server)));
}

/* ───────────── 瀏覽器與設定頁 ───────────── */

async function launch() {
  const dir = fs.mkdtempSync(path.join(WORK, 'profile-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: !HEADED, viewport: { width: 1200, height: 900 }, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      // ibon 的網域一律指到本機樣本伺服器；不用 proxy，免得系統 proxy 繞過這條規則
      `--host-resolver-rules=MAP ibon.com.tw 127.0.0.1:${IBON_PORT},MAP *.ibon.com.tw 127.0.0.1:${IBON_PORT}`, '--no-proxy-server', '--ignore-certificate-errors'],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const popup = await ctx.newPage();
  popup.on('dialog', (d) => d.accept());
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  return { ctx, extId, popup };
}

/** 在這個瀏覽器開始模擬站的某個情境（會設定 cookie；擴充功能開的分頁共用同一份）。模擬站的統計是全站共用的，先清空 */
async function scenario(ctx, preset, query = '') {
  await fetch(`${BASE}/pool/api/_test/default`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset: 'normal' }) });
  // 只拿 cookie、不跟著轉到時段列表：不然那一頁會先讀一次時段（用掉錯誤次數、提早開始排隊計時）
  const q = [query, HARD ? 'hard=1' : ''].filter(Boolean).join('&');
  const res = await ctx.request.get(`${BASE}/pool/scenarios/start?preset=${preset}${q ? '&' + q : ''}`, { maxRedirects: 0 });
  if (res.status() !== 303) throw new Error(`開始情境 ${preset} 失敗：${res.status()}`);
}

async function fillPopup(popup, o = {}) {
  await popup.evaluate(() => { document.getElementById('advanced').open = true; });   // 進階設定（設定頁裡還有別的 <details>，要指名）
  await popup.fill('#eventUrl', o.url || `${BASE}/pool/`);
  await popup.fill('#keywords', (o.keywords || ['11/20 06:00']).join('\n'));
  await popup.fill('#tickets', (o.tickets || ['全票 2', '兒童票 1']).join('\n'));
  await popup.fill('#areas', (o.areas || []).join('\n'));
  await popup.fill('#maxUnitPrice', o.maxUnitPrice ? String(o.maxUnitPrice) : '');
  await popup.fill('#maxTotal', o.maxTotal ? String(o.maxTotal) : '');
  const pf = { ...PROFILE, ...(o.profile || {}) };
  await popup.fill('#profileName', pf.name);
  await popup.fill('#profilePhone', pf.phone);
  await popup.fill('#profileEmail', pf.email);
  await popup.fill('#profileNote', pf.note);
  await popup.setChecked('#autoAgree', o.autoAgree !== false);
  await popup.setChecked('#fallback', !!o.fallback);
  await popup.fill('#openTime', o.openTime || '');
  await popup.fill('#preOpenSec', String(o.preOpenSec || 30));
}

async function clickAndRead(popup, sel) {
  await popup.click(sel);
  await sleep(300);
  return popup.textContent('#msg');
}

const status = (popup) => popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'status' }, r)))
  .then((s) => ({ ...(s || {}), task: (s && s.task) || { phase: 'none', result: null, warned: {} } }));

async function waitTask(popup, pred, timeoutMs) {
  const t0 = Date.now();
  let s = null;
  while (Date.now() - t0 < timeoutMs) {
    s = await status(popup);
    if (s && pred(s.task)) return s;
    await sleep(300);
  }
  return s;
}
const ready = (t) => t.phase === 'waiting-user' && t.result && t.result.kind === 'ready';
/** 流程狀態走過的路（每次轉移的目的狀態），以及有沒有照順序經過 want 這幾個狀態 */
const wfPath = (t) => ((t && t.wf && t.wf.history) || []).map((h) => h.to);
const inOrder = (path, want) => { let i = 0; for (const x of path) if (x === want[i]) i++; return i === want.length; };
const wfState = (t) => (t && t.wf ? t.wf.state : 'none');

/** 用 CDP 關掉擴充功能的 service worker（模擬 Chrome 把閒置的背景程式收掉）；之後的訊息會叫醒一個新的 */
async function restartServiceWorker(ctx, popup, extId) {
  const cdp = await ctx.newCDPSession(popup);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const t = targetInfos.find((x) => x.type === 'service_worker' && x.url.includes(extId));
  if (!t) return false;
  await cdp.send('Target.closeTarget', { targetId: t.targetId });
  await cdp.detach().catch(() => {});
  return true;
}
const stopped = (t) => ['done', 'waiting-user', 'cancelled'].includes(t.phase);
const sitePage = (ctx) => ctx.pages().find((p) => p.url().startsWith(`${BASE}/pool/`)) || null;
/** 伺服器記下的請求時間 → 相鄰兩次的間隔（毫秒） */
const gapsOf = (ts) => (ts || []).slice(1).map((t, i) => t - ts[i]);
const resultMsg = (s) => (s.task.result ? `${s.task.result.kind}：${s.task.result.msg}` : `phase=${s.task.phase}`);

/** 每個情境都要成立：沒有重複送出、沒有替使用者按確認 */
function noDuplicates(st, { confirm = 0 } = {}) {
  return [
    ['沒有重複送出', st.stats.holdDuplicates === 0 && st.stats.confirmDuplicates === 0, `選購重複 ${st.stats.holdDuplicates}、確認重複 ${st.stats.confirmDuplicates}`],
    [confirm ? '只建立一筆訂單' : '沒有替你按「確認建立訂單」', st.stats.confirmRequests === confirm && st.stats.orders === confirm, `確認請求 ${st.stats.confirmRequests}、訂單 ${st.stats.orders}`],
  ];
}

/* ───────────── 情境 ───────────── */

const SCENARIOS = [
  {
    name: 'happy',
    title: '立即執行：選時段、填張數與資料，停在確認頁；使用者自己按確認後才建立訂單',
    async run({ ctx, popup }) {
      await scenario(ctx, 'normal');
      await fillPopup(popup);
      const msg = await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      const page = sitePage(ctx);
      const confirmBtn = page && page.getByRole('button', { name: '確認建立訂單' });
      const outlined = confirmBtn ? await confirmBtn.evaluate((b) => b.style.outline) : '';
      const checks = [
        ['已開始執行', /已開始執行/.test(msg), msg],
        ['停在確認頁等使用者', ready(s.task) && /自己按「確認建立訂單」/.test(s.task.result.msg), resultMsg(s)],
        ['選到偏好的時段', st.pool.hold && st.pool.hold.slotId === '20261120-0600', st.pool.hold && st.pool.hold.slotId],
        ['張數照設定：全票 2、兒童票 1', st.pool.hold && JSON.stringify(st.pool.hold.items) === JSON.stringify({ adult: 2, child: 1 }), st.pool.hold && JSON.stringify(st.pool.hold.items)],
        ['購票人資料照你提供的', st.pool.buyer && st.pool.buyer.name === PROFILE.name && st.pool.buyer.phone === '0912345678' && st.pool.buyer.email === PROFILE.email, JSON.stringify(st.pool.buyer)],
        ['網站停在確認步驟', st.pool.step === 'CONFIRM' && page && /\/pool\/confirm$/.test(page.url()), `${st.pool.step} ${page && page.url()}`],
        ['標出「確認建立訂單」按鈕', /3px/.test(outlined), outlined],
        ...noDuplicates(st),
        ['流程狀態照順序走到付款前交接，沒有硬轉', s.task.wf.state === 'PAYMENT_HANDOFF' && inOrder(wfPath(s.task), ['PAGE_DETECTION', 'ACTIVITY_READ', 'REQUIREMENT_CHECK', 'SESSION_SELECTION', 'PAGE_DETECTION', 'TICKET_AREA_SELECTION', 'QUANTITY_SELECTION', 'PAGE_DETECTION', 'BUYER_INFO', 'PAGE_DETECTION', 'ORDER_REVIEW', 'PAYMENT_HANDOFF']) && !s.task.wf.history.some((h) => h.forced), wfPath(s.task).join('→')],
        ['記下做完的步驟：已保留、已送出資料', !!(s.task.wf.done.hold && s.task.wf.done.buyer), JSON.stringify(Object.keys(s.task.wf.done))],
        ['場次規劃寫明選了哪個與理由', !!(s.task.wf.plan && s.task.wf.plan.session && s.task.wf.plan.session.ranked.some((r) => r.verdict === 'chosen' && /可以買/.test(r.reason))), s.task.wf.plan && s.task.wf.plan.session && s.task.wf.plan.session.msg],
        ['交接內容：已確認的場次、票種張數、金額，下一步由你按確認', s.task.handoff && s.task.handoff.confirmed.session === '11/20（五） 06:00–08:00' && s.task.handoff.confirmed.amount === 280 && s.task.handoff.confirmed.items.length === 2 && /自己按「確認建立訂單」/.test(s.task.handoff.next), JSON.stringify(s.task.handoff && s.task.handoff.confirmed)],
      ];
      // 使用者自己按確認
      await confirmBtn.click();
      const s2 = await waitTask(popup, (t) => t.phase === 'done', 15000);
      const st2 = await siteState(ctx);
      checks.push(['使用者確認後記成成功', s2.task.result && s2.task.result.ok && s2.task.result.kind === 'ordered', resultMsg(s2)]);
      checks.push(['流程狀態：完成', s2.task.wf.state === 'COMPLETED', wfState(s2.task)]);
      checks.push(...noDuplicates(st2, { confirm: 1 }));
      return checks;
    },
  },
  {
    name: 'schedule-not-open',
    title: '排程：開賣前在時段列表倒數並預告，到點重新整理後才選購',
    async run({ ctx, popup }) {
      const T = nextWholeSecond(14000);
      await scenario(ctx, 'not-open', `opensIn=${Math.round((T - Date.now()) / 1000)}`);
      await fillPopup(popup, { openTime: localDT(T) });
      const msg = await clickAndRead(popup, '#btnSchedule');
      const s = await waitTask(popup, ready, 45000);
      const st = await siteState(ctx);
      const logs = (s.logs || []).map((l) => l.msg);
      return [
        ['排程成功', /已排程/.test(msg), msg],
        ['倒數時就預告會選哪一個', logs.some((m) => m.includes('開賣時會選「11/20（五） 06:00–08:00」（目前尚未開放）')), logs.find((m) => m.includes('開賣時會選')) || ''],
        ['開賣後才選購', st.pool.hold && st.pool.hold.createdAt >= T, st.pool.hold ? `開賣後 ${st.pool.hold.createdAt - T} ms` : '沒有選購'],
        ['停在確認頁等使用者', ready(s.task), resultMsg(s)],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'sold-out',
    title: '全部售完：說明哪些時段額滿，不送出任何選購',
    async run({ ctx, popup }) {
      await scenario(ctx, 'sold-out');
      await fillPopup(popup, { keywords: ['11/20 06:00', '11/21'] });
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, stopped, 30000);
      const st = await siteState(ctx);
      return [
        ['停在「售完」', s.task.phase === 'done' && s.task.result.kind === 'sold-out', resultMsg(s)],
        ['訊息列出額滿的時段', /已額滿：.*11\/20（五） 06:00–08:00/.test(s.task.result.msg), ''],
        ['沒有送出選購', st.stats.holdRequests === 0, `選購請求 ${st.stats.holdRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'race-sold-out',
    title: '送出時剛好被買走：記下這個時段，改選下一個偏好的時段',
    async run({ ctx, popup }) {
      await scenario(ctx, 'race-sold-out');
      await fillPopup(popup, { keywords: ['11/20 06:00', '11/20 14:00'] });
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      return [
        ['停在確認頁等使用者', ready(s.task), resultMsg(s)],
        ['改選第二個偏好的時段', st.pool.hold && st.pool.hold.slotId === '20261120-1400', st.pool.hold && st.pool.hold.slotId],
        ['記下買不到的時段', (s.task.skip || []).includes('20261120-0600'), JSON.stringify(s.task.skip)],
        ['兩次選購、只成功一次', st.stats.holdRequests === 2 && st.stats.holds === 1, `請求 ${st.stats.holdRequests}、成功 ${st.stats.holds}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'limited',
    title: '剩少量：剩的不夠就換下一組，不會送出注定失敗的選購',
    async run({ ctx, popup }) {
      await scenario(ctx, 'limited');
      await fillPopup(popup, { keywords: ['11/20 06:00', '11/20 08:00', '11/20 10:00'], tickets: ['全票 3'] });
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      return [
        ['停在確認頁等使用者', ready(s.task), resultMsg(s)],
        ['選到剩 3 張的那一組', st.pool.hold && st.pool.hold.slotId === '20261120-1000', st.pool.hold && st.pool.hold.slotId],
        ['只送出一次選購', st.stats.holdRequests === 1, `請求 ${st.stats.holdRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'error-503',
    title: '系統忙碌（503）：按「更新狀態」重試，恢復後照常選購',
    async run({ ctx, popup }) {
      await scenario(ctx, 'error-503');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      return [
        ['停在確認頁等使用者', ready(s.task), resultMsg(s)],
        ['失敗後有重試', st.stats.slotsRequests >= 3 && (s.task.loadFail || 0) >= 2, `讀取時段 ${st.stats.slotsRequests} 次、重試 ${s.task.loadFail || 0} 次`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'error-page',
    title: '頁面錯誤（500）：重新整理錯誤頁，恢復後照常選購',
    async run({ ctx, popup }) {
      await scenario(ctx, 'error-page');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      return [
        ['停在確認頁等使用者', ready(s.task), resultMsg(s)],
        ['錯誤頁重新整理過', (st.stats.pages.select || 0) >= 2, `選票頁載入 ${st.stats.pages.select || 0} 次`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'error-submit',
    title: '送出時伺服器錯誤：確定失敗後才再送一次，有次數上限',
    async run({ ctx, popup }) {
      await scenario(ctx, 'error-submit');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      return [
        ['停在確認頁等使用者', ready(s.task), resultMsg(s)],
        ['失敗一次、重送一次、成功一次', st.stats.holdRequests === 2 && st.stats.holds === 1 && s.task.fail === 1, `請求 ${st.stats.holdRequests}、成功 ${st.stats.holds}、重試 ${s.task.fail}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'token-expired',
    title: '表單權杖過期：重新整理拿新的權杖，再送一次（有次數上限）',
    async run({ ctx, popup }) {
      await scenario(ctx, 'token-expired');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      return [
        ['停在確認頁等使用者', ready(s.task), resultMsg(s)],
        ['被拒一次、重新整理後成功', st.stats.holdRequests === 2 && st.stats.holds === 1 && s.task.fail === 1, `請求 ${st.stats.holdRequests}、成功 ${st.stats.holds}、重試 ${s.task.fail}`],
        ['重新整理過選票頁', (st.stats.pages.select || 0) >= 2, `選票頁載入 ${st.stats.pages.select || 0} 次`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'rate-limit-list',
    title: '讀取太頻繁（429）：照網站給的 Retry-After 等了才重新讀，恢復後照常選購',
    async run({ ctx, popup }) {
      await scenario(ctx, 'rate-limit-list');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      const gaps = gapsOf(st.stats.slotsAt);
      const logs = (s.logs || []).map((l) => l.msg);
      return [
        ['停在確認頁等使用者', ready(s.task), resultMsg(s)],
        ['被擋兩次、第三次才讀到', st.stats.rateLimited === 2 && st.stats.slotsRequests === 3, `429 共 ${st.stats.rateLimited} 次、讀取 ${st.stats.slotsRequests} 次`],
        ['沒有在網站要求的時間之前再要', st.stats.rateLimitEarly === 0, `太早重試 ${st.stats.rateLimitEarly} 次`],
        ['每次都至少等 2 秒（Retry-After: 2）', gaps.length === 2 && gaps.every((g) => g >= 2000), `間隔 ${gaps.join('、')} ms`],
        ['紀錄寫明照網站要求等', logs.some((m) => /照網站要求等 2\.\d 秒/.test(m)), logs.find((m) => /請求太多/.test(m)) || ''],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'rate-limit-noheader',
    title: '一直說請求太多、也沒給 Retry-After：間隔逐步拉長（2、4、8 秒），重試 3 次就停下來交給使用者',
    async run({ ctx, popup }) {
      await scenario(ctx, 'rate-limit-list', 'retryAfter=0&errors=20');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, stopped, 45000);
      const st = await siteState(ctx);
      const gaps = gapsOf(st.stats.slotsAt);
      return [
        ['停下來交給使用者', s.task.phase === 'waiting-user' && s.task.result.kind === 'rate-limit', resultMsg(s)],
        ['訊息說明一直被說請求太多', /一直說請求太多/.test(s.task.result.msg), ''],
        ['重試 3 次就停', st.stats.slotsRequests === 4, `讀取 ${st.stats.slotsRequests} 次`],
        ['間隔逐步拉長', gaps.length === 3 && gaps[0] >= 1900 && gaps[1] >= 3900 && gaps[2] >= 7900, `間隔 ${gaps.join('、')} ms`],
        ['沒有送出選購', st.stats.holdRequests === 0, `選購請求 ${st.stats.holdRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'rate-limit-submit',
    title: '送出時網站說請求太多（429）：不自動重送，停下來交給使用者',
    async run({ ctx, popup }) {
      await scenario(ctx, 'rate-limit-submit');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, stopped, 40000);
      await sleep(3000);   // 過了 Retry-After 也不會自己再送
      const st = await siteState(ctx);
      return [
        ['停下來交給使用者', s.task.phase === 'waiting-user' && s.task.result.kind === 'rate-limited', resultMsg(s)],
        ['訊息說不自動重送', /不自動重送/.test(s.task.result.msg), ''],
        ['選購只送出一次', st.stats.holdRequests === 1, `選購請求 ${st.stats.holdRequests}`],
        ['顯示「繼續」按鈕', await popup.isVisible('#btnResume'), ''],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'rate-limit-hidden',
    title: '讀取時 429，但頁面只寫「請求太多」、不寫狀態碼：一樣照 Retry-After 等（看回應標頭，不靠頁面文字）',
    async run({ ctx, popup }) {
      await scenario(ctx, 'rate-limit-list', 'hideStatus=1');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, stopped, 60000);
      const st = await siteState(ctx);
      const gaps = gapsOf(st.stats.slotsAt);
      return [
        ['停在確認頁等使用者', ready(s.task), resultMsg(s)],
        ['沒有在網站要求的時間之前再要', st.stats.rateLimitEarly === 0, `太早重試 ${st.stats.rateLimitEarly} 次、讀取 ${st.stats.slotsRequests} 次`],
        ['每次都至少等 2 秒（Retry-After: 2）', gaps.length === 2 && gaps.every((g) => g >= 2000), `間隔 ${gaps.join('、')} ms`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'rate-limit-submit-hidden',
    title: '送出時 429，但頁面不寫狀態碼：一樣認得是請求太多，不自動重送',
    async run({ ctx, popup }) {
      await scenario(ctx, 'rate-limit-submit', 'hideStatus=1');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, stopped, 40000);
      await sleep(3000);   // 過了 Retry-After 也不會自己再送
      const st = await siteState(ctx);
      return [
        ['停下來，而且認得是請求太多', s.task.phase === 'waiting-user' && s.task.result.kind === 'rate-limited', resultMsg(s)],
        ['選購只送出一次', st.stats.holdRequests === 1, `選購請求 ${st.stats.holdRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'area-fallback',
    title: '分區域：偏好的票區售完，改選下一個符合條件的票區；確認頁核對後付款前交接',
    async run({ ctx, popup }) {
      await scenario(ctx, 'area-sold-out');
      await fillPopup(popup, { areas: ['室內池', '戶外池'] });
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      const plan = s.task.wf && s.task.wf.plan && s.task.wf.plan.area;
      const h = s.task.handoff || {};
      return [
        ['付款前交接', ready(s.task) && wfState(s.task) === 'PAYMENT_HANDOFF', resultMsg(s)],
        ['改選戶外池', st.pool.hold && st.pool.hold.areaId === 'outdoor', st.pool.hold && st.pool.hold.areaId],
        ['票區規劃寫明理由：室內池已售完、選戶外池', !!plan && plan.ranked.some((r) => r.id === 'indoor' && r.verdict === 'skip' && /已售完/.test(r.reason)) && plan.ranked.some((r) => r.id === 'outdoor' && r.verdict === 'chosen'), plan && plan.msg],
        ['金額含票區加價', st.pool.hold && st.pool.hold.amount === (110 + 30) * 2 + (60 + 30), st.pool.hold && String(st.pool.hold.amount)],
        ['交接內容有票區與金額（確認頁核對過）', !!h.confirmed && h.confirmed.area === '戶外池' && h.confirmed.amount === 370, JSON.stringify(h.confirmed)],
        ['只送出一次選購', st.stats.holdRequests === 1, `選購請求 ${st.stats.holdRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'area-budget',
    title: '分區域：偏好的票區超過最高單價，改選下一個在預算內的票區',
    async run({ ctx, popup }) {
      await scenario(ctx, 'areas');
      await fillPopup(popup, { areas: ['親子池', '戶外池'], tickets: ['全票 1'], maxUnitPrice: 150 });
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      const plan = s.task.wf && s.task.wf.plan && s.task.wf.plan.area;
      return [
        ['付款前交接', ready(s.task), resultMsg(s)],
        ['選戶外池（每張 140，在 150 以內）', st.pool.hold && st.pool.hold.areaId === 'outdoor' && st.pool.hold.amount === 140, st.pool.hold && `${st.pool.hold.areaId} ${st.pool.hold.amount}`],
        ['親子池因為超過最高單價跳過', !!plan && plan.ranked.some((r) => r.id === 'family' && r.verdict === 'skip' && /超過你設定的最高單價 NT\$150/.test(r.reason)), plan && JSON.stringify(plan.ranked)],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'budget-none',
    once: true,
    title: '沒有符合預算的選擇：選購前就停下來說明，不送出任何選購',
    async run({ ctx, popup }) {
      await scenario(ctx, 'normal');
      await fillPopup(popup, { maxUnitPrice: 100 });
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, stopped, 30000);
      const st = await siteState(ctx);
      return [
        ['停下來，說明哪個票種超過預算', s.task.result.kind === 'budget' && /全票每張 NT\$110超過你設定的最高單價 NT\$100/.test(s.task.result.msg), resultMsg(s)],
        ['流程狀態：沒有完成；下一步請你調整', wfState(s.task) === 'FAILED' && /調整最高單價/.test((s.task.handoff || {}).next || ''), `${wfState(s.task)}｜${(s.task.handoff || {}).next}`],
        ['沒有送出選購', st.stats.holdRequests === 0, `選購請求 ${st.stats.holdRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'status-unknown',
    once: true,
    title: '偏好的場次狀態看不出來：不猜、不當成還沒開放一直重看，停下來請你確認',
    async run({ ctx, popup }) {
      await scenario(ctx, 'unknown-status');
      await fillPopup(popup, { keywords: ['11/20 06:00', '11/20 14:00'] });
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, stopped, 30000);
      await sleep(2500);
      const st = await siteState(ctx);
      return [
        ['停下來請你確認', s.task.phase === 'waiting-user' && s.task.result.kind === 'status-unknown' && wfState(s.task) === 'MANUAL_CONFIRMATION', resultMsg(s)],
        ['訊息說明是哪個場次看不出來', /11\/20（五） 06:00–08:00.*看不出能不能買/.test(s.task.result.msg), ''],
        ['沒有一直重看、沒有選購', st.stats.slotsRequests === 1 && (s.task.notOpen || 0) === 0 && st.stats.holdRequests === 0, `讀取 ${st.stats.slotsRequests}、重看 ${s.task.notOpen || 0}、選購 ${st.stats.holdRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'login-expired',
    once: true,
    title: '登入逾時：停下來請你重新登入；按「繼續」後接著做到付款前交接',
    async run({ ctx, popup }) {
      await scenario(ctx, 'login-expired');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, stopped, 30000);
      const h = s.task.handoff || {};
      const first = { kind: s.task.result.kind, state: wfState(s.task), next: h.next };
      const r = await clickAndRead(popup, '#btnResume');
      const s2 = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      return [
        ['停下來請你重新登入', first.kind === 'login-required' && first.state === 'MANUAL_CONFIRMATION' && /重新登入/.test(first.next || ''), JSON.stringify(first)],
        ['按「繼續」後接著做', /已繼續/.test(r) && ready(s2.task), resultMsg(s2)],
        ['選購一共 2 次：被拒 1 次、成功 1 次', st.stats.holdRequests === 2 && st.stats.holds === 1, `請求 ${st.stats.holdRequests}、成功 ${st.stats.holds}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'unknown-result',
    once: true,
    title: '送出結果不明（頁面等到逾時，網站其實已經保留）：不重送，停下來請你確認',
    async run({ ctx, popup }) {
      await scenario(ctx, 'submit-unknown');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, stopped, 30000);
      await sleep(3000);
      const st = await siteState(ctx);
      return [
        ['停下來請你確認', s.task.result.kind === 'unknown-result' && wfState(s.task) === 'MANUAL_CONFIRMATION', resultMsg(s)],
        ['下一步：請你看頁面或訂單查詢，助手不重送', /不會自己重送/.test((s.task.handoff || {}).next || ''), (s.task.handoff || {}).next],
        ['只送出一次（伺服器其實有保留）', st.stats.holdRequests === 1 && st.stats.holdsDropped === 1, `選購請求 ${st.stats.holdRequests}、回應太晚 ${st.stats.holdsDropped}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'review-mismatch',
    once: true,
    title: '確認頁的內容跟計畫不一致（網站改了張數）：不交接付款，停下來請你確認',
    async run({ ctx, popup }) {
      await scenario(ctx, 'quantity-changed');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, stopped, 30000);
      const st = await siteState(ctx);
      return [
        ['停下來請你確認，不是付款前交接', s.task.result.kind === 'review-mismatch' && wfState(s.task) === 'MANUAL_CONFIRMATION', resultMsg(s)],
        ['說明哪裡不一樣', /全票：預計 2 張，確認頁是 1 張/.test(s.task.result.msg) && /金額：預計 NT\$280，確認頁是 NT\$170/.test(s.task.result.msg), s.task.result.msg],
        ['不能按「繼續」跳過付款前的核對以外的步驟：沒有確認請求', st.stats.confirmRequests === 0, `確認請求 ${st.stats.confirmRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'pause-resume',
    once: true,
    title: '暫停：做完手上的檢查就停，不再做新的操作；按「繼續」從目前這一頁接著做',
    async run({ ctx, popup }) {
      await scenario(ctx, 'slow', 'delayMs=1500');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      await popup.waitForSelector('#btnPause:not([hidden])', { timeout: 5000 });
      const p = await clickAndRead(popup, '#btnPause');
      const s = await waitTask(popup, (t) => t.phase === 'paused', 10000);
      await sleep(5000);   // 列表讀完之後也不會往下做
      const mid = await siteState(ctx);
      const midTask = (await status(popup)).task;
      const r = await clickAndRead(popup, '#btnResume');
      const s2 = await waitTask(popup, ready, 60000);
      const st = await siteState(ctx);
      return [
        ['暫停了', /已暫停/.test(p) && s.task.phase === 'paused' && wfState(s.task) === 'PAUSED', `${s.task.phase} ${wfState(s.task)}`],
        ['暫停後沒有再做任何操作', mid.stats.holdRequests === 0 && midTask.phase === 'paused', `選購 ${mid.stats.holdRequests}、${midTask.phase}`],
        ['按「繼續」從目前這一頁接著做到付款前交接', /已繼續/.test(r) && ready(s2.task) && inOrder(wfPath(s2.task), ['PAUSED', 'PAGE_DETECTION', 'PAYMENT_HANDOFF']), wfPath(s2.task).join('→')],
        ['只送出一次選購', st.stats.holdRequests === 1, `選購 ${st.stats.holdRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'cancel-midway',
    once: true,
    title: '中途取消：之後不再做任何操作',
    async run({ ctx, popup }) {
      await scenario(ctx, 'slow', 'delayMs=1500');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      await sleep(300);
      await clickAndRead(popup, '#btnCancel');
      const s = await waitTask(popup, (t) => t.phase === 'cancelled', 10000);
      await sleep(5000);
      const st = await siteState(ctx);
      return [
        ['已取消', s.task.phase === 'cancelled' && wfState(s.task) === 'CANCELLED', `${s.task.phase} ${wfState(s.task)}`],
        ['取消後沒有送出選購', st.stats.holdRequests === 0, `選購 ${st.stats.holdRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'resume-no-duplicate',
    once: true,
    title: '重新整理、按上一頁再按「繼續」：已經做完的步驟（保留名額）不重做',
    async run({ ctx, popup }) {
      await scenario(ctx, 'normal');
      await fillPopup(popup, { autoAgree: false });
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, stopped, 30000);
      const page = sitePage(ctx);
      await page.reload();
      await sleep(800);
      await page.goBack();
      await sleep(800);
      const backOnSelect = /\/pool\/select\//.test(page.url());
      await popup.bringToFront();
      await popup.setChecked('#autoAgree', true);
      await sleep(400);
      const r = await clickAndRead(popup, '#btnResume');
      const s2 = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      return [
        ['先停在填資料（你設定不自動勾同意）', s.task.result.kind === 'agree' && wfState(s.task) === 'MANUAL_CONFIRMATION', resultMsg(s)],
        ['重新整理、按上一頁回到選票頁', backOnSelect, page.url()],
        ['按「繼續」後接著做到付款前交接', /已繼續/.test(r) && ready(s2.task), resultMsg(s2)],
        ['選購只送出一次（已保留的不重送）', st.stats.holdRequests === 1, `選購 ${st.stats.holdRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'sw-restart',
    once: true,
    title: 'service worker 重啟：流程狀態從儲存區接回來，按「繼續」照常走完',
    async run({ ctx, popup, extId }) {
      await scenario(ctx, 'normal');
      await fillPopup(popup, { autoAgree: false });
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, stopped, 30000);
      const before = wfPath(s.task).length;
      const sw = ctx.serviceWorkers().find((w) => w.url().includes(extId));
      await sw.evaluate(() => { self.__ithMarker = 'before'; });
      const restarted = await restartServiceWorker(ctx, popup, extId);
      await sleep(1000);
      await popup.setChecked('#autoAgree', true);
      await sleep(400);
      const r = await clickAndRead(popup, '#btnResume');
      const s2 = await waitTask(popup, ready, 40000);
      const sw2 = ctx.serviceWorkers().find((w) => w.url().includes(extId));
      const marker = sw2 ? await sw2.evaluate(() => self.__ithMarker || 'fresh').catch(() => 'closed') : 'none';
      const st = await siteState(ctx);
      return [
        ['service worker 真的重啟了（記憶體是新的）', restarted && marker === 'fresh', `${restarted} ${marker}`],
        ['重啟後按「繼續」照常做到付款前交接', /已繼續/.test(r) && ready(s2.task), resultMsg(s2)],
        ['流程紀錄接著原本的寫，沒有重來', wfPath(s2.task).length > before && inOrder(wfPath(s2.task), ['BUYER_INFO', 'MANUAL_CONFIRMATION', 'PAGE_DETECTION', 'BUYER_INFO', 'PAYMENT_HANDOFF']), wfPath(s2.task).join('→')],
        ['選購只送出一次', st.stats.holdRequests === 1, `選購 ${st.stats.holdRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'slow',
    title: '回應很慢（每個 API 慢 3 秒）：耐心等，不會因為等太久又按一次',
    async run({ ctx, popup }) {
      await scenario(ctx, 'slow', 'delayMs=3000');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 60000);
      const st = await siteState(ctx);
      return [
        ['停在確認頁等使用者', ready(s.task), resultMsg(s)],
        ['選購和資料各只送一次', st.stats.holdRequests === 1 && st.stats.buyerRequests === 1, `選購 ${st.stats.holdRequests}、資料 ${st.stats.buyerRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'hold-expire',
    title: '保留逾時：停在確認頁後提醒剩餘時間，到期再提醒一次',
    async run({ ctx, popup }) {
      await scenario(ctx, 'hold-short', 'holdSec=10');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 40000);
      const s2 = await waitTask(popup, (t) => !!(t.warned && t.warned['hold-expired']), 20000);
      const st = await siteState(ctx);
      return [
        ['停在確認頁等使用者', ready(s.task), resultMsg(s)],
        ['提醒保留快到期', !!(s2.task.warned && s2.task.warned['hold-soon']), JSON.stringify(s2.task.warned)],
        ['到期再提醒一次', !!(s2.task.warned && s2.task.warned['hold-expired']), ''],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'captcha',
    title: '確認頁有驗證碼：停下來請使用者自己輸入，不碰驗證碼',
    async run({ ctx, popup }) {
      await scenario(ctx, 'captcha');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      const page = sitePage(ctx);
      const typed = page ? await page.getByLabel('驗證碼', { exact: true }).inputValue() : '?';
      return [
        ['停下來並提到驗證碼', ready(s.task) && /輸入驗證碼/.test(s.task.result.msg), resultMsg(s)],
        ['驗證碼欄位沒有被填', typed === '', `欄位內容「${typed}」`],
        ['沒有嘗試過驗證碼', st.stats.captchaWrong === 0, `答錯 ${st.stats.captchaWrong} 次`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'botcheck',
    title: '確認頁有機器人檢查：停下來請使用者自己做，不替使用者點',
    async run({ ctx, popup }) {
      await scenario(ctx, 'botcheck');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      return [
        ['停下來並提到機器人檢查', ready(s.task) && /我不是機器人/.test(s.task.result.msg), resultMsg(s)],
        ['沒有點機器人檢查', st.stats.botcheckRejected === 0 && st.pool.botcheck === null, `被拒 ${st.stats.botcheckRejected}、狀態 ${st.pool.botcheck}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'queue',
    title: '排隊：停下來交給使用者，排完也不自己繼續；使用者按「繼續」才接著做',
    async run({ ctx, popup }) {
      await scenario(ctx, 'queue', 'queueSec=4');
      await fillPopup(popup);
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, (t) => t.phase === 'waiting-user' && t.result && t.result.kind === 'queue', 20000);
      await sleep(7000);   // 排完了，頁面自己回到時段列表
      const mid = await siteState(ctx);
      const page = sitePage(ctx);
      const midUrl = page ? page.url() : '';
      const backOnList = /\/pool\/$/.test(midUrl);
      const resumeShown = await popup.isVisible('#btnResume');
      const r = await clickAndRead(popup, '#btnResume');
      const s2 = await waitTask(popup, ready, 40000);
      const st = await siteState(ctx);
      return [
        ['遇到排隊就停下來', s.task.result && s.task.result.kind === 'queue', resultMsg(s)],
        ['排完沒有自己繼續', backOnList && mid.stats.holdRequests === 0 && mid.pool.step === 'LIST', `頁面 ${midUrl}、選購 ${mid.stats.holdRequests}`],
        ['顯示「繼續」按鈕', resumeShown, ''],
        ['按「繼續」後接著做', /已繼續/.test(r) && ready(s2.task), `${r}；${resultMsg(s2)}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'schedule-queue',
    title: '排程後開頁就遇到排隊：一樣停下來交給使用者，排完不自己倒數接著做',
    async run({ ctx, popup }) {
      await scenario(ctx, 'queue', 'queueSec=4');
      const T = nextWholeSecond(25000);
      await fillPopup(popup, { openTime: localDT(T) });
      await clickAndRead(popup, '#btnSchedule');
      const s = await waitTask(popup, (t) => t.phase === 'waiting-user' && t.result && t.result.kind === 'queue', 20000);
      await sleep(6000);   // 排完了，頁面自己回到時段列表
      const st = await siteState(ctx);
      const after = await status(popup);
      await popup.click('#btnCancel');
      return [
        ['開賣前遇到排隊就停下來', s.task.result && s.task.result.kind === 'queue', resultMsg(s)],
        ['排完沒有自己繼續', after.task.phase === 'waiting-user' && st.stats.holdRequests === 0, `任務 ${after.task.phase}、選購 ${st.stats.holdRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'site-validation',
    title: '網站說資料有問題（備註太長）：照網站的訊息停下來，請使用者修改',
    async run({ ctx, popup }) {
      await scenario(ctx, 'normal');
      await fillPopup(popup, { profile: { note: '很長的備註'.repeat(30) } });
      await clickAndRead(popup, '#btnRunNow');
      const s = await waitTask(popup, stopped, 40000);
      const st = await siteState(ctx);
      return [
        ['停下來交給使用者', s.task.phase === 'waiting-user' && s.task.result.kind === 'VALIDATION', resultMsg(s)],
        ['訊息講出是哪一欄', /note：備註最多 100 個字/.test(s.task.result.msg), ''],
        ['資料只送出一次', st.stats.buyerRequests === 1, `資料請求 ${st.stats.buyerRequests}`],
        ...noDuplicates(st),
      ];
    },
  },
  {
    name: 'profile-incomplete',
    title: '購票人資料不完整：開始前就擋下，說清楚缺什麼，不開任何頁面',
    async run({ ctx, popup }) {
      await fillPopup(popup, { profile: { email: '', phone: '12345' } });
      const before = ctx.pages().length;
      const msg = await clickAndRead(popup, '#btnRunNow');
      await sleep(800);
      const s = await status(popup);
      return [
        ['擋下並說明', /購票人資料：還沒填：Email；手機：手機要是 09 開頭共 10 碼/.test(msg), msg],
        ['沒有建立任務', s.task.phase === 'none', `任務 ${s.task.phase}`],
        ['沒有開新頁面', ctx.pages().length === before, `${before} → ${ctx.pages().length}`],
      ];
    },
  },
  {
    name: 'check-and-health',
    title: '「檢查時段」顯示會選哪一個、供應狀態與票價；「健檢」確認頁面還認得',
    async run({ ctx, popup }) {
      await scenario(ctx, 'normal');
      await fillPopup(popup);
      await popup.click('#btnCheck');
      await popup.waitForFunction(() => !/檢查中/.test(document.querySelector('#checkMsg').textContent), null, { timeout: 30000 });
      const check = await popup.textContent('#checkMsg');
      await popup.click('#btnHealth');
      await popup.waitForFunction(() => document.querySelector('#healthMsg').textContent && !/健檢中/.test(document.querySelector('#healthMsg').textContent), null, { timeout: 30000 });
      const health = await popup.textContent('#healthMsg');
      const items = await popup.$$eval('#healthList li', (lis) => lis.map((li) => li.className));
      await sleep(500);
      const s = await status(popup);
      return [
        // 畫面上「可購買」不寫剩幾張（只有「剩少量」會寫），助手只看畫面，所以不會有張數
        ['說明會選哪一個時段', /開賣時會選「11\/20（五） 06:00–08:00」（目前可購買）/.test(check), check],
        ['列出供應狀態', /共 15 個時段：可購買 13、已額滿 2/.test(check), ''],
        ['列出票價', /票價：全票 NT\$110、優待票 NT\$80、兒童票 NT\$60/.test(check), ''],
        ['健檢全部正常', /全部正常/.test(health) && items.length >= 5 && items.every((c) => c === 'ok'), `${health}｜${items.join(',')}`],
        ['檢查不會建立任務', s.task.phase === 'none', `任務 ${s.task.phase}`],
        ['檢查用的分頁會關掉', !sitePage(ctx), ''],
      ];
    },
  },
  {
    name: 'ibon-info',
    once: true,   // 跟模擬站的一般／困難模式無關，只跑一次
    title: 'ibon 活動頁只讀資訊：顯示場次、票區、票價、開賣時間；不點任何按鈕、不送出，選購的按鈕停用',
    async run({ ctx, popup }) {
      ibonRequests.length = 0;
      const requests = ibonRequests;
      await popup.fill('#eventUrl', IBON_URL);
      await sleep(600);
      // 「我的需求」：票區偏好、票種張數（合計 2 張）、最高單價
      await popup.fill('#areas', '全票\n看台\n搖滾區');
      await popup.fill('#tickets', '全票 2');
      await popup.fill('#maxUnitPrice', '250');
      const hint = await popup.textContent('#regUrl');
      const runOff = [];
      for (const id of ['#btnSchedule', '#btnRunNow', '#btnCheck', '#btnHealth']) if (await popup.isDisabled(id)) runOff.push(id);
      const pagesBefore = ctx.pages().length;

      // 1. 沒有開著的活動頁：背景開一個分頁讀，讀完關掉
      await popup.click('#btnInfo');
      await popup.waitForFunction(() => document.querySelector('#infoMsg').textContent !== '' && !/讀取中/.test(document.querySelector('#infoMsg').textContent), null, { timeout: 40000 });
      const msg = await popup.textContent('#infoMsg');
      const view = await popup.textContent('#infoView');
      const matchText = await popup.textContent('#matchView');
      const checkText = await popup.textContent('#checkView');
      const policyText = await popup.textContent('#policyView');
      const info = (await popup.evaluate(() => chrome.storage.local.get('eventInfo'))).eventInfo || {};
      await sleep(500);
      const pagesAfter = ctx.pages().length;
      const bgLoads = requests.filter((r) => r === 'GET /ActivityInfo/Details/990001').length;   // 擴充功能自己開的背景分頁，也要是本機樣本回的
      const ss = info.sessions || [];

      // 2. 你自己開著同一頁：直接在那一頁讀，不另外開分頁
      const mine = await ctx.newPage();
      await mine.goto(IBON_URL);
      await sleep(1500);
      const loadsBefore = requests.filter((r) => r === 'GET /ActivityInfo/Details/990001').length;
      await popup.bringToFront();
      await popup.click('#btnInfo');
      await popup.waitForFunction(() => /已讀取|失敗/.test(document.querySelector('#infoMsg').textContent), null, { timeout: 40000 });
      const loadsAfter = requests.filter((r) => r === 'GET /ActivityInfo/Details/990001').length;
      const mineOpen = !mine.isClosed();

      // 3. 直接叫背景程式立即執行、檢查時段：ibon 網址一律拒絕
      const cfg = { eventUrl: IBON_URL, keywords: '12/05 18:00', tickets: '全票 1', profile: PROFILE, autoAgree: true };
      const ask = (type) => popup.evaluate(([t, c]) => new Promise((r) => chrome.runtime.sendMessage({ type: t, cfg: c }, r)), [type, cfg]);
      const run = await ask('run-now');
      const check = await ask('check-slots');
      const s = await status(popup);

      const clicked = requests.filter((r) => /__clicked/.test(r));
      const nonGet = requests.filter((r) => !r.startsWith('GET '));
      return [
        ['網址提示說只能讀取活動資訊', /只能讀取活動資訊/.test(hint), hint],
        ['排程、立即執行、檢查時段、健檢都停用', runOff.length === 4, runOff.join('、')],
        ['讀取成功', /已讀取/.test(msg), msg],
        ['標題與售票平台（說明區塊裡的「取票方式」不算）', info.title === '（測試）示範游泳池夜間入場券' && JSON.stringify((info.offers || []).map((o) => o.label)) === '["售票平台","票券型態"]', `${info.title}｜${JSON.stringify(info.offers)}`],
        ['三個場次：時間、名稱、場地', ss.length === 3 && ss[0].date === '2026-12-05' && ss[0].time === '18:00' && ss[2].name === '夜間入場（第三梯）' && ss.every((x) => x.venue === '示範游泳池'), ss.map((x) => `${x.date} ${x.time} ${x.name} ${x.venue}`).join('／')],
        ['場次狀態：販售中、已售完、尚未開賣（「尚未開賣」是推測的寫法，真站沒看過）', ss.map((x) => x.status).join(',') === 'on-sale,sold-out,not-open', ss.map((x) => x.status).join(',')],
        ['場次的截止與開賣時間', ss[0] && ss[0].saleEnd === '2026-12-04T12:00' && ss[2] && ss[2].saleStart === '2026-11-25T12:00', `${ss[0] && ss[0].saleEnd}｜${ss[2] && ss[2].saleStart}`],
        ['票區與票價（退票規則的 $50 不算）', JSON.stringify(info.prices) === JSON.stringify([{ name: '全票', price: 300 }, { name: '優待票', price: 200 }, { name: '2樓看台', price: 150 }]), JSON.stringify(info.prices)],
        ['開賣時間', (info.saleTimes || []).length === 1 && info.saleTimes[0].at === '2026-11-20T12:00', JSON.stringify(info.saleTimes)],
        ['限購規定只從購票須知讀（收合的也讀得到；周邊商品的不算）', JSON.stringify(info.limits) === '["每位會員限購4張。"]', JSON.stringify(info.limits)],
        ['需求比對：看台對到、全票超過最高單價、搖滾區沒有、2 張在限購 4 張以內', /✓ 「看台」：2樓看台 NT\$150/.test(matchText) && /✗ 「全票」：全票 NT\$300 都超過你設定的最高單價 NT\$250/.test(matchText) && /✗ 「搖滾區」：節目介紹的票價表裡沒有這個票區/.test(matchText) && /✓ 張數：2 張，在限購 4 張以內/.test(matchText), matchText.slice(0, 120)],
        ['資料檢查：還沒開賣、有幾天', /開賣時間 2026\/11\/20 12:00（還有 \d+ 天）/.test(checkText), checkText],
        ['登入狀態：頁首有「快速登入」＝沒登入', info.login && info.login.state === 'logged-out' && info.login.verified === true, JSON.stringify(info.login)],
        ['操作政策：點選、張數、送出由你自己做；驗證碼、付款助手不做', /你自己做點選場次、票區/.test(policyText) && /你自己做按「下一步」、送出訂單/.test(policyText) && /不做驗證碼/.test(policyText) && /不做付款/.test(policyText), policyText.slice(0, 80)],
        ['設定頁顯示讀到的資訊', /夜間入場（第一梯）/.test(view) && /NT\$300/.test(view) && /2026\/11\/20 12:00/.test(view), view.slice(0, 80)],
        ['背景分頁也是本機樣本伺服器回的（沒有連到真站）', bgLoads === 1 && /示範游泳池/.test(info.title || ''), `本機收到 ${bgLoads} 次`],
        ['讀完關掉背景分頁', pagesAfter === pagesBefore, `${pagesBefore} → ${pagesAfter}`],
        ['開著的活動頁直接讀，不另外載入', loadsAfter === loadsBefore && mineOpen, `載入 ${loadsBefore} → ${loadsAfter}、你的分頁${mineOpen ? '還在' : '被關了'}`],
        ['沒有點任何按鈕、沒有送出任何東西', clicked.length === 0 && nonGet.length === 0, `點擊 ${clicked.length}、非 GET 請求 ${nonGet.length}`],
        ['立即執行、檢查時段都拒絕 ibon 網址', !run.ok && /只能「讀取活動資訊」/.test(run.error || '') && !check.ok && /只能「讀取活動資訊」/.test(check.error || ''), `${run.error}｜${check.error}`],
        ['沒有建立任務', s.task.phase === 'none', `任務 ${s.task.phase}`],
      ];
    },
  },
  {
    name: 'ibon-purchase-page',
    once: true,
    title: 'ibon 購票頁（虛構樣本）：只讀狀態並標「未驗證」；結構快照讀得到封閉 Shadow DOM、遮掉個資、不記欄位內容；不點任何東西',
    async run({ ctx, popup }) {
      ibonRequests.length = 0;
      const page = await ctx.newPage();
      await page.goto(IBON_PURCHASE_URL);
      await sleep(800);
      await popup.bringToFront();
      await popup.fill('#eventUrl', IBON_URL);
      await popup.fill('#profileName', '測試使用者');   // 你自己的資料：快照裡要遮掉
      await sleep(600);
      await popup.click('#btnPage');
      await popup.waitForFunction(() => !/讀取中/.test(document.getElementById('pageMsg').textContent), null, { timeout: 15000 });
      const pageMsg = await popup.textContent('#pageMsg');
      const pageView = await popup.textContent('#pageView');
      const [download] = await Promise.all([popup.waitForEvent('download', { timeout: 15000 }), popup.click('#btnSnapshot')]);
      const file = await download.path();
      const raw = fs.readFileSync(file, 'utf8');
      const snap = JSON.parse(raw);
      const snapMsg = await popup.textContent('#pageMsg');
      const findShadow = (n) => !!n && ((n.t === '#shadow-root' && n.mode === 'closed') || (n.k || []).some(findShadow));
      const inputs = [];
      const nodes = [];
      (function walk(n) { if (!n) return; nodes.push(n); if (n.t === 'input') inputs.push(n); for (const k of n.k || []) walk(k); })(snap.tree);
      const clicked = ibonRequests.filter((r) => /__clicked/.test(r));
      const nonGet = ibonRequests.filter((r) => !r.startsWith('GET '));
      const s = await status(popup);
      return [
        ['認得是購票流程入口，並標明結構還沒在真站核對', /購票流程入口（UTK0201）（這種頁面的結構還沒在真站核對過）/.test(pageView), pageView.slice(0, 60)],
        ['驗證碼提示（未驗證）', /驗證碼相關的字.*未驗證/.test(pageView), pageView],
        ['提醒這一頁的操作由你自己做', /點選、張數、下一步、驗證碼、付款都由你自己操作/.test(pageView), pageMsg],
        ['快照：頁面種類與網址（參數只留名稱）', snap.kind === 'purchase-entry' && snap.url === 'https://orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=…&PRODUCT_ID=…', `${snap.kind}｜${snap.url}`],
        ['快照：讀得到封閉 Shadow DOM 裡的票區', findShadow(snap.tree) && raw.includes('示範看台區') && raw.includes('NT$150'), `${snap.nodes} 個節點`],
        ['快照：Email、手機遮掉；參數值、表單送出網址的參數值不留', !raw.includes('member@example.com') && !raw.includes('0912-345-678') && raw.includes('[email]') && raw.includes('[手機]') && !raw.includes('TEST1') && !raw.includes('abc123'), ''],
        ['快照：欄位只記有沒有填，不記內容', !raw.includes('ABCD') && inputs.some((i) => i.filled === true), JSON.stringify(inputs)],
        ['快照：「XXX 您好」「購票人：XXX」與你自己的姓名都遮掉', !/測試會員|陳小華|測試使用者/.test(raw) && raw.includes('[姓名] 您好') && raw.includes('購票人：[姓名]') && raw.includes('[你的資料]'), ''],
        ['快照：記下選項有沒有被選、元素看不看得見', inputs.some((i) => i.type === 'radio' && i.checked === true && i.value === 'atm') && nodes.some((n) => n.id === 'hiddenNote' && n.hidden === true), ''],
        ['設定頁說明已存檔與注意事項', /已存成檔案：\d+ 個節點、1 個 Shadow DOM/.test(snapMsg) && /姓名這類遮不到/.test(snapMsg), snapMsg],
        ['沒有點任何按鈕、沒有送出任何東西', clicked.length === 0 && nonGet.length === 0, `點擊 ${clicked.length}、非 GET 請求 ${nonGet.length}`],
        ['沒有建立任務', s.task.phase === 'none', `任務 ${s.task.phase}`],
      ];
    },
  },
  {
    name: 'ibon-guide',
    once: true,
    title: 'ibon 人工操作模式（虛構樣本頁）：活動頁給建議與依據；你換到購票頁後核對，購票頁欄位照實標「尚未驗證」；填寫購票資訊頁照真站結構讀出訂單並核對需求；不點任何東西',
    async run({ ctx, popup }) {
      ibonRequests.length = 0;
      await popup.fill('#eventUrl', IBON_URL);
      await popup.fill('#keywords', '12/05 20:00\n12/05 18:00');
      await popup.fill('#tickets', '全票 2');
      await popup.fill('#areas', '看台');
      await popup.fill('#maxUnitPrice', '250');
      const page = await ctx.newPage();   // 你自己開著的活動頁
      await page.goto(IBON_URL);
      await sleep(1500);
      await popup.bringToFront();
      await sleep(400);
      await popup.click('#btnGuide');
      await sleep(300);
      const r = await popup.textContent('#guideMsg');
      const s1 = await waitTask(popup, (t) => !!(t.guide && t.guide.pageKind === 'activity'), 20000);
      const g1 = s1.task.guide || {};
      const f1 = Object.fromEntries((g1.fields || []).map((f) => [f.field, f]));
      // 你自己按了「線上購票」：這裡用換頁模擬（真站的操作一律由你做）
      await page.goto(IBON_PURCHASE_URL);
      const s2 = await waitTask(popup, (t) => !!(t.guide && t.guide.n >= 2), 20000);
      const g2 = s2.task.guide || {};
      const f2 = Object.fromEntries((g2.fields || []).map((f) => [f.field, f]));
      await sleep(400);
      const card = await popup.textContent('#taskBox');
      // 你自己選好票區與張數，到了「填寫購票資訊」（結構照真站快照、內容虛構）
      await page.goto(IBON_BUYER_URL);
      const s4 = await waitTask(popup, (t) => !!(t.guide && t.guide.pageKind === 'buyer-info'), 20000);
      const g4 = s4.task.guide || {};
      const f4 = Object.fromEntries((g4.fields || []).map((f) => [f.field, f]));
      const raw4 = JSON.stringify(s4.task);
      let card4 = '';
      for (let i = 0; i < 20 && !/填寫購票資訊（UTK0206/.test(card4); i++) { await sleep(250); card4 = await popup.textContent('#taskBox'); }
      const clicked = ibonRequests.filter((x) => /__clicked/.test(x));
      const nonGet = ibonRequests.filter((x) => !x.startsWith('GET '));
      await clickAndRead(popup, '#btnCancel');
      const s3 = await waitTask(popup, (t) => t.phase === 'cancelled', 5000);
      return [
        ['開始人工操作模式', /已開始人工操作模式/.test(r) && s1.task.mode === 'guide', r],
        ['活動頁建議：先登入，再自己按第一梯的「線上購票」（第二梯已額滿）', /先登入/.test(g1.recommendation) && /自己按「2026\/12\/05\(六\) 18:00 夜間入場（第一梯）」那一列的「線上購票」/.test(g1.recommendation) && g1.basis.plan.ranked.some((x) => /第二梯/.test(x.text) && x.reason === '已額滿'), g1.recommendation],
        ['依據附需求比對與「由你自己做」的政策', g1.basis.match.areas.some((m) => /2樓看台 NT\$150/.test(m)) && /由你自己做（CONFIRMATION_REQUIRED/.test(g1.basis.policy), g1.basis.policy],
        ['活動頁欄位：場次讀取成功、「尚未開賣」尚未驗證、剩餘數量這一頁沒有', f1['場次'] && f1['場次'].status === 'ok' && f1['場次狀態'].status === 'unverified' && f1['剩餘數量'].status === 'unavailable' && f1['張數限制'].status === 'ok', JSON.stringify(f1['場次狀態'])],
        ['換到購票頁後核對：照實說核對不了是哪個場次', g2.pageKind === 'purchase-entry' && g2.verify && g2.verify.status === 'unverified' && /無法確認是不是「2026\/12\/05\(六\) 18:00 夜間入場（第一梯）」/.test(g2.verify.msg), g2.verify && g2.verify.msg],
        ['購票頁欄位一律尚未驗證、不猜；驗證碼只辨識有沒有', ['票區', '價格', '剩餘數量', '張數限制'].every((k) => f2[k] && f2[k].status === 'unverified' && f2[k].value === null) && /^頁面上有「/.test(f2['驗證碼區域'].value) && f2['驗證碼區域'].status === 'unverified', JSON.stringify(f2['驗證碼區域'])],
        ['流程狀態照頁面記（由你操作）', inOrder(wfPath(s2.task), ['ACTIVITY_READ', 'REQUIREMENT_CHECK', 'SESSION_SELECTION', 'PAGE_DETECTION', 'TICKET_AREA_SELECTION']), wfPath(s2.task).join('→')],
        ['設定頁顯示建議與欄位讀取結果', /人工操作模式：第 2 頁/.test(card) && /？ 尚未驗證/.test(card) && /建議：/.test(card), card.slice(0, 80)],
        ['填寫購票資訊：讀出步驟、場次時間、座位、票種、單價、張數、總計、保留時間', f4['目前步驟'] && f4['目前步驟'].value === '第 4 步：填寫購票資訊' && f4['場次時間'].value === '2026/12/05 18:00' && /2樓看台_3排-12號/.test(f4['票區／座位'].value) && f4['票種'].value === '全票' && f4['單價'].value === 'NT$150' && f4['張數'].value === '2 張' && f4['總計'].value === 'NT$300' && /^0?7:4\d$/.test(f4['保留剩餘時間'].value.replace(/^0/, '')), JSON.stringify(Object.values(f4).map((f) => `${f.field}=${f.value}`))],
        ['填寫購票資訊：核對場次時間與張數都跟建議／需求一致', g4.verify && g4.verify.status === 'ok' && /場次時間 2026\/12\/05 18:00 跟建議/.test(g4.verify.msg) && /張數 2 張跟需求一致/.test(g4.verify.msg), g4.verify && g4.verify.msg],
        ['填寫購票資訊：電話只說有填、付款與取票照頁面選的、同意還沒勾；建議由你自己勾選與按下一步', f4['聯絡電話'].value === '已填（助手不讀內容）' && f4['付款方式'].value === '已選「信用卡」' && f4['取票方式'].value === '已選「ibon紙票」' && f4['同意條款'].value === '還沒勾選' && /自己勾選同意/.test(g4.recommendation) && /自己按「下一步，核對資料」/.test(g4.recommendation) && /剩 0?7:4\d/.test(g4.recommendation), g4.recommendation],
        ['填寫購票資訊：沒有把電話、Email 的內容帶出頁面', !/0911222333|demo-buyer@example\.com/.test(raw4), ''],
        ['填寫購票資訊：流程狀態到 BUYER_INFO，設定頁顯示', wfPath(s4.task).includes('BUYER_INFO') && /填寫購票資訊（UTK0206/.test(card4), wfPath(s4.task).join('→')],
        ['沒有點任何按鈕、沒有送出任何東西', clicked.length === 0 && nonGet.length === 0, `點擊 ${clicked.length}、非 GET ${nonGet.length}`],
        ['用「取消任務」結束', s3.task.phase === 'cancelled', s3.task.phase],
      ];
    },
  },
  {
    name: 'ibon-reminders',
    once: true,
    title: 'ibon 提醒與回報（虛構樣本頁）：開賣前提醒排得對、同一段只通知一次；保留倒數剩 2 分鐘通知一次、倒數停住標未知；問題回報不帶個資；取消任務不清開賣提醒；不點任何東西',
    async run({ ctx, popup }) {
      ibonRequests.length = 0;
      const bg = (msg) => popup.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
      const alarms = () => popup.evaluate(() => chrome.alarms.getAll().then((a) => a.map((x) => ({ name: x.name, when: x.scheduledTime }))));
      const store = (k) => popup.evaluate((key) => chrome.storage.local.get(key).then((o) => o[key]), k);
      const logCount = async (re) => ((await status(popup)).logs || []).filter((l) => re.test(l.msg)).length;
      await popup.fill('#eventUrl', IBON_URL);
      await popup.fill('#keywords', '12/05 18:00');
      await popup.fill('#tickets', '全票 2');
      await sleep(600);
      // A2 開賣提醒：讀活動資訊 → 設定提醒
      const noInfo = await bg({ type: 'sale-remind', url: 'https://ticket.ibon.com.tw/ActivityInfo/Details/99999' });
      await popup.click('#btnInfo');
      for (let i = 0; i < 60 && !/已讀取/.test(await popup.textContent('#infoMsg')); i++) await sleep(250);
      await popup.click('#btnSaleRemind');
      await sleep(600);
      const saleMsg = await popup.textContent('#saleMsg');
      const saleListText = await popup.textContent('#saleList');
      const sa = (await alarms()).filter((a) => a.name.startsWith('ith-sale|')).map((a) => a.when).sort((x, y) => x - y);
      const t1120 = Date.UTC(2026, 10, 20, 4, 0), t1125 = Date.UTC(2026, 10, 25, 4, 0);
      const wantAlarms = [t1120 - 300000, t1120 - 60000, t1125 - 300000, t1125 - 60000];
      // 通知路徑：放一個 200 秒後開賣的提醒，叫 alarm 跑兩次，只通知一次
      const list0 = await store('saleReminders');
      await popup.evaluate((l) => chrome.storage.local.set({ saleReminders: l }), [...list0, { id: 'e2e', url: IBON_URL, title: '測試提醒活動', ms: Date.now() + 200000, text: 'x', source: '節目介紹', verified: true, notified: {} }]);
      for (let k = 0; k < 2; k++) {
        await popup.evaluate(() => chrome.alarms.create('ith-sale|e2e|300', { when: Date.now() + 100 }));
        await sleep(1500);
      }
      const fired = (await store('saleReminders')).find((r) => r.id === 'e2e');
      const saleNotices = await logCount(/開賣提醒：「測試提醒活動」約 \d+ 分鐘後開賣/);
      await bg({ type: 'sale-remind-cancel', id: 'e2e' });
      // A1 保留倒數：開始人工操作模式，你自己走到填寫購票資訊（倒數 2:06 開始）
      const page = await ctx.newPage();
      await page.goto(IBON_URL);
      await sleep(1500);
      await popup.bringToFront();
      await popup.click('#btnGuide');
      await waitTask(popup, (t) => !!(t.guide && t.guide.pageKind === 'activity'), 20000);
      await page.goto(`${IBON_BUYER_URL}?cd=126`);
      const s1 = await waitTask(popup, (t) => !!(t.hold && t.hold.status === 'ok'), 20000);
      const holdAl = (await alarms()).filter((a) => a.name.startsWith('ith-hold|')).map((a) => a.name);
      const s2 = await waitTask(popup, (t) => !!(t.hold && t.hold.notified && t.hold.notified[120]), 25000);
      await sleep(12000);   // 再讀一次倒數：同一段不重複
      const holdNotices = await logCount(/保留倒數：剩不到 2 分鐘，已通知/);
      const s3 = await status(popup);
      let holdText = '';
      for (let i = 0; i < 8 && !/保留倒數：剩約/.test(holdText); i++) { await sleep(250); holdText = await popup.textContent('#taskBox'); }
      // A3 問題回報
      const reportVisible = await popup.isVisible('#reportBox');
      const opts = await popup.$$eval('#reportField option', (o) => o.map((x) => x.value));
      const leak = await bg({ type: 'ibon-report', kind: 'parse', field: '張數', expected: '應該是 2 張，我的電話 0912345678', withSnapshot: false, own: [] });
      const rep = await bg({ type: 'ibon-report', kind: 'parse', field: '張數', expected: '應該是 2 張', withSnapshot: true, own: [] });
      const repRaw = JSON.stringify(rep.report || {});
      // 倒數停住：未知、不排保留提醒
      await page.goto(`${IBON_BUYER_URL}?cd=300&freeze=1`);
      const s4 = await waitTask(popup, (t) => !!(t.hold && t.hold.status === 'unknown'), 30000);
      const frozenAl = (await alarms()).filter((a) => a.name.startsWith('ith-hold|'));
      let frozenText = '';
      for (let i = 0; i < 8 && !/保留倒數：未知/.test(frozenText); i++) { await sleep(250); frozenText = await popup.textContent('#taskBox'); }
      await popup.click('#btnCancel');
      await waitTask(popup, (t) => t.phase === 'cancelled', 5000);
      const after = await alarms();
      const clicked = ibonRequests.filter((x) => /__clicked/.test(x));
      const nonGet = ibonRequests.filter((x) => !x.startsWith('GET '));
      return [
        ['沒讀過這個活動就不設提醒', noInfo.ok === false && /先按「讀取活動資訊」/.test(noInfo.error), noInfo.error],
        ['開賣提醒：節目介紹與場次小字各一個時間，開賣前 5 分鐘、1 分鐘（台灣時間）', /已設定 2 個開賣提醒/.test(saleMsg) && JSON.stringify(sa) === JSON.stringify(wantAlarms), `${saleMsg} ${JSON.stringify(sa)}`],
        ['場次小字的時間照實標「寫法還沒在真站看過」', /場次旁的「開賣」小字（這種寫法還沒在真站看過）/.test(saleListText) && /11\/20 12:00（台灣時間）/.test(saleListText), saleListText.slice(0, 120)],
        ['開賣提醒到點只通知一次', fired && fired.notified && fired.notified[300] === true && saleNotices === 1, `通知 ${saleNotices} 次`],
        ['保留倒數讀到後排好 2 分鐘、1 分鐘的提醒', s1.task.hold.status === 'ok' && holdAl.includes('ith-hold|60'), JSON.stringify(holdAl)],
        ['剩 2 分鐘時通知一次、不重複；1 分鐘那段還沒到', s2.task.hold.notified[120] === true && !s3.task.hold.notified[60] && holdNotices === 1, `通知 ${holdNotices} 次`],
        ['設定頁顯示保留倒數與已通知', /保留倒數：剩約 1:\d\d/.test(holdText) && /已通知：2 分鐘/.test(holdText), holdText.match(/保留倒數[^。]*/)?.[0] || holdText.slice(0, 80)],
        ['倒數停住：未知、不排提醒，設定頁說以頁面為準', /停住/.test(s4.task.hold.reason) && frozenAl.length === 0 && /保留倒數：未知.*以頁面上的時間為準/.test(frozenText), s4.task.hold.reason],
        ['回報表單跟著這一頁的欄位', reportVisible && opts.includes('張數') && opts.includes('建議'), opts.join(',')],
        ['回報說明裡有電話：不產生', leak.ok === false && /手機/.test(leak.error), leak.error],
        ['回報檔：有能重跑的內容與快照，沒有電話、Email、網址參數值', rep.ok && rep.report.replay.kind === 'buyer-info' && rep.report.replay.req.tickets[0].name === '全票' && rep.report.snapshot && rep.report.snapshot.tree && !/0911222333|demo-buyer@example\.com|cd=126/.test(repRaw) && /cd=…/.test(rep.report.page.url), rep.error || rep.report.page.url],
        ['取消任務清掉保留提醒，開賣提醒留著', !after.some((a) => a.name.startsWith('ith-hold|')) && after.filter((a) => a.name.startsWith('ith-sale|')).length === 4, after.map((a) => a.name).join(',')],
        ['沒有點任何按鈕、沒有送出任何東西', clicked.length === 0 && nonGet.length === 0, `點擊 ${clicked.length}、非 GET ${nonGet.length}`],
      ];
    },
  },
  {
    name: 'run-gating',
    once: true,
    title: '選購按鈕能不能按，跟背景程式接不接受一致；停用時在按鈕下方寫原因；檢查做完不會把停用的按鈕又打開',
    async run({ ctx, popup }) {
      const RUN = ['#btnSchedule', '#btnRunNow', '#btnCheck', '#btnHealth'];
      const offCount = async () => { let n = 0; for (const id of RUN) if (await popup.isDisabled(id)) n++; return n; };
      const note = () => popup.evaluate(() => { const n = document.getElementById('runNote'); return n.hidden ? '' : n.textContent; });
      // 直接問背景程式：這個網址的「立即執行」接不接受（不經過按鈕）
      const ask = (url) => popup.evaluate((u) => new Promise((r) => chrome.runtime.sendMessage(
        { type: 'run-now', cfg: { eventUrl: u, keywords: '11/20 06:00', tickets: '全票 1', profile: { name: '測試使用者', phone: '0912345678', email: 'tester@example.com', note: '' }, autoAgree: true } }, r)), url);
      const setUrl = async (url, runnable) => {
        await popup.fill('#eventUrl', url);
        await popup.waitForFunction(([want, u]) => document.getElementById('eventUrl').value.trim() === u
          && document.getElementById('btnRunNow').disabled === !want
          && (want ? document.getElementById('runNote').hidden : !document.getElementById('runNote').hidden), [runnable, url], { timeout: 5000 }).catch(() => {});
      };
      const out = {};
      for (const [k, url, runnable] of [['ibon', IBON_URL, false], ['other', 'https://example.com/tickets', false], ['empty', '', false], ['pool', `${BASE}/pool/`, true]]) {
        await setUrl(url, runnable);
        out[k] = { off: await offCount(), note: await note(), info: await popup.isVisible('#btnInfo') };
      }
      const ibRun = await ask(IBON_URL);
      const otherRun = await ask('https://example.com/tickets');

      // 檢查時段做到一半把網址換成 ibon：檢查做完，按鈕要維持停用（以前會被改回可按）
      await scenario(ctx, 'slow', 'delayMs=3000');
      await setUrl(`${BASE}/pool/`, true);
      await popup.click('#btnCheck');
      await setUrl(IBON_URL, false);
      await popup.waitForFunction(() => !/檢查中/.test(document.getElementById('checkMsg').textContent), null, { timeout: 30000 });
      const afterCheck = { off: await offCount(), note: await note(), msg: await popup.textContent('#checkMsg') };

      const ver = await popup.textContent('#ver');
      const manifestVer = await popup.evaluate(() => chrome.runtime.getManifest().version);
      const s = await status(popup);
      return [
        ['ibon 活動頁：四個選購按鈕停用，「讀取活動資訊」可用', out.ibon.off === 4 && out.ibon.info, `停用 ${out.ibon.off}、讀取活動資訊${out.ibon.info ? '有' : '沒有'}`],
        ['ibon 活動頁：按鈕下方寫原因，跟背景程式拒絕的理由一字不差', !!out.ibon.note && !ibRun.ok && out.ibon.note === ibRun.error, out.ibon.note],
        ['不支援的網址：停用，原因跟背景程式一致', out.other.off === 4 && !out.other.info && !otherRun.ok && out.other.note === otherRun.error, out.other.note],
        ['網址空白：停用並請你先貼網址', out.empty.off === 4 && /請先在上面貼網址/.test(out.empty.note), out.empty.note],
        ['模擬站網址：四個都能按，沒有停用說明', out.pool.off === 0 && out.pool.note === '' && !out.pool.info, `停用 ${out.pool.off}`],
        ['檢查途中換成 ibon：檢查做完按鈕仍停用', afterCheck.off === 4 && !!afterCheck.note, `停用 ${afterCheck.off}｜${afterCheck.msg}`],
        ['設定頁標題顯示目前載入的版本', ver === `v${manifestVer}`, `${ver}（manifest ${manifestVer}）`],
        ['沒有建立任務', s.task.phase === 'none', `任務 ${s.task.phase}`],
      ];
    },
  },
];

/* ───────────── 執行 ───────────── */

async function main() {
  const old = stale();
  if (old.length) {
    console.error(`${old.join('、')} 不是最新的，請先執行 node tools/build.mjs`);
    process.exit(2);
  }
  const sim = await startSim();
  const ibon = await startIbonFixture();
  const results = [];
  try {
    for (const mode of MODES) for (const sc of SCENARIOS) {
      if (ONLY && !ONLY.has(sc.name)) continue;
      if (sc.once && mode !== MODES[0]) continue;
      HARD = mode === 'hard';
      const label = `${sc.name}${HARD ? '［困難］' : ''}`;
      const t0 = Date.now();
      let checks = [];
      let error = null;
      let logs = [];
      let b = null;
      try {
        b = await launch();
        checks = await sc.run(b);
        const s = await status(b.popup).catch(() => null);
        logs = (s && s.logs) || [];
      } catch (e) {
        error = e;
      } finally {
        if (b) await b.ctx.close().catch(() => {});
      }
      const pass = !error && checks.length > 0 && checks.every((c) => c[1]);
      results.push({ sc, pass });
      console.log(`\n${pass ? 'PASS' : 'FAIL'}  ${label}：${sc.title}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
      for (const [label, ok, detail] of checks) console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? '　' + detail : ''}`);
      if (error) console.log('   ✗ 執行錯誤：' + (error.stack || error));
      if (!pass) for (const l of logs.slice(-15)) console.log(`     log ${new Date(l.at).toISOString().slice(11, 23)} [${l.level}] ${l.msg}`);
    }
  } finally {
    sim.kill();
    ibon.close();
    fs.rmSync(WORK, { recursive: true, force: true });
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} 個情境通過`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
