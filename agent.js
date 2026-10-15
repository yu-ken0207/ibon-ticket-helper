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
   *   rate-limit 網站說請求太多（429）：讀取時照網站給的 Retry-After 等（沒給就逐步拉長），有次數上限；送出時不自動重送，交給你
   *   next-slot  這個時段買不到（售完、剩餘不足）：換下一個偏好的時段
   *   wait       還沒開賣：等一下重新看
   *   restart    保留逾時、步驟對不上：回到時段列表重來
   *   reload     表單權杖過期：重新整理這一頁拿新的，再做一次
   *   gate       排隊、驗證碼、機器人檢查：停下來交給你
   *   duplicate  網站說重複送出：上一次其實已經送到了，不要再送
   *   login      網站說要重新登入（401、LOGIN_REQUIRED）：交給你
   *   stop       資料有問題或認不得的錯誤：停下來交給你
   */
  function classifyError(code, status = 0) {
    const c = String(code || '').toUpperCase();
    if (/QUEUE|CAPTCHA|BOTCHECK|CHALLENGE/.test(c)) return 'gate';
    if (['LOGIN_REQUIRED', 'UNAUTHORIZED', 'SESSION_EXPIRED'].includes(c) || status === 401) return 'login';
    if (['RATE_LIMITED', 'TOO_MANY_REQUESTS'].includes(c) || status === 429) return 'rate-limit';
    if (['TRANSIENT', 'INTERNAL', 'CLIENT_TIMEOUT', 'NETWORK', 'TIMEOUT'].includes(c)) return 'retry';
    if (['SOLD_OUT', 'INSUFFICIENT'].includes(c)) return 'next-slot';
    if (c === 'NOT_ON_SALE') return 'wait';
    if (['HOLD_EXPIRED', 'STEP_VIOLATION'].includes(c)) return 'restart';
    if (['TOKEN_EXPIRED', 'FORM_EXPIRED', 'CSRF'].includes(c)) return 'reload';
    if (c === 'DUPLICATE_SUBMIT') return 'duplicate';
    if (!c && status >= 500) return 'retry';
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

  /* ───── 內嵌 lib/planner.js ───── */
  // RequirementMatcher 與 PurchasePlanner（純函式，不碰網頁）：把你的需求跟網站讀到的場次、票區、票種、價格比對，
  // 排出候選並說明每一個選或不選的理由。這裡只做決定；網站操作由流程（src/agent/60-flow.js）照決定做，每一步還要過 PolicyGate。
  // 場次的關鍵字比對、票種配對沿用 lib/flow.js（hasAll、planTickets），不另外寫一套。

  const toInt = (v) => {
    const n = Number.parseInt(String(v == null ? '' : v).replace(/[,，\s]/g, ''), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const linesOf = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(/\r?\n/)).map((x) => String(x).trim()).filter(Boolean);
  const plain = (s) => String(s || '').replace(/[\s　]+/g, '').replace(/[–—~～〜－-]/g, '-');

  /** 設定 → 需求：場次偏好、票種張數、票區偏好、最高單價、總金額上限、遞補 */
  function requirementOf(cfg) {
    const c = cfg || {};
    const tickets = Array.isArray(c.tickets) ? c.tickets : [];
    const need = tickets.reduce((a, t) => a + (Number.isInteger(t.qty) && t.qty > 0 ? t.qty : 0), 0);
    return {
      sessions: linesOf(c.keywords), tickets, areas: linesOf(c.areas),
      maxUnitPrice: toInt(c.maxUnitPrice), maxTotal: toInt(c.maxTotal), fallback: !!c.fallback, need: need || 1,
    };
  }

  /**
   * RequirementMatcher：票種張數對網站的票種與價格（加上票區加價 surcharge），檢查最高單價與總金額上限。
   * types: [{ id?, name, price }]。回 { ok, kind?: 'tickets' | 'budget', plan?, msg }
   */
  function matchTickets(req, types, { surcharge = 0, maxPerOrder = Infinity } = {}) {
    const priced = (types || []).map((t, i) => ({ id: t.id || t.name || String(i), name: t.name, price: (Number(t.price) || 0) + surcharge }));
    const p = planTickets(priced, req.tickets, maxPerOrder);
    if (!p.ok) return { ok: false, kind: 'tickets', msg: p.msg };
    const over = req.maxUnitPrice ? p.plan.filter((x) => x.price > req.maxUnitPrice) : [];
    if (over.length) return { ok: false, kind: 'budget', plan: p, msg: `${over.map((x) => `${x.name}每張 NT$${x.price}`).join('、')}超過你設定的最高單價 NT$${req.maxUnitPrice}` };
    if (req.maxTotal && p.amount > req.maxTotal) return { ok: false, kind: 'budget', plan: p, msg: `合計 NT$${p.amount}（${p.total} 張）超過你設定的總金額上限 NT$${req.maxTotal}` };
    return { ok: true, plan: p, msg: `${p.plan.map((x) => `${x.name} ${x.qty} 張`).join('、')}，合計 NT$${p.amount}` };
  }

  /** 場次的判斷與理由 */
  function judgeSession(s, need, skipped) {
    if (skipped.has(s.id)) return ['skip', '這次已經試過，買不到'];
    if (s.status === 'unknown') return ['unknown', '頁面上看不出能不能買'];
    if (s.status === 'not-open') return ['wait', '還沒開放'];
    if (s.status === 'full') return ['skip', '已額滿'];
    if (!isBuyable(s)) return ['skip', '不能買'];
    if (s.remaining != null && s.remaining < need) return ['skip', `只剩 ${s.remaining} 張，不夠 ${need} 張`];
    return ['ok', s.remaining != null ? `可以買（剩 ${s.remaining} 張）` : '可以買'];
  }

  /**
   * PurchasePlanner：場次。依偏好順序（一行一組，空白分隔的每一段都要對到），每個對到的場次都附理由：
   *   ok        選這個（同一組裡有能買的就選第一個）
   *   unknown   這一組沒有能買的，而且有狀態看不出來的：不猜，停下來問你
   *   not-open  這一組還沒開放：等，不跳去比較不想要的那組
   *   sold-out  偏好的都額滿、剩的不夠或已經試過；no-match 關鍵字都對不到
   * 開了遞補，偏好都沒結果時改選第一個能買的。
   * 回 { kind, slot?, line?, fallback?, ranked: [{ id, text, status, remaining, pref, verdict, reason }], msg }
   */
  function planSession(slots, req, { skip = [] } = {}) {
    const skipped = new Set(skip);
    const ranked = [];
    const seen = new Set();
    let result = null;
    req.sessions.forEach((line, i) => {
      if (!words(line).length) return;
      const pref = i + 1;
      for (const s of slots.filter((x) => hasAll(x.text, line) && !seen.has(x.id))) {
        seen.add(s.id);
        const [verdict, reason] = judgeSession(s, req.need, skipped);
        ranked.push({ id: s.id, text: s.text, status: s.status, remaining: s.remaining == null ? null : s.remaining, pref, verdict, reason });
      }
      if (result) return;   // 已經決定了，後面的偏好只列出來給你看
      const mine = ranked.filter((r) => r.pref === pref);
      const ok = mine.find((r) => r.verdict === 'ok');
      if (ok) { ok.verdict = 'chosen'; result = { kind: 'ok', slot: slots.find((s) => s.id === ok.id), line }; return; }
      const unk = mine.find((r) => r.verdict === 'unknown');
      if (unk) { result = { kind: 'unknown', line, text: unk.text }; return; }
      const wait = mine.find((r) => r.verdict === 'wait');
      if (wait) result = { kind: 'not-open', line, text: wait.text };
    });
    if (!result && req.fallback) {
      const any = slots.find((s) => judgeSession(s, req.need, skipped)[0] === 'ok');
      if (any) {
        result = { kind: 'ok', slot: any, line: null, fallback: true };
        ranked.push({ id: any.id, text: any.text, status: any.status, remaining: any.remaining == null ? null : any.remaining, pref: null, verdict: 'chosen', reason: '偏好都買不到，遞補第一個能買的' });
      } else if (slots.some((s) => s.status === 'not-open')) result = { kind: 'not-open', line: null };
    }
    if (!result) {
      // 跟 lib/flow.js 的 describePick 相容：sold-out 帶 names 與 short（剩的不夠的那一個），no-match 帶頁面上的場次
      const short = ranked.find((x) => x.remaining != null && x.remaining > 0 && x.remaining < req.need && (x.status === 'available' || x.status === 'limited'));
      result = ranked.length
        ? { kind: 'sold-out', names: [...new Set(ranked.map((x) => x.text))], short: short ? { text: short.text, remaining: short.remaining } : null }
        : { kind: 'no-match', names: slots.map((s) => s.text) };
    }
    return { ...result, ranked: ranked.slice(0, 20), msg: describeSessionPlan(result, ranked, slots) };
  }

  function describeSessionPlan(r, ranked, slots) {
    const chosen = ranked.find((x) => x.verdict === 'chosen');
    switch (r.kind) {
      case 'ok': return `選「${chosen.text}」（${chosen.pref ? `第 ${chosen.pref} 個偏好` : '遞補'}，${chosen.reason}）`;
      case 'unknown': return `偏好的「${r.text}」頁面上看不出能不能買。為了不選錯，先停下來`;
      case 'not-open': return r.text ? `偏好的「${r.text}」還沒開放` : '還沒開放';
      case 'sold-out': return `偏好的場次都買不到：${ranked.slice(0, 6).map((x) => `${x.text}（${x.reason}）`).join('、')}`;
      default: return `關鍵字對不到任何場次。頁面上的場次有：${slots.slice(0, 6).map((s) => s.text).join('、')}${slots.length > 6 ? '…' : ''}`;
    }
  }

  /**
   * PurchasePlanner：票區（選票頁有分區時）。areas: [{ id, name, surcharge, remaining, soldOut }]，types 是頁面上的票種與單價。
   * 有票區偏好就照偏好順序（一行一組），沒設就照頁面順序；每個票區都附理由：售完、剩的不夠、超過預算、這次試過買不到。
   * 回 { kind: 'ok' | 'none', area?, tickets?（matchTickets 的結果）, ranked, msg }
   */
  function planArea(areas, req, types, { skip = [], maxPerOrder = Infinity } = {}) {
    const skipped = new Set(skip);
    const order = [];
    const add = (a, pref) => { if (!order.some((o) => o.a.id === a.id)) order.push({ a, pref }); };
    if (req.areas.length) req.areas.forEach((line, i) => areas.filter((a) => hasAll(a.name, line)).forEach((a) => add(a, i + 1)));
    else areas.forEach((a) => add(a, null));
    const ranked = [];
    let pick = null;
    for (const { a, pref } of order) {
      let verdict = 'ok', reason = '';
      const t = matchTickets(req, types, { surcharge: a.surcharge || 0, maxPerOrder });
      if (skipped.has(a.id)) { verdict = 'skip'; reason = '這次已經試過，售完了'; }
      else if (a.soldOut || a.remaining === 0) { verdict = 'skip'; reason = '已售完'; }
      else if (a.remaining != null && a.remaining < req.need) { verdict = 'skip'; reason = `只剩 ${a.remaining} 張，不夠 ${req.need} 張`; }
      else if (!t.ok) { verdict = 'skip'; reason = t.msg; }
      else reason = `${a.surcharge ? `每張加 NT$${a.surcharge}，` : ''}${t.msg}${a.remaining != null ? `（剩 ${a.remaining} 張）` : ''}`;
      if (verdict === 'ok' && !pick) { verdict = 'chosen'; pick = { a, t }; }
      ranked.push({ id: a.id, name: a.name, pref, verdict, reason });
    }
    if (pick) return { kind: 'ok', area: pick.a, tickets: pick.t, ranked, msg: `選「${pick.a.name}」：${ranked.find((x) => x.verdict === 'chosen').reason}` };
    const why = ranked.length ? ranked.map((x) => `${x.name}（${x.reason}）`).join('、') : `票區偏好對不到頁面上的票區（有：${areas.map((a) => a.name).join('、')}）`;
    return { kind: 'none', ranked, msg: `沒有符合需求的票區：${why}` };
  }

  /**
   * ORDER_REVIEW：確認頁讀到的內容（summary）跟計畫（expect）比對；不一致就不交接付款，停下來請你確認。
   *   summary { session, area, items: [{ name, qty }], amount }
   *   expect  { sessionText, areaName, items: [{ name, qty }], amount }
   */
  function reviewOrder(summary, expect) {
    const s = summary || {};
    const e = expect || {};
    const items = Array.isArray(s.items) ? s.items : [];
    const diffs = [];
    if (!items.length) diffs.push('確認頁讀不到票種與張數');
    if (e.sessionText && plain(s.session) !== plain(e.sessionText)) diffs.push(`場次：預計「${e.sessionText}」，確認頁是「${s.session || '（沒寫）'}」`);
    if (e.areaName && s.area !== e.areaName) diffs.push(`票區：預計「${e.areaName}」，確認頁是「${s.area || '（沒寫）'}」`);
    for (const it of e.items || []) {
      const got = items.find((x) => x.name === it.name);
      if (!got || got.qty !== it.qty) diffs.push(`${it.name}：預計 ${it.qty} 張，確認頁是 ${got ? got.qty : 0} 張`);
    }
    // 沒有計畫的票種（例如你自己操作到確認頁再按「繼續」）：不比對張數，只確認讀得到內容
    if ((e.items || []).length) for (const got of items) if (!e.items.some((x) => x.name === got.name)) diffs.push(`確認頁多了「${got.name} ${got.qty} 張」`);
    if (e.amount != null && s.amount != null && s.amount !== e.amount) diffs.push(`金額：預計 NT$${e.amount}，確認頁是 NT$${s.amount}`);
    return { ok: !diffs.length, diffs, msg: diffs.length ? `確認頁的內容跟計畫不一致：${diffs.join('；')}` : '確認頁的內容跟計畫一致' };
  }

  /* ───────────────────────── 語意定位 ─────────────────────────
   * 真實網站不會給程式用的固定錨點，class、id、欄位名稱也可能每次不同。這裡用「人看得到、網站也不太會改」的線索找元素：
   * 看得到的文字、標籤與欄位的對應（<label for> 或包住欄位，標準的 label.control）、表單欄位、ARIA 屬性、網址。
   * 封閉的 Shadow DOM 用擴充功能才有的 chrome.dom.openOrClosedShadowRoot 讀；網頁自己的程式拿不到，擴充功能可以。 */

  /** 元素的 shadow root：開放或封閉都拿得到；不是 shadow host 就是 null */
  function shadowOf(el) {
    try {
      if (typeof chrome !== 'undefined' && chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el) || null;
    } catch (_) { /* 不是 HTMLElement 之類 */ }
    return el.shadowRoot || null;
  }

  /** 連同所有 Shadow DOM（包括封閉的）一起找 */
  function deepAll(selector, root = document) {
    const out = [];
    const walk = (node) => {
      out.push(...node.querySelectorAll(selector));
      for (const el of node.querySelectorAll('*')) {
        const sr = shadowOf(el);
        if (sr) walk(sr);
      }
    };
    walk(root);
    return out;
  }

  const textOf = (el) => norm(el ? (el.innerText || el.textContent) : '');
  const hit = (t, match) => (match instanceof RegExp ? match.test(t) : t.includes(match));

  /** 看得到、文字符合的元素（字串＝包含，或正規表示式） */
  function byText(selector, match, root = document) {
    return deepAll(selector, root).filter((el) => isVisible(el) && hit(textOf(el), match));
  }

  /** 照按鈕上的字找按鈕（button、role=button、連結） */
  function buttonByText(match, root = document) {
    return byText('button, [role="button"], a, input[type="submit"], input[type="button"]', match, root)[0] || null;
  }

  /** 照標籤文字找欄位：完全相同優先，再來是開頭相同，最後是正規表示式 */
  function fieldByLabel(match, root = document) {
    const labels = deepAll('label', root);
    const pick = (ok) => {
      for (const label of labels) {
        if (!ok(textOf(label))) continue;
        const c = label.control || label.querySelector('input, select, textarea');
        if (c) return c;
      }
      return null;
    };
    if (match instanceof RegExp) return pick((t) => match.test(t));
    return pick((t) => t === match) || pick((t) => t.startsWith(match));
  }

  /** 欄位旁邊的錯誤訊息：同一個欄位容器裡看得到的 role=alert */
  function alertNear(control) {
    const box = control && control.closest('div');
    const el = box ? [...box.querySelectorAll('[role="alert"]')].find((a) => !a.hidden && isVisible(a) && textOf(a)) : null;
    return el ? textOf(el) : '';
  }

  /** 按鈕那一列正上方的訊息（表單層級的錯誤通常放在送出按鈕上面） */
  function alertAbove(button) {
    const row = button && button.parentElement;
    const prev = row && row.previousElementSibling;
    return prev && prev.getAttribute('role') === 'alert' && !prev.hidden && isVisible(prev) ? textOf(prev) : '';
  }
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

    /**
     * 票區（分區域時才有）：標題寫「區域」的那一組選項 → [{ id, name, surcharge, remaining, soldOut, el }]；沒有就空陣列。
     * 名稱、加價、剩幾張都從選項的標籤文字讀（例如「戶外池　每張加 NT$30　剩 30 張」），售完的選項會停用。
     */
    areas() {
      const group = deepAll('fieldset').find((f) => /區域/.test(textOf(f.querySelector('legend'))));
      if (!group) return [];
      return [...group.querySelectorAll('input[type="radio"]')].map((r) => {
        const t = textOf(r.labels && r.labels[0]);
        const add = t.match(/加\s*NT\$\s*([\d,]+)/);
        const left = t.match(/剩\s*(\d+)\s*張/);
        const soldOut = r.disabled || /已售完|售完/.test(t);
        return { id: r.value, name: t.split(/\s+/)[0], surcharge: add ? Number(add[1].replace(/,/g, '')) : 0, remaining: left ? Number(left[1]) : (soldOut ? 0 : null), soldOut, el: r };
      });
    },

    /** 選票區：點那個選項，回傳有沒有選到 */
    chooseArea(area) {
      if (!area || !area.el || area.el.disabled) return false;
      if (!area.el.checked) area.el.click();
      return area.el.checked;
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

    /** 確認頁的訂單內容：場次、票區、票種張數、合計、保留剩幾秒（給 ORDER_REVIEW 核對） */
    orderSummary() {
      const main = $('main') || document.body;
      const line = (re) => { const p = byText('p', re, main)[0]; return p ? textOf(p) : ''; };
      const items = byText('li', /×\s*\d+/, main).map((li) => {
        const m = textOf(li).match(/^(.+?)\s*×\s*(\d+)/);
        return m ? { name: m[1].trim(), qty: Number(m[2]) } : null;
      }).filter(Boolean);
      const total = line(/^合計/).match(/NT\$\s*([\d,]+)/);
      return {
        session: line(/^入場時段：/).replace(/^入場時段：/, ''),
        area: line(/^區域：/).replace(/^區域：/, '') || null,
        items, amount: total ? Number(total[1].replace(/,/g, '')) : null, holdLeftSec: POOL.holdLeft(),
      };
    },

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

  /* ───────────────────────── 購票流程（WorkflowEngine 的頁面端） ─────────────────────────
   * 流程狀態記在背景程式（lib/workflow.js，task.wf）。這裡每進一個狀態都先 enter() 報到，每個網站操作都先 allowed() 過
   * PolicyGate（lib/policy.js）：被暫停、取消、狀態轉移不合法、政策不是 ALLOWED，就不做。要選哪個場次、票區、票種張數，
   * 以及確認頁對不對，交給 lib/planner.js 決定並附理由；這裡只照決定操作頁面（網站轉接 10-pool.js）。
   *   頁面          狀態
   *   場次列表      PAGE_DETECTION → ACTIVITY_READ → REQUIREMENT_CHECK → SESSION_SELECTION（還沒開放：WAITING_FOR_SALE）
   *   選票頁        TICKET_AREA_SELECTION（有分區就選票區）→ QUANTITY_SELECTION（張數）→ 送出選購
   *   購票人資料頁  BUYER_INFO → 送出
   *   確認頁        ORDER_REVIEW（核對）→ PAYMENT_HANDOFF：一定停在這裡，不替你按「確認建立訂單」，付款由你自己來
   *   排隊、驗證、請求太多、要你確認的：交給你（背景程式依回報的結果轉到 QUEUE／CHALLENGE／RATE_LIMIT／MANUAL_CONFIRMATION）
   * 已經做完的步驟記在 wf.done（hold＝已保留名額、buyer＝已送出購票人資料）：重新整理、按上一頁、按「繼續」都不會重做。
   * 送出結果不明（連線中斷、逾時）一律不重送；確定失敗（伺服器回錯誤）才照次數上限重送。
   * 網站說請求太多（429）：讀取照 Retry-After 等（背景程式看得到標頭），有次數上限；送出不自動重送。是不是 429 也會問背景程式，不只看頁面上的字。 */

  /** 時段列表的錯誤訊息：網站自己已經寫了「時段載入失敗」就不再加，也去掉叫人按按鈕的那一句 */
  const listErrText = (t) => { const x = t.replace(/。請按.*$/, ''); return /^時段載入失敗/.test(x) ? x : `時段載入失敗：${x}`; };

  const totalWanted = (cfg) => (cfg.tickets || []).reduce((a, t) => a + (Number.isInteger(t.qty) && t.qty > 0 ? t.qty : 0), 0) || 1;

  async function finish(ok, kind, msg, extra = {}) {
    const cls = ok ? 'ok' : (extra.handOff ? 'warn' : 'err');
    setStatus(msg, cls);
    setCountdown(null);
    panelLog(msg, cls);
    if (!ok) blackbox(kind, msg);
    const kindOfPage = (() => { try { return SITE.pageKind(); } catch (_) { return ''; } })();
    await call('result', { ok, kind, msg, url: location.href, handOff: !!extra.handOff, pageKind: kindOfPage, summary: extra.summary || null }, 1500);
  }

  /** 進到一個流程狀態之前先向背景程式報到；被暫停、取消，或轉移不合法就不准，這一頁不再做任何事 */
  async function enter(st, extra = {}) {
    const r = await call('wf', { state: st, ...extra }, 2500);
    if (r && r.ok) { if (r.wf) state.wf = r.wf; return true; }
    state.aborted = true;
    if (r && r.reason === 'paused') setStatus('已暫停：到擴充功能按「繼續」，從這一頁接著做', 'warn');
    else if (r && r.msg) setStatus(r.msg, 'err');
    return false;
  }

  /** 把這一步的規劃（候選與理由）記到流程狀態裡，給設定頁顯示；不換狀態 */
  const notePlan = (st, plan) => call('wf', { state: st, plan }, 2500);

  /**
   * PolicyGate：每個網站操作之前問一次。ALLOWED 才做；被暫停就安靜停下；其他照原因交給你
   * （onDeny 可以換成這一步自己的說明，例如不自動勾選同意）。
   */
  async function allowed(action, onDeny) {
    const r = await call('gate', { action }, 2500);
    if (r && r.decision === 'ALLOWED') return true;
    state.aborted = true;
    if (r && r.paused) { setStatus('已暫停：到擴充功能按「繼續」，從這一頁接著做', 'warn'); return false; }
    if (onDeny) { await onDeny(r); return false; }
    const why = r ? `${r.label}：${r.reason}` : `${action}：背景程式沒有回應`;
    await finish(false, 'policy', `${why}（${r ? r.decision : 'UNKNOWN'}），先停下來交給你`, { handOff: true });
    return false;
  }

  /** 已經做完的步驟（wf.done） */
  const doneStep = (k) => !!(state.wf && state.wf.done && state.wf.done[k]);
  const selectionNow = () => (state.wf && state.wf.selection) || {};

  /** 規劃結果只留給人看的部分（候選與理由），送給背景程式記下 */
  const briefPlan = (kind, p) => ({ kind, result: p.kind, msg: p.msg, ranked: (p.ranked || []).slice(0, 20) });

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

  /** 背景程式有沒有看到這個分頁在 since（毫秒時間戳）之後被回 429 */
  async function rateSeenSince(since) {
    const r = await call('rate-seen', { since }, 2000);
    return !!(r && r.seen);
  }

  /** 這一頁開始載入的時間（頁面自己載入時發的請求都在這之後） */
  const pageStart = () => Math.floor(performance.timeOrigin || 0);

  /**
   * 網站說請求太多（429）時的讀取重試：向背景程式要額度，照它給的時間等（Retry-After 或逐步拉長）。
   * 可以再讀回傳 true；額度用完或網站要等太久就停下來交給你，回傳 false。
   */
  async function rateWait(msg) {
    const r = await call('retry', { reason: 'rate', msg, status: 429 }, 3000);
    if (!r || !r.allow) {
      const why = r && r.reason === 'too-long'
        ? `網站要求等 ${Math.round(r.retryAfterMs / 1000)} 秒，超過助手自動等候的上限`
        : `已經照網站的要求等候、重試 ${r ? r.count : 0} 次，還是一直說請求太多`;
      await finish(false, 'rate-limit', `${msg}。${why}，先停下來交給你`, { handOff: true });
      return false;
    }
    const sec = (r.delayMs / 1000).toFixed(1);
    const how = r.source === 'retry-after' ? `照網站要求等 ${sec} 秒` : `網站沒說要等多久，先等 ${sec} 秒`;
    setStatus(`${msg}，${how}再試（${r.count}/${r.max}）`, 'warn');
    log(`${msg}，${how}再試一次（${r.count}/${r.max}）`, 'warn');
    await sleep(r.delayMs);
    return !(state.aborted || state.left);
  }

  /**
   * 等時段列表讀完（成功或失敗）；逾時回傳 null。
   * prevStamp 是按「更新狀態」之前的第一列：舊的列還留在畫面上時不算讀完，要等換成新的（或出現錯誤）。
   */
  async function waitList(maxMs, prevStamp = null) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (state.aborted || state.left) return null;
      const s = SITE.listState();
      if (!s.loading && (s.error || (s.slots && s.stamp !== prevStamp))) return s;
      await sleep(100);
    }
    return null;
  }

  /** 按「更新狀態」，回傳按之前的第一列（給 waitList 分辨新舊） */
  function refreshList() {
    const before = SITE.listState().stamp;
    SITE.refreshList();
    return before;
  }

  /** 送出結果不明：連線中斷、逾時。不知道網站到底收到沒有，一律不重送 */
  const UNKNOWN_OUTCOME = ['NETWORK', 'CLIENT_TIMEOUT', 'TIMEOUT'];

  /**
   * 送出這一步（select 選購／info 購票人資料）：同一次只按一次，按了就等結果，不會因為等太久又按。
   * 要再送，一定是錯誤處理判斷「確定失敗了」（伺服器回錯誤），而且向背景程式要額度、每次都再過一次 PolicyGate。
   * area 是這次選的票區（有分區時）：售完就記下這個票區，重新整理選票頁改選下一個。
   */
  async function submitOnce(stepName, d, slotId, area = null) {
    const action = stepName === 'select' ? 'submit-hold' : 'submit-buyer';
    for (;;) {
      if (state.aborted || state.left) return;
      if (!(await allowed(action))) return;
      const sentAt = Date.now();
      const clicked = stepName === 'select' ? SITE.submitSelect() : SITE.submitInfo();
      if (!clicked) return finish(false, 'no-button', '找不到送出按鈕，先停下來', { handOff: true });
      setStatus('已送出，等網站回應…', 'ok');
      const out = await waitOutcomeFor(stepName, 60000);
      if (out.kind === 'left') return;
      if (out.kind === 'timeout') return finish(false, 'unknown-result', '送出後 60 秒都沒有回應，結果不明。為了避免重複送出，助手不重送，先停下來交給你', { handOff: true });
      const what = `網站回覆「${out.text}」`;
      let act = classifyError(out.code, out.status);
      // 頁面沒寫 429，但回應其實是 429：一樣當成請求太多（不自動重送）
      if (['retry', 'reload', 'wait', 'restart', 'stop'].includes(act) && await rateSeenSince(sentAt)) act = 'rate-limit';
      if (act === 'retry' && UNKNOWN_OUTCOME.includes(String(out.code || '').toUpperCase())) {
        return finish(false, 'unknown-result', `${what}。送出後連線中斷或逾時，不知道網站有沒有收到；為了避免重複送出，助手不重送，先停下來交給你`, { handOff: true });
      }
      if (act === 'login') return finish(false, 'login-required', `${what}。網站要你重新登入，助手先停下來`, { handOff: true });
      if (act === 'next-slot') {
        if (area && slotId) {
          // 這個票區賣完了：記下來，重新整理選票頁改選下一個票區（同一個場次）
          await call('skip-area', { slotId, areaId: area.id }, 1500);
          log(`${what}，「${area.name}」買不到了，改選下一個票區`, 'warn');
          if (!(await allowed('reload-page'))) return;
          location.reload();
          return;
        }
        if (slotId) await call('skip-slot', { slotId }, 1500);
        log(`${what}，改選下一個時段`, 'warn');
        location.assign(SITE.listUrl());
        return;
      }
      if (act === 'rate-limit') {
        // 送出被說請求太多：不自動重送，什麼時候再送由你決定
        return finish(false, 'rate-limited', `${what}。網站說請求太多，助手不自動重送，先停下來交給你：請等一下再自己按，或到擴充功能按「繼續」`, { handOff: true });
      }
      if (act === 'retry') {
        const r = await grant('fail', what);
        if (!r) return finish(false, 'fail-limit', `${what}，重試次數用完了`, { handOff: true });
        continue;   // 前一次確定失敗了，才再送一次（迴圈開頭會再過一次 PolicyGate）
      }
      if (act === 'reload') {
        // 表單權杖過期之類：重新整理這一頁拿新的，這一步會重新做一次（有次數上限）
        const r = await grant('fail', what);
        if (!r) return finish(false, 'fail-limit', `${what}，重試次數用完了`, { handOff: true });
        if (!(await allowed('reload-page'))) return;
        location.reload();
        return;
      }
      if (act === 'duplicate') {
        // 網站說已經收到了：上一次其實送到了，不要再送，往下一步看看
        log(`${what}，上一次其實已經送到了，不再重送`, 'warn');
        location.assign(SITE.nextUrl(stepName));
        return;
      }
      if (act === 'wait' || act === 'restart') {
        const r = await grant('fail', what);
        if (!r) return finish(false, 'fail-limit', `${what}，重試次數用完了`, { handOff: true });
        // 保留逾時、步驟對不上：之前做完的步驟不算數了
        await call('wf', { state: state.wf ? state.wf.state : 'QUANTITY_SELECTION', clearDone: true }, 2500);
        location.assign(SITE.listUrl());
        return;
      }
      if (act === 'gate') return finish(false, out.code.toLowerCase(), `${what}。這一關要你自己處理，助手先停下來`, { handOff: true });
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

  /** 場次列表：讀活動與場次 → 比對需求 → 選場次（還沒開放就等，讀取失敗就重試） */
  async function onList(d) {
    const cfg = d.cfg || {};
    const req = requirementOf(cfg);
    if (!(await enter('ACTIVITY_READ'))) return;
    let prev = null;
    let since = pageStart();   // 這一輪讀取是從什麼時候開始的（給 rateSeenSince）
    const refresh = () => { since = Date.now(); return refreshList(); };
    for (;;) {
      if (state.aborted || state.left) return;
      const ls = await waitList(30000, prev);
      if (!ls) {
        const r = await grant('load', '時段列表等了 30 秒還沒出來');
        if (!r) return finish(false, 'list-timeout', '時段列表一直沒有出來，先停下來', { handOff: true });
        if (!(await allowed('reload-page'))) return;
        location.reload();
        return;
      }
      if (ls.error) {
        if (classifyError('', ls.status) === 'rate-limit' || await rateSeenSince(since)) {
          if (!(await rateWait(listErrText(ls.error)))) return;
          if (!(await allowed('refresh-list'))) return;
          prev = refresh();
          await sleep(50);
          continue;
        }
        if (classifyError('', ls.status) === 'login') return finish(false, 'login-required', `${listErrText(ls.error)}。網站要你重新登入，助手先停下來`, { handOff: true });
        const r = await grant('load', listErrText(ls.error), ls.status);
        if (!r) return finish(false, 'load-limit', `${ls.error}。連續 5 分鐘都沒有恢復，先停下來`, { handOff: true });
        if (!(await allowed('refresh-list'))) return;
        prev = refresh();
        await sleep(50);
        continue;
      }
      send('load-ok', {});
      if (!(await enter('REQUIREMENT_CHECK'))) return;
      // 已經保留了名額（例如按上一頁回到列表）：不再選一次，免得重複保留
      if (doneStep('hold')) {
        return finish(false, 'already-held', `你已經保留了「${selectionNow().sessionText || '某個場次'}」的名額，助手不會再選一次`, { handOff: true });
      }
      // 票種與預算：先用列表上的票價檢查（票區加價在選票頁再檢查一次）
      const prices = SITE.prices();
      if (prices.length) {
        const t = matchTickets(req, prices);
        if (!t.ok && t.kind === 'budget') return finish(false, 'budget', `${t.msg}。沒有符合預算的選擇，不會送出選購`);
      }
      const plan = planSession(ls.slots, req, { skip: d.skip || [] });
      await notePlan('REQUIREMENT_CHECK', briefPlan('session', plan));
      if (plan.kind === 'ok') {
        log(describePick(plan, req.need), 'ok');
        if (!(await enter('SESSION_SELECTION', { selection: { slotId: plan.slot.id, sessionText: plan.slot.text } }))) return;
        if (!(await allowed('select-session'))) return;
        setStatus(`前往「${plan.slot.text}」選票種…`, 'ok');
        if (!SITE.openSlot(plan.slot)) return finish(false, 'no-button', '找不到這個時段的選購按鈕，先停下來', { handOff: true });
        return;
      }
      if (plan.kind === 'not-open') {
        if (!(await enter('WAITING_FOR_SALE'))) return;
        const r = await grant('not-open', describePick(plan, req.need));
        if (!r) return finish(false, 'not-open-limit', `${describePick(plan, req.need)}，重試次數用完了`);
        if (!(await allowed('refresh-list'))) return;
        if (!(await enter('ACTIVITY_READ'))) return;
        prev = refresh();
        await sleep(50);
        continue;
      }
      // 偏好的場次狀態看不出來：不猜、不當成還沒開放一直重看，停下來問你
      if (plan.kind === 'unknown') return finish(false, 'status-unknown', plan.msg, { handOff: true });
      return finish(false, plan.kind, describePick(plan, req.need));
    }
  }

  /** 選票頁：選票區（有分區時）→ 對票種與預算 → 選張數 → 送出選購 */
  async function onSelect(d) {
    const cfg = d.cfg || {};
    const req = requirementOf(cfg);
    if (!(await enter('TICKET_AREA_SELECTION'))) return;
    const info = SITE.selectInfo();
    // 這個場次已經保留過名額（例如重新整理、按上一頁回來）：不重送，直接到下一步
    if (doneStep('hold') && (!state.wf.done.hold.slotId || state.wf.done.hold.slotId === info.slotId)) {
      log('這個場次已經保留過名額，不再送一次選購，直接到下一步', 'warn');
      location.assign(SITE.nextUrl('select'));
      return;
    }
    if (info.status === 'full' || info.status === 'not-open') {
      if (info.status === 'full' && info.slotId) await call('skip-slot', { slotId: info.slotId }, 1500);
      log(`「${info.text}」${info.status === 'full' ? '已額滿' : '還沒開放'}，回時段列表`, 'warn');
      location.assign(SITE.listUrl());
      return;
    }
    const types = SITE.ticketTypes();
    if (!types.length) return finish(false, 'no-types', '選票頁上找不到票種，先停下來', { handOff: true });
    const maxPerOrder = SITE.maxPerOrder();
    let area = null;
    const areas = SITE.areas();
    if (areas.length) {
      const skip = ((state.wf && state.wf.skipAreas) || {})[info.slotId] || [];
      const ap = planArea(areas, req, types, { skip, maxPerOrder });
      await notePlan('TICKET_AREA_SELECTION', briefPlan('area', ap));
      if (ap.kind !== 'ok') return finish(false, 'area-none', `${ap.msg}。不會送出選購`);
      area = ap.area;
      if (!(await allowed('select-area'))) return;
      if (!SITE.chooseArea(area)) return finish(false, 'fill-failed', `選不了「${area.name}」，先停下來`, { handOff: true });
      log(ap.msg, 'ok');
    }
    const t = matchTickets(req, types, { surcharge: area ? area.surcharge || 0 : 0, maxPerOrder });
    if (!t.ok) {
      if (t.kind === 'budget') return finish(false, 'budget', `${t.msg}。沒有符合預算的選擇，不會送出選購`);
      return finish(false, 'tickets', t.msg, { handOff: true });
    }
    const plan = t.plan;
    const selection = {
      slotId: info.slotId, sessionText: selectionNow().sessionText || info.text,
      areaId: area ? area.id : null, areaName: area ? area.name : null,
      items: plan.plan.map((p) => ({ name: p.name, qty: p.qty })), amount: plan.amount,
    };
    if (!(await enter('QUANTITY_SELECTION', { selection }))) return;
    if (!(await allowed('set-quantity'))) return;
    for (const p of plan.plan) SITE.setQty(p.id, p.qty);
    const bad = plan.plan.find((p) => SITE.qtyOf(p.id) !== p.qty);
    if (bad) return finish(false, 'fill-failed', `「${bad.name}」的張數填不進去，先停下來`, { handOff: true });
    log(`張數：${plan.plan.map((p) => `${p.name} ${p.qty}`).join('、')}，共 ${plan.total} 張、NT$${plan.amount}`);
    return submitOnce('select', d, info.slotId, area);
  }

  /** 購票人資料頁：到這裡代表選購已經保留了；填你提供的資料 → 勾同意（照你的設定）→ 送出 */
  async function onInfo(d) {
    const cfg = d.cfg || {};
    if (!(await enter('BUYER_INFO', { done: 'hold' }))) return;
    if (doneStep('buyer')) {
      log('購票人資料已經送出過，不再送一次，直接到下一步', 'warn');
      location.assign(SITE.nextUrl('info'));
      return;
    }
    const chk = checkProfile(cfg.profile);
    if (!chk.ok) return finish(false, 'profile', `購票人資料不完整（${describeProfileProblem(chk)}），請在擴充功能補上後按「繼續」`, { handOff: true });
    if (!(await allowed('fill-profile'))) return;
    const r = SITE.fillProfile(chk.profile);
    if (r.missing.length) return finish(false, 'fill-failed', `這些欄位找不到或填不進去：${r.missing.join('、')}，先停下來`, { handOff: true });
    if (SITE.hasAgree()) {
      const ok = await allowed('agree-terms', () => finish(false, 'agree', '資料已填好。你設定不自動勾選同意，請自己閱讀並勾選後按「下一步」', { handOff: true }));
      if (!ok) return;
      if (!SITE.setAgree(true)) return finish(false, 'agree-failed', '同意使用須知勾不起來，先停下來', { handOff: true });
    }
    log(`已填購票人資料：${maskText(`${chk.profile.name.slice(0, 1)}** ${chk.profile.phone} ${chk.profile.email}`)}${SITE.hasAgree() ? '，已勾選同意' : ''}`);
    return submitOnce('info', d, null);
  }

  /**
   * 確認頁：核對訂單（ORDER_REVIEW），一致才交接付款（PAYMENT_HANDOFF）。只讀、標出按鈕、提醒你，絕不替你按：
   * 「確認建立訂單」在操作政策裡是 CONFIRMATION_REQUIRED（不可逆），付款是 BLOCKED。
   */
  async function onConfirm(d, alreadyReported = false) {
    const g = SITE.confirmGates();
    const left = SITE.holdLeft();
    const extra = [g.captcha && '輸入驗證碼', g.botcheck && '自己完成「我不是機器人」檢查'].filter(Boolean);
    const msg = `已到確認頁${left != null ? `，名額保留中（約剩 ${left} 秒）` : ''}。請檢查訂單內容${extra.length ? '，' + extra.join('、') : ''}，再自己按「確認建立訂單」`;
    if (alreadyReported) { setStatus(msg, 'warn'); watchHold(); return; }
    if (!(await enter('ORDER_REVIEW', { done: 'buyer' }))) return;
    const summary = SITE.orderSummary();
    const sel = selectionNow();
    const review = reviewOrder(summary, { sessionText: sel.sessionText, areaName: sel.areaName, items: sel.items || [], amount: sel.amount });
    if (!review.ok) return finish(false, 'review-mismatch', `${review.msg}。助手不交接付款，先停下來請你確認`, { handOff: true, summary });
    const btn = SITE.confirmButton();
    if (btn) { btn.style.outline = '3px solid #d97706'; btn.style.outlineOffset = '3px'; }
    await finish(true, 'ready', msg, { handOff: true, summary });
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
    let action = classifyError(e.code, e.status);
    if (action !== 'rate-limit' && action !== 'gate' && await rateSeenSince(pageStart())) action = 'rate-limit';
    if (action === 'rate-limit') {
      if (!(await rateWait(what))) return;
      if (!(await allowed('reload-page'))) return;
      location.reload();
      return;
    }
    if (action === 'login') return finish(false, 'login-required', `${what}。網站要你重新登入，助手先停下來`, { handOff: true });
    if (action === 'retry') {
      const r = await grant('load', what, e.status);
      if (!r) return finish(false, 'load-limit', `${what}，一直沒有恢復，先停下來`, { handOff: true });
      if (!(await allowed('reload-page'))) return;
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
    if (d && d.wf) state.wf = d.wf;
    panel();
    setCountdown(null);
    try {
      await domReady();
      const kind = SITE.pageKind();
      if (!(await enter('PAGE_DETECTION', { reason: `頁面：${kind}` }))) return;
      switch (kind) {
        case 'list': setStatus('讀取時段狀態…', 'ok'); return await onList(d);
        case 'select': setStatus('選擇票區、票種與張數…', 'ok'); return await onSelect(d);
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
    if (ls.error) return report({ ok: false, error: listErrText(ls.error) });
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
        add('buy', '選購按鈕', !buy ? 'skip' : buy.el && buy.el.querySelector('a[href*="/select/"]') ? 'ok' : 'fail', buy ? '' : '目前沒有能買的時段');
      }
      add('refresh', '更新狀態按鈕', buttonByText('更新狀態') ? 'ok' : 'warn');
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
    if (c.cmd === 'pause') {
      // 暫停：手上這一個檢查做完就停，不再做新的操作（之後每一步的報到與 PolicyGate 也都會拒絕）
      state.aborted = true;
      if (state.panel) { setStatus('已暫停：到擴充功能按「繼續」，從這一頁接著做', 'warn'); setCountdown(null); }
      return;
    }
    if (c.cmd === 'run') {
      state.aborted = false;
      state.mode = 'run';
      runFlow({ cfg: c.cfg || {}, since: c.since, skip: c.skip || [], wf: c.wf || null });
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
      case 'paused': panel(); setStatus('已暫停：到擴充功能按「繼續」，從這一頁接著做', 'warn'); return undefined;
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
