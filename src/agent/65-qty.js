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

  /** 座位/數量頁：選票區價格（多票區才有）、選張數、按下一步；有驗證碼就停手 */
  async function runQty(cfg) {
    setStatus('選張數中…', 'ok');
    const t0 = Date.now();
    while (!qtyPrice() && !qtySelects().length && Date.now() - t0 < 20000 && !state.aborted) {
      const b = blockerText();
      if (challengeText()) {
        if (!(await waitChallenge(60000))) return finish(false, 'challenge', 'ibon 的「正在驗證您是否是人類」一分鐘還沒通過，請你自己看畫面', { handOff: true });
        continue;
      }
      if (b && !qtyCaptcha()) return finish(false, 'blocked-page', `頁面出現「${b}」，助手不處理，請你自己操作`, { handOff: true });
      await sleep(300);
    }
    if (state.aborted) return;
    const price = qtyPrice();
    if (price && price.selectedIndex <= 0) {
      const opts = [...price.options].slice(1).map((o) => ({ text: o.text, value: o.value }));
      const pick = pickOption(opts, cfg);
      if (pick.kind === 'sold-out') return finish(false, 'sold-out', `對到的票區都賣完了：${pick.names.join('、')}`);
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
    // 等 ibon 的背景更新做完；更新後如果張數被重置了就再選一次（最多三輪）
    let stable = false;
    for (let i = 0; i < 3 && !stable; i++) {
      await settle(500, 8000, 800);   // 至少等 0.8 秒：ibon 的背景更新不一定一變動就開始
      if (state.aborted) return;
      const cur = qtySelects()[0];
      if (cur && Number(cur.value) === want) { stable = true; break; }
      if (!cur || !setSelect(cur, want)) return finish(false, 'fill-failed', `張數被頁面重置，重選 ${want} 失敗，請自己選`, { handOff: true });
      log(`頁面更新後張數被重置，重選 ${want}`, 'warn');
    }
    if (!stable) {
      await settle(500, 8000, 800);
      const cur = qtySelects()[0];
      if (!cur || Number(cur.value) !== want) return finish(false, 'fill-failed', `張數一直被頁面重置，選不住 ${want}，請自己選`, { handOff: true });
    }
    if (qtyCaptcha()) {
      handToUser(qtyCaptcha());
      return finish(false, 'captcha', '張數選好了。這一頁有驗證碼，請自己輸入後按下一步', { handOff: true });
    }
    const next = qtyNext();
    if (!next) return finish(false, 'no-next', '找不到「下一步」按鈕，請自己按', { handOff: true });
    const before = state.alerts.length;
    pageClick(next);
    log('按下「下一步」');
    setStatus('已按下一步…', 'ok');
    const out = await watchAfterClick(before, 45000, '正在處理（可能在排隊或配位）');
    if (out.kind === 'alert') return handleAlert(out, '按下一步');
    if (out.kind === 'timeout') return finish(false, 'timeout', '按下一步後等了 45 秒頁面還是沒有反應，請看畫面，先不要重新整理', { handOff: true });
    return undefined;
  }

