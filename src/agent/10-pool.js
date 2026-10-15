  /* ───────────────────────── 網站轉接：本機一般票券模擬站 ─────────────────────────
   * ticket-sim 用 SIM_SITE=pool 啟動的本機測試網站（虛構的游泳池單次入場票）。
   * 只用語意線索（05-dom.js）：網址判斷是哪一頁，文字找按鈕與狀態，標籤找欄位，選票欄位用 name。
   * 不靠 data-testid，所以模擬站的困難模式（沒有測試錨點、封閉 Shadow DOM、隨機 id 與欄位名稱）也能用。
   * 通用流程只呼叫這裡的函式；要支援別的網站，就照同樣的函式再寫一支。 */
  const STATUS_WORDS = [['已額滿', 'full'], ['尚未開放', 'not-open'], ['剩少量', 'limited'], ['可購買', 'available']];
  const statusFromText = (t) => (STATUS_WORDS.find(([w]) => t.includes(w)) || [null, 'unknown'])[1];

  const POOL = {
    id: 'pool',

    /** 這一頁是不是模擬站（模擬站自己在 meta 標示） */
    matches: () => !!$('meta[name="sim-site"][content="pool"]'),

    listUrl: () => `${location.origin}/pool/`,

    /** 某一步送出成功後會到哪一頁（網站說「重複送出」時，直接去下一步看） */
    nextUrl: (step) => `${location.origin}/pool/${step === 'select' ? 'info' : 'confirm'}`,

    /** 錯誤頁網址不變，先看標題；其他看網址 */
    pageKind() {
      if (/^(系統發生錯誤|無法完成這個動作)$/.test(textOf($('main h1')))) return 'error';
      const p = location.pathname;
      if (/^\/pool\/?$/.test(p)) return 'list';
      if (/^\/pool\/select\/[^/]+$/.test(p)) return 'select';
      if (p === '/pool/info') return 'info';
      if (p === '/pool/confirm') return 'confirm';
      if (/^\/pool\/done\/[^/]+$/.test(p)) return 'done';
      if (p === '/pool/queue') return 'queue';
      return 'other';
    },

    /** 網站在訊息最後附上錯誤代碼「（SOLD_OUT）」；狀態碼「（503）」也讀出來 */
    parseError(text) {
      const t = norm(text);
      const code = (t.match(/（([A-Z][A-Z_]+)）/) || [])[1] || '';
      const status = Number((t.match(/（(\d{3})）/) || [])[1]) || 0;
      return { text: t, code, status };
    },

    /* ── 時段列表 ── */

    slotSection: () => { const h = byText('h2', '選擇入場時段')[0]; return h ? h.closest('section') : null; },

    /**
     * { loading, error, status, slots, stamp }：slots 是 { id, text, status, remaining, el }；
     * stamp 是第一列元素本身，重新讀取後會換成新的元素，用來分辨「已經是新的資料」。
     */
    listState() {
      const sec = POOL.slotSection();
      if (!sec) return { loading: true, error: '', slots: null, stamp: null };
      const alert = [...sec.querySelectorAll('[role="alert"]')].find((a) => !a.hidden && textOf(a));
      const errText = alert ? textOf(alert) : '';
      const loading = deepAll('[aria-busy="true"]', sec).length > 0 || byText('p', '載入中', sec).length > 0;
      const rows = deepAll('tr', sec).filter((tr) => /\d{1,2}:\d{2}/.test(textOf(tr.querySelector('th'))) && tr.querySelector('a, button'));
      const slots = rows.length ? rows.map((tr) => {
        const day = tr.closest('section');
        const date = day ? textOf(day.querySelector('h3')) : '';
        const time = textOf(tr.querySelector('th'));
        const cells = [...tr.querySelectorAll('td')].map(textOf);
        const statusText = cells.find((c) => statusFromText(c) !== 'unknown') || '';
        const link = tr.querySelector('a[href*="/select/"]');
        const id = link ? decodeURIComponent(link.getAttribute('href').split('/').pop()) : `${date} ${time}`;
        const m = statusText.match(/剩\s*(\d+)\s*張/);
        return { id, text: norm(`${date} ${time}`), status: statusFromText(statusText), remaining: m ? Number(m[1]) : null, el: tr };
      }) : null;
      return { loading, error: errText, status: errText ? POOL.parseError(errText).status : 0, slots, stamp: rows[0] || null };
    },

    refreshList() {
      const b = buttonByText('更新狀態');
      if (b) b.click();
      return !!b;
    },

    openSlot(slot) {
      const a = slot.el && slot.el.querySelector('a[href*="/select/"]');
      if (!a) return false;
      a.click();
      return true;
    },

    /** 票價表（標題是「票價」的表格）→ [{ name, price }] */
    prices() {
      const table = deepAll('table').find((t) => textOf(t.querySelector('caption')) === '票價');
      if (!table) return [];
      return [...table.querySelectorAll('tr')].map((tr) => ({
        name: textOf(tr.querySelector('th')),
        price: Number((textOf(tr.querySelector('td')).match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, '')),
      })).filter((p) => p.name);
    },

    /** 尚未開放時，頁面寫的開放說明 */
    openingText() {
      const sec = POOL.slotSection();
      const el = sec ? [...sec.querySelectorAll('[role="status"]')].find((x) => !x.hidden && /開放/.test(textOf(x))) : null;
      return el ? textOf(el) : '';
    },

    /* ── 選票頁 ── */

    selectInfo() {
      const p = byText('p', /^入場時段：/)[0];
      const text = p ? textOf(p).replace(/^入場時段：/, '') : '';
      const slotId = decodeURIComponent(location.pathname.split('/').pop());
      return { slotId, text, status: statusFromText(text) };
    },

    /** 張數欄位：name 是 qty_<票種>；票種名稱看欄位的標籤，單價看同一列的 NT$ */
    ticketTypes() {
      return $$('select[name^="qty_"]').map((sel) => {
        const label = sel.labels && sel.labels[0];
        const row = sel.closest('tr');
        const price = Number((textOf(row).match(/NT\$\s*([\d,]+)/) || [0, '0'])[1].replace(/,/g, ''));
        return { id: sel.name.replace(/^qty_/, ''), name: textOf(label), price, select: sel };
      });
    },

    maxPerOrder() {
      const vals = $$('select[name^="qty_"] option').map((o) => Number(o.value)).filter(Number.isFinite);
      return vals.length ? Math.max(...vals) : Infinity;
    },

    setQty(typeId, n) {
      const sel = $(`select[name="qty_${CSS.escape(typeId)}"]`);
      return !!(sel && setFieldValue(sel, n));
    },

    qtyOf(typeId) {
      const sel = $(`select[name="qty_${CSS.escape(typeId)}"]`);
      return sel ? Number(sel.value) : NaN;
    },

    submitSelect() { const b = buttonByText('下一步'); if (b) b.click(); return !!b; },

    /** 表單層級的錯誤：「下一步」或「確認建立訂單」那一列正上方的訊息 */
    formError() {
      const b = buttonByText('下一步') || buttonByText('確認建立訂單');
      return alertAbove(b);
    },

    /* ── 填資料頁 ── */

    PROFILE_LABELS: { name: '姓名', phone: '手機', email: 'Email', note: '備註' },

    profileInput: (field) => fieldByLabel(POOL.PROFILE_LABELS[field]),

    /** 填你提供的資料，回傳 { filled, missing }；備註沒填就不動 */
    fillProfile(p) {
      const filled = [], missing = [];
      for (const f of Object.keys(POOL.PROFILE_LABELS)) {
        if (f === 'note' && !p.note) continue;
        const el = POOL.profileInput(f);
        if (!el) { missing.push(POOL.PROFILE_LABELS[f]); continue; }
        if (setFieldValue(el, p[f] || '')) filled.push(f); else missing.push(POOL.PROFILE_LABELS[f]);
      }
      return { filled, missing };
    },

    agreeBox: () => { const c = fieldByLabel(/同意/); return c && c.type === 'checkbox' ? c : null; },

    hasAgree: () => !!POOL.agreeBox(),

    setAgree(on) {
      const cb = POOL.agreeBox();
      if (!cb) return false;
      if (cb.checked !== on) cb.click();
      return cb.checked === on;
    },

    /** 網站逐欄顯示的錯誤 → { 欄位: 訊息 } */
    fieldErrors() {
      const out = {};
      for (const f of Object.keys(POOL.PROFILE_LABELS)) {
        const msg = alertNear(POOL.profileInput(f));
        if (msg) out[f] = msg;
      }
      const agree = alertNear(POOL.agreeBox());
      if (agree) out.agree = agree;
      return out;
    },

    submitInfo() { const b = buttonByText('下一步'); if (b) b.click(); return !!b; },

    /* ── 確認頁：只讀，不按 ── */

    confirmGates: () => ({
      captcha: !!fieldByLabel('驗證碼') || deepAll('canvas[aria-label*="驗證碼"], img[alt*="驗證碼"]').length > 0,
      botcheck: !!buttonByText('我不是機器人'),
    }),

    holdLeft() {
      const m = textOf($('main')).match(/剩餘\s*(\d+)\s*秒/);
      return m ? Number(m[1]) : null;
    },

    confirmButton: () => buttonByText('確認建立訂單'),

    summary: () => textOf($('main')).slice(0, 300),

    /* ── 完成頁、錯誤頁 ── */

    orderId: () => (textOf($('main')).match(/訂單編號：\s*([A-Z0-9-]+)/) || [])[1] || '',

    errorPage() {
      const alert = [...document.querySelectorAll('main [role="alert"]')].find((a) => textOf(a));
      const t = textOf(alert);
      return { status: Number((t.match(/（(\d{3})）/) || [])[1]) || 0, code: (t.match(/^([A-Z][A-Z_]+)/) || [])[1] || '', message: t.replace(/^[A-Z_]+（\d{3}）\s*/, '') };
    },

    /** 頁面重點（黑盒子用）：只取主要內容的文字 */
    mainText: () => textOf($('main')).slice(0, 800),
  };

  /** 目前這一頁用哪一支轉接：DOM 準備好之後由 90-boot.js 決定，都不認得就是 null（什麼都不做） */
  const ADAPTERS = [POOL];
  let SITE = null;
  const pickSite = () => ADAPTERS.find((a) => a.matches()) || null;
