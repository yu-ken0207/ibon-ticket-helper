  /* ───────────────────────── 啟動 ─────────────────────────
   * 載入時問背景程式：這個分頁是不是它開來讀資訊的？是才讀。你自己開著的活動頁，背景程式也可以直接要它讀一次。
   * 兩種情況都只讀，讀完把整理好的資訊交回去。 */

  async function readAndBuild() {
    if (IbonAdapter.pageKind() !== 'activity') return { ok: false, error: '這一頁不是活動頁' };
    const raw = await IbonAdapter.readActivity(15000);
    const login = IbonAdapter.loginState();
    return { ok: true, info: { ...buildEventInfo(raw, Date.now()), warnings: raw.warnings, login } };
  }

  /* 背景程式要的東西（只接受擴充功能自己送來的）：
   *   info-read      讀活動頁的資訊
   *   page-state     這一頁的種類、登入、狀態提示、操作政策
   *   page-snapshot  結構快照 */
  const HANDLERS = {
    'info-read': readAndBuild,
    'page-state': async () => ({ ok: true, state: IbonAdapter.readState() }),
    'page-snapshot': async () => ({ ok: true, snapshot: IbonAdapter.snapshot() }),
  };
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const fn = msg && HANDLERS[msg.type];
    if (!fn || sender.id !== chrome.runtime.id) return false;
    fn().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });

  (async () => {
    let r = null;
    try { r = await chrome.runtime.sendMessage({ type: 'info-hello', payload: { url: location.href } }); } catch (_) { return; }
    if (!r || !r.read) return;   // 不是要讀的分頁：什麼都不做
    let out;
    try { out = await readAndBuild(); } catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
    try { await chrome.runtime.sendMessage({ type: 'info-result', payload: out }); } catch (_) { /* 背景程式不在了 */ }
  })();
})();
