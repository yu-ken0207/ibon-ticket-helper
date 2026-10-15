// 這個檔案由 tools/build.mjs 從 src/agent/ 和 lib/ 產生，請改那兩個地方，不要直接改這裡。
/*
 * agent.js —— 頁面程式，跑在 ISOLATED world
 *
 * 只需要讀寫 DOM，所以跑在 ISOLATED world：網站的程式碰不到這裡，也能直接用 chrome.runtime 跟背景程式溝通。
 * 背景程式負責排程、到點保險、任務狀態、紀錄與黑盒子；這裡負責每一頁該做的那一步。
 *
 * 結構：
 *   通用流程（60-flow.js 與 lib/flow.js）只用 SITE 的函式讀寫頁面；
 *   每個網站一支轉接（10-pool.js…）負責「這個網站的時段、票種、欄位、按鈕在哪裡」。
 *
 * 一定停下來交給你的地方：確認頁（建立訂單前要你自己確認）、排隊、驗證碼、機器人檢查。
 * 不會繞過任何一種，也不會替你按「確認建立訂單」。
 */
(() => {
  'use strict';

  if (window.__ITH_AGENT__) return;
  window.__ITH_AGENT__ = true;

  const PANEL_TITLE = '一般票券訂票助手';

  const state = {
    clockOffset: 0,
    clockReliable: false,
    syncing: false,
    resyncArmed: false,
    aborted: false,
    running: false,
    left: false,        // 頁面已經離開（換頁或進了上一頁快取）：之後等到的結果都不算
    panel: null,
    mode: null,
  };

  /* ───────────────────────── 基礎工具 ───────────────────────── */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now() + state.clockOffset;
  const norm = (s) => String(s == null ? '' : s).replace(/[\s　]+/g, ' ').trim();
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function domReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  }

  /** 照網站自己的輸入方式寫值：用原生 setter，再送 input / change，網站的程式才會知道值變了 */
  function setFieldValue(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === String(value);
  }

  window.addEventListener('pagehide', () => { state.left = true; });

  /* ───────────────────────── 與背景程式溝通 ───────────────────────── */

  function send(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, payload, url: location.href }, () => void chrome.runtime.lastError);
    } catch (_) { /* 擴充功能剛重新載入，這一頁的舊程式已失效 */ }
  }

  function call(type, payload, timeout = 1500) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout);
      try {
        chrome.runtime.sendMessage({ type, payload, url: location.href }, (res) => {
          void chrome.runtime.lastError;
          clearTimeout(timer);
          resolve(res === undefined ? null : res);
        });
      } catch (_) {
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  function log(msg, level = 'info') {
    send('log', { msg: String(msg), level });
    panelLog(String(msg), level);
  }

  /** 紀錄裡不寫完整的個人資料：手機、Email、姓名只留頭尾 */
  function maskText(s) {
    return String(s || '')
      .replace(/09\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, (m) => m.slice(0, 2) + '*'.repeat(Math.max(0, m.length - 4)) + m.slice(-2))
      .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+)/g, '$1***@$2');
  }

  /* ───── 內嵌 lib/format.js ───── */
  // 共用的小工具：補零與日期時間格式。背景程式直接 import，頁面程式由 tools/build.mjs 內嵌。
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  /** 毫秒時間戳記 → 「10/15 13:00:00」 */
  function fmt(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /** 轉成整數並限制在 min～max 之間；看不懂就用預設值 */
  function int(v, def, min, max) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  /* ───── 內嵌 lib/clock.js ───── */
  // 對時的計算：從 HEAD 請求的送出時間 t0、收到時間 t1 和伺服器 Date 的秒數 sec，推算「伺服器 − 本機」毫秒數。

  /** 假設伺服器在請求來回的正中間產生 Date */
  const probeOffset = (p) => Math.round(p.sec - (p.t1 - (p.t1 - p.t0) / 2));

  /** 第二段對時：同時送出的探測裡，找第一個跨到下一秒的那一個。沒有跨秒就回傳 null */
  function crossingOffset(probes) {
    const got = (probes || []).filter(Boolean).sort((a, b) => a.t0 - b.t0);
    if (!got.length) return null;
    const firstSec = got[0].sec;
    const cross = got.findIndex((p) => p.sec > firstSec);
    return cross > 0 ? probeOffset(got[cross]) : null;
  }

  /* ───── 內嵌 lib/flow.js ───── */
  // 一般票券購買流程的判斷：選時段、配票種張數、檢查購票人資料、網站錯誤該怎麼辦。只處理資料，不碰網頁，所以可以單獨測試。
  // 網站的頁面怎麼讀、怎麼填，交給 src/generic/ 底下各網站的轉接程式；轉接把頁面讀成這裡用的格式：
  //   時段 { id, text, status: available | limited | full | not-open | unknown, remaining: 數字或 null }
  //   票種 { id, name, price }

  const DASH = /[–—~～〜－-]/g;
  const normDash = (s) => String(s).replace(DASH, '-');
  const words = (line) => normDash(line).replace(/　/g, ' ').split(/\s+/).filter(Boolean);
  const RANGE = /\d{1,2}:\d{2}-\d{1,2}:\d{2}/;

  /** 一段關鍵字有沒有出現在時段文字裡。只寫一個時間（08:00）代表開始時間，不會對到 06:00–08:00 的結束時間 */
  function wordHit(text, w) {
    if (/^\d{1,2}:\d{2}$/.test(w)) {
      const t = w.padStart(5, '0');
      if (RANGE.test(text)) return new RegExp(`(^|[^\\d])${t}-`).test(text);
      return text.includes(t);
    }
    return text.includes(w);
  }
  const hasAll = (text, line) => { const t = normDash(text); return words(line).every((w) => wordHit(t, w)); };

  const isBuyable = (s) => s.status === 'available' || s.status === 'limited';
  /** 能不能買到 need 張：可以買，而且有寫剩幾張的話要夠 */
  const enoughFor = (s, need) => isBuyable(s) && (s.remaining == null || s.remaining >= need);

  /**
   * 依偏好選時段。prefs 一行一組（空白分隔的每一段都要出現在時段文字裡），越上面越優先；skip 是這次已經試過買不到的時段。
   * 第一個比對得到的那一組決定結果：
   *   有能買而且剩餘夠的 → ok
   *   全部額滿、剩的不夠或已經試過 → 換下一組
   *   還沒開放 → not-open（等它開放，不跳去比較不想要的那組）
   * 每一組都沒結果時，開了遞補就從上往下選第一個能買的；否則 sold-out 或 no-match。
   */
  function pickSlot(slots, prefs, { need = 1, fallback = false, skip = [] } = {}) {
    const skipped = new Set(skip);
    const usable = (s) => !skipped.has(s.id) && enoughFor(s, need);
    const tried = [];
    for (const line of prefs || []) {
      if (!words(line).length) continue;
      const hits = slots.filter((s) => hasAll(s.text, line));
      if (!hits.length) continue;
      const ok = hits.find(usable);
      if (ok) return { kind: 'ok', slot: ok, line };
      if (hits.some((s) => s.status === 'not-open' || s.status === 'unknown')) return { kind: 'not-open', line, text: hits[0].text };
      tried.push(...hits);
    }
    if (fallback) {
      const any = slots.find(usable);
      if (any) return { kind: 'ok', slot: any, line: null, fallback: true };
      if (slots.some((s) => s.status === 'not-open' || s.status === 'unknown')) return { kind: 'not-open', line: null };
    }
    if (tried.length || (fallback && slots.length)) {
      const short = tried.find((s) => isBuyable(s) && s.remaining != null && s.remaining < need);
      return { kind: 'sold-out', names: [...new Set(tried.map((s) => s.text))], short: short ? { text: short.text, remaining: short.remaining } : null };
    }
    return { kind: 'no-match', names: slots.map((s) => s.text) };
  }

  /** 「全票 2」「兒童票 1」這種一行一筆的設定 → [{ name, qty }]；張數寫在最後，可以用空白或冒號隔開 */
  function parseTicketLines(input) {
    const lines = Array.isArray(input) ? input : String(input == null ? '' : input).split(/\r?\n/);
    const out = [];
    for (const raw of lines) {
      const line = String(raw).replace(/　/g, ' ').trim();
      if (!line) continue;
      const m = line.match(/^(.*?)[\s:：×xX*]*(\d+)\s*(張)?$/);
      if (!m || !m[1].trim()) { out.push({ name: line, qty: NaN }); continue; }
      out.push({ name: m[1].trim(), qty: Number(m[2]) });
    }
    return out;
  }

  /**
   * 把設定的票種張數對到頁面上的票種。名稱完全相同優先，其次「頁面名稱包含設定的字」。
   * 回傳 { ok: true, plan: [{ id, name, qty, price }], total, amount } 或 { ok: false, msg }。
   */
  function planTickets(types, wanted, maxPerOrder = Infinity) {
    if (!wanted || !wanted.length) return { ok: false, msg: '還沒設定要買哪些票種、各幾張' };
    const plan = [];
    for (const w of wanted) {
      if (!Number.isInteger(w.qty) || w.qty < 0) return { ok: false, msg: `「${w.name}」的張數看不懂，請寫成「${w.name} 2」這樣` };
      if (w.qty === 0) continue;
      const t = types.find((x) => x.name === w.name) || types.find((x) => x.name.includes(w.name));
      if (!t) return { ok: false, msg: `頁面上沒有「${w.name}」這個票種。頁面上的票種有：${types.map((x) => x.name).join('、') || '（沒有）'}` };
      const same = plan.find((p) => p.id === t.id);
      if (same) same.qty += w.qty;
      else plan.push({ id: t.id, name: t.name, qty: w.qty, price: t.price });
    }
    const total = plan.reduce((a, p) => a + p.qty, 0);
    if (!total) return { ok: false, msg: '每個票種都是 0 張，請至少設定 1 張' };
    if (total > maxPerOrder) return { ok: false, msg: `一共 ${total} 張，超過每筆上限 ${maxPerOrder} 張` };
    const amount = plan.reduce((a, p) => a + (Number(p.price) || 0) * p.qty, 0);
    return { ok: true, plan, total, amount };
  }

  const PROFILE_FIELDS = { name: '姓名', phone: '手機', email: 'Email' };
  const PHONE = /^09\d{8}$/;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /** 你提供的購票人資料：去掉多餘空白，手機拿掉空白與連字號 */
  function cleanProfile(p) {
    const v = (k) => String((p && p[k]) ?? '').replace(/　/g, ' ').trim();
    return { name: v('name'), phone: v('phone').replace(/[\s-]/g, ''), email: v('email'), note: v('note') };
  }

  /** 購票人資料是否完整、格式對不對。只檢查你提供的資料，網站送出後還會再檢查一次 */
  function checkProfile(p) {
    const c = cleanProfile(p);
    const missing = Object.keys(PROFILE_FIELDS).filter((k) => !c[k]);
    const bad = {};
    if (c.phone && !PHONE.test(c.phone)) bad.phone = '手機要是 09 開頭共 10 碼';
    if (c.email && !EMAIL.test(c.email)) bad.email = 'Email 格式不對';
    return { ok: !missing.length && !Object.keys(bad).length, missing, bad, profile: c };
  }

  function describeProfileProblem(r) {
    const parts = [];
    if (r.missing.length) parts.push(`還沒填：${r.missing.map((k) => PROFILE_FIELDS[k]).join('、')}`);
    for (const [k, msg] of Object.entries(r.bad)) parts.push(`${PROFILE_FIELDS[k]}：${msg}`);
    return parts.join('；');
  }

  /**
   * 網站回的錯誤 → 助手該怎麼做：
   *   retry      暫時性的錯誤（忙碌、伺服器錯誤、逾時、連線中斷）：等一下再試，有次數上限
   *   next-slot  這個時段買不到（售完、剩餘不足）：換下一個偏好的時段
   *   wait       還沒開賣：等一下重新看
   *   restart    保留逾時、步驟對不上：回到時段列表重來
   *   gate       排隊、驗證碼、機器人檢查：停下來交給你
   *   duplicate  網站說重複送出：上一次其實已經送到了，不要再送
   *   stop       資料有問題或認不得的錯誤：停下來交給你
   */
  function classifyError(code, status = 0) {
    const c = String(code || '').toUpperCase();
    if (['TRANSIENT', 'INTERNAL', 'CLIENT_TIMEOUT', 'NETWORK', 'TIMEOUT', 'RATE_LIMITED'].includes(c)) return 'retry';
    if (['SOLD_OUT', 'INSUFFICIENT'].includes(c)) return 'next-slot';
    if (c === 'NOT_ON_SALE') return 'wait';
    if (['HOLD_EXPIRED', 'STEP_VIOLATION'].includes(c)) return 'restart';
    if (/QUEUE|CAPTCHA|BOTCHECK|CHALLENGE/.test(c)) return 'gate';
    if (c === 'DUPLICATE_SUBMIT') return 'duplicate';
    if (!c && (status >= 500 || status === 429)) return 'retry';
    return 'stop';
  }

  const listNames = (names) => (names.slice(0, 6).join('、') + (names.length > 6 ? '…' : '')) || '（沒有）';
  const STATUS_TEXT = { available: '可購買', limited: '剩少量', full: '已額滿', 'not-open': '尚未開放', unknown: '狀態不明' };
  /** 「可購買，剩 80 張」這種給人看的狀態 */
  const statusText = (s) => `${STATUS_TEXT[s.status] || s.status}${s.remaining != null && s.status !== 'full' ? `，剩 ${s.remaining} 張` : ''}`;

  /** pickSlot 的結果 → 一句話；need 是要買的張數 */
  function describePick(p, need = 1) {
    if (p.kind === 'ok') return `選中「${p.slot.text}」（${statusText(p.slot)}）${p.fallback ? '。關鍵字都沒對到，照遞補設定選第一個能買的' : ''}`;
    if (p.kind === 'not-open') return p.line ? `「${p.line}」還沒開放` : '時段都還沒開放';
    if (p.kind === 'sold-out') return p.short ? `「${p.short.text}」只剩 ${p.short.remaining} 張，不夠 ${need} 張` : `已額滿：${listNames(p.names)}`;
    return `關鍵字對不到任何時段。頁面上的時段有：${listNames(p.names)}`;
  }

  /**
   * 預先比對（開賣前、檢查時段用）：只看時段文字，不管現在能不能買，告訴你開賣時會選哪一個。
   * 回傳 { kind: 'match', slot, line, count } 或 { kind: 'no-match', names }
   */
  function previewSlot(slots, prefs) {
    for (const line of prefs || []) {
      if (!words(line).length) continue;
      const hits = slots.filter((s) => hasAll(s.text, line));
      if (hits.length) return { kind: 'match', slot: hits[0], line, count: hits.length };
    }
    return { kind: 'no-match', names: slots.map((s) => s.text) };
  }

  function describePreview(p, fallback = false) {
    if (p.kind === 'match') {
      let msg = `開賣時會選「${p.slot.text}」（目前${statusText(p.slot)}）`;
      if (p.count > 1) msg += `。這組關鍵字對到 ${p.count} 個時段，會選第一個能買的`;
      return msg;
    }
    return `關鍵字對不到任何時段。頁面上的時段有：${listNames(p.names)}${fallback ? '。你開了遞補，開賣時會改選第一個能買的時段' : '。請在開賣前修改關鍵字'}`;
  }

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
  /* ───────────────────────── 畫面面板 ─────────────────────────
   * 頁面右上角的狀態面板；標題 PANEL_TITLE 在 00-core.js 定義。 */

  const PANEL_CSS = `
    .box { font: 13px/1.5 system-ui, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
           color: #111; background: #fff; border: 2px solid #0a7d55; border-radius: 10px;
           box-shadow: 0 6px 24px rgba(0,0,0,.18); width: 300px; overflow: hidden; }
    .hd { display: flex; align-items: center; justify-content: space-between; gap: 8px;
          background: #0a7d55; color: #fff; padding: 6px 10px; font-weight: 700; }
    .hd button { font: inherit; font-size: 12px; font-weight: 600; background: #fff; color: #0a7d55;
                 border: 0; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
    .hd button:disabled { opacity: .5; cursor: default; }
    .st { padding: 8px 10px 2px; font-weight: 600; }
    .st.ok { color: #0a7d55; } .st.warn { color: #b45309; } .st.err { color: #b91c1c; }
    .cd { padding: 0 10px; font-size: 26px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .cd:empty { display: none; }
    ol { list-style: none; margin: 4px 0 8px; padding: 0 10px; max-height: 132px; overflow: auto;
         font-size: 12px; color: #444; }
    li.warn { color: #b45309; } li.err { color: #b91c1c; } li.ok { color: #0a7d55; }
  `;

  function panel() {
    if (state.panel) return state.panel;
    const host = document.createElement('div');
    host.setAttribute('data-ith', 'panel');
    host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    // 樣式用 constructable stylesheet：不受網站 CSP 的 style-src 限制；舊瀏覽器才退回 <style>
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(PANEL_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (_) {
      const st = document.createElement('style');
      st.textContent = PANEL_CSS;
      root.appendChild(st);
    }
    // 用 createElement 組畫面，不用 innerHTML（網站若啟用 Trusted Types，innerHTML 會被擋）
    const mk = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const box = mk('div', 'box');
    const hd = mk('div', 'hd');
    const btn = mk('button', '', '取消任務');
    btn.type = 'button';
    hd.append(mk('span', '', PANEL_TITLE), btn);
    const p = { host, st: mk('div', 'st'), cd: mk('div', 'cd'), lg: mk('ol'), btn };
    box.append(hd, p.st, p.cd, p.lg);
    root.appendChild(box);
    p.btn.addEventListener('click', () => {
      p.btn.disabled = true;
      stopLocal('已取消');
      send('abort-request', {});
    });
    const attach = () => (document.body || document.documentElement).appendChild(host);
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
    state.panel = p;
    return p;
  }

  function setStatus(text, cls = '') {
    const p = panel();
    p.st.textContent = text;
    p.st.className = 'st ' + cls;
  }

  /**
   * 面板中間的大字（平常顯示倒數）。網站處理比較久時可以改成「處理中 N 秒」，讓你知道它沒當掉。
   * 同樣的字也放在面板外框的 data-big 上，面板是封閉的 shadow root，測試只讀得到外框。
   */
  function setBig(text) {
    const p = panel();
    p.cd.textContent = text || '';
    if (text) p.host.setAttribute('data-big', text);
    else p.host.removeAttribute('data-big');
  }

  function setCountdown(ms) {
    const p = panel();
    if (ms == null) { p.cd.textContent = ''; return; }
    const left = Math.max(0, ms);
    if (left < 10000) { p.cd.textContent = (left / 1000).toFixed(2) + ' 秒'; return; }
    const s = Math.floor(left / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const two = (n) => String(n).padStart(2, '0');
    p.cd.textContent = (h ? h + ':' + two(m) : String(m)) + ':' + two(sec);
  }

  function clock() {
    const d = new Date();
    const two = (n) => String(n).padStart(2, '0');
    return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }

  function panelLog(msg, level = 'info') {
    if (!state.panel) return;
    const li = document.createElement('li');
    li.className = level;
    li.textContent = `${clock()} ${msg}`;
    state.panel.lg.appendChild(li);
    while (state.panel.lg.children.length > 8) state.panel.lg.firstChild.remove();
    state.panel.lg.scrollTop = 1e6;
  }

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

  /* ───────────────────────── 通用購票流程 ─────────────────────────
   * 每次載入頁面都問背景程式該做什麼（90-boot.js），run 模式就照這一頁是哪一步來做一步：
   *   list     讀時段狀態 → 照偏好選時段（還沒開放就等、讀取失敗就重試）→ 進選票頁
   *   select   照設定填各票種張數 → 送出一次 → 被拒就看原因：換時段、重試或停下來
   *   info     檢查你提供的資料 → 填好、勾同意 → 送出一次 → 網站說哪一欄有問題就交給你
   *   confirm  一定停在這裡：標出「確認建立訂單」，請你自己檢查後按；之後提醒保留時間
   *   queue    網站要排隊：停下來交給你，不略過排隊
   *   error    網站錯誤頁：暫時性錯誤就重新整理（有次數上限），其他交給你
   * 判斷寫在 lib/flow.js；頁面怎麼讀寫寫在網站轉接（10-pool.js）。 */

  const totalWanted = (cfg) => (cfg.tickets || []).reduce((a, t) => a + (Number.isInteger(t.qty) && t.qty > 0 ? t.qty : 0), 0) || 1;

  async function finish(ok, kind, msg, extra = {}) {
    const cls = ok ? 'ok' : (extra.handOff ? 'warn' : 'err');
    setStatus(msg, cls);
    setCountdown(null);
    panelLog(msg, cls);
    if (!ok) blackbox(kind, msg);
    await call('result', { ok, kind, msg, url: location.href, handOff: !!extra.handOff }, 1500);
  }

  /** 向背景程式要一次重試額度（load 載入失敗／not-open 還沒開放／fail 其他失敗），拿到就等它給的時間 */
  async function grant(reason, msg, status = 0) {
    const r = await call('retry', { reason, msg, status }, 1500);
    if (!r || !r.allow) return null;
    const of = r.max ? `${r.count}/${r.max}` : `第 ${r.count} 次`;
    setStatus(`${msg}，${(r.delayMs / 1000).toFixed(1)} 秒後再試（${of}）`, 'warn');
    log(`${msg}，再試一次（${of}）`, 'warn');
    await sleep(r.delayMs);
    return state.aborted || state.left ? null : r;
  }

  /** 等時段列表讀完（成功或失敗）；逾時回傳 null */
  async function waitList(maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (state.aborted) return null;
      const s = SITE.listState();
      if (!s.loading && (s.error || s.slots)) return s;
      await sleep(100);
    }
    return null;
  }

  /**
   * 送出這一步（select／info）：同一次只按一次，按了就等結果，不會因為等太久又按。
   * 要再送一定是錯誤處理決定的（伺服器錯誤之類），而且向背景程式要額度、有次數上限。
   */
  async function submitOnce(stepName, d, slotId) {
    for (;;) {
      if (state.aborted || state.left) return;
      const clicked = stepName === 'select' ? SITE.submitSelect() : SITE.submitInfo();
      if (!clicked) return finish(false, 'no-button', '找不到送出按鈕，先停下來', { handOff: true });
      setStatus('已送出，等網站回應…', 'ok');
      const out = await waitOutcomeFor(stepName, 60000);
      if (out.kind === 'left') return;
      if (out.kind === 'timeout') return finish(false, 'timeout', '送出後 60 秒都沒有回應，先停下來。請看頁面上的狀況，不要急著再按', { handOff: true });
      const what = `網站回覆「${out.text}」`;
      const action = classifyError(out.code, out.status);
      if (action === 'next-slot') {
        if (slotId) await call('skip-slot', { slotId }, 1500);
        log(`${what}，改選下一個時段`, 'warn');
        location.assign(SITE.listUrl());
        return;
      }
      if (action === 'retry') {
        const r = await grant('fail', what);
        if (!r) return finish(false, 'fail-limit', `${what}，重試次數用完了`, { handOff: true });
        continue;   // 前一次確定失敗了，才再送一次
      }
      if (action === 'duplicate') {
        // 網站說已經收到了：上一次其實送到了，不要再送，往下一步看看
        log(`${what}，上一次其實已經送到了，不再重送`, 'warn');
        location.assign(SITE.nextUrl(stepName));
        return;
      }
      if (action === 'wait' || action === 'restart') {
        const r = await grant('fail', what);
        if (!r) return finish(false, 'fail-limit', `${what}，重試次數用完了`, { handOff: true });
        location.assign(SITE.listUrl());
        return;
      }
      if (action === 'gate') return finish(false, out.code.toLowerCase(), `${what}。這一關要你自己處理，助手先停下來`, { handOff: true });
      const fields = Object.entries(out.fields || {}).map(([k, v]) => `${k}：${v}`).join('；');
      return finish(false, out.code || 'rejected', `${what}${fields ? `（${fields}）` : ''}。資料可能要修改，先停下來`, { handOff: true });
    }
  }

  /** 按一下送出後等網站回應：換頁的話這一頁的助手就結束了（新頁面的助手接手）；出現錯誤訊息就回傳它 */
  async function waitOutcomeFor(stepName, maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (state.aborted || state.left) return { kind: 'left' };
      const text = SITE.formError();
      if (text) return { kind: 'error', ...SITE.parseError(text), fields: stepName === 'info' ? SITE.fieldErrors() : {} };
      await sleep(100);
    }
    return { kind: 'timeout' };
  }

  async function onList(d) {
    const cfg = d.cfg || {};
    const need = totalWanted(cfg);
    for (;;) {
      if (state.aborted || state.left) return;
      const ls = await waitList(30000);
      if (!ls) {
        const r = await grant('load', '時段列表等了 30 秒還沒出來');
        if (!r) return finish(false, 'list-timeout', '時段列表一直沒有出來，先停下來', { handOff: true });
        location.reload();
        return;
      }
      if (ls.error) {
        const r = await grant('load', `時段載入失敗：${ls.error.replace(/。請按.*$/, '')}`, ls.status);
        if (!r) return finish(false, 'load-limit', `${ls.error}。連續 5 分鐘都沒有恢復，先停下來`, { handOff: true });
        SITE.refreshList();
        await sleep(50);
        continue;
      }
      send('load-ok', {});
      const pick = pickSlot(ls.slots, cfg.keywords, { need, fallback: cfg.fallback, skip: d.skip || [] });
      if (pick.kind === 'ok') {
        log(describePick(pick, need), 'ok');
        setStatus(`前往「${pick.slot.text}」選票種…`, 'ok');
        if (!SITE.openSlot(pick.slot)) return finish(false, 'no-button', '找不到這個時段的選購按鈕，先停下來', { handOff: true });
        return;
      }
      if (pick.kind === 'not-open') {
        const r = await grant('not-open', describePick(pick, need));
        if (!r) return finish(false, 'not-open-limit', `${describePick(pick, need)}，重試次數用完了`);
        SITE.refreshList();
        await sleep(50);
        continue;
      }
      return finish(false, pick.kind, describePick(pick, need));
    }
  }

  async function onSelect(d) {
    const cfg = d.cfg || {};
    const info = SITE.selectInfo();
    if (info.status === 'full' || info.status === 'not-open') {
      if (info.status === 'full' && info.slotId) await call('skip-slot', { slotId: info.slotId }, 1500);
      log(`「${info.text}」${info.status === 'full' ? '已額滿' : '還沒開放'}，回時段列表`, 'warn');
      location.assign(SITE.listUrl());
      return;
    }
    const types = SITE.ticketTypes();
    if (!types.length) return finish(false, 'no-types', '選票頁上找不到票種，先停下來', { handOff: true });
    const plan = planTickets(types, cfg.tickets, SITE.maxPerOrder());
    if (!plan.ok) return finish(false, 'tickets', plan.msg, { handOff: true });
    for (const p of plan.plan) SITE.setQty(p.id, p.qty);
    const bad = plan.plan.find((p) => SITE.qtyOf(p.id) !== p.qty);
    if (bad) return finish(false, 'fill-failed', `「${bad.name}」的張數填不進去，先停下來`, { handOff: true });
    log(`張數：${plan.plan.map((p) => `${p.name} ${p.qty}`).join('、')}，共 ${plan.total} 張、NT$${plan.amount}`);
    return submitOnce('select', d, info.slotId);
  }

  async function onInfo(d) {
    const cfg = d.cfg || {};
    const chk = checkProfile(cfg.profile);
    if (!chk.ok) return finish(false, 'profile', `購票人資料不完整（${describeProfileProblem(chk)}），請在擴充功能補上後按「繼續」`, { handOff: true });
    const r = SITE.fillProfile(chk.profile);
    if (r.missing.length) return finish(false, 'fill-failed', `這些欄位找不到或填不進去：${r.missing.join('、')}，先停下來`, { handOff: true });
    if (SITE.hasAgree()) {
      if (cfg.autoAgree === false) return finish(false, 'agree', '資料已填好。你設定不自動勾選同意，請自己閱讀並勾選後按「下一步」', { handOff: true });
      if (!SITE.setAgree(true)) return finish(false, 'agree-failed', '同意使用須知勾不起來，先停下來', { handOff: true });
    }
    log(`已填購票人資料：${maskText(`${chk.profile.name.slice(0, 1)}** ${chk.profile.phone} ${chk.profile.email}`)}${SITE.hasAgree() ? '，已勾選同意' : ''}`);
    return submitOnce('info', d, null);
  }

  /** 確認頁：只檢查、標出按鈕、提醒你，絕不替你按 */
  async function onConfirm(d, alreadyReported = false) {
    const g = SITE.confirmGates();
    const btn = SITE.confirmButton();
    if (btn) { btn.style.outline = '3px solid #d97706'; btn.style.outlineOffset = '3px'; }
    const left = SITE.holdLeft();
    const extra = [g.captcha && '輸入驗證碼', g.botcheck && '自己完成「我不是機器人」檢查'].filter(Boolean);
    const msg = `已到確認頁${left != null ? `，名額保留中（約剩 ${left} 秒）` : ''}。請檢查訂單內容${extra.length ? '，' + extra.join('、') : ''}，再自己按「確認建立訂單」`;
    if (!alreadyReported) await finish(true, 'ready', msg, { handOff: true });
    else setStatus(msg, 'warn');
    watchHold();
  }

  /** 確認頁的保留倒數：剩 1 分鐘提醒一次，到期再提醒一次 */
  function watchHold() {
    let soon = false;
    const t = setInterval(() => {
      if (state.left || state.aborted) { clearInterval(t); return; }
      const left = SITE.holdLeft();
      if (left == null) return;
      if (left <= 0) {
        clearInterval(t);
        setStatus('保留時間到了，名額已釋出。要重新選購，請在擴充功能按「立即執行」', 'err');
        send('warn', { kind: 'hold-expired', msg: '保留時間到了，名額已釋出。要重新選購，請在擴充功能按「立即執行」' });
      } else if (left <= 60 && !soon) {
        soon = true;
        send('warn', { kind: 'hold-soon', msg: `保留只剩 ${left} 秒，請盡快到確認頁檢查並按「確認建立訂單」` });
      }
    }, 1000);
  }

  async function onQueue() {
    return finish(false, 'queue', '網站要求排隊。助手不會略過排隊，先停下來：請在這一頁等候，輪到你之後到擴充功能按「繼續」，或自己操作', { handOff: true });
  }

  async function onErrorPage() {
    const e = SITE.errorPage();
    const what = `網站回了錯誤頁（${e.status} ${e.code}）：${e.message}`;
    const action = classifyError(e.code, e.status);
    if (action === 'retry') {
      const r = await grant('load', what, e.status);
      if (!r) return finish(false, 'load-limit', `${what}，一直沒有恢復，先停下來`, { handOff: true });
      location.reload();
      return;
    }
    if (action === 'restart' || action === 'wait') {
      const r = await grant('fail', what);
      if (!r) return finish(false, 'fail-limit', `${what}，重試次數用完了`, { handOff: true });
      location.assign(SITE.listUrl());
      return;
    }
    return finish(false, e.code || 'error-page', `${what}。先停下來`, { handOff: true });
  }

  async function runFlow(d) {
    if (state.running) return;
    state.running = true;
    state.aborted = false;
    panel();
    setCountdown(null);
    try {
      await domReady();
      switch (SITE.pageKind()) {
        case 'list': setStatus('讀取時段狀態…', 'ok'); return await onList(d);
        case 'select': setStatus('選擇票種與張數…', 'ok'); return await onSelect(d);
        case 'info': setStatus('填寫購票人資料…', 'ok'); return await onInfo(d);
        case 'confirm': return await onConfirm(d);
        case 'queue': return await onQueue(d);
        case 'error': return await onErrorPage(d);
        case 'done': return undefined;   // 完成頁由背景程式判定成功
        default: return await finish(false, 'unknown-page', '認不得這一頁，先停下來', { handOff: true });
      }
    } catch (e) {
      await finish(false, 'error', '程式錯誤：' + (e && e.message ? e.message : e));
    } finally {
      state.running = false;
    }
  }

  /** 排程：在時段列表倒數，到點重新整理（對時與背景程式的到點保險見 30-clock.js、background.js） */
  async function runCountdown(d) {
    const cfg = d.cfg || {};
    const fireAt = d.targetTs + (cfg.fireOffsetMs == null ? 30 : cfg.fireOffsetMs);
    panel();
    setStatus('已排程，等待開賣', 'ok');
    await domReady();
    if (SITE.pageKind() === 'list') {
      // 開賣前先讀一次時段名稱，預告會選哪一個；打錯字現在就會發現
      const ls = await waitList(15000);
      if (ls && ls.slots) {
        const p = previewSlot(ls.slots, cfg.keywords);
        const msg = describePreview(p, cfg.fallback);
        log(msg, p.kind === 'match' ? 'ok' : 'warn');
        if (p.kind !== 'match') { setStatus(msg, 'err'); send('warn', { kind: 'keywords', msg }); }
        else setStatus('已排程。' + msg, 'ok');
      }
    }
    if (cfg.syncClock !== false) {
      await doSync('已與網站伺服器對時');
      if (!state.clockReliable) resyncWhenVisible(fireAt);
      if (fireAt - now() > 45000) {
        if (!(await waitUntil(fireAt - 30000))) return;
        await doSync('開賣前再對時一次');
      }
    }
    const loadedAt = performance.timeOrigin + state.clockOffset;
    if (loadedAt >= fireAt) {
      await call('fired', { at: Date.now(), drift: Math.round(now() - fireAt) }, 800);
      return runFlow({ cfg, since: Date.now(), skip: [] });
    }
    if (!(await waitUntil(fireAt - 300))) return;
    await call('fired', { at: Date.now(), drift: null }, 800);
    if (!(await waitUntil(fireAt))) return;
    send('fired-drift', { drift: Math.round(now() - fireAt) });
    setStatus('開賣時間到，重新整理…', 'ok');
    location.reload();
  }

  /** 「檢查時段」：在背景分頁讀時段與票價，預先比對，不選票 */
  async function runCheck(d) {
    const cfg = d.cfg || {};
    const report = (r) => call('check-result', r, 1500);
    panel();
    setStatus('檢查時段中…', 'ok');
    await domReady();
    if (SITE.pageKind() === 'queue') return report({ ok: false, error: '網站正在排隊，現在沒辦法檢查' });
    if (SITE.pageKind() !== 'list') return report({ ok: false, error: '打開的不是時段列表，請確認網址' });
    const ls = await waitList(20000);
    if (!ls) return report({ ok: false, error: '20 秒內沒有讀到時段列表' });
    if (ls.error) return report({ ok: false, error: `時段載入失敗：${ls.error}` });
    const p = previewSlot(ls.slots, cfg.keywords);
    const buyable = ls.slots.filter(isBuyable).length;
    const full = ls.slots.filter((s) => s.status === 'full').length;
    const notOpen = ls.slots.filter((s) => s.status === 'not-open').length;
    const prices = SITE.prices().map((x) => `${x.name} NT$${x.price}`).join('、');
    const opening = SITE.openingText();
    const msg = `${describePreview(p, cfg.fallback)}。共 ${ls.slots.length} 個時段：可購買 ${buyable}、已額滿 ${full}${notOpen ? `、尚未開放 ${notOpen}` : ''}。${prices ? `票價：${prices}。` : ''}${opening ? opening : ''}`;
    setStatus(msg, p.kind === 'match' ? 'ok' : 'err');
    return report({ ok: p.kind === 'match', kind: p.kind, msg, label: p.slot ? p.slot.text : null, status: p.slot ? statusText(p.slot) : null });
  }

  /** 「健檢」：照轉接的錨點檢查時段列表頁還是不是助手認得的樣子 */
  async function runHealth() {
    const report = (r) => call('health-result', r, 1500);
    panel();
    setStatus('健檢中…', 'ok');
    await domReady();
    const items = [];
    const add = (key, label, status, detail = '') => items.push({ key, label, status, detail });
    const kind = SITE.pageKind();
    add('page', '頁面種類', kind === 'list' ? 'ok' : 'fail', kind === 'list' ? '時段列表' : `認成「${kind}」`);
    if (kind === 'list') {
      const ls = await waitList(20000);
      add('slots', '時段列表', ls && ls.slots ? 'ok' : 'fail', ls && ls.slots ? `${ls.slots.length} 個時段` : ls && ls.error ? ls.error : '讀不到');
      if (ls && ls.slots) {
        const odd = ls.slots.filter((s) => !['available', 'limited', 'full', 'not-open'].includes(s.status));
        add('status', '時段狀態判讀', odd.length ? 'warn' : 'ok', odd.length ? `${odd.length} 個看不出狀態` : '都認得');
        const buy = ls.slots.find(isBuyable);
        add('buy', '選購按鈕', !buy ? 'skip' : buy.el && buy.el.querySelector('a[data-testid=slot-buy]') ? 'ok' : 'fail', buy ? '' : '目前沒有能買的時段');
      }
      add('refresh', '更新狀態按鈕', $('[data-testid=refresh-status]') ? 'ok' : 'warn');
      add('prices', '票價表', SITE.prices().length ? 'ok' : 'warn', SITE.prices().map((x) => x.name).join('、'));
    }
    const worst = items.some((i) => i.status === 'fail') ? 'fail' : items.some((i) => i.status === 'warn') ? 'warn' : 'ok';
    setStatus(worst === 'ok' ? '健檢通過' : '健檢有幾項要注意', worst === 'ok' ? 'ok' : 'warn');
    return report({ ok: worst !== 'fail', worst, items, bundles: [] });
  }

  function showSuccess() {
    panel();
    setStatus(`訂單已建立（${SITE.orderId()}）。這一步是你自己確認的，助手只負責前面的步驟`, 'ok');
  }

  function stopLocal(reason) {
    state.aborted = true;
    state.mode = 'idle';
    if (state.panel) {
      setStatus(reason, 'err');
      setCountdown(null);
    }
  }

  function onCommand(c) {
    if (c.cmd === 'abort') { stopLocal(c.reason || '已取消'); return; }
    if (c.cmd === 'run') {
      state.aborted = false;
      state.mode = 'run';
      runFlow({ cfg: c.cfg || {}, since: c.since, skip: c.skip || [] });
    }
  }
  /* ───────────────────────── 黑盒子 ─────────────────────────
   * 失敗或停下來交給你時，記下當下頁面的重點，可以從擴充功能匯出。手機、Email 會遮掉，不記欄位裡填的值。 */
  function snapshot(kind, msg) {
    const vis = $$('button, a.btn, input[type="submit"]').filter(isVisible);
    const alerts = $$('[role="alert"]').filter((e) => !e.hidden && isVisible(e)).map((e) => maskText(norm(e.textContent)).slice(0, 200)).filter(Boolean);
    return {
      at: Date.now(), kind, msg: maskText(String(msg || '')).slice(0, 300),
      url: location.href, title: norm(document.title).slice(0, 80), page: SITE ? SITE.pageKind() : 'other',
      buttons: vis.map((b) => norm(b.textContent || b.value).slice(0, 30)).filter(Boolean).slice(0, 15),
      modals: alerts.slice(0, 5),
      text: SITE && ['info', 'confirm'].includes(SITE.pageKind()) ? '' : maskText(SITE ? SITE.mainText() : ''),
    };
  }

  const boxed = new Set();
  function blackbox(kind, msg, once = false) {
    if (once && boxed.has(kind)) return;
    boxed.add(kind);
    try { send('blackbox', snapshot(kind, msg)); } catch (_) { /* 記錄失敗不影響流程 */ }
  }
  /* ───────────────────────── 啟動 ─────────────────────────
   * DOM 準備好後確認是認得的網站，再問背景程式這一頁該做什麼。沒有任務就什麼都不做。 */

  function handleDirective(d) {
    state.mode = (d && d.mode) || 'idle';
    switch (d && d.mode) {
      case 'countdown': return runCountdown(d);
      case 'run': return runFlow(d);
      case 'check': return runCheck(d);
      case 'health': return runHealth(d);
      case 'success': return showSuccess(d);
      case 'confirm-wait': panel(); return onConfirm(d, true);   // 已經交給你了：重新整理確認頁時繼續提醒保留時間
      default: return undefined;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.cmd && SITE) onCommand(msg);
  });

  (async () => {
    await domReady();
    SITE = pickSite();
    if (!SITE) return;
    for (let i = 0; i < 20; i++) {
      const res = await call('hello', { kind: SITE.pageKind(), url: location.href }, 1500);
      if (res) { handleDirective(res); return; }
      await sleep(250);   // 背景程式剛被叫醒，稍等再問
    }
  })();
})();
