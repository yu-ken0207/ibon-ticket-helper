  /* ───────────────────────── 座位/數量頁（UTK0202_、UTK0201_001，第 3 步，2026-10-16 真站快照） ─────────────────────────
   * 「票區價格」下拉（#ctl00_ContentPlaceHolder1_PRICE，多票區才有），再有「購買數量」表格（#…_DataGrid）。
   * 選了票區價格，ibon 會回傳重畫整頁；「下一步」是 #ctl00_ContentPlaceHolder1_AddShopingCart，
   * href 是 javascript:__doPostBack(...)，要用 pageClick 由頁面環境代點。
   * 驗證碼（#…_CHK，tickets_hunter）出現就停手交給你。舊版頁面的數量下拉是 table.table 裡的 select[name*="AMOUNT_DDL"]。 */
  const QTY = {
    price: '#ctl00_ContentPlaceHolder1_PRICE',
    grid: '#ctl00_ContentPlaceHolder1_DataGrid',
    next: '#ctl00_ContentPlaceHolder1_AddShopingCart',
    captcha: '#ctl00_ContentPlaceHolder1_CHK, input[id*="CHK"]',
  };
  const qtyPrice = () => { const s = $(QTY.price); return s && isVisible(s) ? s : null; };
  const qtyGrid = () => $(QTY.grid) || $('table.rwdtable') || deepAll('table.table').find((t) => t.querySelector('select')) || null;
  const qtySelects = () => {
    const grid = qtyGrid();
    return grid ? deepAll('select.form-control-sm, select[name*="AMOUNT_DDL"]', grid).filter(isVisible) : [];
  };
  const qtyNext = () => $(QTY.next) || $('a[id*="AddShopingCart"]') || $('#ctl00_ContentPlaceHolder1_A2')
    || deepAll('a.btn.btn-primary.btn-block').find((b) => isVisible(b) && /下一步/.test(b.textContent)) || null;
  const qtyCaptcha = () => deepAll(QTY.captcha).find(isVisible) || null;
  // 「接受不連號座位」（tickets_hunter：div.not-consecutive > div.custom-control > span > input[type=checkbox]）
  const qtyNonAdjacent = () => deepAll('div.not-consecutive input[type="checkbox"]').find(isVisible) || null;

  /** 這一頁現在選的票區（記售完用）：票區價格下拉選中的那一項，沒有就用數量表格第一格 */
  function qtyAreaText() {
    const p = qtyPrice();
    if (p && p.selectedIndex > 0) return norm(p.options[p.selectedIndex].text);
    const grid = qtyGrid();
    const td = grid && grid.querySelector('td');
    return td ? norm(td.textContent) : '';
  }

  /**
   * 這個票區賣完了沒（照 tickets_hunter）：有數量下拉時，看有沒有大於 0 的選項；
   * 沒有數量下拉時，看張數欄（AMOUNT_STR）或數量表格寫著售完。只看表格，不看整頁：票區下拉會列出別的票區「(已售完)」。
   */
  function qtySoldOut() {
    const sels = qtySelects();
    if (sels.length) return sels.every((s) => ![...s.options].some((o) => !o.disabled && Number(o.value) > 0));
    const grid = qtyGrid();
    return deepAll('span[id*="AMOUNT_STR"]').some((s) => SOLD_OUT_MSG.test(norm(s.textContent)))
      || (!!grid && SOLD_OUT_MSG.test(norm(grid.innerText || grid.textContent)));
  }

  /** 選「票區價格」下拉（多票區才有）：照關鍵字、排除字挑，之前售完的跳過。選好回 true；挑不到（已經回報結果）回 false */
  async function qtyPickPrice(cfg, price, failed, curArea) {
    if (curArea) log(`「${curArea}」賣完了，改選別的票區`, 'warn');
    const opts = [...price.options].slice(1).map((o) => ({ text: o.text, value: o.value, unavailable: isFailedArea(o.text, failed) }));
    send('areas-seen', { names: opts.map((o) => norm(o.text)) });
    const pick = pickOption(opts, cfg);
    let stop = null;
    if (pick.kind === 'sold-out') stop = finish(false, 'sold-out', `對到的票區都賣完了：${pick.names.join('、')}`);
    else if (pick.kind === 'blocked') stop = finish(false, 'blocked', `對到的票區都在排除清單裡：${pick.names.join('、')}`, { handOff: true });
    else if (pick.kind === 'no-match') stop = finish(false, 'no-match', `關鍵字比對不到任何票區。可選的有：${opts.map((o) => o.text).join(' ／ ')}。請自己選`, { handOff: true });
    if (stop) { await stop; return false; }
    log(pick.kind === 'fallback' ? `關鍵字都沒比對到，改選第一個還能買的：${pick.text}` : `選中票區：${pick.text}`, pick.kind === 'fallback' ? 'warn' : 'info');
    if (!setSelect(price, opts[pick.index].value)) { await finish(false, 'fill-failed', '票區價格選不起來', { handOff: true }); return false; }
    // 選了票區價格，ibon 會回傳（整頁換掉，或在背景更新張數表）：整頁換掉的話頁面開始離開就停手，由新頁面接著做；
    // 背景更新的話等請求回來、畫面穩定再往下。0.9.4 以前是固定等 4 秒
    await settle(150, 6000, 300);
    return !state.aborted && !state.leaving;
  }

  /**
   * 座位/數量頁：選票區價格（多票區才有）、選張數、按下一步；有驗證碼就停手。
   * 這個票區賣完了：記下來（d.failedAreas 是之前售完的），同一頁還有別的票區就直接改選，沒有就回選區頁（d.areaUrl）換別區。
   */
  async function runQty(cfg, d = {}) {
    setStatus('選張數中…', 'ok');
    const deadline = Date.now() + 20000;
    for (;;) {
      const got = await waitFor(() => (qtyPrice() || qtySelects().length ? { kind: 'ready' } : null), Math.max(0, deadline - Date.now()), () => {
        if (challengeText()) return { kind: 'challenge' };
        const b = blockerText();
        return b && !qtyCaptcha() ? { kind: 'blocker', text: b } : null;
      });
      if (!got || got.kind === 'ready') break;
      if (got.kind === 'blocker') return finish(false, 'blocked-page', `頁面出現「${got.text}」，助手不處理，請你自己操作`, { handOff: true });
      if (!(await waitChallenge(60000))) return finish(false, 'challenge', 'ibon 的「正在驗證您是否是人類」一分鐘還沒通過，請你自己看畫面', { handOff: true });
    }
    if (state.aborted || state.leaving) return;
    const failed = [...(d.failedAreas || [])];
    for (let round = 0; round < 5; round++) {
      const price = qtyPrice();
      const curArea = price && price.selectedIndex > 0 ? norm(price.options[price.selectedIndex].text) : '';
      if (price && (price.selectedIndex <= 0 || isFailedArea(curArea, failed))) {
        if (!(await qtyPickPrice(cfg, price, failed, curArea))) return;
        if (!qtySelects().length) return finish(false, 'no-qty', '選了票區價格但沒有出現購買數量，請自己看畫面', { handOff: true });
      }
      if (!qtySelects().length) return finish(false, 'no-qty', '找不到「購買數量」的下拉選單。可能是 ibon 改版了，請直接看畫面', { handOff: true });
      if (!qtySoldOut()) return qtyFill(cfg, d);
      const area = qtyAreaText();
      await markAreaFailed(area);
      failed.push(area);
      const p = qtyPrice();
      if (p && [...p.options].slice(1).some((o) => !isFailedArea(o.text, failed) && !SOLD_OUT_RE.test(o.text))) continue;   // 同一頁還有別的票區：直接改選
      return retry('fail', `票區「${area}」賣完了，回選區頁換別的票區`, d.areaUrl);
    }
    return finish(false, 'sold-out', '這一頁的票區試了好幾個都賣完了');
  }

  /** 選張數、（有開的話）勾不連號、按下一步 */
  async function qtyFill(cfg, d) {
    const sel = qtySelects()[0];
    const have = [...sel.options].filter((o) => !o.disabled).map((o) => Number(o.value)).filter((n) => Number.isFinite(n) && n > 0);
    const want = Math.max(1, Math.min(Number(cfg.qty) || 1, 10));
    if (Math.max(...have) < want) return finish(false, 'qty-limit', `你要 ${want} 張，但這個票區最多只能選 ${Math.max(...have)} 張。請自己決定要不要買`, { handOff: true });
    if (!setSelect(sel, want)) return finish(false, 'fill-failed', `張數選不到 ${want}`, { handOff: true });
    log(`已選張數 ${want}（${pageAge()}）`);
    // 等 ibon 的背景更新做完（請求回來、畫面穩定）；更新後如果張數被重置了就再選一次（最多三輪）
    let stable = false;
    for (let i = 0; i < 3 && !stable; i++) {
      await settle();
      if (state.aborted || state.leaving) return;
      const cur = qtySelects()[0];
      if (cur && Number(cur.value) === want) { stable = true; break; }
      if (!cur || !setSelect(cur, want)) return finish(false, 'fill-failed', `張數被頁面重置，重選 ${want} 失敗，請自己選`, { handOff: true });
      log(`頁面更新後張數被重置，重選 ${want}`, 'warn');
    }
    if (!stable) {
      await settle();
      if (state.aborted || state.leaving) return;
      const cur = qtySelects()[0];
      if (!cur || Number(cur.value) !== want) return finish(false, 'fill-failed', `張數一直被頁面重置，選不住 ${want}，請自己選`, { handOff: true });
    }
    if (cfg.allowNonAdjacent) {
      const box = qtyNonAdjacent();
      if (box && !box.checked) {
        pageClick(box);
        if (!box.checked) await sleep(50);
        if (box.checked) { log('已勾選「接受不連號座位」'); await settle(150, 4000, 200); }
        else log('「接受不連號座位」勾不起來，照連號的座位買', 'warn');
      }
    }
    if (qtyCaptcha()) {
      handToUser(qtyCaptcha());
      return finish(false, 'captcha', '張數選好了。這一頁有驗證碼，請自己輸入後按下一步', { handOff: true });
    }
    const next = qtyNext();
    if (!next) return finish(false, 'no-next', '找不到「下一步」按鈕，請自己按', { handOff: true });
    log(`按下「下一步」（${pageAge()}）`);
    setStatus('已按下一步…', 'ok');
    const out = await clickAndWatch(next, 45000, '正在處理（可能在排隊或配位）');
    if (out.kind === 'alert') return handleAlert(out, '按下一步', { areaText: qtyAreaText(), areaUrl: d.areaUrl });
    if (out.kind === 'timeout') return finish(false, 'timeout', '按下一步後等了 45 秒頁面還是沒有反應，請看畫面，先不要重新整理', { handOff: true });
    return undefined;
  }

