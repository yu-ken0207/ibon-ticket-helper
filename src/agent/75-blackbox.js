  /* ───────────────────────── 黑盒子 ─────────────────────────
   * 遇到失敗、交手、被拒、排隊頁時，記下當下頁面的重點，可以從擴充功能匯出。
   * 真站沒測過的狀況一旦真的發生，就能拿回來補進假網站。只記頁面上看得到的字，不記導覽列和個人資料；
   * 網址只留路徑，不帶參數。 */
  function safeUrl() {
    return location.origin + location.pathname;
  }

  function snapshot(kind, msg) {
    const vis = [...document.querySelectorAll('button, a.btn, input[type="submit"]')].filter(isVisible);
    const content = $('#content') || $('main') || document.body;
    const rows = pageKind() === 'area' ? areaRows().map((r) => areaInfo(r, 1).text) : sessionRows().map((r) => norm(r.textContent));
    return {
      at: Date.now(), kind, msg: String(msg || '').slice(0, 300),
      url: safeUrl(), title: norm(document.title).slice(0, 80), page: pageKind(), login: loginState(),
      rows: rows.length, rowSample: rows.slice(0, 4).map((r) => r.slice(0, 60)),
      buttons: vis.map((b) => norm(b.textContent || b.value).slice(0, 30)).filter(Boolean).slice(0, 15),
      modals: [...document.querySelectorAll('.modal, [role="dialog"], .alert')].filter(isVisible).map((m) => norm(m.innerText).slice(0, 200)).slice(0, 5),
      alerts: state.alerts.slice(-3),
      text: content ? norm(content.innerText || '').slice(0, 800) : '',
    };
  }

  const boxed = new Set();
  /** 記一筆黑盒子；once 為真時同一種狀況在這一頁只記一次 */
  function blackbox(kind, msg, once = false) {
    if (once && boxed.has(kind)) return;
    boxed.add(kind);
    try { send('blackbox', snapshot(kind, msg)); } catch (_) { /* 記錄失敗不影響流程 */ }
  }
