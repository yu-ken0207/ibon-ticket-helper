  /* ───────────────────────── 通用購票流程 ─────────────────────────
   * 每次載入頁面都問背景程式該做什麼（90-boot.js），run 模式就照這一頁是哪一步來做一步：
   *   list     讀時段狀態 → 照偏好選時段（還沒開放就等、讀取失敗就重試）→ 進選票頁
   *   select   照設定填各票種張數 → 送出一次 → 被拒就看原因：換時段、重試或停下來
   *   info     檢查你提供的資料 → 填好、勾同意 → 送出一次 → 網站說哪一欄有問題就交給你
   *   confirm  一定停在這裡：標出「確認建立訂單」，請你自己檢查後按；之後提醒保留時間
   *   queue    網站要排隊：停下來交給你，不略過排隊
   *   error    網站錯誤頁：暫時性錯誤就重新整理（有次數上限），其他交給你
   * 判斷寫在 lib/flow.js；頁面怎麼讀寫寫在網站轉接（10-pool.js）。 */

  const totalWanted = (cfg) => (cfg.tickets || []).reduce((a, t) => a + (Number.isInteger(t.qty) && t.qty > 0 ? t.qty : 0), 0) || 1;

  async function finish(ok, kind, msg, extra = {}) {
    const cls = ok ? 'ok' : (extra.handOff ? 'warn' : 'err');
    setStatus(msg, cls);
    setCountdown(null);
    panelLog(msg, cls);
    if (!ok) blackbox(kind, msg);
    await call('result', { ok, kind, msg, url: location.href, handOff: !!extra.handOff }, 1500);
  }

  /** 向背景程式要一次重試額度（load 載入失敗／not-open 還沒開放／fail 其他失敗），拿到就等它給的時間 */
  async function grant(reason, msg, status = 0) {
    const r = await call('retry', { reason, msg, status }, 1500);
    if (!r || !r.allow) return null;
    const of = r.max ? `${r.count}/${r.max}` : `第 ${r.count} 次`;
    setStatus(`${msg}，${(r.delayMs / 1000).toFixed(1)} 秒後再試（${of}）`, 'warn');
    log(`${msg}，再試一次（${of}）`, 'warn');
    await sleep(r.delayMs);
    return state.aborted || state.left ? null : r;
  }

  /**
   * 等時段列表讀完（成功或失敗）；逾時回傳 null。
   * prevStamp 是按「更新狀態」之前的第一列：舊的列還留在畫面上時不算讀完，要等換成新的（或出現錯誤）。
   */
  async function waitList(maxMs, prevStamp = null) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (state.aborted || state.left) return null;
      const s = SITE.listState();
      if (!s.loading && (s.error || (s.slots && s.stamp !== prevStamp))) return s;
      await sleep(100);
    }
    return null;
  }

  /** 按「更新狀態」，回傳按之前的第一列（給 waitList 分辨新舊） */
  function refreshList() {
    const before = SITE.listState().stamp;
    SITE.refreshList();
    return before;
  }

  /**
   * 送出這一步（select／info）：同一次只按一次，按了就等結果，不會因為等太久又按。
   * 要再送一定是錯誤處理決定的（伺服器錯誤之類），而且向背景程式要額度、有次數上限。
   */
  async function submitOnce(stepName, d, slotId) {
    for (;;) {
      if (state.aborted || state.left) return;
      const clicked = stepName === 'select' ? SITE.submitSelect() : SITE.submitInfo();
      if (!clicked) return finish(false, 'no-button', '找不到送出按鈕，先停下來', { handOff: true });
      setStatus('已送出，等網站回應…', 'ok');
      const out = await waitOutcomeFor(stepName, 60000);
      if (out.kind === 'left') return;
      if (out.kind === 'timeout') return finish(false, 'timeout', '送出後 60 秒都沒有回應，先停下來。請看頁面上的狀況，不要急著再按', { handOff: true });
      const what = `網站回覆「${out.text}」`;
      const action = classifyError(out.code, out.status);
      if (action === 'next-slot') {
        if (slotId) await call('skip-slot', { slotId }, 1500);
        log(`${what}，改選下一個時段`, 'warn');
        location.assign(SITE.listUrl());
        return;
      }
      if (action === 'retry') {
        const r = await grant('fail', what);
        if (!r) return finish(false, 'fail-limit', `${what}，重試次數用完了`, { handOff: true });
        continue;   // 前一次確定失敗了，才再送一次
      }
      if (action === 'reload') {
        // 表單權杖過期之類：重新整理這一頁拿新的，這一步會重新做一次（有次數上限）
        const r = await grant('fail', what);
        if (!r) return finish(false, 'fail-limit', `${what}，重試次數用完了`, { handOff: true });
        location.reload();
        return;
      }
      if (action === 'duplicate') {
        // 網站說已經收到了：上一次其實送到了，不要再送，往下一步看看
        log(`${what}，上一次其實已經送到了，不再重送`, 'warn');
        location.assign(SITE.nextUrl(stepName));
        return;
      }
      if (action === 'wait' || action === 'restart') {
        const r = await grant('fail', what);
        if (!r) return finish(false, 'fail-limit', `${what}，重試次數用完了`, { handOff: true });
        location.assign(SITE.listUrl());
        return;
      }
      if (action === 'gate') return finish(false, out.code.toLowerCase(), `${what}。這一關要你自己處理，助手先停下來`, { handOff: true });
      const fields = Object.entries(out.fields || {}).map(([k, v]) => `${k}：${v}`).join('；');
      return finish(false, out.code || 'rejected', `${what}${fields ? `（${fields}）` : ''}。資料可能要修改，先停下來`, { handOff: true });
    }
  }

  /** 按一下送出後等網站回應：換頁的話這一頁的助手就結束了（新頁面的助手接手）；出現錯誤訊息就回傳它 */
  async function waitOutcomeFor(stepName, maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (state.aborted || state.left) return { kind: 'left' };
      const text = SITE.formError();
      if (text) return { kind: 'error', ...SITE.parseError(text), fields: stepName === 'info' ? SITE.fieldErrors() : {} };
      await sleep(100);
    }
    return { kind: 'timeout' };
  }

  async function onList(d) {
    const cfg = d.cfg || {};
    const need = totalWanted(cfg);
    let prev = null;
    for (;;) {
      if (state.aborted || state.left) return;
      const ls = await waitList(30000, prev);
      if (!ls) {
        const r = await grant('load', '時段列表等了 30 秒還沒出來');
        if (!r) return finish(false, 'list-timeout', '時段列表一直沒有出來，先停下來', { handOff: true });
        location.reload();
        return;
      }
      if (ls.error) {
        const r = await grant('load', `時段載入失敗：${ls.error.replace(/。請按.*$/, '')}`, ls.status);
        if (!r) return finish(false, 'load-limit', `${ls.error}。連續 5 分鐘都沒有恢復，先停下來`, { handOff: true });
        prev = refreshList();
        await sleep(50);
        continue;
      }
      send('load-ok', {});
      const pick = pickSlot(ls.slots, cfg.keywords, { need, fallback: cfg.fallback, skip: d.skip || [] });
      if (pick.kind === 'ok') {
        log(describePick(pick, need), 'ok');
        setStatus(`前往「${pick.slot.text}」選票種…`, 'ok');
        if (!SITE.openSlot(pick.slot)) return finish(false, 'no-button', '找不到這個時段的選購按鈕，先停下來', { handOff: true });
        return;
      }
      if (pick.kind === 'not-open') {
        const r = await grant('not-open', describePick(pick, need));
        if (!r) return finish(false, 'not-open-limit', `${describePick(pick, need)}，重試次數用完了`);
        prev = refreshList();
        await sleep(50);
        continue;
      }
      return finish(false, pick.kind, describePick(pick, need));
    }
  }

  async function onSelect(d) {
    const cfg = d.cfg || {};
    const info = SITE.selectInfo();
    if (info.status === 'full' || info.status === 'not-open') {
      if (info.status === 'full' && info.slotId) await call('skip-slot', { slotId: info.slotId }, 1500);
      log(`「${info.text}」${info.status === 'full' ? '已額滿' : '還沒開放'}，回時段列表`, 'warn');
      location.assign(SITE.listUrl());
      return;
    }
    const types = SITE.ticketTypes();
    if (!types.length) return finish(false, 'no-types', '選票頁上找不到票種，先停下來', { handOff: true });
    const plan = planTickets(types, cfg.tickets, SITE.maxPerOrder());
    if (!plan.ok) return finish(false, 'tickets', plan.msg, { handOff: true });
    for (const p of plan.plan) SITE.setQty(p.id, p.qty);
    const bad = plan.plan.find((p) => SITE.qtyOf(p.id) !== p.qty);
    if (bad) return finish(false, 'fill-failed', `「${bad.name}」的張數填不進去，先停下來`, { handOff: true });
    log(`張數：${plan.plan.map((p) => `${p.name} ${p.qty}`).join('、')}，共 ${plan.total} 張、NT$${plan.amount}`);
    return submitOnce('select', d, info.slotId);
  }

  async function onInfo(d) {
    const cfg = d.cfg || {};
    const chk = checkProfile(cfg.profile);
    if (!chk.ok) return finish(false, 'profile', `購票人資料不完整（${describeProfileProblem(chk)}），請在擴充功能補上後按「繼續」`, { handOff: true });
    const r = SITE.fillProfile(chk.profile);
    if (r.missing.length) return finish(false, 'fill-failed', `這些欄位找不到或填不進去：${r.missing.join('、')}，先停下來`, { handOff: true });
    if (SITE.hasAgree()) {
      if (cfg.autoAgree === false) return finish(false, 'agree', '資料已填好。你設定不自動勾選同意，請自己閱讀並勾選後按「下一步」', { handOff: true });
      if (!SITE.setAgree(true)) return finish(false, 'agree-failed', '同意使用須知勾不起來，先停下來', { handOff: true });
    }
    log(`已填購票人資料：${maskText(`${chk.profile.name.slice(0, 1)}** ${chk.profile.phone} ${chk.profile.email}`)}${SITE.hasAgree() ? '，已勾選同意' : ''}`);
    return submitOnce('info', d, null);
  }

  /** 確認頁：只檢查、標出按鈕、提醒你，絕不替你按 */
  async function onConfirm(d, alreadyReported = false) {
    const g = SITE.confirmGates();
    const btn = SITE.confirmButton();
    if (btn) { btn.style.outline = '3px solid #d97706'; btn.style.outlineOffset = '3px'; }
    const left = SITE.holdLeft();
    const extra = [g.captcha && '輸入驗證碼', g.botcheck && '自己完成「我不是機器人」檢查'].filter(Boolean);
    const msg = `已到確認頁${left != null ? `，名額保留中（約剩 ${left} 秒）` : ''}。請檢查訂單內容${extra.length ? '，' + extra.join('、') : ''}，再自己按「確認建立訂單」`;
    if (!alreadyReported) await finish(true, 'ready', msg, { handOff: true });
    else setStatus(msg, 'warn');
    watchHold();
  }

  /** 確認頁的保留倒數：剩 1 分鐘提醒一次，到期再提醒一次 */
  function watchHold() {
    let soon = false;
    const t = setInterval(() => {
      if (state.left || state.aborted) { clearInterval(t); return; }
      const left = SITE.holdLeft();
      if (left == null) return;
      if (left <= 0) {
        clearInterval(t);
        setStatus('保留時間到了，名額已釋出。要重新選購，請在擴充功能按「立即執行」', 'err');
        send('warn', { kind: 'hold-expired', msg: '保留時間到了，名額已釋出。要重新選購，請在擴充功能按「立即執行」' });
      } else if (left <= 60 && !soon) {
        soon = true;
        send('warn', { kind: 'hold-soon', msg: `保留只剩 ${left} 秒，請盡快到確認頁檢查並按「確認建立訂單」` });
      }
    }, 1000);
  }

  async function onQueue() {
    return finish(false, 'queue', '網站要求排隊。助手不會略過排隊，先停下來：請在這一頁等候，輪到你之後到擴充功能按「繼續」，或自己操作', { handOff: true });
  }

  async function onErrorPage() {
    const e = SITE.errorPage();
    const what = `網站回了錯誤頁（${e.status} ${e.code}）：${e.message}`;
    const action = classifyError(e.code, e.status);
    if (action === 'retry') {
      const r = await grant('load', what, e.status);
      if (!r) return finish(false, 'load-limit', `${what}，一直沒有恢復，先停下來`, { handOff: true });
      location.reload();
      return;
    }
    if (action === 'restart' || action === 'wait') {
      const r = await grant('fail', what);
      if (!r) return finish(false, 'fail-limit', `${what}，重試次數用完了`, { handOff: true });
      location.assign(SITE.listUrl());
      return;
    }
    return finish(false, e.code || 'error-page', `${what}。先停下來`, { handOff: true });
  }

  async function runFlow(d) {
    if (state.running) return;
    state.running = true;
    state.aborted = false;
    panel();
    setCountdown(null);
    try {
      await domReady();
      switch (SITE.pageKind()) {
        case 'list': setStatus('讀取時段狀態…', 'ok'); return await onList(d);
        case 'select': setStatus('選擇票種與張數…', 'ok'); return await onSelect(d);
        case 'info': setStatus('填寫購票人資料…', 'ok'); return await onInfo(d);
        case 'confirm': return await onConfirm(d);
        case 'queue': return await onQueue(d);
        case 'error': return await onErrorPage(d);
        case 'done': return undefined;   // 完成頁由背景程式判定成功
        default: return await finish(false, 'unknown-page', '認不得這一頁，先停下來', { handOff: true });
      }
    } catch (e) {
      await finish(false, 'error', '程式錯誤：' + (e && e.message ? e.message : e));
    } finally {
      state.running = false;
    }
  }

  /** 排程：在時段列表倒數，到點重新整理（對時與背景程式的到點保險見 30-clock.js、background.js） */
  async function runCountdown(d) {
    const cfg = d.cfg || {};
    const fireAt = d.targetTs + (cfg.fireOffsetMs == null ? 30 : cfg.fireOffsetMs);
    panel();
    setStatus('已排程，等待開賣', 'ok');
    await domReady();
    if (SITE.pageKind() === 'list') {
      // 開賣前先讀一次時段名稱，預告會選哪一個；打錯字現在就會發現
      const ls = await waitList(15000);
      if (ls && ls.slots) {
        const p = previewSlot(ls.slots, cfg.keywords);
        const msg = describePreview(p, cfg.fallback);
        log(msg, p.kind === 'match' ? 'ok' : 'warn');
        if (p.kind !== 'match') { setStatus(msg, 'err'); send('warn', { kind: 'keywords', msg }); }
        else setStatus('已排程。' + msg, 'ok');
      }
    }
    if (cfg.syncClock !== false) {
      await doSync('已與網站伺服器對時');
      if (!state.clockReliable) resyncWhenVisible(fireAt);
      if (fireAt - now() > 45000) {
        if (!(await waitUntil(fireAt - 30000))) return;
        await doSync('開賣前再對時一次');
      }
    }
    const loadedAt = performance.timeOrigin + state.clockOffset;
    if (loadedAt >= fireAt) {
      await call('fired', { at: Date.now(), drift: Math.round(now() - fireAt) }, 800);
      return runFlow({ cfg, since: Date.now(), skip: [] });
    }
    if (!(await waitUntil(fireAt - 300))) return;
    await call('fired', { at: Date.now(), drift: null }, 800);
    if (!(await waitUntil(fireAt))) return;
    send('fired-drift', { drift: Math.round(now() - fireAt) });
    setStatus('開賣時間到，重新整理…', 'ok');
    location.reload();
  }

  /** 「檢查時段」：在背景分頁讀時段與票價，預先比對，不選票 */
  async function runCheck(d) {
    const cfg = d.cfg || {};
    const report = (r) => call('check-result', r, 1500);
    panel();
    setStatus('檢查時段中…', 'ok');
    await domReady();
    if (SITE.pageKind() === 'queue') return report({ ok: false, error: '網站正在排隊，現在沒辦法檢查' });
    if (SITE.pageKind() !== 'list') return report({ ok: false, error: '打開的不是時段列表，請確認網址' });
    const ls = await waitList(20000);
    if (!ls) return report({ ok: false, error: '20 秒內沒有讀到時段列表' });
    if (ls.error) return report({ ok: false, error: `時段載入失敗：${ls.error}` });
    const p = previewSlot(ls.slots, cfg.keywords);
    const buyable = ls.slots.filter(isBuyable).length;
    const full = ls.slots.filter((s) => s.status === 'full').length;
    const notOpen = ls.slots.filter((s) => s.status === 'not-open').length;
    const prices = SITE.prices().map((x) => `${x.name} NT$${x.price}`).join('、');
    const opening = SITE.openingText();
    const msg = `${describePreview(p, cfg.fallback)}。共 ${ls.slots.length} 個時段：可購買 ${buyable}、已額滿 ${full}${notOpen ? `、尚未開放 ${notOpen}` : ''}。${prices ? `票價：${prices}。` : ''}${opening ? opening : ''}`;
    setStatus(msg, p.kind === 'match' ? 'ok' : 'err');
    return report({ ok: p.kind === 'match', kind: p.kind, msg, label: p.slot ? p.slot.text : null, status: p.slot ? statusText(p.slot) : null });
  }

  /** 「健檢」：照轉接的錨點檢查時段列表頁還是不是助手認得的樣子 */
  async function runHealth() {
    const report = (r) => call('health-result', r, 1500);
    panel();
    setStatus('健檢中…', 'ok');
    await domReady();
    const items = [];
    const add = (key, label, status, detail = '') => items.push({ key, label, status, detail });
    const kind = SITE.pageKind();
    add('page', '頁面種類', kind === 'list' ? 'ok' : 'fail', kind === 'list' ? '時段列表' : `認成「${kind}」`);
    if (kind === 'list') {
      const ls = await waitList(20000);
      add('slots', '時段列表', ls && ls.slots ? 'ok' : 'fail', ls && ls.slots ? `${ls.slots.length} 個時段` : ls && ls.error ? ls.error : '讀不到');
      if (ls && ls.slots) {
        const odd = ls.slots.filter((s) => !['available', 'limited', 'full', 'not-open'].includes(s.status));
        add('status', '時段狀態判讀', odd.length ? 'warn' : 'ok', odd.length ? `${odd.length} 個看不出狀態` : '都認得');
        const buy = ls.slots.find(isBuyable);
        add('buy', '選購按鈕', !buy ? 'skip' : buy.el && buy.el.querySelector('a[href*="/select/"]') ? 'ok' : 'fail', buy ? '' : '目前沒有能買的時段');
      }
      add('refresh', '更新狀態按鈕', buttonByText('更新狀態') ? 'ok' : 'warn');
      add('prices', '票價表', SITE.prices().length ? 'ok' : 'warn', SITE.prices().map((x) => x.name).join('、'));
    }
    const worst = items.some((i) => i.status === 'fail') ? 'fail' : items.some((i) => i.status === 'warn') ? 'warn' : 'ok';
    setStatus(worst === 'ok' ? '健檢通過' : '健檢有幾項要注意', worst === 'ok' ? 'ok' : 'warn');
    return report({ ok: worst !== 'fail', worst, items, bundles: [] });
  }

  function showSuccess() {
    panel();
    setStatus(`訂單已建立（${SITE.orderId()}）。這一步是你自己確認的，助手只負責前面的步驟`, 'ok');
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
      runFlow({ cfg: c.cfg || {}, since: c.since, skip: c.skip || [] });
    }
  }
