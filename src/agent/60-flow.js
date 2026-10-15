  /* ───────────────────────── 購票流程（WorkflowEngine 的頁面端） ─────────────────────────
   * 流程狀態記在背景程式（lib/workflow.js，task.wf）。這裡每進一個狀態都先 enter() 報到，每個網站操作都先 allowed() 過
   * PolicyGate（lib/policy.js）：被暫停、取消、狀態轉移不合法、政策不是 ALLOWED，就不做。要選哪個場次、票區、票種張數，
   * 以及確認頁對不對，交給 lib/planner.js 決定並附理由；這裡只照決定操作頁面（網站轉接 10-pool.js）。
   *   頁面          狀態
   *   場次列表      PAGE_DETECTION → ACTIVITY_READ → REQUIREMENT_CHECK → SESSION_SELECTION（還沒開放：WAITING_FOR_SALE）
   *   選票頁        TICKET_AREA_SELECTION（有分區就選票區）→ QUANTITY_SELECTION（張數）→ 送出選購
   *   購票人資料頁  BUYER_INFO → 送出
   *   確認頁        ORDER_REVIEW（核對）→ PAYMENT_HANDOFF：一定停在這裡，不替你按「確認建立訂單」，付款由你自己來
   *   排隊、驗證、請求太多、要你確認的：交給你（背景程式依回報的結果轉到 QUEUE／CHALLENGE／RATE_LIMIT／MANUAL_CONFIRMATION）
   * 已經做完的步驟記在 wf.done（hold＝已保留名額、buyer＝已送出購票人資料）：重新整理、按上一頁、按「繼續」都不會重做。
   * 送出結果不明（連線中斷、逾時）一律不重送；確定失敗（伺服器回錯誤）才照次數上限重送。
   * 網站說請求太多（429）：讀取照 Retry-After 等（背景程式看得到標頭），有次數上限；送出不自動重送。是不是 429 也會問背景程式，不只看頁面上的字。 */

  /** 時段列表的錯誤訊息：網站自己已經寫了「時段載入失敗」就不再加，也去掉叫人按按鈕的那一句 */
  const listErrText = (t) => { const x = t.replace(/。請按.*$/, ''); return /^時段載入失敗/.test(x) ? x : `時段載入失敗：${x}`; };

  const totalWanted = (cfg) => (cfg.tickets || []).reduce((a, t) => a + (Number.isInteger(t.qty) && t.qty > 0 ? t.qty : 0), 0) || 1;

  async function finish(ok, kind, msg, extra = {}) {
    const cls = ok ? 'ok' : (extra.handOff ? 'warn' : 'err');
    setStatus(msg, cls);
    setCountdown(null);
    panelLog(msg, cls);
    if (!ok) blackbox(kind, msg);
    const kindOfPage = (() => { try { return SITE.pageKind(); } catch (_) { return ''; } })();
    await call('result', { ok, kind, msg, url: location.href, handOff: !!extra.handOff, pageKind: kindOfPage, summary: extra.summary || null }, 1500);
  }

  /** 進到一個流程狀態之前先向背景程式報到；被暫停、取消，或轉移不合法就不准，這一頁不再做任何事 */
  async function enter(st, extra = {}) {
    const r = await call('wf', { state: st, ...extra }, 2500);
    if (r && r.ok) { if (r.wf) state.wf = r.wf; return true; }
    state.aborted = true;
    if (r && r.reason === 'paused') setStatus('已暫停：到擴充功能按「繼續」，從這一頁接著做', 'warn');
    else if (r && r.msg) setStatus(r.msg, 'err');
    return false;
  }

  /** 把這一步的規劃（候選與理由）記到流程狀態裡，給設定頁顯示；不換狀態 */
  const notePlan = (st, plan) => call('wf', { state: st, plan }, 2500);

  /**
   * PolicyGate：每個網站操作之前問一次。ALLOWED 才做；被暫停就安靜停下；其他照原因交給你
   * （onDeny 可以換成這一步自己的說明，例如不自動勾選同意）。
   */
  async function allowed(action, onDeny) {
    const r = await call('gate', { action }, 2500);
    if (r && r.decision === 'ALLOWED') return true;
    state.aborted = true;
    if (r && r.paused) { setStatus('已暫停：到擴充功能按「繼續」，從這一頁接著做', 'warn'); return false; }
    if (onDeny) { await onDeny(r); return false; }
    const why = r ? `${r.label}：${r.reason}` : `${action}：背景程式沒有回應`;
    await finish(false, 'policy', `${why}（${r ? r.decision : 'UNKNOWN'}），先停下來交給你`, { handOff: true });
    return false;
  }

  /** 已經做完的步驟（wf.done） */
  const doneStep = (k) => !!(state.wf && state.wf.done && state.wf.done[k]);
  const selectionNow = () => (state.wf && state.wf.selection) || {};

  /** 規劃結果只留給人看的部分（候選與理由），送給背景程式記下 */
  const briefPlan = (kind, p) => ({ kind, result: p.kind, msg: p.msg, ranked: (p.ranked || []).slice(0, 20) });

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

  /** 背景程式有沒有看到這個分頁在 since（毫秒時間戳）之後被回 429 */
  async function rateSeenSince(since) {
    const r = await call('rate-seen', { since }, 2000);
    return !!(r && r.seen);
  }

  /** 這一頁開始載入的時間（頁面自己載入時發的請求都在這之後） */
  const pageStart = () => Math.floor(performance.timeOrigin || 0);

  /**
   * 網站說請求太多（429）時的讀取重試：向背景程式要額度，照它給的時間等（Retry-After 或逐步拉長）。
   * 可以再讀回傳 true；額度用完或網站要等太久就停下來交給你，回傳 false。
   */
  async function rateWait(msg) {
    const r = await call('retry', { reason: 'rate', msg, status: 429 }, 3000);
    if (!r || !r.allow) {
      const why = r && r.reason === 'too-long'
        ? `網站要求等 ${Math.round(r.retryAfterMs / 1000)} 秒，超過助手自動等候的上限`
        : `已經照網站的要求等候、重試 ${r ? r.count : 0} 次，還是一直說請求太多`;
      await finish(false, 'rate-limit', `${msg}。${why}，先停下來交給你`, { handOff: true });
      return false;
    }
    const sec = (r.delayMs / 1000).toFixed(1);
    const how = r.source === 'retry-after' ? `照網站要求等 ${sec} 秒` : `網站沒說要等多久，先等 ${sec} 秒`;
    setStatus(`${msg}，${how}再試（${r.count}/${r.max}）`, 'warn');
    log(`${msg}，${how}再試一次（${r.count}/${r.max}）`, 'warn');
    await sleep(r.delayMs);
    return !(state.aborted || state.left);
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

  /** 送出結果不明：連線中斷、逾時。不知道網站到底收到沒有，一律不重送 */
  const UNKNOWN_OUTCOME = ['NETWORK', 'CLIENT_TIMEOUT', 'TIMEOUT'];

  /**
   * 送出這一步（select 選購／info 購票人資料）：同一次只按一次，按了就等結果，不會因為等太久又按。
   * 要再送，一定是錯誤處理判斷「確定失敗了」（伺服器回錯誤），而且向背景程式要額度、每次都再過一次 PolicyGate。
   * area 是這次選的票區（有分區時）：售完就記下這個票區，重新整理選票頁改選下一個。
   */
  async function submitOnce(stepName, d, slotId, area = null) {
    const action = stepName === 'select' ? 'submit-hold' : 'submit-buyer';
    for (;;) {
      if (state.aborted || state.left) return;
      if (!(await allowed(action))) return;
      const sentAt = Date.now();
      const clicked = stepName === 'select' ? SITE.submitSelect() : SITE.submitInfo();
      if (!clicked) return finish(false, 'no-button', '找不到送出按鈕，先停下來', { handOff: true });
      setStatus('已送出，等網站回應…', 'ok');
      const out = await waitOutcomeFor(stepName, 60000);
      if (out.kind === 'left') return;
      if (out.kind === 'timeout') return finish(false, 'unknown-result', '送出後 60 秒都沒有回應，結果不明。為了避免重複送出，助手不重送，先停下來交給你', { handOff: true });
      const what = `網站回覆「${out.text}」`;
      let act = classifyError(out.code, out.status);
      // 頁面沒寫 429，但回應其實是 429：一樣當成請求太多（不自動重送）
      if (['retry', 'reload', 'wait', 'restart', 'stop'].includes(act) && await rateSeenSince(sentAt)) act = 'rate-limit';
      if (act === 'retry' && UNKNOWN_OUTCOME.includes(String(out.code || '').toUpperCase())) {
        return finish(false, 'unknown-result', `${what}。送出後連線中斷或逾時，不知道網站有沒有收到；為了避免重複送出，助手不重送，先停下來交給你`, { handOff: true });
      }
      if (act === 'login') return finish(false, 'login-required', `${what}。網站要你重新登入，助手先停下來`, { handOff: true });
      if (act === 'next-slot') {
        if (area && slotId) {
          // 這個票區賣完了：記下來，重新整理選票頁改選下一個票區（同一個場次）
          await call('skip-area', { slotId, areaId: area.id }, 1500);
          log(`${what}，「${area.name}」買不到了，改選下一個票區`, 'warn');
          if (!(await allowed('reload-page'))) return;
          location.reload();
          return;
        }
        if (slotId) await call('skip-slot', { slotId }, 1500);
        log(`${what}，改選下一個時段`, 'warn');
        location.assign(SITE.listUrl());
        return;
      }
      if (act === 'rate-limit') {
        // 送出被說請求太多：不自動重送，什麼時候再送由你決定
        return finish(false, 'rate-limited', `${what}。網站說請求太多，助手不自動重送，先停下來交給你：請等一下再自己按，或到擴充功能按「繼續」`, { handOff: true });
      }
      if (act === 'retry') {
        const r = await grant('fail', what);
        if (!r) return finish(false, 'fail-limit', `${what}，重試次數用完了`, { handOff: true });
        continue;   // 前一次確定失敗了，才再送一次（迴圈開頭會再過一次 PolicyGate）
      }
      if (act === 'reload') {
        // 表單權杖過期之類：重新整理這一頁拿新的，這一步會重新做一次（有次數上限）
        const r = await grant('fail', what);
        if (!r) return finish(false, 'fail-limit', `${what}，重試次數用完了`, { handOff: true });
        if (!(await allowed('reload-page'))) return;
        location.reload();
        return;
      }
      if (act === 'duplicate') {
        // 網站說已經收到了：上一次其實送到了，不要再送，往下一步看看
        log(`${what}，上一次其實已經送到了，不再重送`, 'warn');
        location.assign(SITE.nextUrl(stepName));
        return;
      }
      if (act === 'wait' || act === 'restart') {
        const r = await grant('fail', what);
        if (!r) return finish(false, 'fail-limit', `${what}，重試次數用完了`, { handOff: true });
        // 保留逾時、步驟對不上：之前做完的步驟不算數了
        await call('wf', { state: state.wf ? state.wf.state : 'QUANTITY_SELECTION', clearDone: true }, 2500);
        location.assign(SITE.listUrl());
        return;
      }
      if (act === 'gate') return finish(false, out.code.toLowerCase(), `${what}。這一關要你自己處理，助手先停下來`, { handOff: true });
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

  /** 場次列表：讀活動與場次 → 比對需求 → 選場次（還沒開放就等，讀取失敗就重試） */
  async function onList(d) {
    const cfg = d.cfg || {};
    const req = requirementOf(cfg);
    if (!(await enter('ACTIVITY_READ'))) return;
    let prev = null;
    let since = pageStart();   // 這一輪讀取是從什麼時候開始的（給 rateSeenSince）
    const refresh = () => { since = Date.now(); return refreshList(); };
    for (;;) {
      if (state.aborted || state.left) return;
      const ls = await waitList(30000, prev);
      if (!ls) {
        const r = await grant('load', '時段列表等了 30 秒還沒出來');
        if (!r) return finish(false, 'list-timeout', '時段列表一直沒有出來，先停下來', { handOff: true });
        if (!(await allowed('reload-page'))) return;
        location.reload();
        return;
      }
      if (ls.error) {
        if (classifyError('', ls.status) === 'rate-limit' || await rateSeenSince(since)) {
          if (!(await rateWait(listErrText(ls.error)))) return;
          if (!(await allowed('refresh-list'))) return;
          prev = refresh();
          await sleep(50);
          continue;
        }
        if (classifyError('', ls.status) === 'login') return finish(false, 'login-required', `${listErrText(ls.error)}。網站要你重新登入，助手先停下來`, { handOff: true });
        const r = await grant('load', listErrText(ls.error), ls.status);
        if (!r) return finish(false, 'load-limit', `${ls.error}。連續 5 分鐘都沒有恢復，先停下來`, { handOff: true });
        if (!(await allowed('refresh-list'))) return;
        prev = refresh();
        await sleep(50);
        continue;
      }
      send('load-ok', {});
      if (!(await enter('REQUIREMENT_CHECK'))) return;
      // 已經保留了名額（例如按上一頁回到列表）：不再選一次，免得重複保留
      if (doneStep('hold')) {
        return finish(false, 'already-held', `你已經保留了「${selectionNow().sessionText || '某個場次'}」的名額，助手不會再選一次`, { handOff: true });
      }
      // 票種與預算：先用列表上的票價檢查（票區加價在選票頁再檢查一次）
      const prices = SITE.prices();
      if (prices.length) {
        const t = matchTickets(req, prices);
        if (!t.ok && t.kind === 'budget') return finish(false, 'budget', `${t.msg}。沒有符合預算的選擇，不會送出選購`);
      }
      const plan = planSession(ls.slots, req, { skip: d.skip || [] });
      await notePlan('REQUIREMENT_CHECK', briefPlan('session', plan));
      if (plan.kind === 'ok') {
        log(describePick(plan, req.need), 'ok');
        if (!(await enter('SESSION_SELECTION', { selection: { slotId: plan.slot.id, sessionText: plan.slot.text } }))) return;
        if (!(await allowed('select-session'))) return;
        setStatus(`前往「${plan.slot.text}」選票種…`, 'ok');
        if (!SITE.openSlot(plan.slot)) return finish(false, 'no-button', '找不到這個時段的選購按鈕，先停下來', { handOff: true });
        return;
      }
      if (plan.kind === 'not-open') {
        if (!(await enter('WAITING_FOR_SALE'))) return;
        const r = await grant('not-open', describePick(plan, req.need));
        if (!r) return finish(false, 'not-open-limit', `${describePick(plan, req.need)}，重試次數用完了`);
        if (!(await allowed('refresh-list'))) return;
        if (!(await enter('ACTIVITY_READ'))) return;
        prev = refresh();
        await sleep(50);
        continue;
      }
      // 偏好的場次狀態看不出來：不猜、不當成還沒開放一直重看，停下來問你
      if (plan.kind === 'unknown') return finish(false, 'status-unknown', plan.msg, { handOff: true });
      return finish(false, plan.kind, describePick(plan, req.need));
    }
  }

  /** 選票頁：選票區（有分區時）→ 對票種與預算 → 選張數 → 送出選購 */
  async function onSelect(d) {
    const cfg = d.cfg || {};
    const req = requirementOf(cfg);
    if (!(await enter('TICKET_AREA_SELECTION'))) return;
    const info = SITE.selectInfo();
    // 這個場次已經保留過名額（例如重新整理、按上一頁回來）：不重送，直接到下一步
    if (doneStep('hold') && (!state.wf.done.hold.slotId || state.wf.done.hold.slotId === info.slotId)) {
      log('這個場次已經保留過名額，不再送一次選購，直接到下一步', 'warn');
      location.assign(SITE.nextUrl('select'));
      return;
    }
    if (info.status === 'full' || info.status === 'not-open') {
      if (info.status === 'full' && info.slotId) await call('skip-slot', { slotId: info.slotId }, 1500);
      log(`「${info.text}」${info.status === 'full' ? '已額滿' : '還沒開放'}，回時段列表`, 'warn');
      location.assign(SITE.listUrl());
      return;
    }
    const types = SITE.ticketTypes();
    if (!types.length) return finish(false, 'no-types', '選票頁上找不到票種，先停下來', { handOff: true });
    const maxPerOrder = SITE.maxPerOrder();
    let area = null;
    const areas = SITE.areas();
    if (areas.length) {
      const skip = ((state.wf && state.wf.skipAreas) || {})[info.slotId] || [];
      const ap = planArea(areas, req, types, { skip, maxPerOrder });
      await notePlan('TICKET_AREA_SELECTION', briefPlan('area', ap));
      if (ap.kind !== 'ok') return finish(false, 'area-none', `${ap.msg}。不會送出選購`);
      area = ap.area;
      if (!(await allowed('select-area'))) return;
      if (!SITE.chooseArea(area)) return finish(false, 'fill-failed', `選不了「${area.name}」，先停下來`, { handOff: true });
      log(ap.msg, 'ok');
    }
    const t = matchTickets(req, types, { surcharge: area ? area.surcharge || 0 : 0, maxPerOrder });
    if (!t.ok) {
      if (t.kind === 'budget') return finish(false, 'budget', `${t.msg}。沒有符合預算的選擇，不會送出選購`);
      return finish(false, 'tickets', t.msg, { handOff: true });
    }
    const plan = t.plan;
    const selection = {
      slotId: info.slotId, sessionText: selectionNow().sessionText || info.text,
      areaId: area ? area.id : null, areaName: area ? area.name : null,
      items: plan.plan.map((p) => ({ name: p.name, qty: p.qty })), amount: plan.amount,
    };
    if (!(await enter('QUANTITY_SELECTION', { selection }))) return;
    if (!(await allowed('set-quantity'))) return;
    for (const p of plan.plan) SITE.setQty(p.id, p.qty);
    const bad = plan.plan.find((p) => SITE.qtyOf(p.id) !== p.qty);
    if (bad) return finish(false, 'fill-failed', `「${bad.name}」的張數填不進去，先停下來`, { handOff: true });
    log(`張數：${plan.plan.map((p) => `${p.name} ${p.qty}`).join('、')}，共 ${plan.total} 張、NT$${plan.amount}`);
    return submitOnce('select', d, info.slotId, area);
  }

  /** 購票人資料頁：到這裡代表選購已經保留了；填你提供的資料 → 勾同意（照你的設定）→ 送出 */
  async function onInfo(d) {
    const cfg = d.cfg || {};
    if (!(await enter('BUYER_INFO', { done: 'hold' }))) return;
    if (doneStep('buyer')) {
      log('購票人資料已經送出過，不再送一次，直接到下一步', 'warn');
      location.assign(SITE.nextUrl('info'));
      return;
    }
    const chk = checkProfile(cfg.profile);
    if (!chk.ok) return finish(false, 'profile', `購票人資料不完整（${describeProfileProblem(chk)}），請在擴充功能補上後按「繼續」`, { handOff: true });
    if (!(await allowed('fill-profile'))) return;
    const r = SITE.fillProfile(chk.profile);
    if (r.missing.length) return finish(false, 'fill-failed', `這些欄位找不到或填不進去：${r.missing.join('、')}，先停下來`, { handOff: true });
    if (SITE.hasAgree()) {
      const ok = await allowed('agree-terms', () => finish(false, 'agree', '資料已填好。你設定不自動勾選同意，請自己閱讀並勾選後按「下一步」', { handOff: true }));
      if (!ok) return;
      if (!SITE.setAgree(true)) return finish(false, 'agree-failed', '同意使用須知勾不起來，先停下來', { handOff: true });
    }
    log(`已填購票人資料：${maskText(`${chk.profile.name.slice(0, 1)}** ${chk.profile.phone} ${chk.profile.email}`)}${SITE.hasAgree() ? '，已勾選同意' : ''}`);
    return submitOnce('info', d, null);
  }

  /**
   * 確認頁：核對訂單（ORDER_REVIEW），一致才交接付款（PAYMENT_HANDOFF）。只讀、標出按鈕、提醒你，絕不替你按：
   * 「確認建立訂單」在操作政策裡是 CONFIRMATION_REQUIRED（不可逆），付款是 BLOCKED。
   */
  async function onConfirm(d, alreadyReported = false) {
    const g = SITE.confirmGates();
    const left = SITE.holdLeft();
    const extra = [g.captcha && '輸入驗證碼', g.botcheck && '自己完成「我不是機器人」檢查'].filter(Boolean);
    const msg = `已到確認頁${left != null ? `，名額保留中（約剩 ${left} 秒）` : ''}。請檢查訂單內容${extra.length ? '，' + extra.join('、') : ''}，再自己按「確認建立訂單」`;
    if (alreadyReported) { setStatus(msg, 'warn'); watchHold(); return; }
    if (!(await enter('ORDER_REVIEW', { done: 'buyer' }))) return;
    const summary = SITE.orderSummary();
    const sel = selectionNow();
    const review = reviewOrder(summary, { sessionText: sel.sessionText, areaName: sel.areaName, items: sel.items || [], amount: sel.amount });
    if (!review.ok) return finish(false, 'review-mismatch', `${review.msg}。助手不交接付款，先停下來請你確認`, { handOff: true, summary });
    const btn = SITE.confirmButton();
    if (btn) { btn.style.outline = '3px solid #d97706'; btn.style.outlineOffset = '3px'; }
    await finish(true, 'ready', msg, { handOff: true, summary });
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
    let action = classifyError(e.code, e.status);
    if (action !== 'rate-limit' && action !== 'gate' && await rateSeenSince(pageStart())) action = 'rate-limit';
    if (action === 'rate-limit') {
      if (!(await rateWait(what))) return;
      if (!(await allowed('reload-page'))) return;
      location.reload();
      return;
    }
    if (action === 'login') return finish(false, 'login-required', `${what}。網站要你重新登入，助手先停下來`, { handOff: true });
    if (action === 'retry') {
      const r = await grant('load', what, e.status);
      if (!r) return finish(false, 'load-limit', `${what}，一直沒有恢復，先停下來`, { handOff: true });
      if (!(await allowed('reload-page'))) return;
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
    if (d && d.wf) state.wf = d.wf;
    panel();
    setCountdown(null);
    try {
      await domReady();
      const kind = SITE.pageKind();
      if (!(await enter('PAGE_DETECTION', { reason: `頁面：${kind}` }))) return;
      switch (kind) {
        case 'list': setStatus('讀取時段狀態…', 'ok'); return await onList(d);
        case 'select': setStatus('選擇票區、票種與張數…', 'ok'); return await onSelect(d);
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
    if (ls.error) return report({ ok: false, error: listErrText(ls.error) });
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
    if (c.cmd === 'pause') {
      // 暫停：手上這一個檢查做完就停，不再做新的操作（之後每一步的報到與 PolicyGate 也都會拒絕）
      state.aborted = true;
      if (state.panel) { setStatus('已暫停：到擴充功能按「繼續」，從這一頁接著做', 'warn'); setCountdown(null); }
      return;
    }
    if (c.cmd === 'run') {
      state.aborted = false;
      state.mode = 'run';
      runFlow({ cfg: c.cfg || {}, since: c.since, skip: c.skip || [], wf: c.wf || null });
    }
  }
