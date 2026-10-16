/*
 * page-agent.js —— 跑在 ISOLATED world（擴充功能自己的環境，可以直接用 chrome.runtime）
 *
 * 為什麼是 ISOLATED：ibon 活動頁的場次表在封閉的 Shadow DOM 裡，只有擴充功能的 chrome.dom.openOrClosedShadowRoot 讀得到。
 * 網站用 alert() 回報結果，這個環境接不到，由 MAIN world 的 alert-hook.js 轉成訊息送過來。
 *
 * 模式（由 background 依任務狀態決定，頁面每次載入都會重新問一次）：
 *   countdown  活動頁：對時 → 倒數到開賣時間 → 通知 background → 重新整理
 *   run        依頁面種類動作：
 *                活動頁   找你選的場次，「線上購票」可按就點；還不能按就照尚未開賣重試
 *                選票區頁 照關鍵字、排除字選票區
 *                座位/數量頁 選票區價格、選張數、按下一步；有驗證碼就停手交給你
 *                填購票資訊頁 勾同意、按下一步
 *   success    進到購票確認頁代表名額已保留；只顯示提示，不按任何東西
 *   check      「讀取活動」「檢查」按鈕：在背景分頁讀場次、開賣時間、票價，回報後由 background 關掉分頁
 *   health     「健檢」按鈕：檢查活動頁還是不是助手認得的樣子
 * 驗證碼、排隊、付款一律交給你；最後的確認、付款也不碰。
 */
(() => {
  'use strict';

  if (window.__ITH_AGENT__) return;
  window.__ITH_AGENT__ = true;

  const state = {
    clockOffset: 0,       // 伺服器時間 - 本機時間（毫秒）
    clockReliable: false, // 有沒有在前景完成過一次對時
    syncing: false,
    resyncArmed: false,
    aborted: false,
    running: false,
    alerts: [],           // MAIN world 的 alert-hook.js 轉來的網站訊息
    netStarts: [],        // 頁面自己還沒回來的網路請求的開始時間（alert-hook.js 轉來的）
    netLastStart: 0,      // 頁面最後一個請求開始的時間
    domReadyAt: 0,        // DOMContentLoaded 的時間
    leaving: false,       // 頁面開始離開了（按了換頁的東西）：舊頁面上的助手不要再動作
    panel: null,
    mode: null,
  };

  /* ───────────────────────── 基礎工具 ───────────────────────── */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now() + state.clockOffset;
  const norm = (s) => String(s == null ? '' : s).replace(/[\s　]+/g, ' ').trim();
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function domReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  }

  /** 元素裡的文字，保留換行：段落、清單、<br> 換成換行（收合起來看不到的區塊也讀得到） */
  const BLOCK = new Set(['P', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'HR']);
  function blockText(root) {
    const out = [];
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) { out.push(n.nodeValue); return; }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      if (tag === 'BR') { out.push('\n'); return; }
      const block = BLOCK.has(tag);
      if (block) out.push('\n');
      for (const c of n.childNodes) walk(c);
      if (block) out.push('\n');
    };
    if (root) walk(root);
    return out.join('').split('\n').map((l) => l.replace(/[ \t　]+/g, ' ').trim()).filter(Boolean).join('\n');
  }

  /** 頁面自己的背景更新還在跑嗎：5 秒內開始、還沒回來的請求才算（太久沒回的多半是常駐連線，不是這次的更新） */
  const NET_BUSY_MS = 5000;
  function netBusy() {
    const t = Date.now();
    return state.netStarts.some((s) => t - s < NET_BUSY_MS);
  }

  /** 這一頁從開始載入到現在多久（毫秒），寫在紀錄裡看每一步花多少時間 */
  const pageAge = () => `這一頁載入後 ${Math.round(performance.now())} ms`;

  /** 頁面種類（判讀寫在 lib/urls.js） */
  function pageKind() {
    return pageKindOf(location.href);
  }

  /* ───────────────────────── 與背景程式溝通 ───────────────────────── */

  /** 送出不等回覆 */
  function send(type, payload) {
    try { chrome.runtime.sendMessage({ type, payload, url: location.href }, () => void chrome.runtime.lastError); } catch (_) { /* 擴充功能剛重新載入 */ }
  }

  /** 送出並等回覆；逾時或失敗回 null */
  function call(type, payload, timeout = 1500) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout);
      try {
        chrome.runtime.sendMessage({ type, payload, url: location.href }, (res) => {
          void chrome.runtime.lastError;
          clearTimeout(timer);
          resolve(res === undefined ? null : res);
        });
      } catch (_) { clearTimeout(timer); resolve(null); }
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.cmd === 'ping') { sendResponse({ ok: true, kind: pageKind() }); return; }   // 背景程式問「助手還在不在」
    if (msg && msg.cmd) onCommand(msg);
  });

  // MAIN world 的 alert-hook.js 把網站的 alert / confirm 轉成 postMessage
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (d && d.__ith === 'net' && Array.isArray(d.starts)) {
      state.netStarts = d.starts.filter(Number.isFinite);
      if (Number.isFinite(d.lastStart)) state.netLastStart = d.lastStart;
      return;
    }
    if (!d || d.__ith !== 'alert' || typeof d.msg !== 'string') return;
    const msg = d.msg.slice(0, 300);
    state.alerts.push(msg);
    // 等結果的那幾秒 alert-hook.js 接管了對話框，沒有跳出來：寫進面板讓你知道 ibon 說了什麼
    if (d.kind === 'confirm' && d.caught) log(`ibon 詢問「${msg.slice(0, 60)}」，助手按了${d.answer ? '確定' : '否'}`, 'warn');
    else if (d.caught) log(`ibon 訊息：「${msg.slice(0, 80)}」`, 'warn');
  });

  // 這支程式在 document_start 就載入，比 ibon 自己的程式早；記下 DOMContentLoaded 的時間，點票區前給 ibon 時間掛上點擊處理
  document.addEventListener('DOMContentLoaded', () => { state.domReadyAt = Date.now(); }, { once: true });
  if (document.readyState !== 'loading') state.domReadyAt = Date.now();

  // 按了換頁的東西（下一步、__doPostBack）：頁面開始離開時舊頁面還能操作一陣子，這段時間不要再動作
  window.addEventListener('beforeunload', () => { state.leaving = true; });
  window.addEventListener('pagehide', () => { state.leaving = true; });
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) state.leaving = false; });

  function log(msg, level = 'info') {
    send('log', { msg: String(msg), level });
    panelLog(String(msg), level);
  }

  /* ───────────────────────── 啟動 ───────────────────────── */

  let helloState = 'pending';   // pending → inflight → done
  async function hello() {
    if (helloState !== 'pending') return;
    helloState = 'inflight';
    const res = await call('hello', { kind: pageKind(), url: location.href }, 1500);
    if (!res) { helloState = 'pending'; return; }
    helloState = 'done';
    handleDirective(res);
  }
