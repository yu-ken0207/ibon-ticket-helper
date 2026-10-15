  /* ───────────────────────── 網站轉接：本機一般票券模擬站 ─────────────────────────
   * ticket-sim 用 SIM_SITE=pool 啟動的本機測試網站（虛構的游泳池單次入場票）。
   * 這是唯一知道它頁面長什麼樣子的地方，錨點照 ticket-sim README「給擴充功能的錨點與 API」。
   * 通用流程只呼叫這裡的函式；要支援別的網站，就照同樣的函式再寫一支。 */
  const POOL = {
    id: 'pool',

    /** 這一頁是不是模擬站 */
    matches: () => !!$('meta[name="sim-site"][content="pool"]'),

    listUrl: () => `${location.origin}/pool/`,

    /** 某一步送出成功後會到哪一頁（網站說「重複送出」時，直接去下一步看） */
    nextUrl: (step) => `${location.origin}/pool/${step === 'select' ? 'info' : 'confirm'}`,

    /** list 時段列表、select 選票、info 填資料、confirm 確認、done 完成、queue 排隊、error 錯誤頁，其他是 other */
    pageKind() {
      const k = document.body && document.body.dataset.poolPage;
      return ['list', 'select', 'info', 'confirm', 'done', 'queue', 'error'].includes(k) ? k : 'other';
    },

    /** 網站在訊息最後附上錯誤代碼「（SOLD_OUT）」；狀態碼「（503）」也讀出來 */
    parseError(text) {
      const t = norm(text);
      const code = (t.match(/（([A-Z][A-Z_]+)）/) || [])[1] || '';
      const status = Number((t.match(/（(\d{3})）/) || [])[1]) || 0;
      return { text: t, code, status };
    },

    visibleText(sel) {
      const el = $(sel);
      return el && !el.hidden && isVisible(el) ? norm(el.textContent) : '';
    },

    /* ── 時段列表 ── */

    /** { loading, error, status, slots }：slots 是 { id, text, status, remaining, el } */
    listState() {
      const list = $('[data-testid=slot-list]');
      if (!list) return { loading: true, error: '', slots: null };
      const loading = list.getAttribute('aria-busy') === 'true';
      const errText = POOL.visibleText('[data-testid=list-error]');
      const rows = $$('[data-testid=slot]', list);
      const slots = rows.length ? rows.map((r) => {
        const day = r.closest('[data-testid=slot-day]');
        const date = day ? norm(($('h3', day) || {}).textContent) : '';
        const rem = r.dataset.remaining;
        return { id: r.dataset.slotId, text: norm(`${date} ${($('th', r) || {}).textContent || ''}`), status: r.dataset.status || 'unknown', remaining: rem === '' || rem == null ? null : Number(rem), el: r };
      }) : null;
      return { loading, error: errText, status: errText ? POOL.parseError(errText).status : 0, slots };
    },

    refreshList() {
      const b = $('[data-testid=refresh-status]');
      if (b) b.click();
      return !!b;
    },

    openSlot(slot) {
      const a = slot.el && $('a[data-testid=slot-buy]', slot.el);
      if (!a) return false;
      a.click();
      return true;
    },

    /** 票價表 → [{ name, price }] */
    prices() {
      return $$('[data-testid=price-table] tr').map((tr) => ({
        name: norm(($('th', tr) || {}).textContent),
        price: Number((norm(($('td', tr) || {}).textContent).match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, '')),
      })).filter((p) => p.name);
    },

    /** 尚未開放時，頁面寫的開放說明 */
    openingText: () => POOL.visibleText('[data-testid=opening]'),

    /* ── 選票頁 ── */

    selectInfo() {
      const s = $('[data-testid=selected-slot]');
      const st = $('[data-testid=slot-status]');
      return { slotId: s ? s.dataset.slotId : null, text: s ? norm(s.textContent).replace(/^入場時段：/, '') : '', status: st ? st.dataset.status : 'unknown' };
    },

    /** [{ id, name, price, select }] */
    ticketTypes() {
      return $$('[data-testid=ticket-type]').map((r) => ({
        id: r.dataset.typeId,
        name: norm(($('label', r) || {}).textContent),
        price: Number(r.dataset.price) || 0,
        select: $('select[data-testid=ticket-qty]', r),
      }));
    },

    /** 每筆上限：張數選單最大的那一個 */
    maxPerOrder() {
      const vals = $$('select[data-testid=ticket-qty] option').map((o) => Number(o.value)).filter(Number.isFinite);
      return vals.length ? Math.max(...vals) : Infinity;
    },

    setQty(typeId, n) {
      const t = POOL.ticketTypes().find((x) => x.id === typeId);
      return !!(t && t.select && setFieldValue(t.select, n));
    },

    qtyOf(typeId) {
      const t = POOL.ticketTypes().find((x) => x.id === typeId);
      return t && t.select ? Number(t.select.value) : NaN;
    },

    submitSelect() { const b = $('[data-testid=select-next]'); if (b) b.click(); return !!b; },

    formError: () => POOL.visibleText('[data-testid=form-error]'),

    /* ── 填資料頁 ── */

    PROFILE_FIELDS: ['name', 'phone', 'email', 'note'],

    profileInput(field) {
      const form = $('[data-testid=info-form]');
      return form ? form.elements[field] || null : null;
    },

    /** 填你提供的資料，回傳 { filled, missing }；備註沒填就不動 */
    fillProfile(p) {
      const filled = [], missing = [];
      for (const f of POOL.PROFILE_FIELDS) {
        if (f === 'note' && !p.note) continue;
        const el = POOL.profileInput(f);
        if (!el) { missing.push(f); continue; }
        if (setFieldValue(el, p[f] || '')) filled.push(f); else missing.push(f);
      }
      return { filled, missing };
    },

    hasAgree: () => !!$('[data-testid=agree]'),

    setAgree(on) {
      const cb = $('[data-testid=agree]');
      if (!cb) return false;
      if (cb.checked !== on) cb.click();
      return cb.checked === on;
    },

    /** 網站逐欄顯示的錯誤 → { 欄位: 訊息 } */
    fieldErrors() {
      const out = {};
      for (const el of $$('[data-error-for]')) if (!el.hidden && norm(el.textContent)) out[el.dataset.errorFor] = norm(el.textContent);
      return out;
    },

    submitInfo() { const b = $('[data-testid=info-next]'); if (b) b.click(); return !!b; },

    /* ── 確認頁：只讀，不按 ── */

    confirmGates: () => ({ captcha: !!$('[data-testid=captcha]'), botcheck: !!$('[data-testid=botcheck]') }),

    holdLeft() {
      const el = $('[data-testid=hold-left]');
      const n = el ? Number(norm(el.textContent)) : NaN;
      return Number.isFinite(n) ? n : null;
    },

    confirmButton: () => $('[data-testid=confirm-order]'),

    summary: () => norm(($('[data-testid=order-summary]') || {}).textContent),

    /* ── 完成頁、排隊頁、錯誤頁 ── */

    orderId: () => norm(($('[data-testid=order-id]') || {}).textContent),

    errorPage() {
      const c = $('[data-testid=error-code]');
      return { status: c ? Number(c.dataset.status) || 0 : 0, code: c ? norm(c.textContent) : '', message: norm(($('[data-testid=error-message]') || {}).textContent) };
    },

    /** 頁面重點（黑盒子用）：只取主要內容的文字 */
    mainText: () => norm(($('main') || document.body || {}).innerText || '').slice(0, 800),
  };

  /** 目前這一頁用哪一支轉接：DOM 準備好之後由 90-boot.js 決定，都不認得就是 null（什麼都不做） */
  const ADAPTERS = [POOL];
  let SITE = null;
  const pickSite = () => ADAPTERS.find((a) => a.matches()) || null;
