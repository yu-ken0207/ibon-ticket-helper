  /* ───────────────────────── 驗證問題頁（UTK0201_0.aspx?rn=…） ─────────────────────────
   * 有些活動要先回答驗證問題（例如會員資格）。助手不代答，通知你作答；你送出後進到下一頁，助手接著動作。 */

  async function runVerify() {
    const input = deepAll('#content input[type="text"], #content input:not([type]), div.editor-box input[type="text"]').find(isVisible);
    if (input) handToUser(input);
    return finish(false, 'verify', 'ibon 要你先回答驗證問題。請自己作答並送出，之後的步驟助手會接著做', { handOff: true });
  }
