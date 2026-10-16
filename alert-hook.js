/*
 * alert-hook.js —— 跑在 MAIN world（與 ibon 頁面共用同一個 JS 環境），document_start 就載入
 *
 * ibon 用 alert() 回報「已售完」「請先登入」這類結果，擴充功能的 ISOLATED world 接不到。
 * 做兩件事：
 *   1. 記下網站呼叫 alert / confirm 時的文字，用 postMessage 轉給 page-agent.js。
 *      平常照原本的樣子顯示對話框。只有 page-agent.js 按下去、等結果的那幾秒（它送 catch 過來）才接管：
 *      alert 不跳出來（不然整個頁面會停住，要你按確定才繼續）；confirm 照 kktix 助手的做法，
 *      訊息裡有「取消、不保留、放棄、刪除、清除」就按否，其他按確定。
 *   2. 代 page-agent.js 點 href 是 javascript: 的連結（ibon 的「下一步」就是 javascript:__doPostBack(...)）。
 *      擴充功能的環境（ISOLATED world）點這種連結會被擴充功能自己的 CSP 擋掉（2026-10-16 實測：
 *      Running the JavaScript URL violates the following Content Security Policy directive 'script-src 'self' …'），
 *      在頁面自己的環境（這裡）點就跟你手動按一樣。只點 page-agent.js 剛標記過的那一個元素。
 */
(() => {
  'use strict';
  if (window.__ITH_ALERT_HOOK__) return;
  window.__ITH_ALERT_HOOK__ = true;
  const DANGEROUS_CONFIRM = ['取消', '不保留', '放棄', '刪除', '清除'];
  let catchUntil = 0;   // 到這個時間之前接管對話框（page-agent.js 等結果的那幾秒）
  const catching = () => Date.now() < catchUntil;
  const tell = (msg, kind, extra) => {
    try { window.postMessage({ __ith: 'alert', kind, msg: String(msg == null ? '' : msg), ...extra }, location.origin); } catch (_) { /* 轉不出去就算了 */ }
  };
  const origAlert = window.alert;
  const origConfirm = window.confirm;
  window.alert = function (msg) {
    if (catching()) { tell(msg, 'alert', { caught: true }); return undefined; }
    tell(msg, 'alert', { caught: false });
    return origAlert.apply(this, arguments);
  };
  window.confirm = function (msg) {
    if (catching()) {
      const answer = !DANGEROUS_CONFIRM.some((w) => String(msg).includes(w));
      tell(msg, 'confirm', { caught: true, answer });
      return answer;
    }
    tell(msg, 'confirm', { caught: false });
    return origConfirm.apply(this, arguments);
  };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d) return;
    if (d.__ith === 'catch') {
      const ms = Number(d.ms);
      catchUntil = Number.isFinite(ms) && ms > 0 ? Date.now() + Math.min(ms, 120000) : 0;
      return;
    }
    if (d.__ith !== 'click' || typeof d.token !== 'string' || d.token.length > 40) return;
    const el = document.querySelector('[data-ith-click="' + CSS.escape(d.token) + '"]');
    if (!el) return;
    el.removeAttribute('data-ith-click');
    el.click();
  });
})();
