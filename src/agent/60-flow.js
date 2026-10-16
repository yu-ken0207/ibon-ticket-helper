  /* ───────────────────────── 流程：共用的工具與分派 ─────────────────────────
   * 各頁的動作分在 61～67：61-countdown 活動頁倒數、62-event 活動頁點場次、63-verify 驗證問題頁、
   * 64-area 選票區頁、65-qty 座位/數量頁、66-buyer 填購票資訊頁、67-check 讀取活動。 */

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

  /**
   * 等頁面安靜下來：選了張數、勾了同意之後，ibon 會在背景更新頁面（重算金額、重畫表格）。
   * 更新到一半就按下一步，兩個請求撞在一起，ibon 會一直轉圈（2026-10-16 實測：選張數與按下一步只隔 4 毫秒就卡住）。
   * 所以先等「連續 quietMs 毫秒沒有任何頁面變動」，最多等 maxMs；至少等 minMs，讓網頁的 change 事件有時間開始動作。
   */
  function settle(quietMs = 400, maxMs = 6000, minMs = 300) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let last = Date.now();
      const obs = new MutationObserver(() => { last = Date.now(); });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      const tick = () => {
        const t = Date.now();
        if ((t - t0 >= minMs && t - last >= quietMs) || t - t0 >= maxMs) { obs.disconnect(); resolve(t - t0); return; }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  /** 按下去之後等結果：網站用 alert 回報就接到；換頁成功時這個頁面已經卸載，由新頁面接手 */
  async function watchAfterClick(alertBefore, maxMs = 45000, label = '處理中') {
    const t0 = Date.now();
    let shown = 0;
    while (Date.now() - t0 < maxMs && !state.aborted) {
      if (state.alerts.length > alertBefore) return { kind: 'alert', msg: state.alerts[state.alerts.length - 1] };
      const sec = Math.floor((Date.now() - t0) / 1000);
      if (sec >= 3 && sec !== shown) { shown = sec; setStatus(`ibon ${label}，已等 ${sec} 秒…先不要重新整理`, 'ok'); }
      await sleep(200);
    }
    return { kind: 'timeout' };
  }

  /**
   * ibon 的「正在驗證您是否是人類」檢查頁：等它自己通過（通過後頁面會重新載入，由新頁面接手），
   * 這段時間不重新整理、不點任何東西。過了 maxMs 還在就回 false。
   */
  async function waitChallenge(maxMs = 60000) {
    const t0 = Date.now();
    while (challengeText() && Date.now() - t0 < maxMs && !state.aborted) {
      setStatus(`ibon 正在驗證您是否是人類，請等它通過（已等 ${Math.floor((Date.now() - t0) / 1000)} 秒；助手不處理，也不重新整理）`, 'warn');
      await sleep(500);
    }
    return !challengeText();
  }

  /**
   * 按下去並等結果。等的這段時間請 alert-hook.js 接管對話框：alert 不跳出來（不然頁面會停住、要你按確定），
   * 照 kktix 助手「只在等結果的那幾秒接管」的做法，等完就交還。換頁成功時這個頁面已經卸載，新頁面一開始就不接管。
   */
  async function clickAndWatch(el, maxMs, label) {
    const before = state.alerts.length;
    window.postMessage({ __ith: 'catch', ms: maxMs + 2000 }, location.origin);
    pageClick(el);
    try {
      return await watchAfterClick(before, maxMs, label);
    } finally {
      window.postMessage({ __ith: 'catch', ms: 0 }, location.origin);
    }
  }

  /* 售完的票區：記在背景程式的任務裡，回到選區頁時跳過，改選下一個（tickets_hunter 也是售完就回選區頁換別區）。 */
  const SOLD_OUT_MSG = /已售完|售完|選購一空|尚無票|額滿|已無票|No tickets available|Sold out/i;

  /** 這個票區是不是之前售完過：記的可能是「1F 鐵粉席 1,000」或只有「鐵粉席」，互相包含就算 */
  function isFailedArea(name, failed) {
    const n = norm(name);
    return !!n && (failed || []).some((f) => { const x = norm(f); return !!x && (x.includes(n) || n.includes(x)); });
  }

  async function markAreaFailed(text) {
    if (!text) return;
    log(`票區「${text}」賣完了，之後跳過它`, 'warn');
    await call('area-failed', { text }, 1500);
  }

  /**
   * alert 的結果：登入問題交給你；說售完而且知道是哪個票區 → 記下來，回選區頁（或重新整理這頁）換下一個；
   * 其他算被拒絕，照額度重試。opts：{ areaText 這次選的票區, areaUrl 選區頁網址（在座位/數量頁才有） }
   */
  async function handleAlert(out, label, opts = {}) {
    if (/登入|sign in|log in/i.test(out.msg)) return finish(false, 'guest', `ibon 要求登入：「${out.msg}」`, { handOff: true });
    blackbox('rejected', `ibon 回覆「${out.msg}」`);
    if (SOLD_OUT_MSG.test(out.msg) && opts.areaText) {
      await markAreaFailed(opts.areaText);
      return retry('fail', `${label}時 ibon 回覆「${out.msg}」，換別的票區`, opts.areaUrl);
    }
    return retry('fail', `${label}時 ibon 回覆「${out.msg}」`);
  }

  /* ───────────────────────── 分派 ───────────────────────── */

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
      else if (kind === 'verify') await runVerify(cfg);
      else if (kind === 'area') await runArea(cfg, d);
      else if (kind === 'qty') await runQty(cfg, d);
      else if (kind === 'buyer') await runBuyer(cfg);
    } catch (e) {
      await finish(false, 'error', '程式錯誤：' + (e && e.message ? e.message : e));
    } finally {
      state.running = false;
    }
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
