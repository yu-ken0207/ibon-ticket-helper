  /* ───────────────────────── 啟動 ─────────────────────────
   * 載入時問背景程式：這個分頁是不是它開來讀資訊的？是才讀。你自己開著的活動頁，背景程式也可以直接要它讀一次。
   * 兩種情況都只讀，讀完把整理好的資訊交回去。 */

  async function readAndBuild() {
    if (IbonAdapter.pageKind() !== 'activity') return { ok: false, error: '這一頁不是活動頁' };
    const raw = await IbonAdapter.readActivity(15000);
    const login = IbonAdapter.loginState();
    return { ok: true, info: { ...buildEventInfo(raw, Date.now()), warnings: raw.warnings, login } };
  }

  /** 人工操作模式：活動頁讀活動資訊，其他頁讀頁面狀態（都只讀） */
  async function guideRead() {
    const kind = IbonAdapter.pageKind();
    if (kind === 'activity') {
      const r = await readAndBuild();
      return r.ok ? { ok: true, kind, info: r.info } : { ok: false, kind, error: r.error };
    }
    if (kind === 'buyer-info') return { ok: true, kind, state: IbonAdapter.readState(), detail: IbonAdapter.readBuyerInfo() };
    return { ok: true, kind, state: IbonAdapter.readState() };
  }

  /* 背景程式要的東西（只接受擴充功能自己送來的）：
   *   info-read      讀活動頁的資訊
   *   page-state     這一頁的種類、登入、狀態提示、操作政策
   *   page-snapshot  結構快照 */
  const HANDLERS = {
    'info-read': readAndBuild,
    'page-state': async () => ({ ok: true, state: IbonAdapter.readState() }),
    'guide-read': guideRead,
    'page-snapshot': async (msg) => ({ ok: true, snapshot: IbonAdapter.snapshot(Array.isArray(msg.own) ? msg.own : []) }),
  };
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const fn = msg && HANDLERS[msg.type];
    if (!fn || sender.id !== chrome.runtime.id) return false;
    fn(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });

  /* 保留倒數：人工操作模式的購票流程頁，每 10 秒讀一次「剩餘時間」交給背景程式（只讀；不重新整理、不點擊）。
   * 背景程式說人工操作模式結束了就停。 */
  const COUNTDOWN_EVERY_MS = 10000;
  function watchCountdown() {
    const tick = async () => {
      let r = null;
      try { r = await chrome.runtime.sendMessage({ type: 'guide-hold', payload: { secs: IbonAdapter.readCountdown(), kind: IbonAdapter.pageKind() } }); } catch (_) { return; }
      if (r && r.guide) setTimeout(tick, COUNTDOWN_EVERY_MS);
    };
    tick();
  }

  (async () => {
    let r = null;
    // 背景程式剛被鬧鐘叫醒時第一次訊息可能失敗：重試幾次；還是不行就當成你自己開的頁（自動點與購票流程不依賴背景程式回應）
    let helloOk = false;
    for (let i = 0; i < 4 && !helloOk; i++) {
      try { r = await chrome.runtime.sendMessage({ type: 'info-hello', payload: { url: location.href } }); helloOk = true; } catch (_) { await sleep(400); }
    }
    if (!helloOk) {
      if (IbonAdapter.pageKind() === 'activity') ibonAutoWatch(); else ibonFlowWatch();
      return;
    }
    if (!r || !r.read) {
      // 背景程式開來讀資訊的臨時分頁（r.read）不跑自動點：只有你自己開著的活動頁才會
      if (IbonAdapter.pageKind() === 'activity') ibonAutoWatch();
      else ibonFlowWatch();
      // 人工操作模式綁著這個分頁：每次換頁都讀一次交給背景程式核對
      let g = null;
      try { g = await chrome.runtime.sendMessage({ type: 'guide-hello', payload: { url: location.href } }); } catch (_) { return; }
      if (g && g.guide) {
        const out = await guideRead().catch((e) => ({ ok: false, error: String(e) }));
        try { await chrome.runtime.sendMessage({ type: 'guide-report', payload: out }); } catch (_) { /* 背景程式不在了 */ }
        if (IbonAdapter.pageKind() !== 'activity') watchCountdown();
      }
      return;   // 不是要讀資訊的分頁：其他什麼都不做
    }
    let out;
    try { out = await readAndBuild(); } catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
    try { await chrome.runtime.sendMessage({ type: 'info-result', payload: out }); } catch (_) { /* 背景程式不在了 */ }
  })();
})();
