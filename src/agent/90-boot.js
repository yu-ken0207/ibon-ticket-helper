  /* ───────────────────────── 啟動 ─────────────────────────
   * DOM 準備好後確認是認得的網站，再問背景程式這一頁該做什麼。沒有任務就什麼都不做。 */

  function handleDirective(d) {
    state.mode = (d && d.mode) || 'idle';
    switch (d && d.mode) {
      case 'countdown': return runCountdown(d);
      case 'run': return runFlow(d);
      case 'check': return runCheck(d);
      case 'health': return runHealth(d);
      case 'success': return showSuccess(d);
      case 'confirm-wait': panel(); return onConfirm(d, true);   // 已經交給你了：重新整理確認頁時繼續提醒保留時間
      case 'paused': panel(); setStatus('已暫停：到擴充功能按「繼續」，從這一頁接著做', 'warn'); return undefined;
      default: return undefined;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.cmd && SITE) onCommand(msg);
  });

  (async () => {
    await domReady();
    SITE = pickSite();
    if (!SITE) return;
    for (let i = 0; i < 20; i++) {
      const res = await call('hello', { kind: SITE.pageKind(), url: location.href }, 1500);
      if (res) { handleDirective(res); return; }
      await sleep(250);   // 背景程式剛被叫醒，稍等再問
    }
  })();
})();
