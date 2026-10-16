  /* ───────────────────────── 選票區頁（UTK0201_000，第 2 步） ─────────────────────────
   * 2026-10-16 截圖：表格欄位「顏色、票區、票價(NT$)、空位」，空位寫「熱賣中」、「已售完」或剩下的張數。
   * tickets_hunter 的 ibon.py：表格在封閉的 Shadow DOM 裡；每列 4 格（[0] 顏色 [1] 票區 [2] 票價 [3] 空位），
   * 表頭在 THEAD；不能買的列 class 帶 disabled；「座位已被選擇」「座位已售出」「舞台區域」是圖例不是票區；點的是整列。
   * 0.9.2 實測：點整列可以進到座位/數量頁。 */
  const AREA_LEGEND = /^(座位已被選擇|座位已售出|舞台區域)$/;

  function areaCells(r) {
    return [...r.children].filter((c) => c.tagName === 'TD');
  }

  function areaRows() {
    return deepAll('tr').filter((r) => {
      if (!isVisible(r) || (r.parentElement && r.parentElement.tagName === 'THEAD')) return false;
      const tds = areaCells(r);
      return tds.length >= 4 && /\d/.test(norm(tds[2].textContent)) && !AREA_LEGEND.test(norm(r.textContent));
    });
  }

  /** 一列 → { text, name, price, seat, left, unavailable }：空位是數字就是剩下的張數，不夠你要的張數就當成不能買 */
  function areaInfo(r, qty) {
    const tds = areaCells(r);
    const name = norm(tds[1].textContent);
    const price = norm(tds[2].textContent);
    const seat = norm(tds[3].textContent);
    const left = /^\d+$/.test(seat) ? Number(seat) : null;
    const unavailable = /(^|\s)disabled(\s|$)/i.test(r.className || '') || (left != null && left < qty);
    return { text: `${name} ${price} ${seat}`, name, price, seat, left, unavailable };
  }

  /** 這個元素看起來是不是「已選」：radio 勾了，或 class / aria 標了選取 */
  const looksSelected = (el) => !!(el.checked || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true'
    || /(^|\s)(active|selected|checked|on|current)(\s|$)/i.test(el.className || ''));

  /** radio 的說明文字：<label for>、包著它的 <label>、或緊接在後面的字 */
  function radioLabel(input) {
    const byFor = input.id ? deepAll(`label[for="${CSS.escape(input.id)}"]`)[0] : null;
    const wrap = input.closest ? input.closest('label') : null;
    const next = input.nextElementSibling || (input.parentElement && input.parentElement.nextElementSibling);
    return norm((byFor || wrap || next || {}).textContent || '');
  }

  /**
   * 購票方式可以選「自行選位」或「電腦配位」時（2026-10-16 活動 39978：「購票方式： 自行選位 電腦配位」），先選電腦配位：
   * 助手的流程是選張數讓 ibon 配位，不會替你點座位圖。只點看起來點得動的（radio、label、按鈕、連結、滑鼠會變手指的），純文字不動。
   * 回傳 'selected' 選了、'already' 本來就是、null 找不到可以點的。
   */
  async function chooseComputerSeat() {
    for (const input of deepAll('input[type="radio"]')) {
      if (!/電腦配位/.test(radioLabel(input))) continue;
      if (input.checked) return 'already';
      const target = isVisible(input) ? input : (input.id && deepAll(`label[for="${CSS.escape(input.id)}"]`)[0]) || input.closest('label') || input;
      pageClick(target);
      await settle(150, 3000, 150);
      return 'selected';
    }
    const clickable = deepAll('button, a, label, [role="radio"], [role="tab"], [onclick], .btn, li, span, div').filter((el) => isVisible(el)
      && norm(el.textContent) === '電腦配位' && (/^(BUTTON|A|LABEL)$/.test(el.tagName) || el.hasAttribute('onclick') || el.getAttribute('role')
        || /(^|\s)btn(\s|$)/.test(el.className || '') || getComputedStyle(el).cursor === 'pointer'));
    const el = clickable[clickable.length - 1];   // 最裡層的那一個
    if (!el) return null;
    if (looksSelected(el)) return 'already';
    pointClick(el);
    await settle(150, 3000, 150);
    return 'selected';
  }

  /** 等票區表穩定：列數 0.15 秒沒變，而且 DOMContentLoaded 之後至少 0.1 秒（最多等 1.5 秒）；回傳最新的列 */
  async function waitAreaStable(rows) {
    let n = rows.length;
    let since = Date.now();
    const t0 = Date.now();
    while (Date.now() - t0 < 1500 && !state.aborted && !state.leaving) {
      const ready = state.domReadyAt && Date.now() - state.domReadyAt >= 100;
      if (ready && Date.now() - since >= 150) break;
      await sleep(30);
      const m = areaRows().length;
      if (m !== n) { n = m; since = Date.now(); }
    }
    const now = areaRows();
    return now.length ? now : rows;
  }

  /** 選票區頁：照關鍵字、排除字選票區；之前售完過的票區（d.failedAreas）跳過 */
  async function runArea(cfg, d = {}) {
    setStatus('選票區中…', 'ok');
    const deadline = Date.now() + 20000;
    let rows = [];
    for (;;) {
      const got = await waitFor(() => {
        // 有些活動票區與張數在同一頁：直接照座位/數量頁的做法
        if (qtyPrice() || qtySelects().length) return { kind: 'qty' };
        const r = areaRows();
        return r.length ? { kind: 'rows', rows: r } : null;
      }, Math.max(0, deadline - Date.now()), () => {
        if (challengeText()) return { kind: 'challenge' };
        const b = blockerText();
        return b ? { kind: 'blocker', text: b } : null;
      });
      if (!got) break;
      if (got.kind === 'qty') { log('這一頁直接出現張數，票區與張數在同一頁'); return runQty(cfg, d); }
      if (got.kind === 'rows') { rows = got.rows; break; }
      if (got.kind === 'blocker') return finish(false, 'blocked-page', `頁面出現「${got.text}」，助手不處理，請你自己操作`, { handOff: true });
      if (!(await waitChallenge(60000))) return finish(false, 'challenge', 'ibon 的「正在驗證您是否是人類」一分鐘還沒通過，請你自己看畫面', { handOff: true });
    }
    if (state.aborted || state.leaving) return;
    if (!rows.length) return finish(false, 'no-area-table', '票區頁一直沒有出現票區表格。可能是 ibon 改版了，請直接看畫面', { handOff: true });
    // 票區表剛出現時 ibon 可能還沒掛上點擊處理（2026-10-16 活動 39978、夢想音樂節：載入後 0.43 秒就點，30 秒沒反應）：
    // 等列數穩定 0.15 秒、而且 DOMContentLoaded 之後至少 0.1 秒再點（tickets_hunter 也是等列數連續兩次一樣才點）
    rows = await waitAreaStable(rows);
    if (state.aborted || state.leaving) return;
    const qty = Math.max(1, Math.min(Number(cfg.qty) || 1, 10));
    const failed = d.failedAreas || [];
    const infos = rows.map((r) => areaInfo(r, qty)).map((x) => (isFailedArea(x.name, failed) ? { ...x, unavailable: true } : x));
    const texts = infos.map((x) => x.text);
    // 記下這場的票區名稱，彈出視窗下次讀取這個活動時當成關鍵字的參考
    send('areas-seen', { names: infos.map((x) => `${x.name} ${x.price}`) });
    if (failed.length) log(`跳過之前售完的票區：${failed.join('、')}`);
    const pick = pickOption(infos, cfg);
    if (pick.kind === 'sold-out') return finish(false, 'sold-out', `對到的票區都賣完了，或剩下的張數不夠 ${qty} 張：${pick.names.join('、')}`);
    if (pick.kind === 'blocked') return finish(false, 'blocked', `對到的票區都在排除清單裡：${pick.names.join('、')}`, { handOff: true });
    if (pick.kind === 'no-match') {
      const ex = pick.excluded ? `（另有 ${pick.excluded} 個票區在排除清單裡）` : '';
      return finish(false, 'no-match', `關鍵字比對不到任何票區。頁面上的票區有：${texts.join(' ／ ')}${ex}。請自己選`, { handOff: true });
    }
    if (pick.kind === 'fallback') log(`關鍵字都沒比對到，照遞補設定改選第一個還能買的：${pick.text}`, 'warn');
    else log(`選中票區：${pick.text}（${pageAge()}）`);
    const pageText = visibleText();
    if (/自行選位/.test(pageText) && /電腦配位/.test(pageText)) {
      const how = await chooseComputerSeat();
      if (state.aborted || state.leaving) return undefined;
      if (how === 'selected') log('購票方式改選「電腦配位」（助手不會替你點座位圖）');
      else if (!how) log('頁面有「自行選位」和「電腦配位」，但找不到可以點的電腦配位選項，照原本的方式選票區', 'warn');
    }
    const row = rows[pick.index];
    // 三種點法：列中央那一點（tickets_hunter 的做法）、整列、票區名稱那一格
    const out = await clickUntilReacts(row, 30000, '正在處理票區', [pointClick, (r) => { r.click(); return r; }, (r) => pointClick(areaCells(r)[1] || r)]);
    if (out.kind === 'alert') return handleAlert(out, '選票區', { areaText: infos[pick.index].name });
    if (out.kind === 'timeout') {
      const seatMap = /選擇座位|座位圖|請點選座位|請選擇您的座位|已選座位/.test(visibleText());
      const how = `（點了 ${out.tries} 次，點了之後頁面${out.sentRequest ? '有' : '沒有'}送出請求）`;
      return finish(false, 'no-advance', seatMap
        ? `點了票區之後 ibon 出現座位圖，要你自己點座位（助手不會替你選座位）。請直接在畫面上選${how}`
        : `選了票區但等了 30 秒頁面沒有進到下一步，請自己看畫面${how}`, { handOff: true });
    }
    return undefined;
  }

