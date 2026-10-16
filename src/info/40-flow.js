  /* ───────────────────────── 購票流程自動操作（ibon 客服 2026-10-16 第二封回覆：允許自動選區、選張數、點下一步、勾同意約款） ─────────────────────────
   * 只在 orders.ibon.com.tw 的購票頁，而且你在助手視窗開啟了「開賣自動點場次」才會動。每一頁只做一次：
   *   UTK0201_000  票區頁：照你的票區關鍵字選第一個還有票的區（沒填關鍵字就選第一個還有票的）；關鍵字都對不到就不選，交給你
   *   UTK0201_001 等 張數頁：把張數選成你設定的（不超過選單上限）；有驗證碼就停下來讓你自己輸入、自己按；沒有驗證碼才按「下一步」
   *   UTK0206      填寫購票資訊：勾「同意」、按「下一步」（結構照 2026-10-16 真站快照）
   * 驗證碼、排隊、流量控管字樣一出現就整頁不動。付款、最後的確認頁都不碰。
   * 票區頁與張數頁的選擇器參考 tickets_hunter 的 ibon.py，這兩頁還沒在這個專案的真站快照核對過；找不到或對不上就什麼都不做。 */
  async function ibonFlowWatch() {
    let cfg;
    try { cfg = (await chrome.storage.local.get('ibonAuto')).ibonAuto; } catch (_) { return; }
    if (!cfg || cfg.enabled !== true) return;
    const kind = IbonAdapter.pageKind();
    if (kind !== 'purchase-entry' && kind !== 'purchase' && kind !== 'buyer-info') return;
    const guardKey = `ibonFlow:${location.pathname}${location.search}`;
    try { if (sessionStorage.getItem(guardKey)) return; } catch (_) { /* 沒有 sessionStorage 就靠下面的一頁一次 */ }
    const stop = () => /排隊|流量控管|請稍候|機器人|robot/i.test(visibleText());
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (stop()) return;
      if (await ibonFlowStep(kind, cfg)) { try { sessionStorage.setItem(guardKey, '1'); } catch (_) {} return; }
      await sleep(300);
    }
  }

  const DEFAULT_EXCLUDE = ['輪椅', '身障', '身心', '障礙', '愛心', 'Restricted View', '燈柱遮蔽', '視線不完整'];
  const flowVisible = (el) => !!el && isVisible(el);
  const soldOut = (t) => /已售完|售完|已額滿|額滿|暫無|無法購買/.test(t);

  /** 做完這一頁該做的事回 true；還沒準備好（頁面還在載入）回 false */
  async function ibonFlowStep(kind, cfg) {
    if (kind === 'purchase-entry') {
      const rows = deepAll('tbody tr').filter((r) => flowVisible(r) && r.querySelector('a[href], a[onclick]'));
      if (!rows.length) return false;
      // 排除字（同 kktix 助手 exclude）：名稱含這些字的票區一律不選，沒設定就用預設
      const exclude = (cfg.exclude == null ? DEFAULT_EXCLUDE : String(cfg.exclude).split(/\r?\n/)).map((x) => norm(x)).filter(Boolean);
      const ok = rows.filter((r) => { const t = norm(r.textContent); return !soldOut(t) && !exclude.some((x) => t.toLowerCase().includes(x.toLowerCase())); });
      const lines = String(cfg.areas || '').split(/\r?\n/).map((l) => norm(l)).filter(Boolean);
      let pick = null;
      for (const l of lines) {
        const terms = l.split(' ');
        pick = ok.find((r) => terms.every((t) => norm(r.textContent).includes(t)));
        if (pick) break;
      }
      if (!pick && !lines.length) pick = ok[0];
      if (!pick) return true;   // 沒有對得上的區：不選，交給你
      const a = pick.querySelector('a[href], a[onclick]');
      a.click();
      return true;
    }
    if (kind === 'purchase') {
      const sels = deepAll('table.rwdtable select.form-control-sm, table.table select[name*="AMOUNT_DDL"], select.form-control-sm').filter(flowVisible);
      if (!sels.length) return false;
      const want = Math.max(1, Math.min(Number(cfg.qty) || 1, 4));
      const sel = sels[0];
      const opts = [...sel.options].map((o) => Number(o.value)).filter((n) => Number.isFinite(n) && n > 0);
      if (!opts.length) return true;
      const n = Math.min(want, Math.max(...opts));
      sel.value = String(n);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const captcha = deepAll('#ctl00_ContentPlaceHolder1_CHK, input[id*="CHK"]').find(flowVisible);
      if (captcha) return true;   // 驗證碼由你輸入、你按下一步
      const next = $('#ctl00_ContentPlaceHolder1_A2') || $('a[id*="AddShopingCart"]')
        || deepAll('a.btn.btn-primary.btn-block').find((b) => flowVisible(b) && /下一步/.test(b.textContent));
      if (next) next.click();
      return true;
    }
    // buyer-info：勾同意、按下一步
    const agree = $$('input[type=checkbox]').find((c) => { const l = c.id ? $(`label[for="${CSS.escape(c.id)}"]`) : null; return l && /同意/.test(l.textContent); });
    const nextLink = deepAll('a, button').find((b) => flowVisible(b) && /^下一步/.test(norm(b.textContent)));
    if (!agree || !nextLink) return false;
    if (!agree.checked) agree.click();
    await sleep(150);
    if (!agree.checked) return true;
    nextLink.click();
    return true;
  }

