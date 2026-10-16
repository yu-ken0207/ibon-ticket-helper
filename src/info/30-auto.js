  /* ───────────────────────── 開賣自動點場次（ibon 客服 2026-10-16 回覆：允許自動選擇場次） ─────────────────────────
   * 只在你開著的活動頁做一件事：你選的那個場次的「線上購票」按鈕變成可按時，點一次。
   * 開賣時間到了按鈕還是灰的才重新整理（到點後 30 毫秒一次，之後每 1 秒一次，最多 30 次（同 kktix 助手預設））；沒登入不點；選票區、張數、驗證碼、排隊、送出、付款都不碰。
   * 設定在 chrome.storage.local 的 ibonAuto：{ enabled, when（場次的演出時間，例如「2026/10/24 13:00」）, saleAt（開賣時間，台灣時間 ISO）, reloads, lastReload, lastClick }。
   * 沒到開賣時間就只等（每 0.3 秒看一眼畫面）。 */
  const AUTO_POLL_MS = 300;
  const AUTO_GIVE_UP_MS = 30 * 60 * 1000;
  const AUTO_NO_REPEAT_MS = 2 * 60 * 1000;
  // 開賣時間一到按鈕還是灰的，才重新整理頁面（像 kktix 助手：準時整理一次，之後隔一段時間再整理，次數有上限，用完就停下來交給你）
  const AUTO_RELOAD_GAP_MS = 1000;   // 同 kktix 助手的 notOpenRetryMs
  const AUTO_FIRE_OFFSET_MS = 30;   // 同 kktix 助手的 fireOffsetMs：到點後再等一下才整理
  const AUTO_RELOAD_MAX = 30;    // 同 kktix 助手的 notOpenMaxRetries


  /* ───── 對時（做法同 kktix 助手 src/agent/30-clock.js）─────
   * HTTP Date 只有秒精度，所以抓伺服器「跨秒」的那一瞬間：第一段每 140ms 探一次抓到跨秒，
   * 第二段預測下一次跨秒，在附近每 20ms 同時送出探測，誤差約 20ms。量到的是「伺服器 − 本機」毫秒數，存在 ibonClock。
   * 網頁在背景時 Chrome 會拖慢計時、量不準，發現被拖慢就放棄這次。 */
  const CLOCK_FRESH_MS = 10 * 60 * 1000;
  let clockBusy = false;
  const probeOffset = (p) => Math.round(p.sec - (p.t1 - (p.t1 - p.t0) / 2));
  async function headDate(url) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
      const t1 = Date.now();
      const sec = new Date(res.headers.get('Date') || '').getTime();
      return Number.isFinite(sec) ? { t0, t1, sec } : null;
    } catch (_) { return null; }
  }
  async function syncServerClock() {
    if (clockBusy) return null;
    clockBusy = true;
    let throttled = document.hidden;
    const onVis = () => { if (document.hidden) throttled = true; };
    document.addEventListener('visibilitychange', onVis);
    const nap = async (ms) => { const t = Date.now(); await sleep(ms); if (Date.now() - t > ms + 250) throttled = true; };
    try {
      const url = location.origin + '/assets/favicon.ico';
      let prev = null; let coarse = null;
      for (let i = 0; i < 15 && !coarse; i++) {
        if (throttled) return null;
        const p = await headDate(url);
        if (!p) return null;
        if (prev && p.sec > prev.sec) coarse = { offset: probeOffset(p), boundaryLocal: p.t1 - (p.t1 - p.t0) / 2 };
        else { prev = p; await nap(140); }
      }
      if (!coarse) return null;
      let offset = coarse.offset;
      await nap(Math.max(0, coarse.boundaryLocal + 1000 - 170 - Date.now()));
      if (throttled) return null;
      const probes = [];
      for (let i = 0; i < 12 && !throttled; i++) { probes.push(headDate(url)); await nap(20); }
      if (throttled) return null;
      const got = (await Promise.all(probes)).filter(Boolean).sort((a, b) => a.t0 - b.t0);
      if (got.length) { const k = got.findIndex((q) => q.sec > got[0].sec); if (k > 0) offset = probeOffset(got[k]); }
      if (throttled) return null;
      try { await chrome.storage.local.set({ ibonClock: { offset, at: Date.now() } }); } catch (_) { /* 存不了就只用這一次 */ }
      return offset;
    } finally {
      document.removeEventListener('visibilitychange', onVis);
      clockBusy = false;
    }
  }
  async function serverOffset() {
    try { const c = (await chrome.storage.local.get('ibonClock')).ibonClock; return c && Date.now() - c.at < CLOCK_FRESH_MS ? { offset: Number(c.offset) || 0, fresh: true } : { offset: 0, fresh: false }; } catch (_) { return { offset: 0, fresh: false }; }
  }

  let autoRunning = false;
  function ibonAutoWatch() {
    ibonAutoSession();
    try { chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.ibonAuto) ibonAutoSession(); }); } catch (_) { /* 沒有 storage 事件就只在載入時啟動 */ }
  }

  async function ibonAutoSession() {
    if (autoRunning) return;
    autoRunning = true;
    try { await ibonAutoLoop(); } finally { autoRunning = false; }
  }

  /** 頁面右下角的倒數小標籤（同 kktix 助手的倒數面板）：只顯示，不能點 */
  let autoBadge = null;
  function showBadge(text) {
    if (!document.body) return;
    if (!autoBadge || !autoBadge.isConnected) {
      autoBadge = document.createElement('div');
      autoBadge.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#fff;font:14px/1.4 sans-serif;padding:8px 12px;border-radius:8px;opacity:.9;pointer-events:none';
      document.body.appendChild(autoBadge);
    }
    autoBadge.textContent = text;
  }
  const autoMmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

  async function ibonAutoLoop() {
    let cfg;
    try { cfg = (await chrome.storage.local.get('ibonAuto')).ibonAuto; } catch (_) { return; }
    if (!cfg || cfg.enabled !== true || !cfg.when) return;
    if (cfg.lastClick && Date.now() - cfg.lastClick < AUTO_NO_REPEAT_MS) return;
    const strip = (s) => norm(s).replace(/\s*\([^)]*\)/, '');
    const want = strip(cfg.when);
    const saleMs = twMs(cfg.saleAt);
    const t0 = Date.now();
    let clk = await serverOffset();
    while (Date.now() - t0 < AUTO_GIVE_UP_MS) {
      // 每圈重讀設定：你在視窗關掉或換場次，立刻生效
      try { const c = (await chrome.storage.local.get('ibonAuto')).ibonAuto; if (!c || c.enabled !== true || c.when !== cfg.when) return; cfg = c; } catch (_) { return; }
      const col = columnsOf(sessionHeader());
      const hit = sessionRows().filter((r) => strip(readRow(r, col).when) === want);
      if (hit.length === 1) {
        const info = readRow(hit[0], col);
        const btn = hit[0].querySelector('button, a[role="button"], a.btn');
        if (btn && /線上購票/.test(info.button) && !info.disabled && IbonAdapter.loginState().state !== 'logged-out') {
          try { await chrome.storage.local.set({ ibonAuto: { ...cfg, lastClick: Date.now() } }); } catch (_) { /* 存不了也照點 */ }
          btn.click();
          return;
        }
      }
      // 離開賣還有 15 秒以上、還沒有新的對時結果：背景對一次（不擋住上面的畫面檢查）
      const now = Date.now() + clk.offset;
      showBadge(saleMs > now ? `自動點場次：開賣倒數 ${autoMmss(saleMs - now)}` : `自動點場次：等「線上購票」可按（已整理 ${cfg.reloads || 0}/${AUTO_RELOAD_MAX} 次）`);
      if (!clk.fresh && !clockBusy && saleMs - now > 15000) syncServerClock().then(async () => { clk = await serverOffset(); });
      const n = cfg.reloads || 0;
      if (saleMs + AUTO_FIRE_OFFSET_MS <= now && n < AUTO_RELOAD_MAX && Date.now() - (cfg.lastReload || 0) >= AUTO_RELOAD_GAP_MS) {
        try { await chrome.storage.local.set({ ibonAuto: { ...cfg, reloads: n + 1, lastReload: Date.now() } }); } catch (_) { return; }
        location.reload();
        return;
      }
      const toFire = saleMs + AUTO_FIRE_OFFSET_MS - now;
      await sleep(toFire > 0 && toFire < AUTO_POLL_MS ? toFire : AUTO_POLL_MS);
    }
  }

