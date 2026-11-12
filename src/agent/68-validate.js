  /* ───────────────────────── 持卡人優先購驗證頁（ticket.ibon.com.tw/Vaildate/…） ─────────────────────────
   * 做法照 tickets_hunter nodriver_ibon_card_vaildate：
   *   填入 cfg.cardPrefix（信用卡前幾碼），沒設就填第一個 memberCodes。
   *   欄位是 #content input[type=text]（Angular ngModel，所以要用 setNativeInputValue）；送出按鈕 #content a.btn。
   *   已經填了值就不覆蓋；頁面重新畫出時也只送一次（送出後 beforeunload 會把 state.leaving 設起來，後面 clickUntilReacts 不會再點）。
   */
  async function runValidate(cfg) {
    setStatus('持卡人優先購驗證頁…', 'ok');
    await waitFor(() => validateInput() && validateSubmit(), 10000);
    if (state.aborted || state.leaving) return;
    const input = validateInput();
    const submit = validateSubmit();
    if (!input || !submit) return finish(false, 'card-validate', 'ibon 要你先驗證持卡人資格（優先購）。找不到輸入欄或送出按鈕，請自己完成', { handOff: true });
    // 已經填好就不覆蓋（可能是你剛填、頁面重新渲染）
    if (norm(input.value || '')) {
      log('輸入欄已經有值，不覆蓋');
    } else {
      const prefix = String(cfg.cardPrefix || '').trim() || parseList(cfg.memberCodes || '')[0] || '';
      if (!prefix) {
        handToUser(input);
        return finish(false, 'card-validate', 'ibon 要你先驗證持卡人資格（優先購）。你還沒設定「持卡人卡號前幾碼」或「會員代碼」，請自己填入並送出', { handOff: true });
      }
      if (!setNativeInputValue(input, prefix)) {
        return finish(false, 'card-validate-fill', '驗證欄位填不進去（可能受控表單擋住），請自己填入並送出', { handOff: true });
      }
      log(`已填驗證欄位（${prefix.length} 字）`);
    }
    await settle(150, 3000, 200);
    if (state.aborted || state.leaving) return;
    log(`按下送出（${pageAge()}）`);
    const out = await clickUntilReacts(submit, 30000, '正在驗證', [pageClick, (b) => b.click(), (b) => pointClick(b)]);
    if (out.kind === 'alert') return handleAlert(out, '送出持卡人驗證');
    if (out.kind === 'timeout') return finish(false, 'no-advance', '送出持卡人驗證後 30 秒頁面沒進到下一步，可能卡號不對或 ibon 處理中，請自己看畫面', { handOff: true });
    return undefined;
  }
