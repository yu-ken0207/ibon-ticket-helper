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

  /**
   * 等到 cond() 回傳真值，回傳那個值；逾時、取消或頁面開始離開回 null。
   * 頁面一有變動就馬上再看一次（MutationObserver，同一批變動只看一次）；封閉 Shadow DOM 裡的變動觀察不到
   * （ibon 的場次表、票區表都在裡面），所以另外每 50 毫秒看一次。
   * slow() 是比較重的檢查（找排隊、人類驗證的字樣要讀整頁文字），每 slowEvery 毫秒才看一次，回傳真值也會結束等待。
   */
  function waitFor(cond, maxMs, slow = null, slowEvery = 500) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let done = false;
      let timer = 0;
      let queued = false;
      let slowAt = 0;
      const obs = new MutationObserver(() => {
        if (queued || done) return;
        queued = true;
        setTimeout(() => { queued = false; check(); }, 0);
      });
      const stop = (v) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        resolve(v);
      };
      function check() {
        if (done) return;
        if (state.aborted || state.leaving) { stop(null); return; }
        const v = cond();
        if (v) { stop(v); return; }
        if (slow && Date.now() - slowAt >= slowEvery) {
          slowAt = Date.now();
          const w = slow();
          if (w) { stop(w); return; }
        }
        if (Date.now() - t0 >= maxMs) stop(null);
      }
      obs.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true });
      const tick = () => { check(); if (!done) timer = setTimeout(tick, 50); };
      tick();
    });
  }

  /** 等場次表出現（最多 maxMs），回傳列 */
  async function waitSessions(maxMs) {
    const rows = await waitFor(() => { const r = sessionRows(); return r.length ? r : null; }, maxMs);
    return rows || [];
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
   * 等 ibon 的背景更新做完：選了張數、勾了同意之後，ibon 可能在背景送請求更新頁面（重算金額、重畫表格）。
   * 更新到一半就按下一步，兩個請求可能撞在一起（2026-10-16 選張數到按下一步只隔 4 毫秒時一直轉圈）。
   * 做完的條件：頁面自己的網路請求都回來了（alert-hook.js 數的）、而且連續 quietMs 毫秒沒有畫面變動；
   * 至少等 minMs，讓網頁的 change 事件有時間把請求送出去。最多等 maxMs。頁面開始離開就馬上結束。
   * 0.9.4 以前是固定至少等 0.8 秒，這裡改成看請求，通常幾百毫秒就好。
   */
  function settle(quietMs = 150, maxMs = 8000, minMs = 250) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let last = Date.now();
      const obs = new MutationObserver(() => { last = Date.now(); });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      const tick = () => {
        const t = Date.now();
        const quiet = t - t0 >= minMs && t - last >= quietMs && !netBusy();
        if (quiet || state.leaving || state.aborted || t - t0 >= maxMs) { obs.disconnect(); resolve(t - t0); return; }
        setTimeout(tick, 25);
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
      if (state.leaving) return { kind: 'leaving' };   // 換頁了：由新頁面接手
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
  async function clickAndWatch(el, maxMs, label, clicker = pageClick) {
    const before = state.alerts.length;
    window.postMessage({ __ith: 'catch', ms: maxMs + 2000 }, location.origin);
    clicker(el);
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
