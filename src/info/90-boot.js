  /* ───────────────────────── 啟動 ─────────────────────────
   * 載入時問背景程式：這個分頁是不是它開來讀資訊的？是才讀。你自己開著的活動頁，背景程式也可以直接要它讀一次。
   * 兩種情況都只讀，讀完把整理好的資訊交回去。 */

  async function readAndBuild() {
    const raw = await readIbonActivity(15000);
    return { ok: true, info: { ...buildEventInfo(raw, Date.now()), warnings: raw.warnings } };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'info-read' || sender.id !== chrome.runtime.id) return false;
    readAndBuild().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
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
