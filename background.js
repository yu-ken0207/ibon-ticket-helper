/*
 * background.js —— service worker（照 kktix 訂票助手的結構，換成 ibon 的網址與頁面）
 *
 * 負責三件事：
 *   1. 排程：開賣前 preOpenSec 秒把活動頁開在獨立視窗。
 *      chrome.alarms 的精度不夠拿來「到點」，真正的到點交給頁面裡 page-agent 的倒數，
 *      這裡只負責提早把頁面開好（跟台鐵訂票助手同一套兩段式排程）。
 *   2. 任務狀態：同一時間只有一個任務，記住綁定的分頁、目前階段與重試次數。
 *      頁面每次重新整理都是全新的 page-agent，它靠這裡的狀態知道自己該倒數還是該動作。
 *      ibon 的購票流程會換好幾頁（活動頁 → 選票區 → 座位/數量 → 填資料 → 確認），每一頁都跟這裡報到。
 *   3. 通知與紀錄：結果用系統通知告訴你，過程寫進 storage 給 popup 顯示。
 *
 * 任務階段（task.phase）：
 *   armed        已排程，等開賣（綁定的分頁在倒數）
 *   fired        開賣時間到，頁面已重新整理，正在選票
 *   running      「立即執行」模式，正在選票
 *   waiting-user 遇到驗證碼、找不到票區等需要你接手的狀況，已停手；你處理完進到下一頁，助手會接著動作
 *   done         結束（成功或失敗）
 *   cancelled    已取消
 */
'use strict';

import { pad, fmt, int } from './lib/format.js';
import { activityUrl, eventSlug, pageKindOf, isIbonHost, offTrackKind, FLOW_KINDS } from './lib/urls.js';
import { DEFAULT_EXCLUDE, parseKeywords, parseList, validateCfg } from './lib/areas.js';
import { loadDelay, loadGaveUp } from './lib/backoff.js';
import { summarizeHealth } from './lib/health.js';
import { sanitizeBox, BLACKBOX_MAX } from './lib/box.js';

const ALARM_OPEN = 'ith-open';
const ALARM_WATCH = 'ith-watch';
const ALARM_FIRE = 'ith-fire';
const LOG_MAX = 300;

const DEFAULTS = {
  eventUrl: '',
  sessionWhen: '',         // 場次的演出時間，例如「2026/10/24 13:00」（先按「讀取活動」再從清單選）
  keywords: [],
  qty: 1,
  preOpenSec: 90,          // 開賣前幾秒開頁
  fireOffsetMs: 30,        // 到點後再等多久才重新整理，吸收網路來回不對稱的誤差，避免太早只看到「尚未開賣」
  notOpenRetryMs: 1000,    // 時間到了「線上購票」仍不能按時，多久重新整理一次
  notOpenMaxRetries: 30,   // 最多重新整理幾次
  failRetryMs: 300,        // 按下一步後被網站拒絕（alert）時，多久後重來（次數有上限，所以可以短）
  failMaxRetries: 3,
  syncClock: true,
  autoAgree: true,         // 填購票資訊頁自動勾「同意」
  allowNonAdjacent: false, // 座位/數量頁有「接受不連號座位」時要不要勾（tickets_hunter 也有這個選項）
  // 名稱含這些字的票區一律不選（同 kktix 助手）：身障席位保留給需要的人，視線不良的位置也避開
  exclude: DEFAULT_EXCLUDE.slice(),
  fallback: false,         // 關鍵字都比對不到時，要不要改選第一個還能買的（一樣套用排除字）
};

const ACTIVE_PHASES = ['armed', 'fired', 'running', 'waiting-user'];
const SUCCESS_PHASES = ['fired', 'running', 'waiting-user'];
const FLOW_PHASES = ['fired', 'running', 'waiting-user'];

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



/* ───────────────────────── 網址 ─────────────────────────
 * 網址的判讀在 lib/urls.js，這裡只剩表單用的小工具 */


function normalizeCfg(raw) {
  const r = raw || {};
  const cfg = {
    eventUrl: String(r.eventUrl || '').trim(),
    sessionWhen: String(r.sessionWhen || '').trim(),
    keywords: parseKeywords(r.keywords),
    qty: int(r.qty, DEFAULTS.qty, 1, 10),
    preOpenSec: int(r.preOpenSec, DEFAULTS.preOpenSec, 5, 600),
    fireOffsetMs: int(r.fireOffsetMs, DEFAULTS.fireOffsetMs, 0, 2000),
    notOpenRetryMs: int(r.notOpenRetryMs, DEFAULTS.notOpenRetryMs, 700, 60000),
    notOpenMaxRetries: int(r.notOpenMaxRetries, DEFAULTS.notOpenMaxRetries, 0, 120),
    failRetryMs: int(r.failRetryMs, DEFAULTS.failRetryMs, 200, 60000),
    failMaxRetries: int(r.failMaxRetries, DEFAULTS.failMaxRetries, 0, 10),
    syncClock: r.syncClock !== false,
    autoAgree: r.autoAgree !== false,
    // 沒傳就用預設；傳了空字串代表你刻意清空，就照你的意思不排除
    exclude: r.exclude === undefined ? DEFAULTS.exclude.slice() : parseList(r.exclude),
    fallback: r.fallback === true,
    allowNonAdjacent: r.allowNonAdjacent === true,
  };
  cfg.regUrl = activityUrl(cfg.eventUrl);
  return cfg;
}

function validate(cfg) {
  return validateCfg(cfg);
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
    mode, cfg, regUrl: cfg.regUrl, slug: eventSlug(cfg.regUrl),
    targetTs: null, openAt: null, tabId: null, windowId: null,
    phase: mode === 'scheduled' ? 'armed' : 'running',
    notOpen: 0, fail: 0, loadFail: 0, loadStreak: 0, loadFailSince: null, lastNetFail: null, createdAt: Date.now(), startedAt: null, firedAt: null, fireDrift: null,
    failedAreas: [], areaUrl: null,   // 這次售完過的票區、選區頁的網址（售完時回這一頁換別區）
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
  await badge('⏱', '#0a7d55');
  addLog(`已排程：${fmt(targetTs)} 開賣，${fmt(openAt)} 開啟活動頁`);
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
    // 已經有綁定的分頁（例如你先自己打開活動頁登入好了），拉到前景就好，不要重開
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
  addLog('已在新視窗開啟活動頁，開始倒數');
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
  const sameEventTab = tab && tab.url && eventSlug(tab.url) === eventSlug(cfg.regUrl);
  const onEvent = sameEventTab && pageKindOf(tab.url) === 'event';

  await retireOld();
  await chrome.alarms.clearAll();
  let tabId = tab ? tab.id : null;
  if (!sameEventTab) {
    // 目前分頁不是這個活動：開新分頁，不要把你正在看的網頁導走
    const created = await chrome.tabs.create({ url: cfg.regUrl, active: true });
    tabId = created.id;
  }
  const task = newTask(cfg, 'now', { tabId, startedAt: Date.now() });
  await serial(() => set({ task }));
  await badge('▶', '#0a7d55');
  addLog('立即執行');

  if (onEvent) sendCmd(tabId, { cmd: 'run', cfg, since: task.startedAt });
  else if (sameEventTab) await chrome.tabs.update(tabId, { url: cfg.regUrl });
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

/* ───────────────────────── 讀取活動（檢查） ─────────────────────────
 * 在背景分頁讀活動頁的場次、開賣時間、票價，回報後關掉分頁。popup 用它填場次清單與開賣時間。 */

// 背景分頁編號 → { cfg, resolve, timer }。只放記憶體：檢查只要幾秒，service worker 不會在這期間被收掉
const pendingChecks = new Map();

async function checkEvent(raw) {
  const cfg = normalizeCfg(raw);
  if (!cfg.regUrl) return { ok: false, error: '活動網址看不懂，請貼 ibon 活動頁網址（https://ticket.ibon.com.tw/ActivityInfo/Details/…）' };
  const tab = await chrome.tabs.create({ url: cfg.regUrl, active: false });
  addLog('讀取活動：在背景分頁讀取場次、開賣時間與票價');
  return new Promise((resolve) => {
    const timer = setTimeout(() => finishCheck(tab.id, { ok: false, error: '40 秒內沒有讀到場次表，請自己打開活動頁看看' }), 40000);
    pendingChecks.set(tab.id, { kind: 'keywords', cfg, resolve, timer });
  });
}

function finishCheck(tabId, result) {
  const pending = pendingChecks.get(tabId);
  if (!pending) return false;
  pendingChecks.delete(tabId);
  clearTimeout(pending.timer);
  chrome.tabs.remove(tabId).catch(() => {});
  const out = { ...result, at: Date.now() };
  addLog(`${pending.kind === 'health' ? '健檢' : '讀取活動'}：${out.msg || out.error || ''}`, out.ok ? 'ok' : 'warn');
  pending.resolve(out);
  return true;
}

/* ───────────────────────── 健檢 ─────────────────────────
 * 在背景分頁檢查 ibon 活動頁，並記下活動頁程式檔的檔名。
 * 檔名帶內容雜湊，ibon 一改版就會變，下次健檢或開頁時就能發現。 */
async function healthCheck(raw) {
  const cfg = normalizeCfg(raw);
  if (!cfg.regUrl) return { ok: false, error: '活動網址看不懂，請貼 ibon 活動頁網址（https://ticket.ibon.com.tw/ActivityInfo/Details/…）' };
  const tab = await chrome.tabs.create({ url: cfg.regUrl, active: false });
  addLog('健檢：在背景分頁檢查活動頁');
  return new Promise((resolve) => {
    const timer = setTimeout(() => finishCheck(tab.id, { ok: false, error: '45 秒內沒有完成健檢，請自己打開活動頁看看' }), 45000);
    pendingChecks.set(tab.id, { kind: 'health', cfg, resolve, timer });
  });
}

/** 跟上次記下的活動頁程式檔比對，並記下這次的 */
async function compareFingerprint(bundles) {
  const cur = (Array.isArray(bundles) ? bundles : []).map(String).sort();
  const { ibonFingerprint: prev = null } = await get('ibonFingerprint');
  if (!cur.length) return { changed: null, first: false, same: false };
  const before = prev && Array.isArray(prev.bundles) && prev.bundles.length ? prev : null;
  await set({ ibonFingerprint: { bundles: cur, at: Date.now() } });
  if (!before) return { changed: null, first: true, same: false };
  if (before.bundles.join() !== cur.join()) return { changed: { from: before.bundles, at: before.at }, first: false, same: false };
  return { changed: null, first: false, same: true };
}


/* ───────────────────────── 黑盒子 ─────────────────────────
 * 頁面遇到失敗、交手、被拒、排隊頁或 Cloudflare 時送來的頁面重點。最多留 20 筆，彈出視窗可以匯出。 */


/* ───────────────────────── 頁面回報（經 bridge） ───────────────────────── */

/** 頁面載入時問：這個分頁現在該做什麼？（opener：這個分頁是從哪個分頁開出來的，活動頁按「線上購票」可能另開分頁） */
function onHello(tabId, page, opener) {
  noteHello(tabId);
  const check = pendingChecks.get(tabId);
  if (check) return Promise.resolve({ mode: check.kind === 'health' ? 'health' : 'check', cfg: check.cfg });
  return serial(async () => {
    const task = await getTask();
    if (!task || !ACTIVE_PHASES.includes(task.phase)) return { mode: 'idle' };

    const kind = page && page.kind;
    let t = task;

    if (task.tabId !== tabId) {
      const sameEvent = eventSlug(page && page.url) === task.slug;
      if (!task.tabId && task.phase === 'armed' && sameEvent && kind === 'event') {
        // 排程後、開頁前，你自己先開好同一個活動的活動頁：直接綁定這個分頁，到時不再另開視窗
        t = { ...task, tabId };
        await set({ task: t });
      } else if (task.tabId && opener === task.tabId && FLOW_PHASES.includes(task.phase) && (FLOW_KINDS.includes(kind) || kind === 'confirm')) {
        // 活動頁按「線上購票」另開了分頁：任務跟著搬過去
        t = { ...task, tabId };
        await set({ task: t });
      } else {
        return { mode: 'idle' };
      }
    }

    if (kind === 'confirm') {
      // 進到購票確認頁代表名額已保留（確認頁的結構還沒看過，助手只顯示提示，不按任何東西）
      if (!SUCCESS_PHASES.includes(t.phase)) return { mode: 'idle' };
      const since = t.firedAt || t.startedAt;
      const result = { ok: true, kind: 'held', msg: '已保留名額，請確認訂單後自己付款', url: page.url, at: Date.now(), elapsedMs: since ? Date.now() - since : null };
      await set({ task: { ...t, phase: 'done', result } });
      return { mode: 'success', since, finalize: true };
    }
    if (kind === 'event') {
      if (t.mode === 'scheduled' && t.phase === 'armed') return { mode: 'countdown', targetTs: t.targetTs, cfg: t.cfg };
      if (t.phase === 'fired' || t.phase === 'running') {
        return { mode: 'run', cfg: t.cfg, since: t.firedAt || t.startedAt, notOpen: t.notOpen, fail: t.fail, loadFail: t.loadStreak || 0 };
      }
      return { mode: 'idle' };
    }
    if (FLOW_KINDS.includes(kind)) {
      // 購票流程的頁面：開賣後（含你處理完驗證碼、進到下一頁）助手接著動作
      if (!FLOW_PHASES.includes(t.phase)) return { mode: 'idle' };
      const next = { ...t, phase: t.phase === 'waiting-user' ? 'running' : t.phase, areaUrl: kind === 'area' ? page.url : t.areaUrl };
      if (next.phase !== t.phase || next.areaUrl !== t.areaUrl) await set({ task: next });
      return { mode: 'run', cfg: t.cfg, since: t.firedAt || t.startedAt, notOpen: t.notOpen, fail: t.fail, loadFail: 0,
        failedAreas: next.failedAreas || [], areaUrl: next.areaUrl || null };
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

/* 票種資料載入失敗後的重新整理：連續失敗才逐步拉長間隔，最長 3 秒一次；連續失敗超過 5 分鐘就交給你。
 * 頁面上的助手和下面「盯住購票分頁」共用這份額度。 */

/** 給不給重新整理、等多久。只能在 serial 裡呼叫（裡面直接寫 storage） */
async function loadRetryGrant(t, status) {
  const since = t.loadFailSince || Date.now();
  const streak = t.loadStreak || 0;
  if (loadGaveUp(since, Date.now())) return { allow: false, count: t.loadFail || 0 };
  const delayMs = loadDelay(streak, status);
  const count = (t.loadFail || 0) + 1;
  await set({ task: { ...t, loadFail: count, loadStreak: streak + 1, loadFailSince: since } });
  return { allow: true, count, delayMs };
}

/** 頁面想重新整理再試一次：這裡決定還有沒有額度 */
function onRetry(tabId, p) {
  return serial(async () => {
    const t = await getTask();
    if (!t || t.tabId !== tabId || !['fired', 'running'].includes(t.phase)) return { allow: false };
    if (p && p.reason === 'load') return loadRetryGrant(t, Number(p.status) || 0);
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
  if (r2.ok) {
    notify('ibon：已保留名額', r2.msg, true);
    await badge('✓', '#0a7d55');
  } else if (t.phase === 'waiting-user') {
    notify('ibon：需要你接手', r2.msg, true);
    await badge('!', '#d97706');
  } else {
    notify('ibon：沒有完成', r2.msg, true);
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
    return true;
  });
  // 填購票資訊頁一進來名額就保留了：用比較醒目的標題，開始倒數保留時間
  if (first) notify(kind === 'held' ? 'ibon：名額已保留' : 'ibon：請注意', p.msg || kind, true);
  if (first && kind === 'held') await badge('✓', '#0a7d55');
  addLog(p.msg || kind, 'warn');
  return { ok: true };
}

/* ───────────────────────── 到點保險 ─────────────────────────
 * 到點重新整理平常由頁面上的助手負責，最準。但頁面在背景時，Chrome 會把它的計時器拖到整秒才跑，
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
  const kind = pageKindOf(tab.url || '');
  if (kind !== 'event') return;
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

/* ───────────────────────── 盯住購票分頁 ─────────────────────────
 * 有任務時，購票分頁可能被帶到助手管不到的地方，而且都不會自己恢復：
 *   ibon 的登入頁（登入過期）、伺服器錯誤頁
 *   Chrome 自己的連線錯誤頁：網址不變，但頁面上沒有助手
 * 發現了就把分頁帶回活動頁（登入問題除外，那要你自己登入），間隔與上限跟頁面載入失敗共用。 */
const WATCH_PHASES = ['armed', 'fired', 'running'];
const NO_AGENT_MS = 4000;          // 頁面載入完成後過了這麼久，助手還沒報到，就當成錯誤頁
const tabLoads = new Map();        // 分頁 → { loadingAt, helloAt }；只放記憶體，service worker 重啟就重新開始記
const recovering = new Set();      // 已經排好要帶回的分頁，避免同一次重複處理

function noteHello(tabId) {
  const rec = tabLoads.get(tabId) || { loadingAt: 0, helloAt: 0 };
  rec.helloAt = Date.now();
  tabLoads.set(tabId, rec);
}

async function recoverTab(tabId, why, how) {
  if (recovering.has(tabId)) return;
  recovering.add(tabId);
  try {
    const grant = await serial(async () => {
      const t = await getTask();
      if (!t || t.tabId !== tabId || !WATCH_PHASES.includes(t.phase)) return null;
      // 還沒開賣：不急，也不算額度
      if (t.phase === 'armed') return { allow: true, delayMs: 3000, count: 0, regUrl: t.regUrl };
      return { ...(await loadRetryGrant(t, 0)), regUrl: t.regUrl };
    });
    if (!grant) return;
    if (!grant.allow) {
      await onResult(tabId, { ok: false, kind: 'load-limit', msg: `${why}，連續 5 分鐘都沒有恢復，先停下來。請自己重新整理活動頁`, handOff: true });
      return;
    }
    const action = how === 'navigate' ? '帶回活動頁' : '重新載入';
    addLog(`${why}，${(grant.delayMs / 1000).toFixed(1)} 秒後${action}${grant.count ? `（第 ${grant.count} 次）` : ''}`, 'warn');
    await new Promise((r) => setTimeout(r, grant.delayMs));
    const t = await getTask();
    if (!t || t.tabId !== tabId || !WATCH_PHASES.includes(t.phase)) return;
    const tab = await chrome.tabs.get(tabId);
    if (how === 'navigate') {
      if (pageKindOf(tab.url || '') !== 'other' && !offTrackKind(tab.url || '')) return;   // 已經自己回到 ibon 的頁面
      await chrome.tabs.update(tabId, { url: grant.regUrl });
    } else {
      const rec = tabLoads.get(tabId);
      if (rec && rec.helloAt > rec.loadingAt) return;      // 等的這段時間助手報到了：不是錯誤頁
      await chrome.tabs.reload(tabId);
    }
  } catch (_) {
    /* 分頁可能已經關掉 */
  } finally {
    recovering.delete(tabId);
  }
}

async function onOffTrack(tabId, kind, url) {
  const t = await getTask();
  if (!t || t.tabId !== tabId || !WATCH_PHASES.includes(t.phase)) return;
  if (kind === 'sign-in') {
    // 登入過期之類：帶回去也只會再被要求登入，交給你
    const msg = 'ibon 要你重新登入。登入後回到活動頁';
    if (t.phase === 'armed') await onWarn(tabId, { kind: 'guest', msg: msg + '，助手會照常倒數' });
    else await onResult(tabId, { ok: false, kind: 'guest', url, handOff: true, msg: msg + '，在擴充功能按「立即執行」' });
    return;
  }
  if (kind === 'card-validate') {
    // 持卡人優先購：要你驗證卡片資格，助手不代填；驗證完進到購票流程，助手會接著動作
    const msg = 'ibon 要你先驗證持卡人資格（優先購）。請自己完成，之後的步驟助手會接著做';
    if (t.phase === 'armed') await onWarn(tabId, { kind: 'card-validate', msg });
    else await onResult(tabId, { ok: false, kind: 'card-validate', url, handOff: true, msg });
    return;
  }
  await recoverTab(tabId, kind === 'home' ? 'ibon 把頁面導回首頁' : 'ibon 回了錯誤頁', 'navigate');
}

/** 問頁面上的助手還在不在：活動頁是單頁應用，網址或載入狀態會變但頁面沒有真的重新載入，助手不會再報到一次 */
async function agentAlive(tabId) {
  try {
    const r = await Promise.race([chrome.tabs.sendMessage(tabId, { cmd: 'ping' }), new Promise((res) => setTimeout(() => res(null), 1200))]);
    return !!(r && r.ok);
  } catch (_) { return false; }
}

async function checkAgent(tabId, loadingAt) {
  const rec = tabLoads.get(tabId);
  if (!rec || rec.loadingAt !== loadingAt || rec.helloAt >= loadingAt) return;   // 助手報到了，或已經是下一次載入
  if (await agentAlive(tabId)) { noteHello(tabId); return; }                     // 助手還在，只是沒有再報到
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (_) { return; }
  const kind = pageKindOf(tab.url || '');
  if (tab.status !== 'complete' || !isIbonHost(tab.url || '') || (kind !== 'event' && !FLOW_KINDS.includes(kind))) return;
  await recoverTab(tabId, '頁面沒有正常載入，可能是 Chrome 的連線錯誤頁', 'reload');
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading') {
    const rec = tabLoads.get(tabId) || { loadingAt: 0, helloAt: 0 };
    rec.loadingAt = Date.now();
    tabLoads.set(tabId, rec);
    noteFired(tabId);
  }
  const url = info.url || (info.status === 'loading' ? tab.url : null);
  const off = url ? offTrackKind(url) : null;
  if (off) onOffTrack(tabId, off, url).catch(() => {});
  if (info.status === 'complete') {
    const rec = tabLoads.get(tabId);
    if (rec && rec.loadingAt) {
      const at = rec.loadingAt;
      setTimeout(() => { checkAgent(tabId, at).catch(() => {}); }, NO_AGENT_MS);
    }
  }
});

/* ───────────────────────── 訊息入口 ───────────────────────── */

const POPUP_TYPES = new Set(['schedule', 'run-now', 'cancel', 'status', 'clear-logs', 'preview-url', 'check-event', 'health-check']);
const PAGE_TYPES = new Set(['hello', 'fired', 'fired-drift', 'retry', 'result', 'log', 'warn', 'abort-request', 'check-result', 'load-ok', 'clock', 'health-result', 'health', 'blackbox', 'area-failed', 'areas-seen']);
const AREA_SEEN_EVENTS = 30;   // 記幾個活動的票區名稱（給彈出視窗當關鍵字參考）

async function handle(msg, sender) {
  const type = msg && msg.type;
  // 用來源網址分辨：popup 就算被開在分頁裡也有 sender.tab，不能拿 tab 有沒有來判斷
  const extOrigin = `chrome-extension://${chrome.runtime.id}/`;
  const isExtensionPage = !!(sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(extOrigin));
  const fromTab = !isExtensionPage && !!(sender && sender.tab);

  if (fromTab) {
    // 只接受頁面該送的訊息。頁面上的網站程式也看得到 postMessage，不能讓它排程或取消別的東西
    if (!PAGE_TYPES.has(type)) return { ok: false, error: 'not allowed' };
    const tabId = sender.tab.id;
    const p = msg.payload || {};
    switch (type) {
      case 'hello': {
        const r = await onHello(tabId, { kind: p.kind, url: p.url || sender.tab.url }, sender.tab.openerTabId);
        if (r && r.finalize) {
          const took = r.since ? `從開賣到保留 ${((Date.now() - r.since) / 1000).toFixed(1)} 秒。` : '';
          notify('ibon：已保留名額', `${took}請到購票視窗確認訂單後自己付款，保留有時間限制。`, true);
          await badge('✓', '#0a7d55');
          addLog(`成功：已保留名額。${took}`, 'ok');
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
        if (armedNow) await armFireWatch();   // 已經在等開賣了：用新的時間重新計時
        return { ok: true };
      }
      case 'load-ok': {
        // 票種載入成功：連續失敗的計算重來，下次失敗又從 0.5 秒開始
        await serial(async () => {
          const t = await getTask();
          if (t && t.tabId === tabId && (t.loadStreak || t.loadFailSince)) await set({ task: { ...t, loadStreak: 0, loadFailSince: null } });
        });
        return { ok: true };
      }
      case 'check-result': return { ok: finishCheck(tabId, p) };
      case 'area-failed': {
        // 這個票區賣完了：記在任務裡，回到選區頁時跳過
        const text = String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!text) return { ok: false };
        const ok = await serial(async () => {
          const t = await getTask();
          if (!t || t.tabId !== tabId) return false;
          const list = t.failedAreas || [];
          if (!list.includes(text) && list.length < 20) await set({ task: { ...t, failedAreas: [...list, text] } });
          return true;
        });
        if (ok) addLog(`票區「${text}」賣完了，之後跳過它`, 'warn');
        return { ok };
      }
      case 'areas-seen': {
        // 頁面上看到的票區名稱：照活動記下來，彈出視窗讀取這個活動時當成關鍵字的參考（不影響任何動作）
        const t = await getTask();
        if (!t || t.tabId !== tabId || !t.slug) return { ok: false };
        const names = [...new Set((Array.isArray(p.names) ? p.names : []).map((x) => String(x).replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean))].slice(0, 40);
        if (!names.length) return { ok: false };
        await serial(async () => {
          const { areaSeen = {} } = await get('areaSeen');
          areaSeen[t.slug] = { at: Date.now(), session: (t.cfg && t.cfg.sessionWhen) || '', names };
          const keep = Object.entries(areaSeen).sort((a, b) => b[1].at - a[1].at).slice(0, AREA_SEEN_EVENTS);
          await set({ areaSeen: Object.fromEntries(keep) });
        });
        return { ok: true };
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
      case 'health-result': {
        if (!pendingChecks.has(tabId)) return { ok: false };
        const fp = await compareFingerprint(p.bundles);
        return { ok: finishCheck(tabId, { ok: !!p.ok, worst: p.worst || null, items: Array.isArray(p.items) ? p.items : [], bundles: p.bundles || [], ...fp, msg: summarizeHealth(p, fp) }) };
      }
      case 'health': {
        // 開頁時的健檢：有一定會卡住的項目、或 ibon 改版了，就發通知
        const t = await getTask();
        if (!t || t.tabId !== tabId) return { ok: false };
        const fp = await compareFingerprint(p.bundles);
        const items = Array.isArray(p.items) ? p.items : [];
        const bad = items.filter((i) => i.status === 'fail');
        if (bad.length) {
          await onWarn(tabId, { kind: 'health', msg: `開賣前健檢發現問題：${bad.map((i) => (i.detail ? `${i.label}，${i.detail}` : i.label)).join('；')}。ibon 可能改版了，開賣時請準備自己操作` });
        } else {
          const warn = items.filter((i) => i.status === 'warn').map((i) => i.label);
          addLog(`開賣前健檢：${warn.length ? '大致正常，要注意：' + warn.join('、') : '全部正常'}`, warn.length ? 'warn' : 'ok');
        }
        if (fp.changed) await onWarn(tabId, { kind: 'bundle', msg: `ibon 的活動頁程式在上次檢查（${fmt(fp.changed.at)}）之後更新過。助手照舊會動作，但建議看一下面板上的健檢結果` });
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
    case 'check-event': return checkEvent(msg.cfg);
    case 'health-check': return healthCheck(msg.cfg);
    case 'cancel': return cancel();
    case 'clear-logs': await serial(() => set({ logs: [], blackbox: [] })); return { ok: true };
    case 'preview-url': return { ok: true, regUrl: activityUrl(msg.url) };
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
  tabLoads.delete(tabId);
  if (pendingChecks.has(tabId)) { finishCheck(tabId, { ok: false, error: '檢查用的分頁被關掉了' }); return; }
  const task = await getTask();
  if (task && task.tabId === tabId && ACTIVE_PHASES.includes(task.phase)) {
    await cancel('購票頁的分頁被關掉了，任務已取消');
  }
});

// 瀏覽器重開後 alarm 可能不在了：還沒到的排程重新掛上
async function restoreAlarms(reason) {
  const task = await getTask();
  if (!task || task.mode !== 'scheduled' || task.phase !== 'armed') return;
  if (task.targetTs <= Date.now()) {
    await cancel(reason === 'reload' ? '擴充功能重新載入時已經過了開賣時間，任務已取消' : '瀏覽器關閉期間錯過了開賣時間，任務已取消');
    return;
  }
  if (reason === 'reload' && task.tabId) {
    // 擴充功能重新載入（例如換新版）：原本開好的活動頁還在，但上面的舊助手已經跟背景程式斷線。
    // 重新整理那一頁，讓新版助手接手倒數，不另開視窗
    const tab = await chrome.tabs.get(task.tabId).catch(() => null);
    if (tab) {
      await chrome.tabs.reload(task.tabId).catch(() => {});
      // Chrome 重新載入擴充功能時把鬧鐘清掉了：開頁時間還沒到就補回去，到時才會把視窗拉到前景
      if (task.openAt > Date.now()) {
        await chrome.alarms.create(ALARM_OPEN, { when: task.openAt });
        await chrome.alarms.create(ALARM_WATCH, { periodInMinutes: 1 });
      } else {
        await openTarget();   // 開頁時間已過：現在就把活動頁拉到前景，背景分頁的計時器會被拖慢
      }
      await scheduleFireWatch(task.targetTs);
      await badge('⏱', '#0a7d55');
      addLog('擴充功能重新載入：已重新整理活動頁，由新版接手倒數');
      return;
    }
  }
  // 重開瀏覽器後原本的分頁編號已失效
  await serial(async () => { const t = await getTask(); if (t && t.id === task.id) await set({ task: { ...t, tabId: null, windowId: null } }); });
  if (task.openAt <= Date.now()) await openTarget();
  else {
    await chrome.alarms.create(ALARM_OPEN, { when: task.openAt });
    await chrome.alarms.create(ALARM_WATCH, { periodInMinutes: 1 });
  }
  await scheduleFireWatch(task.targetTs);
  await badge('⏱', '#0a7d55');
}
chrome.runtime.onStartup.addListener(() => restoreAlarms('startup'));
// 重新載入或更新擴充功能時，Chrome 會清掉這個擴充功能的鬧鐘：已排程的任務要重新掛上
chrome.runtime.onInstalled.addListener((d) => { if (d && d.reason === 'update') restoreAlarms('reload'); });
