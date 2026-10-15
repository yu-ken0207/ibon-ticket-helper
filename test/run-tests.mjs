// 端對端測試：本機一般票券模擬站（ticket-sim 以 SIM_SITE=pool 啟動）＋ Playwright 的 Chromium 載入真的擴充功能。
// 每個情境除了看擴充功能的任務狀態，也用模擬站的統計核對：有沒有重複送出、有沒有替使用者按「確認建立訂單」。
//
// 用法：node test/run-tests.mjs [--only 情境[,情境…]] [--headed]
//   需要 ticket-sim（預設 ../ticket-sim，可用 SIM_DIR 指定）；playwright 預設從 ticket-sim/tools 載入，可用 PW_DIR 指定
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from '../tools/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..');
const SIM_DIR = path.resolve(process.env.SIM_DIR || path.join(EXT, '..', 'ticket-sim'));
const PW_DIR = (process.env.PW_DIR || path.join(SIM_DIR, 'tools')).replace(/\/?$/, '/');
const { chromium } = createRequire(PW_DIR)('playwright');
const argv = process.argv.slice(2);
const ONLY = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
const HEADED = argv.includes('--headed');
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

/* ───────────── 瀏覽器與設定頁 ───────────── */

async function launch() {
  const dir = fs.mkdtempSync(path.join(WORK, 'profile-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: !HEADED, viewport: { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
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
  const res = await ctx.request.get(`${BASE}/pool/scenarios/start?preset=${preset}${query ? '&' + query : ''}`, { maxRedirects: 0 });
  if (res.status() !== 303) throw new Error(`開始情境 ${preset} 失敗：${res.status()}`);
}

async function fillPopup(popup, o = {}) {
  await popup.evaluate(() => { document.querySelector('details').open = true; });
  await popup.fill('#eventUrl', o.url || `${BASE}/pool/`);
  await popup.fill('#keywords', (o.keywords || ['11/20 06:00']).join('\n'));
  await popup.fill('#tickets', (o.tickets || ['全票 2', '兒童票 1']).join('\n'));
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
const stopped = (t) => ['done', 'waiting-user', 'cancelled'].includes(t.phase);
const sitePage = (ctx) => ctx.pages().find((p) => p.url().startsWith(`${BASE}/pool/`)) || null;
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
      const outlined = page ? await page.evaluate(() => document.querySelector('[data-testid=confirm-order]').style.outline) : '';
      const checks = [
        ['已開始執行', /已開始執行/.test(msg), msg],
        ['停在確認頁等使用者', ready(s.task) && /自己按「確認建立訂單」/.test(s.task.result.msg), resultMsg(s)],
        ['選到偏好的時段', st.pool.hold && st.pool.hold.slotId === '20261120-0600', st.pool.hold && st.pool.hold.slotId],
        ['張數照設定：全票 2、兒童票 1', st.pool.hold && JSON.stringify(st.pool.hold.items) === JSON.stringify({ adult: 2, child: 1 }), st.pool.hold && JSON.stringify(st.pool.hold.items)],
        ['購票人資料照你提供的', st.pool.buyer && st.pool.buyer.name === PROFILE.name && st.pool.buyer.phone === '0912345678' && st.pool.buyer.email === PROFILE.email, JSON.stringify(st.pool.buyer)],
        ['網站停在確認步驟', st.pool.step === 'CONFIRM' && page && /\/pool\/confirm$/.test(page.url()), `${st.pool.step} ${page && page.url()}`],
        ['標出「確認建立訂單」按鈕', /3px/.test(outlined), outlined],
        ...noDuplicates(st),
      ];
      // 使用者自己按確認
      await page.click('[data-testid=confirm-order]');
      const s2 = await waitTask(popup, (t) => t.phase === 'done', 15000);
      const st2 = await siteState(ctx);
      checks.push(['使用者確認後記成成功', s2.task.result && s2.task.result.ok && s2.task.result.kind === 'ordered', resultMsg(s2)]);
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
      const typed = page ? await page.inputValue('[data-testid=captcha-input]') : '?';
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
        ['說明會選哪一個時段', /開賣時會選「11\/20（五） 06:00–08:00」（目前可購買，剩 80 張）/.test(check), check],
        ['列出供應狀態', /共 15 個時段：可購買 13、已額滿 2/.test(check), ''],
        ['列出票價', /票價：全票 NT\$110、優待票 NT\$80、兒童票 NT\$60/.test(check), ''],
        ['健檢全部正常', /全部正常/.test(health) && items.length >= 5 && items.every((c) => c === 'ok'), `${health}｜${items.join(',')}`],
        ['檢查不會建立任務', s.task.phase === 'none', `任務 ${s.task.phase}`],
        ['檢查用的分頁會關掉', !sitePage(ctx), ''],
      ];
    },
  },
];

/* ───────────── 執行 ───────────── */

async function main() {
  if (fs.readFileSync(path.join(EXT, 'agent.js'), 'utf8') !== build()) {
    console.error('agent.js 不是最新的，請先執行 node tools/build.mjs');
    process.exit(2);
  }
  const sim = await startSim();
  const results = [];
  try {
    for (const sc of SCENARIOS) {
      if (ONLY && !ONLY.has(sc.name)) continue;
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
      console.log(`\n${pass ? 'PASS' : 'FAIL'}  ${sc.name}：${sc.title}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
      for (const [label, ok, detail] of checks) console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? '　' + detail : ''}`);
      if (error) console.log('   ✗ 執行錯誤：' + (error.stack || error));
      if (!pass) for (const l of logs.slice(-15)) console.log(`     log ${new Date(l.at).toISOString().slice(11, 23)} [${l.level}] ${l.msg}`);
    }
  } finally {
    sim.kill();
    fs.rmSync(WORK, { recursive: true, force: true });
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} 個情境通過`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
