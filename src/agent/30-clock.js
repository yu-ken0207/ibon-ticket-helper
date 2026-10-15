  /* ───────────────────────── 對時 ───────────────────────── */

  /**
   * HTTP Date header 只有「秒」精度，直接拿會有 ±500ms 誤差，所以抓伺服器「跨秒」的那一瞬間。分兩段：
   *   第一段：每 140ms 探一次，抓到跨秒。這樣算出來的時間只會偏慢（0～140ms），不會偏快。
   *   第二段：預測下一次跨秒，在那附近每 20ms 同時送出探測，把誤差壓到約 20ms。
   * 第二段失敗就沿用第一段的結果。
   */
  async function headDate(url) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
      const t1 = Date.now();
      const sec = new Date(res.headers.get('Date') || '').getTime();
      return Number.isFinite(sec) ? { t0, t1, sec } : null;
    } catch (_) { return null; }
  }

  /**
   * 跟網站的伺服器對時，回傳 { offset, reliable }，失敗回傳 null。
   * 網頁在背景時，Chrome 會把計時器對齊到整秒，跨秒的時間點會量偏將近一秒（2026-10-15 在一台 Windows 電腦量到「本機快 947 ms」）。
   * 所以對時期間只要網頁進過背景、或任何一次等待被拖長，這次結果就不採用，維持原本的值，等網頁回到前景再對。
   */
  async function syncClock(maxProbe = 15) {
    if (state.syncing) return null;
    state.syncing = true;
    const before = state.clockOffset;
    let throttled = document.hidden;
    const onVis = () => { if (document.hidden) throttled = true; };
    document.addEventListener('visibilitychange', onVis);
    const nap = async (ms) => {
      const t = Date.now();
      await sleep(ms);
      if (Date.now() - t > ms + 250) throttled = true;
    };
    // 一發現被拖慢就放棄這次，不硬做完：背景時每次等待都會被拉長到一秒，做完要二十幾秒，結果還是不準
    const bail = () => {
      state.clockOffset = before;   // 沒對過就是本機時間，對過就沿用上一次可靠的結果
      return { offset: before, reliable: false };
    };
    try {
      const url = location.origin + '/robots.txt';
      let prev = null;
      let coarse = null;
      for (let i = 0; i < maxProbe && !coarse; i++) {
        if (state.aborted) return null;
        if (throttled) return bail();
        const p = await headDate(url);
        if (!p) return null;
        if (prev && p.sec > prev.sec) {
          coarse = { offset: probeOffset(p), boundaryLocal: p.t1 - (p.t1 - p.t0) / 2 };
        } else {
          prev = p;
          await nap(140);
        }
      }
      if (!coarse) return null;
      let offset = coarse.offset;

      // 第二段：真正的跨秒落在估計值之前 0～140ms，下一次跨秒就在 +860～+1000ms 之間
      const startAt = coarse.boundaryLocal + 1000 - 170;
      await nap(Math.max(0, startAt - Date.now()));
      if (throttled) return bail();
      const probes = [];
      for (let i = 0; i < 12 && !throttled; i++) {
        probes.push(headDate(url));
        await nap(20);
      }
      if (throttled) return bail();
      const fine = crossingOffset(await Promise.all(probes));   // 計算寫在 lib/clock.js
      if (fine !== null) offset = fine;
      if (throttled) return bail();
      state.clockOffset = offset;
      state.clockReliable = true;
      return { offset, reliable: true };
    } finally {
      document.removeEventListener('visibilitychange', onVis);
      state.syncing = false;
    }
  }

  /** 對時並寫紀錄、回報背景程式；量不準時不採用 */
  async function doSync(label) {
    const r = await syncClock();
    if (!r) {
      log(`${label}失敗，先用${state.clockReliable ? '上一次對時的結果' : '本機時間'}`, 'warn');
      return;
    }
    if (!r.reliable) {
      log(`${label}時網頁在背景，Chrome 會拖慢計時，這次量的不準，不採用。網頁回到前景時會再對一次`, 'warn');
      return;
    }
    log(`${label}：本機${r.offset >= 0 ? '慢' : '快'} ${Math.abs(r.offset)} ms`);
    send('clock', { offset: r.offset, reliable: true, at: Date.now() });
  }

  /** 對時一直量不準：網頁回到前景時再對一次，離開賣不到 3 秒就不對了，免得拖到重新整理 */
  function resyncWhenVisible(fireAt) {
    if (state.resyncArmed) return;
    state.resyncArmed = true;
    const onVis = async () => {
      if (document.hidden || state.aborted || state.syncing) return;
      if (state.clockReliable || fireAt - now() < 3000) {
        document.removeEventListener('visibilitychange', onVis);
        return;
      }
      await doSync('網頁回到前景，重新對時');
    };
    document.addEventListener('visibilitychange', onVis);
    if (!document.hidden) onVis();   // 已經在前景了：不用等下一次切換，現在就重對
  }

  /** 等到伺服器時間 ts。遠的時候省電輪詢，越接近越密，最後 60ms 每 4ms 檢查一次。 */
  async function waitUntil(ts) {
    let lastHiddenWarn = 0;
    for (;;) {
      if (state.aborted) return false;
      const left = ts - now();
      setCountdown(left);
      if (left <= 0) return true;
      if (document.hidden && left < 20000 && Date.now() - lastHiddenWarn > 5000) {
        lastHiddenWarn = Date.now();
        setStatus('這個分頁不在前景，瀏覽器可能拖慢計時！請把它切到前景', 'warn');
        send('warn', { kind: 'hidden', msg: '購票頁被切到背景或最小化了，開賣時可能晚好幾秒。請讓它保持在前景。' });
      }
      if (left > 3000) await sleep(200);
      else if (left > 60) await sleep(16);
      else await sleep(4);   // 最後 60ms 每 4ms 看一次。不用 requestAnimationFrame：分頁不在前景時畫面不更新，它會整個停住
    }
  }

