  /* ───────────────────────── 黑盒子 ─────────────────────────
   * 失敗或停下來交給你時，記下當下頁面的重點，可以從擴充功能匯出。手機、Email 會遮掉，不記欄位裡填的值。 */
  function snapshot(kind, msg) {
    const vis = $$('button, a.btn, input[type="submit"]').filter(isVisible);
    const alerts = $$('[role="alert"]').filter((e) => !e.hidden && isVisible(e)).map((e) => maskText(norm(e.textContent)).slice(0, 200)).filter(Boolean);
    return {
      at: Date.now(), kind, msg: maskText(String(msg || '')).slice(0, 300),
      url: location.href, title: norm(document.title).slice(0, 80), page: SITE ? SITE.pageKind() : 'other',
      buttons: vis.map((b) => norm(b.textContent || b.value).slice(0, 30)).filter(Boolean).slice(0, 15),
      modals: alerts.slice(0, 5),
      text: SITE && ['info', 'confirm'].includes(SITE.pageKind()) ? '' : maskText(SITE ? SITE.mainText() : ''),
    };
  }

  const boxed = new Set();
  function blackbox(kind, msg, once = false) {
    if (once && boxed.has(kind)) return;
    boxed.add(kind);
    try { send('blackbox', snapshot(kind, msg)); } catch (_) { /* 記錄失敗不影響流程 */ }
  }
