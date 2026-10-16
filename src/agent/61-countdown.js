  /* ───────────────────────── 活動頁：倒數 ─────────────────────────
   * 開賣前在活動頁：檢查你選的場次、健檢、對時，倒數到開賣時間再重新整理。 */
  async function runCountdown(d) {
    const cfg = d.cfg || {};
    const fireAt = d.targetTs + (cfg.fireOffsetMs == null ? 30 : cfg.fireOffsetMs);
    panel();
    setStatus('已排程，等待開賣', 'ok');
    await domReady();
    const rows = await waitSessions(15000);
    if (!rows.length && challengeText()) {
      // 檢查頁通過後會自己重新載入，載入後由新頁面接著倒數
      setStatus('ibon 正在驗證您是否是人類，請等它通過（助手不處理，也不重新整理）', 'warn');
      send('warn', { kind: 'challenge', msg: 'ibon 顯示「正在驗證您是否是人類」。請讓它自己通過，通過後助手會照常倒數。' });
    }
    if (loginState() === 'logged-out') {
      setStatus('還沒登入 ibon！請先登入，登入後回到這一頁', 'err');
      send('warn', { kind: 'guest', msg: '活動頁顯示你還沒登入。請在開賣前登入，否則時間到也買不了票。' });
    }
    // 開賣前場次就看得到：先檢查你選的場次有沒有，選錯現在就會發現，不用等到開賣
    if (rows.length) {
      const col = columnsOf(sessionHeader());
      const hit = rows.filter((r) => sessionKey(readRow(r, col).when) === sessionKey(cfg.sessionWhen));
      if (hit.length === 1) log(`找到場次：${sessionKey(cfg.sessionWhen)}`, 'ok');
      else {
        const msg = hit.length ? `有多列相同演出時間「${sessionKey(cfg.sessionWhen)}」，助手不知道該選哪一個` : `活動頁上找不到你選的場次「${sessionKey(cfg.sessionWhen)}」`;
        log(msg, 'warn');
        send('warn', { kind: 'session', msg });
      }
      const h = healthItems(cfg);
      send('health', { context: 'preopen', worst: h.worst, items: h.items, bundles: h.bundles });
    } else {
      log('現在還讀不到場次表，開賣時重新整理會再試', 'warn');
    }
    if (cfg.syncClock !== false) {
      await doSync('已與 ibon 伺服器對時');
      if (!state.clockReliable) resyncWhenVisible(fireAt);
      if (fireAt - now() > 45000) {
        if (!(await waitUntil(fireAt - 30000))) return;
        await doSync('開賣前再對時一次');
      }
    }
    // 頁面本身就是在開賣之後才載入的（例如視窗開晚了）
    const loadedAt = performance.timeOrigin + state.clockOffset;
    if (loadedAt >= fireAt) {
      await call('fired', { at: Date.now(), drift: Math.round(now() - fireAt) }, 800);
      return runFlow({ cfg, since: Date.now() });
    }
    // 開賣前 0.3 秒先跟背景程式報備「要重新整理了」，等它回覆；到點時就不用再等，重新整理可以立刻發出
    if (!(await waitUntil(fireAt - 300))) return;
    await call('fired', { at: Date.now(), drift: null }, 800);
    if (!(await waitUntil(fireAt))) return;
    const drift = Math.round(now() - fireAt);
    setStatus('開賣時間到，重新整理…', 'ok');
    send('fired-drift', { drift });   // 只是紀錄誤差，不等回覆
    location.reload();
  }

