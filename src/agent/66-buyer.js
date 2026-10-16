  /* ───────────────────────── 填購票資訊頁（UTK0206_，第 4 步，2026-10-16 真站快照） ─────────────────────────
   * 進到這一頁名額就保留了（頁面開始倒數「剩餘時間」；tickets_hunter 也把到這一頁當成成功）。
   * 助手只勾同意、按下一步；電話與 Email 是會員資料，ibon 已經帶好，不改。實名制要填持票人資料，交給你。 */
  const buyerAgree = () => $$('input[type=checkbox]').find((c) => {
    const l = c.id ? $(`label[for="${CSS.escape(c.id)}"]`) : null;
    return l && /同意/.test(l.textContent);
  }) || null;
  const buyerNext = () => deepAll('a, button').find((b) => isVisible(b) && /^下一步/.test(norm(b.textContent))) || null;
  const buyerCountdown = () => $$('span').filter(isVisible).map((el) => norm(el.textContent)).find((x) => /^剩餘時間\s*\d{1,2}\s*[:：]\s*\d{2}$/.test(x)) || null;

  /** 填購票資訊頁：勾同意、按下一步。不改你的資料（電話、Email 是會員資料，ibon 已經帶好） */
  async function runBuyer(cfg) {
    setStatus('填購票資訊頁…', 'ok');
    const left = buyerCountdown();
    send('warn', { kind: 'held', msg: `名額已保留${left ? `（ibon 顯示${left}）` : ''}。助手會勾同意並按下一步；確認訂單與付款請你自己來，保留有時間限制` });
    const t0 = Date.now();
    while ((!buyerAgree() || !buyerNext()) && Date.now() - t0 < 15000 && !state.aborted) await sleep(300);
    if (state.aborted) return;
    const agree = buyerAgree();
    const next = buyerNext();
    if (!agree || !next) return finish(false, 'no-buyer-form', '找不到「同意」或「下一步」，請自己操作（名額已保留，注意剩餘時間）', { handOff: true });
    if (cfg.autoAgree === false) {
      handToUser(agree);
      return finish(false, 'agree', '你設定不自動勾選同意。請自己閱讀後勾選並按下一步', { handOff: true });
    }
    if (!agree.checked) pageClick(agree);
    await sleep(150);
    if (!agree.checked) return finish(false, 'agree-failed', '同意條款勾不起來，請自己勾選', { handOff: true });
    log('已勾選同意約款');
    await settle(500, 4000, 600);   // 勾選後 ibon 可能在背景更新頁面，等安靜了再按下一步
    if (state.aborted) return;
    if (/實名制/.test(visibleText())) {
      // 實名制要填持票人資料，助手不替你填（tickets_hunter 遇到實名制也不按下一步）
      handToUser(next);
      return finish(false, 'name-based', '這場是實名制，請自己填寫持票人資料後按下一步（名額已保留，注意剩餘時間）', { handOff: true });
    }
    log('按下「下一步」');
    const out = await clickAndWatch(next, 45000, '正在處理');
    // 這一頁名額已經保留：被網站擋下時不重新整理（重新整理可能弄丟保留的名額），交給你看
    if (out.kind === 'alert') return finish(false, 'rejected', `按下一步時 ibon 回覆「${out.msg}」。名額還在保留中，請自己看畫面，先不要重新整理`, { handOff: true });
    if (out.kind === 'timeout') return finish(false, 'timeout', '按下一步後等了 45 秒頁面還是沒有反應，請看畫面，先不要重新整理', { handOff: true });
    return undefined;
  }

