/*
 * background.js —— service worker
 *
 * 負責：
 *   1. 排程：開賣前 preOpenSec 秒把時段列表開在獨立視窗；真正的到點由頁面程式倒數，這裡另有到點保險。
 *   2. 任務狀態：同一時間只有一個任務，記住綁定的分頁、目前階段、重試次數、這次試過買不到的時段。
 *      頁面每次載入都是全新的頁面程式，它靠這裡的狀態知道該倒數、該做下一步，還是什麼都不做。
 *   3. 通知與紀錄：結果用系統通知告訴你，過程寫進 storage 給設定頁顯示。
 *
 * 任務階段（task.phase）：
 *   armed        已排程，等開賣（綁定的分頁在倒數）
 *   fired        開賣時間到，頁面已重新整理，正在選購
 *   running      「立即執行」或你按了「繼續」，正在選購
 *   waiting-user 已經停下來交給你：確認頁（等你自己確認）、排隊、驗證碼、機器人檢查、資料有問題
 *   done         結束（你確認後建立了訂單，或失敗）
 *   cancelled    已取消
 *
 * 網站（lib/sites.js）：選購只支援本機的一般票券模擬站。助手一定停在確認頁，不會替你建立訂單；
 * ibon 活動頁只能「讀取活動資訊」（ibon-info.js 讀、這裡存），排程、立即執行、檢查時段一律不接受 ibon 的網址。
 * 排隊、驗證碼、機器人檢查一律交給你，處理完你按「繼續」它才接著做。
 */
'use strict';

import { fmt, int } from './lib/format.js';
import { loadDelay, loadGaveUp, parseRetryAfter, rateLimitDelay, RATE_MAX_RETRIES } from './lib/backoff.js';
import { summarizeHealth } from './lib/health.js';
import { sanitizeBox, BLACKBOX_MAX } from './lib/box.js';
import { siteOf, targetUrlOf, siteKey, siteLabel, pageKindOf, infoSiteOf, infoUrlOf, INFO_SITES } from './lib/sites.js';
import { parseTicketLines, cleanProfile, checkProfile, describeProfileProblem } from './lib/flow.js';
import { sanitizeInfo } from './lib/eventinfo.js';

const ALARM_OPEN = 'ith-open';
const ALARM_WATCH = 'ith-watch';
const ALARM_FIRE = 'ith-fire';
const LOG_MAX = 300;

const DEFAULTS = {
  preOpenSec: 90,          // 開賣前幾秒開頁
  fireOffsetMs: 30,        // 到點後再等多久才重新整理，吸收網路來回不對稱的誤差
  notOpenRetryMs: 1000,    // 時間到了時段仍未開放時，多久重看一次
  notOpenMaxRetries: 30,   // 最多重看幾次
  failRetryMs: 300,        // 送出被伺服器錯誤擋下時，多久後再送（次數有上限）
  failMaxRetries: 3,
  syncClock: true,
};

const ACTIVE_PHASES = ['armed', 'fired', 'running', 'waiting-user'];
const SUCCESS_PHASES = ['fired', 'running', 'waiting-user'];

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

/* storage 是「讀出來、改完、寫回去」。好幾則訊息同時進來會互相蓋掉，所以全部排隊執行。
 * 注意：serial 裡面不要再 await 另一個 serial，否則會互等卡死。 */
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(() => fn());
  chain = p.catch(() => {});
  return p;
}

function addLog(msg, level = 'info') {
  const entry = { at: Date.now(), level, msg: String(msg).slice(0, 500) };
  return serial(async () => {
    const { logs = [] } = await get('logs');
    logs.push(entry);
    if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX);
    await set({ logs });
  });
}

/* ───────────────────────── 設定 ───────────────────────── */

function normalizeCfg(raw) {
  const r = raw || {};
  const keywords = (Array.isArray(r.keywords) ? r.keywords : String(r.keywords || '').split(/\r?\n/))
    .map((s) => String(s).replace(/　/g, ' ').trim())
    .filter(Boolean);
  const cfg = {
    eventUrl: String(r.eventUrl || '').trim(),
    keywords,
    tickets: parseTicketLines(r.tickets),
    profile: cleanProfile(r.profile),
    autoAgree: r.autoAgree !== false,
    fallback: r.fallback === true,
    preOpenSec: int(r.preOpenSec, DEFAULTS.preOpenSec, 5, 600),
    fireOffsetMs: int(r.fireOffsetMs, DEFAULTS.fireOffsetMs, 0, 2000),
    notOpenRetryMs: int(r.notOpenRetryMs, DEFAULTS.notOpenRetryMs, 700, 60000),
    notOpenMaxRetries: int(r.notOpenMaxRetries, DEFAULTS.notOpenMaxRetries, 0, 120),
    failRetryMs: int(r.failRetryMs, DEFAULTS.failRetryMs, 200, 60000),
    failMaxRetries: int(r.failMaxRetries, DEFAULTS.failMaxRetries, 0, 10),
    syncClock: r.syncClock !== false,
  };
  cfg.site = siteOf(cfg.eventUrl);
  cfg.regUrl = targetUrlOf(cfg.eventUrl);
  return cfg;
}

const URL_HINT = '網址看不懂。目前只支援本機的一般票券模擬站，請貼 http://127.0.0.1:3300/pool/';
const INFO_ONLY_HINT = 'ibon 活動頁目前只能「讀取活動資訊」：排程、立即執行、檢查時段、健檢只支援本機的一般票券模擬站；在真實網站自動選票、送出還在確認網站規則與法律適用，所以停用';
const urlHint = (url) => (infoSiteOf(url) ? INFO_ONLY_HINT : URL_HINT);
/** 選購（排程、立即執行、繼續、檢查時段、健檢）接不接受這個網址：validate() 和設定頁的按鈕都用這一個判斷 */
const runCheck = (url) => (targetUrlOf(url) ? { runnable: true, runNote: '' } : { runnable: false, runNote: urlHint(url) });

/** 開始前把設定檢查完整，不把不完整的資料送到網站 */
function validate(cfg) {
  if (!cfg.regUrl) return urlHint(cfg.eventUrl);
  if (!cfg.keywords.length && !cfg.fallback) return '請至少填一組時段關鍵字（或打開「關鍵字都對不到時改選第一個能買的」）';
  if (!cfg.tickets.length) return '請填要買的票種與張數，一行一筆，例如「全票 2」';
  const bad = cfg.tickets.find((t) => !Number.isInteger(t.qty));
  if (bad) return `「${bad.name}」的張數看不懂，請寫成「${bad.name} 2」這樣`;
  if (!cfg.tickets.some((t) => t.qty > 0)) return '每個票種都是 0 張，請至少設定 1 張';
  const chk = checkProfile(cfg.profile);
  if (!chk.ok) return `購票人資料：${describeProfileProblem(chk)}`;
  return null;
}

/* ───────────────────────── 通知與徽章 ───────────────────────── */

function notify(title, message, sticky = false) {
  try {
    chrome.notifications.create('ith-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), {
      type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 2, requireInteraction: sticky,
    }, () => void chrome.runtime.lastError);
  } catch (_) { /* 通知失敗不影響流程 */ }
}

async function badge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) { /* 忽略 */ }
}

function sendCmd(tabId, msg) {
  if (!tabId) return;
  try { chrome.tabs.sendMessage(tabId, msg).catch(() => {}); } catch (_) { /* 分頁可能已關閉 */ }
}

/* ───────────────────────── 任務 ───────────────────────── */

async function getTask() {
  const { task = null } = await get('task');
  return task;
}

function newTask(cfg, mode, extra) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    mode, cfg, regUrl: cfg.regUrl, site: cfg.site, slug: siteKey(cfg.site, cfg.regUrl), skip: [],
    targetTs: null, openAt: null, tabId: null, windowId: null,
    phase: mode === 'scheduled' ? 'armed' : 'running',
    notOpen: 0, fail: 0, loadFail: 0, loadStreak: 0, loadFailSince: null, rateRetries: 0, createdAt: Date.now(), startedAt: null, firedAt: null, fireDrift: null,
    result: null, warned: {},
    ...extra,
  };
}

async function retireOld() {
  const old = await getTask();
  if (old && ACTIVE_PHASES.includes(old.phase) && old.tabId) sendCmd(old.tabId, { cmd: 'abort', reason: '已被新的任務取代' });
}

async function schedule(raw) {
  const cfg = normalizeCfg(raw);
  const err = validate(cfg);
  if (err) return { ok: false, error: err };
  const targetTs = Number(raw && raw.targetTs);
  if (!Number.isFinite(targetTs)) return { ok: false, error: '請設定開賣時間' };
  if (targetTs < Date.now() + 3000) return { ok: false, error: '開賣時間已經過了，或剩不到 3 秒。要馬上跑請按「立即執行」' };

  await retireOld();
  const openAt = targetTs - cfg.preOpenSec * 1000;
  const task = newTask(cfg, 'scheduled', { targetTs, openAt });
  await serial(() => set({ task }));
  await chrome.alarms.clearAll();
  await badge('⏱', '#0f766e');
  addLog(`已排程：${fmt(targetTs)} 開賣，${fmt(openAt)} 開啟時段列表`);
  if (openAt <= Date.now()) await openTarget();
  else {
    await chrome.alarms.create(ALARM_OPEN, { when: openAt });
    await chrome.alarms.create(ALARM_WATCH, { periodInMinutes: 1 });
  }
  await scheduleFireWatch(targetTs);
  return { ok: true, task: await getTask() };
}

async function openTarget() {
  const task = await getTask();
  if (!task || task.mode !== 'scheduled' || task.phase !== 'armed') return;
  if (task.tabId) {
    // 已經有綁定的分頁（例如你先自己打開了時段列表），拉到前景就好，不要重開
    try {
      const tab = await chrome.tabs.get(task.tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
      return;
    } catch (_) { /* 分頁不見了，往下重開 */ }
  }
  // 開獨立視窗：Chrome 會把看不見的分頁計時器節流，獨立視窗裡的作用中分頁不會被節流
  const win = await chrome.windows.create({ url: task.regUrl, focused: true, type: 'normal' });
  const tabId = win && win.tabs && win.tabs[0] ? win.tabs[0].id : null;
  await serial(async () => {
    const t = await getTask();
    if (t && t.id === task.id) await set({ task: { ...t, tabId, windowId: win.id, openedAt: Date.now() } });
  });
  addLog('已在新視窗開啟時段列表，開始倒數');
}

async function runNow(raw, tabIdHint) {
  const cfg = normalizeCfg(raw);
  const err = validate(cfg);
  if (err) return { ok: false, error: err };

  let tab = null;
  if (tabIdHint) tab = await chrome.tabs.get(tabIdHint).catch(() => null);
  if (!tab) {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = t || null;
  }
  const sameSiteTab = tab && tab.url && siteKey(cfg.site, tab.url) === siteKey(cfg.site, cfg.regUrl);
  // 已經在這個站的某一步：從那一步接著做
  const midFlow = sameSiteTab && ['list', 'select', 'info', 'confirm'].includes(pageKindOf(cfg.site, tab.url));

  await retireOld();
  await chrome.alarms.clearAll();
  let tabId = tab ? tab.id : null;
  if (!sameSiteTab) {
    // 目前分頁不是這個站：開新分頁，不要把你正在看的網頁導走
    const created = await chrome.tabs.create({ url: cfg.regUrl, active: true });
    tabId = created.id;
  }
  const task = newTask(cfg, 'now', { tabId, startedAt: Date.now() });
  await serial(() => set({ task }));
  await badge('▶', '#0f766e');
  addLog('立即執行');

  if (midFlow) sendCmd(tabId, { cmd: 'run', cfg, since: task.startedAt, skip: [] });
  else if (sameSiteTab) await chrome.tabs.update(tabId, { url: cfg.regUrl });
  return { ok: true, task: await getTask() };
}

async function cancel(reason = '已取消任務') {
  await chrome.alarms.clearAll();
  const t = await serial(async () => {
    const task = await getTask();
    if (!task || !ACTIVE_PHASES.includes(task.phase)) return null;
    const next = { ...task, phase: 'cancelled', result: { ok: false, kind: 'cancelled', msg: reason, at: Date.now() } };
    await set({ task: next });
    return next;
  });
  if (t && t.tabId) sendCmd(t.tabId, { cmd: 'abort', reason });
  await badge('');
  addLog(reason);
  return { ok: true };
}

/**
 * 「繼續」：停下來交給你之後（排隊、驗證碼、資料不完整…），你處理好了，讓頁面程式從目前這一頁接著做。
 * 可以順便換成設定頁裡最新的設定（例如補上購票人資料），但必須是同一個站。
 */
async function resume(raw) {
  let cfg = null;
  if (raw) {
    cfg = normalizeCfg(raw);
    const err = validate(cfg);
    if (err) return { ok: false, error: err };
  }
  const t = await serial(async () => {
    const task = await getTask();
    if (!task || task.phase !== 'waiting-user' || !task.tabId) return null;
    if (cfg && siteKey(cfg.site, cfg.regUrl) !== task.slug) return { error: '設定頁裡的網址跟目前的任務不是同一個站，請按「立即執行」重新開始' };
    const next = { ...task, cfg: cfg || task.cfg, phase: 'running', result: null };
    await set({ task: next });
    return next;
  });
  if (!t) return { ok: false, error: '目前沒有停下來等你、可以繼續的任務' };
  if (t.error) return { ok: false, error: t.error };
  try {
    const tab = await chrome.tabs.get(t.tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  } catch (_) { /* 分頁可能已關閉 */ }
  sendCmd(t.tabId, { cmd: 'run', cfg: t.cfg, since: t.startedAt || t.firedAt || Date.now(), skip: t.skip || [] });
  await badge('▶', '#0f766e');
  addLog('你按了「繼續」，助手從目前這一頁接著做');
  return { ok: true, task: t };
}

/* ───────────────────────── 檢查時段、健檢 ─────────────────────────
 * 在背景分頁讀頁面，讀完自動關掉，不選購。 */

// 背景分頁編號 → { kind, cfg, resolve, timer }。只放記憶體：檢查只要幾秒，service worker 不會在這期間被收掉
const pendingChecks = new Map();

async function openCheck(kind, raw) {
  const cfg = normalizeCfg(raw);
  if (!cfg.regUrl) return { ok: false, error: urlHint(cfg.eventUrl) };
  const tab = await chrome.tabs.create({ url: cfg.regUrl, active: false });
  addLog(kind === 'health' ? '健檢：在背景分頁檢查時段列表頁' : '檢查時段：在背景分頁讀取時段與票價');
  return new Promise((resolve) => {
    const timer = setTimeout(() => finishCheck(tab.id, { ok: false, error: '40 秒內沒有讀到時段列表，請自己打開看看' }), 40000);
    pendingChecks.set(tab.id, { kind, cfg, resolve, timer });
  });
}

function finishCheck(tabId, result) {
  const pending = pendingChecks.get(tabId);
  if (!pending) return false;
  pendingChecks.delete(tabId);
  clearTimeout(pending.timer);
  chrome.tabs.remove(tabId).catch(() => {});
  const out = { ...result, at: Date.now() };
  addLog(`${pending.kind === 'health' ? '健檢' : '檢查時段'}：${out.msg || out.error || ''}`, out.ok ? 'ok' : 'warn');
  pending.resolve(out);
  return true;
}

/* ───────────────────────── 讀取活動資訊（A 類，只讀） ─────────────────────────
 * 你自己已經開著同一個活動頁，就直接在那個分頁讀；沒有的話在背景開一個分頁讀，讀完自動關掉。
 * 讀的是頁面上看得到的資訊（ibon-info.js），不點按鈕、不送出、不進購票流程。結果存在 storage 的 eventInfo 給設定頁顯示。 */

// 背景分頁編號 → { url, resolve, timer }
const pendingInfo = new Map();

async function readInfo(rawUrl) {
  const url = infoUrlOf(rawUrl);
  if (!url) return { ok: false, error: '這不是能讀取的活動頁。目前只支援 ibon 的活動頁：https://ticket.ibon.com.tw/ActivityInfo/Details/數字' };
  const open = (await chrome.tabs.query({})).find((t) => t.url && infoUrlOf(t.url) === url && !pendingInfo.has(t.id));
  if (open) {
    const r = await chrome.tabs.sendMessage(open.id, { type: 'info-read' }).catch(() => null);
    if (r && r.ok) return saveInfo(url, r.info, '你開著的分頁');
  }
  const tab = await chrome.tabs.create({ url, active: false });
  addLog('讀取活動資訊：在背景分頁讀活動頁（只讀，不點任何按鈕），讀完自動關掉');
  return new Promise((resolve) => {
    const timer = setTimeout(() => finishInfo(tab.id, { ok: false, error: '40 秒內沒有讀到活動頁，請自己打開看看' }), 40000);
    pendingInfo.set(tab.id, { url, resolve, timer });
  });
}

async function saveInfo(url, info, from) {
  const clean = { ...sanitizeInfo(info), url, site: infoSiteOf(url) };
  await set({ eventInfo: clean });
  const n = (clean.sessions || []).length;
  addLog(`讀取活動資訊（${from}）：「${clean.title || '沒有標題'}」，場次 ${n} 個、票價 ${(clean.prices || []).length} 筆、開賣時間 ${(clean.saleTimes || []).length} 筆`, n ? 'ok' : 'warn');
  return { ok: true, info: clean };
}

function finishInfo(tabId, result) {
  const pending = pendingInfo.get(tabId);
  if (!pending) return false;
  pendingInfo.delete(tabId);
  clearTimeout(pending.timer);
  chrome.tabs.remove(tabId).catch(() => {});
  if (result && result.ok && result.info) saveInfo(pending.url, result.info, '背景分頁').then(pending.resolve, () => pending.resolve({ ok: false, error: '存不了讀到的資訊' }));
  else {
    addLog(`讀取活動資訊：${(result && result.error) || '沒有讀到'}`, 'warn');
    pending.resolve({ ok: false, error: (result && result.error) || '沒有讀到活動資訊' });
  }
  return true;
}

/* ───────────────────────── 頁面報到 ───────────────────────── */

/**
 * 頁面載入時問：這個分頁現在該做什麼？
 *   時段列表倒數、各步驟照流程跑一步；完成頁＝你自己按了確認，記成成功；
 *   已經交給你（waiting-user）時不再動作，只在確認頁繼續提醒保留時間。
 */
function onHello(tabId, page) {
  const check = pendingChecks.get(tabId);
  if (check) return Promise.resolve({ mode: check.kind, cfg: check.cfg });
  return serial(async () => {
    const task = await getTask();
    if (!task || !ACTIVE_PHASES.includes(task.phase)) return { mode: 'idle' };
    const kind = page && page.kind;
    const sameSite = siteKey(task.site, page && page.url) === task.slug;
    let t = task;
    if (task.tabId !== tabId) {
      // 排程後、開頁前，你自己先開好同一個站的時段列表：直接綁定這個分頁
      if (!task.tabId && task.phase === 'armed' && sameSite && kind === 'list') {
        t = { ...task, tabId };
        await set({ task: t });
      } else {
        return { mode: 'idle' };
      }
    }
    if (!sameSite) return { mode: 'idle' };
    if (kind === 'done') {
      if (!SUCCESS_PHASES.includes(t.phase)) return { mode: 'idle' };
      const since = t.firedAt || t.startedAt;
      const result = { ok: true, kind: 'ordered', msg: '訂單已建立（由你確認）', url: page.url, at: Date.now(), elapsedMs: since ? Date.now() - since : null };
      await set({ task: { ...t, phase: 'done', result } });
      return { mode: 'success', since, finalize: true };
    }
    if (t.phase === 'waiting-user') {
      return kind === 'confirm' && t.result && t.result.kind === 'ready' ? { mode: 'confirm-wait', cfg: t.cfg } : { mode: 'idle' };
    }
    if (t.mode === 'scheduled' && t.phase === 'armed') {
      if (kind === 'list') return { mode: 'countdown', targetTs: t.targetTs, cfg: t.cfg };
      // 開賣前就被帶到排隊頁：一樣停下來交給你（頁面程式會回報），不在背景等它排完再自己接著做
      if (kind === 'queue') return { mode: 'run', cfg: t.cfg, since: Date.now(), skip: t.skip || [] };
      return { mode: 'idle' };
    }
    if (t.phase === 'fired' || t.phase === 'running') {
      return { mode: 'run', cfg: t.cfg, since: t.firedAt || t.startedAt, skip: t.skip || [], loadFail: t.loadStreak || 0 };
    }
    return { mode: 'idle' };
  });
}

function onFired(tabId, p) {
  return serial(async () => {
    const t = await getTask();
    if (!t || t.tabId !== tabId || t.phase !== 'armed') return { ok: false };
    await set({ task: { ...t, phase: 'fired', firedAt: p && p.at ? p.at : Date.now(), fireDrift: p ? p.drift : null } });
    return { ok: true };
  });
}

/*
 * 網站回「請求太多」（429）時記下 Retry-After。頁面程式讀不到回應標頭，背景程式用 webRequest 看得到；
 * 只看、不改也不擋任何請求，範圍只有 manifest 的 host_permissions（本機模擬站）。
 */
const RATE_SEEN_MS = 15000;
const rateSeen = new Map();   // tabId → { at, url, retryAfterMs }
if (chrome.webRequest && chrome.webRequest.onCompleted) {
  chrome.webRequest.onCompleted.addListener((d) => {
    if (d.statusCode !== 429 || d.tabId < 0) return;
    const h = (d.responseHeaders || []).find((x) => x.name.toLowerCase() === 'retry-after');
    rateSeen.set(d.tabId, { at: Date.now(), url: d.url, retryAfterMs: h ? parseRetryAfter(h.value) : null });
  }, { urls: ['http://127.0.0.1/pool/*', 'http://localhost/pool/*'], types: ['main_frame', 'xmlhttprequest'] }, ['responseHeaders']);
}

/** 這個分頁在 since 之後有沒有被回 429，而且是最近 RATE_SEEN_MS 內的事 */
function freshRate(tabId, since = 0) {
  const s = rateSeen.get(tabId);
  return s && s.at >= since && Date.now() - s.at <= RATE_SEEN_MS ? s : null;
}

/** 請求太多後要不要再讀一次、等多久：照 Retry-After，沒給就逐步拉長；有次數上限，網站要等太久就交給你 */
async function rateRetryGrant(t, tabId) {
  const fresh = () => freshRate(tabId);
  let seen = fresh();
  if (!seen) { await new Promise((r) => setTimeout(r, 300)); seen = fresh(); }   // 頁面可能比 webRequest 早一步看到錯誤
  const attempt = t.rateRetries || 0;
  const d = rateLimitDelay(attempt, seen ? seen.retryAfterMs : null);
  if (!d.allow) return { allow: false, reason: d.reason, count: attempt, max: RATE_MAX_RETRIES, retryAfterMs: d.retryAfterMs ?? null };
  rateSeen.delete(tabId);
  await set({ task: { ...t, rateRetries: attempt + 1 } });
  return { allow: true, count: attempt + 1, max: RATE_MAX_RETRIES, delayMs: d.delayMs, source: d.source };
}

/* 讀取失敗後的重試：連續失敗才逐步拉長間隔，最長 3 秒一次；連續失敗超過 5 分鐘就交給你。 */

/** 給不給重試、等多久。只能在 serial 裡呼叫（裡面直接寫 storage） */
async function loadRetryGrant(t, status) {
  const since = t.loadFailSince || Date.now();
  const streak = t.loadStreak || 0;
  if (loadGaveUp(since, Date.now())) return { allow: false, count: t.loadFail || 0 };
  const delayMs = loadDelay(streak, status);
  const count = (t.loadFail || 0) + 1;
  await set({ task: { ...t, loadFail: count, loadStreak: streak + 1, loadFailSince: since } });
  return { allow: true, count, delayMs };
}

/** 頁面想再試一次：load 讀取失敗、not-open 還沒開放、其他是送出失敗。這裡決定還有沒有額度 */
function onRetry(tabId, p) {
  return serial(async () => {
    const t = await getTask();
    if (!t || t.tabId !== tabId || !['fired', 'running'].includes(t.phase)) return { allow: false };
    if (p && p.reason === 'load') return loadRetryGrant(t, Number(p.status) || 0);
    if (p && p.reason === 'rate') return rateRetryGrant(t, tabId);
    const notOpen = p && p.reason === 'not-open';
    const used = notOpen ? t.notOpen : t.fail;
    const max = notOpen ? t.cfg.notOpenMaxRetries : t.cfg.failMaxRetries;
    if (used >= max) return { allow: false, count: used, max };
    const next = notOpen ? { ...t, notOpen: used + 1 } : { ...t, fail: used + 1 };
    await set({ task: next });
    return { allow: true, count: used + 1, max, delayMs: notOpen ? t.cfg.notOpenRetryMs : t.cfg.failRetryMs };
  });
}

async function onResult(tabId, r) {
  const t = await serial(async () => {
    const task = await getTask();
    if (!task || task.tabId !== tabId || !ACTIVE_PHASES.includes(task.phase)) return null;
    const since = task.firedAt || task.startedAt;
    const result = { ok: !!r.ok, kind: r.kind || '', msg: r.msg || '', url: r.url || '', at: Date.now(), elapsedMs: since ? Date.now() - since : null };
    const phase = r.handOff ? 'waiting-user' : 'done';
    const next = { ...task, phase, result };
    await set({ task: next });
    return next;
  });
  if (!t) return { ok: false };
  const r2 = t.result;
  const label = siteLabel(t.site);
  if (r2.ok) {
    notify(`${label}：已保留名額`, r2.msg, true);
    await badge(t.phase === 'waiting-user' ? '!' : '✓', t.phase === 'waiting-user' ? '#d97706' : '#0f766e');
  } else if (t.phase === 'waiting-user') {
    notify(`${label}：需要你接手`, r2.msg, true);
    await badge('!', '#d97706');
  } else {
    notify(`${label}：沒有完成`, r2.msg, true);
    await badge('✕', '#b91c1c');
  }
  addLog(`${r2.ok ? '成功' : '停止'}：${r2.msg}`, r2.ok ? 'ok' : 'err');
  return { ok: true };
}

async function onWarn(tabId, p) {
  const kind = (p && p.kind) || 'warn';
  const first = await serial(async () => {
    const t = await getTask();
    if (!t || t.tabId !== tabId) return false;
    if (t.warned && t.warned[kind]) return false;
    await set({ task: { ...t, warned: { ...(t.warned || {}), [kind]: Date.now() } } });
    return siteLabel(t.site);
  });
  if (first) notify(`${first}：請注意`, p.msg || kind, true);
  addLog(p.msg || kind, 'warn');
  return { ok: true };
}

/* ───────────────────────── 到點保險 ─────────────────────────
 * 到點重新整理平常由頁面程式負責，最準。但頁面在背景時，Chrome 會把它的計時器拖到整秒才跑，
 * 可能晚將近一秒。背景程式不受影響，所以開賣前 25 秒叫醒自己，開賣後 0.1 秒看頁面有沒有重新整理，
 * 沒有就由這裡重新整理。service worker 閒置 30 秒才會被收掉，25 秒內一定撐得到。 */
const FIRE_WATCH_LEAD_MS = 25000;
const FIRE_BACKUP_MS = 100;
let fireWatch = null;   // { taskId, fireAtLocal, reloadedAt, timer }

async function scheduleFireWatch(targetTs) {
  const when = targetTs - FIRE_WATCH_LEAD_MS;
  if (when - Date.now() > 35000) await chrome.alarms.create(ALARM_FIRE, { when });
  else await armFireWatch();   // 離開賣很近了：鬧鐘可能被延後，直接在這裡等
}

async function armFireWatch() {
  const t = await getTask();
  if (!t || t.mode !== 'scheduled' || !['armed', 'fired'].includes(t.phase)) return;
  const offset = t.clock && t.clock.reliable ? Number(t.clock.offset) || 0 : 0;   // 伺服器 - 本機
  const fireOffset = t.cfg && t.cfg.fireOffsetMs != null ? t.cfg.fireOffsetMs : DEFAULTS.fireOffsetMs;
  const fireAtLocal = t.targetTs + fireOffset - offset;
  const due = fireAtLocal + FIRE_BACKUP_MS - Date.now();
  if (due < -3000) return;   // 開賣早就過了
  const keep = fireWatch && fireWatch.taskId === t.id ? fireWatch.reloadedAt : 0;
  if (fireWatch && fireWatch.timer) clearTimeout(fireWatch.timer);
  fireWatch = { taskId: t.id, fireAtLocal, reloadedAt: keep, timer: null };
  fireWatch.timer = setTimeout(() => { backupFire(t.id).catch(() => {}); }, Math.max(0, due));
}

/** 開賣後 0.1 秒：頁面還沒重新整理，就由背景程式重新整理 */
async function backupFire(taskId) {
  const w = fireWatch;
  if (!w || w.taskId !== taskId) return;
  w.timer = null;
  if (w.reloadedAt) return;
  const t = await getTask();
  if (!t || t.id !== taskId || !['armed', 'fired'].includes(t.phase) || !t.tabId) return;
  const tab = await chrome.tabs.get(t.tabId).catch(() => null);
  if (!tab || w.reloadedAt) return;   // 等的這幾毫秒裡頁面自己動了
  if (siteKey(t.site, tab.url || '') !== t.slug) return;
  w.reloadedAt = Date.now();
  const late = Date.now() - w.fireAtLocal;
  await serial(async () => {
    const x = await getTask();
    if (x && x.id === taskId && x.phase === 'armed') await set({ task: { ...x, phase: 'fired', firedAt: Date.now(), fireDrift: null } });
  });
  await chrome.tabs.reload(t.tabId);
  addLog(`開賣了，頁面的計時器被 Chrome 拖慢還沒動作，改由背景程式重新整理（到點後 ${late} ms）`, 'warn');
}

/** 頁面自己重新整理了：記下來，背景程式就不用補 */
function noteFired(tabId) {
  const w = fireWatch;
  if (!w || w.reloadedAt || Date.now() < w.fireAtLocal - 1500) return;
  getTask().then((t) => { if (t && t.id === w.taskId && t.tabId === tabId && !w.reloadedAt) w.reloadedAt = Date.now(); }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') noteFired(tabId);
});

/* ───────────────────────── 訊息入口 ───────────────────────── */

const POPUP_TYPES = new Set(['schedule', 'run-now', 'resume', 'cancel', 'status', 'clear-logs', 'preview-url', 'check-slots', 'health-check', 'read-info']);
// 只讀活動資訊的頁面（ibon 活動頁）只能送這兩種
const INFO_PAGE_TYPES = new Set(['info-hello', 'info-result']);
const PAGE_TYPES = new Set(['hello', 'fired', 'fired-drift', 'retry', 'result', 'log', 'warn', 'abort-request', 'check-result', 'load-ok', 'clock', 'health-result', 'blackbox', 'skip-slot', 'rate-seen']);

async function handle(msg, sender) {
  const type = msg && msg.type;
  // 用來源網址分辨：設定頁就算被開在分頁裡也有 sender.tab，不能拿 tab 有沒有來判斷
  const extOrigin = `chrome-extension://${chrome.runtime.id}/`;
  const isExtensionPage = !!(sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(extOrigin));
  const fromTab = !isExtensionPage && !!(sender && sender.tab);

  if (fromTab && infoSiteOf(sender.url || sender.tab.url)) {
    // ibon 活動頁：只收讀取活動資訊的訊息，碰不到任何選購任務
    if (!INFO_PAGE_TYPES.has(type)) return { ok: false, error: 'not allowed' };
    const tabId = sender.tab.id;
    if (type === 'info-hello') return { read: pendingInfo.has(tabId) };
    return { ok: finishInfo(tabId, msg.payload || {}) };
  }

  if (fromTab) {
    // 只接受頁面該送的訊息
    if (!PAGE_TYPES.has(type)) return { ok: false, error: 'not allowed' };
    const tabId = sender.tab.id;
    const p = msg.payload || {};
    switch (type) {
      case 'hello': {
        const r = await onHello(tabId, { kind: p.kind, url: p.url || sender.tab.url });
        if (r && r.finalize) {
          const t = await getTask();
          notify(`${siteLabel(t && t.site)}：訂單已建立`, '這一步是你自己確認的；助手只負責前面的選時段、張數與填資料。', true);
          await badge('✓', '#0f766e');
          addLog('成功：訂單已建立（由你確認）', 'ok');
        }
        return r;
      }
      case 'fired': {
        const r = await onFired(tabId, p);
        if (r.ok && p.drift != null) addLog(`開賣時間到，重新整理（比預定晚 ${Math.round(p.drift)} ms）`);
        return r;
      }
      case 'fired-drift': {
        noteFired(tabId);
        await serial(async () => {
          const t = await getTask();
          if (t && t.tabId === tabId) await set({ task: { ...t, fireDrift: p.drift } });
        });
        addLog(`開賣時間到，重新整理（比預定晚 ${Math.round(p.drift || 0)} ms）`);
        return { ok: true };
      }
      case 'retry': return onRetry(tabId, p);
      case 'skip-slot': {
        // 這個時段買不到（剛好售完、剩的不夠），這次任務不再選它
        const id = String(p.slotId || '').slice(0, 80);
        if (!id) return { ok: false };
        const ok = await serial(async () => {
          const t = await getTask();
          if (!t || t.tabId !== tabId) return false;
          await set({ task: { ...t, skip: [...new Set([...(t.skip || []), id])] } });
          return true;
        });
        return { ok };
      }
      case 'clock': {
        // 頁面對時的結果：到點保險要用同一個時間基準
        const offset = Number(p.offset);
        if (!Number.isFinite(offset) || p.reliable !== true) return { ok: false };
        const armedNow = await serial(async () => {
          const t = await getTask();
          if (!t || t.tabId !== tabId) return false;
          await set({ task: { ...t, clock: { offset, reliable: true, at: Date.now() } } });
          return !!(fireWatch && fireWatch.taskId === t.id);
        });
        if (armedNow) await armFireWatch();
        return { ok: true };
      }
      case 'load-ok': {
        // 讀取成功：連續失敗的計算重來
        await serial(async () => {
          const t = await getTask();
          if (t && t.tabId === tabId && (t.loadStreak || t.loadFailSince || t.rateRetries)) await set({ task: { ...t, loadStreak: 0, loadFailSince: null, rateRetries: 0 } });
        });
        return { ok: true };
      }
      case 'rate-seen': {
        // 頁面看到錯誤時問：剛剛的回應是不是 429？網站的錯誤訊息不一定寫狀態碼，回應標頭才準。
        // 頁面可能比 webRequest 早一步看到錯誤，第一次沒看到就再等一下
        const since = Number(p.since) || 0;
        let seen = freshRate(tabId, since);
        if (!seen) { await new Promise((r) => setTimeout(r, 300)); seen = freshRate(tabId, since); }
        return { seen: !!seen };
      }
      case 'check-result': return { ok: finishCheck(tabId, p) };
      case 'health-result': {
        if (!pendingChecks.has(tabId)) return { ok: false };
        return { ok: finishCheck(tabId, { ok: !!p.ok, worst: p.worst || null, items: Array.isArray(p.items) ? p.items : [], msg: summarizeHealth(p) }) };
      }
      case 'blackbox': {
        const t = await getTask();
        if (!(t && t.tabId === tabId) && !pendingChecks.has(tabId)) return { ok: false };
        const entry = sanitizeBox(p);
        if (!entry) return { ok: false };
        await serial(async () => {
          const { blackbox = [] } = await get('blackbox');
          blackbox.push(entry);
          if (blackbox.length > BLACKBOX_MAX) blackbox.splice(0, blackbox.length - BLACKBOX_MAX);
          await set({ blackbox });
        });
        addLog(`黑盒子：記下「${entry.kind}」當下的頁面狀態，可以按紀錄旁的「匯出」帶走`);
        return { ok: true };
      }
      case 'result': return onResult(tabId, p);
      case 'warn': return onWarn(tabId, p);
      case 'log': {
        const t = await getTask();
        if (t && t.tabId === tabId) addLog(p.msg, p.level);
        return { ok: true };
      }
      case 'abort-request': {
        const t = await getTask();
        if (t && t.tabId === tabId) return cancel('你在頁面上按了取消');
        return { ok: false };
      }
      default: return { ok: false };
    }
  }

  if (!isExtensionPage || !POPUP_TYPES.has(type)) return { ok: false, error: 'not allowed' };
  switch (type) {
    case 'schedule': return schedule(msg.cfg);
    case 'run-now': return runNow(msg.cfg, msg.tabId);
    case 'resume': return resume(msg.cfg);
    case 'check-slots': return openCheck('check', msg.cfg);
    case 'health-check': return openCheck('health', msg.cfg);
    case 'read-info': return readInfo(msg.url);
    case 'cancel': return cancel();
    case 'clear-logs': await serial(() => set({ logs: [], blackbox: [] })); return { ok: true };
    case 'preview-url': {
      const site = siteOf(msg.url);
      const info = infoSiteOf(msg.url);
      // runnable／runNote：設定頁照這個決定選購按鈕能不能按、旁邊寫什麼原因（跟 validate() 同一個判斷，不會一邊能按一邊拒絕）
      return { ok: true, regUrl: targetUrlOf(msg.url), site, label: site ? siteLabel(site) : null, info, infoUrl: infoUrlOf(msg.url), infoLabel: info ? INFO_SITES[info].label : null, ...runCheck(msg.url) };
    }
    case 'status': {
      const { task = null, logs = [] } = await get(['task', 'logs']);
      return { ok: true, task, logs: logs.slice(-80), now: Date.now() };
    }
    default: return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;   // 非同步回覆
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_FIRE) { await armFireWatch(); return; }
  if (alarm.name !== ALARM_OPEN && alarm.name !== ALARM_WATCH) return;
  const task = await getTask();
  if (!task || task.phase !== 'armed') {
    await chrome.alarms.clear(ALARM_WATCH);
    return;
  }
  if (Date.now() >= task.openAt - 2000 && !task.tabId) await openTarget();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (pendingChecks.has(tabId)) { finishCheck(tabId, { ok: false, error: '檢查用的分頁被關掉了' }); return; }
  if (pendingInfo.has(tabId)) { finishInfo(tabId, { ok: false, error: '讀取用的分頁被關掉了' }); return; }
  const task = await getTask();
  if (task && task.tabId === tabId && ACTIVE_PHASES.includes(task.phase)) {
    await cancel('網站的分頁被關掉了，任務已取消');
  }
});

// 瀏覽器重開或擴充功能重新載入後 alarm 可能不在了：還沒到的排程重新掛上
async function restoreAlarms(reason) {
  const task = await getTask();
  if (!task || task.mode !== 'scheduled' || task.phase !== 'armed') return;
  if (task.targetTs <= Date.now()) {
    await cancel(reason === 'reload' ? '擴充功能重新載入時已經過了開賣時間，任務已取消' : '瀏覽器關閉期間錯過了開賣時間，任務已取消');
    return;
  }
  if (reason === 'reload' && task.tabId) {
    // 擴充功能重新載入（例如換新版）：原本開好的頁面還在，但上面的舊程式已經跟背景程式斷線，重新整理讓新版接手
    const tab = await chrome.tabs.get(task.tabId).catch(() => null);
    if (tab) {
      await chrome.tabs.reload(task.tabId).catch(() => {});
      if (task.openAt > Date.now()) {
        await chrome.alarms.create(ALARM_OPEN, { when: task.openAt });
        await chrome.alarms.create(ALARM_WATCH, { periodInMinutes: 1 });
      } else {
        await openTarget();
      }
      await scheduleFireWatch(task.targetTs);
      await badge('⏱', '#0f766e');
      addLog('擴充功能重新載入：已重新整理時段列表，由新版接手倒數');
      return;
    }
  }
  await serial(async () => { const t = await getTask(); if (t && t.id === task.id) await set({ task: { ...t, tabId: null, windowId: null } }); });
  if (task.openAt <= Date.now()) await openTarget();
  else {
    await chrome.alarms.create(ALARM_OPEN, { when: task.openAt });
    await chrome.alarms.create(ALARM_WATCH, { periodInMinutes: 1 });
  }
  await scheduleFireWatch(task.targetTs);
  await badge('⏱', '#0f766e');
}
chrome.runtime.onStartup.addListener(() => restoreAlarms('startup'));
chrome.runtime.onInstalled.addListener((d) => { if (d && d.reason === 'update') restoreAlarms('reload'); });
