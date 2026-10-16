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

  /** 選票區頁：照關鍵字、排除字選票區；之前售完過的票區（d.failedAreas）跳過 */
  async function runArea(cfg, d = {}) {
    setStatus('選票區中…', 'ok');
    const t0 = Date.now();
    let rows = areaRows();
    while (!rows.length && Date.now() - t0 < 20000 && !state.aborted) {
      // 有些活動票區與張數在同一頁：直接照座位/數量頁的做法
      if (qtyPrice() || qtySelects().length) { log('這一頁直接出現張數，票區與張數在同一頁'); return runQty(cfg, d); }
      if (challengeText()) {
        if (!(await waitChallenge(60000))) return finish(false, 'challenge', 'ibon 的「正在驗證您是否是人類」一分鐘還沒通過，請你自己看畫面', { handOff: true });
        continue;
      }
      const b = blockerText();
      if (b) return finish(false, 'blocked-page', `頁面出現「${b}」，助手不處理，請你自己操作`, { handOff: true });
      await sleep(300);
      rows = areaRows();
    }
    if (state.aborted) return;
    if (!rows.length) return finish(false, 'no-area-table', '票區頁一直沒有出現票區表格。可能是 ibon 改版了，請直接看畫面', { handOff: true });
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
    else log(`選中票區：${pick.text}`);
    const row = rows[pick.index];
    const out = await clickAndWatch(row.querySelector('a[href], a[onclick]') || row, 30000, '正在處理票區');
    if (out.kind === 'alert') return handleAlert(out, '選票區', { areaText: infos[pick.index].name });
    if (out.kind === 'timeout') return finish(false, 'no-advance', '選了票區但等了 30 秒頁面沒有進到下一步，請自己看畫面', { handOff: true });
    return undefined;
  }

