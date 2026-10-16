/*
 * alert-hook.js —— 跑在 MAIN world（與 ibon 頁面共用同一個 JS 環境），document_start 就載入
 *
 * ibon 用 alert() 回報「已售完」「請先登入」這類結果，擴充功能的 ISOLATED world 接不到。
 * 做兩件事：
 *   1. 記下網站呼叫 alert / confirm 時的文字，用 postMessage 轉給 page-agent.js，然後照原本的樣子顯示對話框。
 *      它不替你按確定、不改變任何網站行為。
 *   2. 代 page-agent.js 點 href 是 javascript: 的連結（ibon 的「下一步」就是 javascript:__doPostBack(...)）。
 *      擴充功能的環境（ISOLATED world）點這種連結會被擴充功能自己的 CSP 擋掉（2026-10-16 實測：
 *      Running the JavaScript URL violates the following Content Security Policy directive 'script-src 'self' …'），
 *      在頁面自己的環境（這裡）點就跟你手動按一樣。只點 page-agent.js 剛標記過的那一個元素。
 */
(() => {
  'use strict';
  if (window.__ITH_ALERT_HOOK__) return;
  window.__ITH_ALERT_HOOK__ = true;
  const tell = (msg) => {
    try { window.postMessage({ __ith: 'alert', msg: String(msg == null ? '' : msg) }, location.origin); } catch (_) { /* 轉不出去就算了 */ }
  };
  const origAlert = window.alert;
  const origConfirm = window.confirm;
  window.alert = function (msg) { tell(msg); return origAlert.apply(this, arguments); };
  window.confirm = function (msg) { tell(msg); return origConfirm.apply(this, arguments); };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.__ith !== 'click' || typeof d.token !== 'string' || d.token.length > 40) return;
    const el = document.querySelector('[data-ith-click="' + CSS.escape(d.token) + '"]');
    if (!el) return;
    el.removeAttribute('data-ith-click');
    el.click();
  });
})();
