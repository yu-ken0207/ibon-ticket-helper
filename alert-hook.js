/*
 * alert-hook.js —— 跑在 MAIN world（與 ibon 頁面共用同一個 JS 環境），document_start 就載入
 *
 * ibon 用 alert() 回報「已售完」「請先登入」這類結果，擴充功能的 ISOLATED world 接不到。
 * 這支只做一件事：記下網站呼叫 alert / confirm 時的文字，用 postMessage 轉給 page-agent.js，
 * 然後照原本的樣子顯示對話框。它不替你按確定、不改變任何網站行為。
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
})();
