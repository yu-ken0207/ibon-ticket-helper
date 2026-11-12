  /* ───────────────────────── 驗證問題頁（UTK0201_0.aspx?rn=…） ─────────────────────────
   * 有些活動要先填會員優先購代碼、身分證末幾碼之類的題目。cfg.memberCodes 是你在設定裡填的一列答案（一行一個）。
   * 做法照 tickets_hunter nodriver_ibon_verification_question：
   *   題目在 #content div.form-group 的 span 裡；欄位是同一個 form-group 的 input；送出按鈕是 #content a.btn。
   *   單題：題目有「末N碼／前N碼」就從答案裡截取；一組答案就填那一個。
   *   多題：answer[i] 對 question[i]，各自依題目截取。
   * 沒答案或答案不夠就不填、通知你接手。送出後靠 clickUntilReacts 等反應，不會重複送。
   */
  async function runVerify(cfg) {
    setStatus('驗證問題頁…', 'ok');
    await waitFor(() => verifyInputs().length && verifySubmit(), 10000);
    if (state.aborted || state.leaving) return;
    const inputs = verifyInputs();
    const submit = verifySubmit();
    if (!inputs.length || !submit) return finish(false, 'verify', 'ibon 要你先回答驗證問題。請自己作答並送出，之後的步驟助手會接著做', { handOff: true });
    const questions = verifyQuestions();
    const codes = parseList(cfg.memberCodes || '');
    if (!codes.length) {
      handToUser(inputs[0]);
      return finish(false, 'verify', 'ibon 要你先回答驗證問題。你還沒設定「會員代碼／優先購號碼」，請自己作答並送出', { handOff: true });
    }
    // 多題但你填的不夠：停下來提示，不要用第一組亂填（tickets_hunter 單題模式只填第一格，我覺得整張表單有一格空等於白填）
    if (inputs.length > 1 && codes.length < inputs.length) {
      handToUser(inputs[codes.length]);
      return finish(false, 'verify', `ibon 要你回答 ${inputs.length} 題驗證問題，你設定的「會員代碼」只有 ${codes.length} 組。請自己補上並送出`, { handOff: true });
    }
    // 逐欄算要填的答案；多題時 codes[i] 對 inputs[i]，單題時試每個 code 找非空的
    const answers = [];
    for (let i = 0; i < inputs.length; i++) {
      const q = questions[i] || questions[0] || '';
      if (inputs.length > 1) { answers.push(extractAnswer(codes[i], q)); continue; }
      let best = '';
      for (const c of codes) { const v = extractAnswer(c, q); if (v) { best = v; break; } }
      answers.push(best);
    }
    if (answers.some((a) => !a)) {
      handToUser(inputs[0]);
      return finish(false, 'verify', '驗證問題題目認不出，助手沒辦法決定要填哪個值。請自己作答並送出', { handOff: true });
    }
    for (let i = 0; i < inputs.length; i++) {
      if (!setNativeInputValue(inputs[i], answers[i])) {
        return finish(false, 'verify-fill', `驗證問題第 ${i + 1} 格填不進去（可能受控表單擋住），請自己作答`, { handOff: true });
      }
      log(`驗證問題第 ${i + 1} 格已填（${answers[i].length} 字）`);
    }
    await settle(150, 3000, 200);
    if (state.aborted || state.leaving) return;
    log(`按下「下一步」（${pageAge()}）`);
    const out = await clickUntilReacts(submit, 30000, '正在驗證', [pageClick, (b) => b.click(), (b) => pointClick(b)]);
    if (out.kind === 'alert') return handleAlert(out, '送出驗證答案');
    if (out.kind === 'timeout') return finish(false, 'no-advance', '送出驗證答案後 30 秒頁面沒進到下一步，可能答案不對或 ibon 處理中，請自己看畫面', { handOff: true });
    return undefined;
  }
