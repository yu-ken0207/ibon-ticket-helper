  /* ───────────────────────── 流程 ───────────────────────── */

  /** 把你要接手的元素框起來 */
  function handToUser(el) {
    if (!el) return;
    try {
      el.style.outline = '3px solid #d97706';
      el.style.outlineOffset = '2px';
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (_) { /* 看不到就算了 */ }
  }

  async function finish(ok, kind, msg, extra = {}) {
    const cls = ok ? 'ok' : (extra.handOff ? 'warn' : 'err');
    setStatus(msg, cls);
    setCountdown(null);
    panelLog(msg, cls);
    if (!ok) blackbox(kind, msg);
    await call('result', { ok, kind, msg, url: location.href, handOff: !!extra.handOff }, 1500);
  }

  /** 等場次表出現（最多 maxMs），回傳列 */
  async function waitSessions(maxMs) {
    const t0 = Date.now();
    let rows = sessionRows();
    while (!rows.length && Date.now() - t0 < maxMs && !state.aborted) {
      await sleep(300);
      rows = sessionRows();
    }
    return rows;
  }

  /** 重新整理再試一次：次數與間隔由背景程式決定 */
  async function retry(reason, msg, gotoUrl) {
    const r = await call('retry', { reason, msg }, 1500);
    if (!r || !r.allow) {
      const used = r && r.max != null ? `（已重試 ${r.count || 0}/${r.max} 次）` : '';
      return finish(false, reason === 'not-open' ? 'not-open-limit' : 'fail-limit', `${msg}，重試次數用完了${used}`, { handOff: true });
    }
    const action = gotoUrl ? '再前往' : '重新整理';
    setStatus(`${msg}，${(r.delayMs / 1000).toFixed(1)} 秒後${action}（${r.count}/${r.max}）`, 'warn');
    log(`${msg}，${action}（${r.count}/${r.max}）`, 'warn');
    await sleep(r.delayMs);
    if (state.aborted) return undefined;
    if (gotoUrl) location.href = gotoUrl;
    else location.reload();
    return undefined;
  }

  /** 頁面載入不出來（沒有場次表之類）：重新整理，間隔連續失敗才逐步拉長，最長 3 秒；連續失敗超過 5 分鐘交給你 */
  async function loadRetry(why) {
    const ask = () => call('retry', { reason: 'load', status: 0, msg: why }, 1500);
    let r = await ask();
    if (!r) { await sleep(1000); r = await ask(); }
    if (!r) { setStatus(`${why}。背景程式沒有回應，先停下來，請自己重新整理`, 'err'); return undefined; }
    if (!r.allow && r.count == null) { setStatus(`${why}。任務已經結束，不再重新整理`, 'err'); return undefined; }
    if (!r.allow) {
      const n = r.count ? `，已重新整理 ${r.count} 次` : '';
      return finish(false, 'load-limit', `${why}${n}。連續 5 分鐘都沒有恢復，先停下來，請自己重新整理看看`, { handOff: true });
    }
    setStatus(`${why}。${(r.delayMs / 1000).toFixed(1)} 秒後重新整理（第 ${r.count} 次）`, 'warn');
    log(`${why}，重新整理（第 ${r.count} 次）`, 'warn');
    await sleep(r.delayMs);
    if (state.aborted) return undefined;
    location.reload();
    return undefined;
  }

  /** 按下去之後等結果：網站用 alert 回報就接到；換頁成功時這個頁面已經卸載，由新頁面接手 */
  async function watchAfterClick(alertBefore, maxMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs && !state.aborted) {
      if (state.alerts.length > alertBefore) return { kind: 'alert', msg: state.alerts[state.alerts.length - 1] };
      await sleep(200);
    }
    return { kind: 'timeout' };
  }

  /** alert 的結果：登入問題交給你，其他算被拒絕，照額度重試 */
  async function handleAlert(out, label) {
    if (/登入|sign in|log in/i.test(out.msg)) return finish(false, 'guest', `ibon 要求登入：「${out.msg}」`, { handOff: true });
    blackbox('rejected', `ibon 回覆「${out.msg}」`);
    return retry('fail', `${label}時 ibon 回覆「${out.msg}」`);
  }

  /* ───────────────────────── 倒數 ───────────────────────── */

  async function runCountdown(d) {
    const cfg = d.cfg || {};
    const fireAt = d.targetTs + (cfg.fireOffsetMs == null ? 30 : cfg.fireOffsetMs);
    panel();
    setStatus('已排程，等待開賣', 'ok');
    await domReady();
    const rows = await waitSessions(15000);
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

  /* ───────────────────────── 各頁的動作 ───────────────────────── */

  async function runFlow(d) {
    if (state.running) return;
    state.running = true;
    state.aborted = false;
    const cfg = d.cfg || {};
    panel();
    setCountdown(null);
    try {
      await domReady();
      const kind = pageKind();
      if (kind === 'event') await runEvent(cfg, d);
      else if (kind === 'area') await runArea(cfg);
      else if (kind === 'qty') await runQty(cfg);
      else if (kind === 'buyer') await runBuyer(cfg);
    } catch (e) {
      await finish(false, 'error', '程式錯誤：' + (e && e.message ? e.message : e));
    } finally {
      state.running = false;
    }
  }

  /** 活動頁：找你選的場次，「線上購票」可按就點；還不能按就照尚未開賣重試 */
  async function runEvent(cfg, d) {
    setStatus('找場次中…', 'ok');
    const rows = await waitSessions(15000);
    if (state.aborted) return;
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
    const before = state.alerts.length;
    log(`場次「${sessionKey(cfg.sessionWhen)}」可以買了，按下「${info.button}」`);
    setStatus('按下線上購票…', 'ok');
    btn.click();
    const out = await watchAfterClick(before, 6000);
    if (out.kind === 'alert') return handleAlert(out, '按下線上購票');
    if (out.kind === 'timeout') return retry('fail', '按下線上購票後頁面沒有反應');
    return undefined;
  }

  /** 選票區頁：照關鍵字、排除字選票區 */
  async function runArea(cfg) {
    setStatus('選票區中…', 'ok');
    const t0 = Date.now();
    let rows = areaRows();
    while (!rows.length && Date.now() - t0 < 20000 && !state.aborted) {
      const b = blockerText();
      if (b) return finish(false, 'blocked-page', `頁面出現「${b}」，助手不處理，請你自己操作`, { handOff: true });
      await sleep(300);
      rows = areaRows();
    }
    if (state.aborted) return;
    if (!rows.length) return finish(false, 'no-area-table', '票區頁一直沒有出現票區表格。可能是 ibon 改版了，請直接看畫面', { handOff: true });
    const texts = rows.map(areaRowText);
    const pick = pickOption(texts.map((text) => ({ text })), cfg);
    if (pick.kind === 'sold-out') return finish(false, 'sold-out', `已售完：${pick.names.join('、')}`);
    if (pick.kind === 'blocked') return finish(false, 'blocked', `對到的票區都在排除清單裡：${pick.names.join('、')}`, { handOff: true });
    if (pick.kind === 'no-match') {
      const ex = pick.excluded ? `（另有 ${pick.excluded} 個票區在排除清單裡）` : '';
      return finish(false, 'no-match', `關鍵字比對不到任何票區。頁面上的票區有：${texts.join(' ／ ')}${ex}。請自己選`, { handOff: true });
    }
    if (pick.kind === 'fallback') log(`關鍵字都沒比對到，照遞補設定改選第一個還能買的：${pick.text}`, 'warn');
    else log(`選中票區：${pick.text}`);
    const row = rows[pick.index];
    const before = state.alerts.length;
    (row.querySelector('a[href], a[onclick]') || row).click();
    const out = await watchAfterClick(before, 8000);
    if (out.kind === 'alert') return handleAlert(out, '選票區');
    if (out.kind === 'timeout') return finish(false, 'no-advance', '選了票區但頁面沒有進到下一步，請自己看畫面', { handOff: true });
    return undefined;
  }

  /** 座位/數量頁：選票區價格（多票區才有）、選張數、按下一步；有驗證碼就停手 */
  async function runQty(cfg) {
    setStatus('選張數中…', 'ok');
    const t0 = Date.now();
    while (!qtyPrice() && !qtySelects().length && Date.now() - t0 < 20000 && !state.aborted) {
      const b = blockerText();
      if (b && !qtyCaptcha()) return finish(false, 'blocked-page', `頁面出現「${b}」，助手不處理，請你自己操作`, { handOff: true });
      await sleep(300);
    }
    if (state.aborted) return;
    const price = qtyPrice();
    if (price && price.selectedIndex <= 0) {
      const opts = [...price.options].slice(1).map((o) => ({ text: o.text, value: o.value }));
      const pick = pickOption(opts, cfg);
      if (pick.kind === 'sold-out') return finish(false, 'sold-out', `已售完：${pick.names.join('、')}`);
      if (pick.kind === 'blocked') return finish(false, 'blocked', `對到的票區都在排除清單裡：${pick.names.join('、')}`, { handOff: true });
      if (pick.kind === 'no-match') return finish(false, 'no-match', `關鍵字比對不到任何票區。可選的有：${opts.map((o) => o.text).join(' ／ ')}。請自己選`, { handOff: true });
      log(pick.kind === 'fallback' ? `關鍵字都沒比對到，改選第一個還能買的：${pick.text}` : `選中票區：${pick.text}`, pick.kind === 'fallback' ? 'warn' : 'info');
      if (!setSelect(price, opts[pick.index].value)) return finish(false, 'fill-failed', '票區價格選不起來', { handOff: true });
      await sleep(4000);   // ibon 會回傳重畫整頁；換頁的話這個頁面已經卸載，由新頁面接著做
      if (state.aborted) return;
      if (!qtySelects().length) return finish(false, 'no-qty', '選了票區價格但沒有出現購買數量，請自己看畫面', { handOff: true });
    }
    const sel = qtySelects()[0];
    if (!sel) return finish(false, 'no-qty', '找不到「購買數量」的下拉選單。可能是 ibon 改版了，請直接看畫面', { handOff: true });
    const have = [...sel.options].map((o) => Number(o.value)).filter((n) => Number.isFinite(n) && n > 0);
    const want = Math.max(1, Math.min(Number(cfg.qty) || 1, 10));
    if (!have.length) return finish(false, 'sold-out', '這個票區沒有可以選的張數（可能剛賣完）');
    if (Math.max(...have) < want) return finish(false, 'qty-limit', `你要 ${want} 張，但這個票區最多只能選 ${Math.max(...have)} 張。請自己決定要不要買`, { handOff: true });
    if (!setSelect(sel, want)) return finish(false, 'fill-failed', `張數選不到 ${want}`, { handOff: true });
    log(`已選張數 ${want}`);
    if (qtyCaptcha()) {
      handToUser(qtyCaptcha());
      return finish(false, 'captcha', '張數選好了。這一頁有驗證碼，請自己輸入後按下一步', { handOff: true });
    }
    const next = qtyNext();
    if (!next) return finish(false, 'no-next', '找不到「下一步」按鈕，請自己按', { handOff: true });
    const before = state.alerts.length;
    next.click();
    log('按下「下一步」');
    setStatus('已按下一步…', 'ok');
    const out = await watchAfterClick(before, 8000);
    if (out.kind === 'alert') return handleAlert(out, '按下一步');
    if (out.kind === 'timeout') return finish(false, 'timeout', '按下一步後頁面一直沒有反應，請自己看畫面', { handOff: true });
    return undefined;
  }

  /** 填購票資訊頁：勾同意、按下一步。不改你的資料（電話、Email 是會員資料，ibon 已經帶好） */
  async function runBuyer(cfg) {
    setStatus('填購票資訊頁…', 'ok');
    const t0 = Date.now();
    while ((!buyerAgree() || !buyerNext()) && Date.now() - t0 < 15000 && !state.aborted) await sleep(300);
    if (state.aborted) return;
    const agree = buyerAgree();
    const next = buyerNext();
    if (!agree || !next) return finish(false, 'no-buyer-form', '找不到「同意」或「下一步」，請自己操作', { handOff: true });
    if (cfg.autoAgree === false) {
      handToUser(agree);
      return finish(false, 'agree', '你設定不自動勾選同意。請自己閱讀後勾選並按下一步', { handOff: true });
    }
    if (!agree.checked) agree.click();
    await sleep(150);
    if (!agree.checked) return finish(false, 'agree-failed', '同意條款勾不起來，請自己勾選', { handOff: true });
    log('已勾選同意約款');
    const before = state.alerts.length;
    next.click();
    log('按下「下一步」');
    const out = await watchAfterClick(before, 8000);
    if (out.kind === 'alert') return handleAlert(out, '按下一步');
    if (out.kind === 'timeout') return finish(false, 'timeout', '按下一步後頁面一直沒有反應，請自己看畫面', { handOff: true });
    return undefined;
  }

  function showSuccess(d) {
    panel();
    const took = d.since ? `從開賣到保留花了 ${((Date.now() - d.since) / 1000).toFixed(1)} 秒。` : '';
    setStatus(`已保留名額！${took}請確認訂單後自己付款，保留有時間限制。`, 'ok');
    panelLog('助手到這裡就停手，不會替你確認訂單或付款', 'ok');
  }

  function stopLocal(reason) {
    state.aborted = true;
    state.mode = 'idle';
    if (state.panel) {
      setStatus(reason, 'err');
      setCountdown(null);
    }
  }

  function onCommand(c) {
    if (c.cmd === 'abort') { stopLocal(c.reason || '已取消'); return; }
    if (c.cmd === 'run') {
      state.aborted = false;
      state.mode = 'run';
      runFlow({ cfg: c.cfg || {}, since: c.since });
    }
  }

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

  function handleDirective(d) {
    state.mode = (d && d.mode) || 'idle';
    switch (d && d.mode) {
      case 'countdown': return runCountdown(d);
      case 'run': return runFlow(d);
      case 'check': return runCheck(d);
      case 'health': return runHealth(d);
      case 'success': return showSuccess(d);
      default: return undefined;   // 沒有任務：什麼都不做
    }
  }
