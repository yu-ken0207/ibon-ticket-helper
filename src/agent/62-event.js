  /* ───────────────────────── 活動頁：點場次 ───────────────────────── */

  /** 活動頁：找你選的場次，「線上購票」可按就點；還不能按就照尚未開賣重試 */
  async function runEvent(cfg, d) {
    setStatus('找場次中…', 'ok');
    let rows = await waitSessions(15000);
    if (state.aborted) return;
    if (!rows.length && challengeText()) {
      if (!(await waitChallenge(60000))) return finish(false, 'challenge', 'ibon 的「正在驗證您是否是人類」一分鐘還沒通過，請你自己看畫面', { handOff: true });
      rows = await waitSessions(15000);
      if (state.aborted) return;
    }
    if (!rows.length) return loadRetry('ibon 活動頁沒有出現場次表');
    if (d && d.loadFail) send('load-ok', {});
    if (loginState() === 'logged-out') {
      return finish(false, 'guest', '目前沒有登入 ibon，所以沒有動作。請登入後在擴充功能按「立即執行」', { handOff: true });
    }
    const col = columnsOf(sessionHeader());
    const hit = rows.filter((r) => sessionKey(readRow(r, col).when) === sessionKey(cfg.sessionWhen));
    if (hit.length !== 1) {
      const names = rows.map((r) => sessionKey(readRow(r, col).when)).join('、');
      return finish(false, 'no-session', hit.length
        ? `有多列相同演出時間「${sessionKey(cfg.sessionWhen)}」，不知道該選哪一個`
        : `找不到場次「${sessionKey(cfg.sessionWhen)}」。頁面上的場次有：${names}`, { handOff: true });
    }
    const info = readRow(hit[0], col);
    const st = sessionStatus(info.button, info.disabled);
    const btn = hit[0].querySelector('button, a[role="button"], a.btn');
    if (st.status === 'sold-out') return finish(false, 'sold-out', `場次「${sessionKey(cfg.sessionWhen)}」已售完`);
    if (st.status === 'closed') return finish(false, 'closed', `場次「${sessionKey(cfg.sessionWhen)}」已截止`);
    if (!btn || st.status !== 'on-sale') {
      return retry('not-open', `場次「${sessionKey(cfg.sessionWhen)}」還不能買（按鈕：${info.button || '沒有'}${info.disabled ? '，灰的' : ''}）`);
    }
    log(`場次「${sessionKey(cfg.sessionWhen)}」可以買了，按下「${info.button}」`);
    setStatus('按下線上購票…', 'ok');
    const out = await clickAndWatch(btn, 20000, '正在進入購票流程');
    if (out.kind === 'alert') return handleAlert(out, '按下線上購票');
    if (out.kind === 'timeout') return retry('fail', '按下線上購票後 20 秒頁面沒有反應');
    return undefined;
  }

