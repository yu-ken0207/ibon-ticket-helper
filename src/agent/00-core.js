/*
 * agent.js —— 頁面程式，跑在 ISOLATED world
 *
 * 只需要讀寫 DOM，所以跑在 ISOLATED world：網站的程式碰不到這裡，也能直接用 chrome.runtime 跟背景程式溝通。
 * 背景程式負責排程、到點保險、任務狀態、紀錄與黑盒子；這裡負責每一頁該做的那一步。
 *
 * 結構：
 *   通用流程（60-flow.js 與 lib/flow.js）只用 SITE 的函式讀寫頁面；
 *   每個網站一支轉接（10-pool.js…）負責「這個網站的時段、票種、欄位、按鈕在哪裡」。
 *
 * 一定停下來交給你的地方：確認頁（建立訂單前要你自己確認）、排隊、驗證碼、機器人檢查。
 * 不會繞過任何一種，也不會替你按「確認建立訂單」。
 */
(() => {
  'use strict';

  if (window.__ITH_AGENT__) return;
  window.__ITH_AGENT__ = true;

  const PANEL_TITLE = '一般票券訂票助手';

  const state = {
    clockOffset: 0,
    clockReliable: false,
    syncing: false,
    resyncArmed: false,
    aborted: false,
    running: false,
    left: false,        // 頁面已經離開（換頁或進了上一頁快取）：之後等到的結果都不算
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

  /** 照網站自己的輸入方式寫值：用原生 setter，再送 input / change，網站的程式才會知道值變了 */
  function setFieldValue(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === String(value);
  }

  window.addEventListener('pagehide', () => { state.left = true; });

  /* ───────────────────────── 與背景程式溝通 ───────────────────────── */

  function send(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, payload, url: location.href }, () => void chrome.runtime.lastError);
    } catch (_) { /* 擴充功能剛重新載入，這一頁的舊程式已失效 */ }
  }

  function call(type, payload, timeout = 1500) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout);
      try {
        chrome.runtime.sendMessage({ type, payload, url: location.href }, (res) => {
          void chrome.runtime.lastError;
          clearTimeout(timer);
          resolve(res === undefined ? null : res);
        });
      } catch (_) {
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  function log(msg, level = 'info') {
    send('log', { msg: String(msg), level });
    panelLog(String(msg), level);
  }

  /** 紀錄裡不寫完整的個人資料：手機、Email、姓名只留頭尾 */
  function maskText(s) {
    return String(s || '')
      .replace(/09\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, (m) => m.slice(0, 2) + '*'.repeat(Math.max(0, m.length - 4)) + m.slice(-2))
      .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+)/g, '$1***@$2');
  }
