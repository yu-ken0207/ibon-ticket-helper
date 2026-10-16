  /* ───────────────────────── 讀取活動（彈出視窗的「讀取活動」） ───────────────────────── */

  /** 「讀取活動」「檢查」按鈕：在背景分頁讀場次、開賣時間、票價，回報後由 background 關掉分頁。不按任何東西 */
  async function runCheck(d) {
    const cfg = d.cfg || {};
    const report = (r) => call('check-result', r, 1500);
    panel();
    setStatus('讀取活動中…', 'ok');
    await domReady();
    if (pageKind() !== 'event') return report({ ok: false, error: '這不是 ibon 活動頁，請確認活動網址' });
    const raw = await readIbonActivity(20000);
    const info = buildEventInfo(raw, Date.now());
    if (!info.sessions.length) {
      return report({ ok: false, error: '沒有讀到任何場次（可能還沒開放、已下架，或頁面結構改了）', title: info.title });
    }
    const sale = (info.saleTimes || [])[0];
    const sessions = info.sessions.map((s) => ({ when: s.when, name: s.name, status: s.status, statusLabel: s.statusLabel }));
    const matched = cfg.sessionWhen ? sessions.filter((s) => sessionKey(s.when) === sessionKey(cfg.sessionWhen)).length : null;
    const saleTxt = sale ? sale.at.replace('T', ' ').replace(/-/g, '/') : '節目介紹裡讀不到開賣時間';
    const msg = `${info.title || '活動'}：${sessions.length} 個場次，開賣 ${saleTxt}`
      + (matched === 0 ? `。注意：你選的場次「${sessionKey(cfg.sessionWhen)}」不在這個清單裡` : '');
    setStatus(msg, matched === 0 ? 'err' : 'ok');
    return report({
      ok: matched !== 0, msg, title: info.title, sessions, saleAt: sale ? sale.at : null,
      prices: info.prices, limits: info.limits, warnings: raw.warnings || [],
    });
  }

