  /* ───────────────────────── IbonAdapter（只讀） ─────────────────────────
   * ibon 的頁面轉接，跟模擬站的 POOL（src/agent/10-pool.js）分開。
   * 這裡只有讀取：頁面種類、活動資訊、登入狀態、狀態提示、這一頁助手能做什麼、結構快照。
   * 沒有任何點擊、填值、送出的函式：網站上的操作照 lib/ibon.js 的 IBON_POLICY，一律由你自己做。 */

  /** 看得到的文字，連同 Shadow DOM（包括封閉的）裡的文字；innerText 本身不會進到 Shadow DOM */
  function visibleText() {
    const parts = [document.body ? document.body.innerText : ''];
    for (const host of deepAll('*')) {
      const sr = shadowOf(host);
      if (sr) for (const c of sr.children) if (c.innerText) parts.push(c.innerText);
    }
    return parts.join('\n');
  }

  /**
   * 結構快照（你按了才記）：標籤、id、class、角色、欄位名稱、按鈕與標籤上的字、下拉選單的選項，連同封閉的 Shadow DOM。
   * 也記看不看得見（hidden）、選項有沒有被選（checked、selected）、data-* 屬性：之後要核對「你選了哪一個」。
   * 不記錄欄位裡填的內容；文字經過 maskText（遮 Email、手機、身分證、長數字、「XXX 您好」「姓名：XXX」，以及 own＝你在設定頁填的姓名、手機、Email），
   * 網址只留路徑與參數名稱。沒有固定說法的姓名還是可能遮不到，交出去之前請自己看過。
   */
  const SNAP = { nodes: 5000, depth: 45, text: 80 };
  function snapshotStructure(own = []) {
    let count = 0;
    const m = (v, n) => maskText(v, own).slice(0, n);
    const attr = (el, out) => {
      for (const a of ['name', 'type', 'role', 'aria-label', 'for', 'title', 'placeholder', 'value']) {
        if (a === 'value' && !['radio', 'checkbox', 'submit', 'button'].includes(el.type)) continue;   // 文字欄位的值不記
        if (el.hasAttribute(a)) out[a] = m(el.getAttribute(a), 40);
      }
      const data = [...el.attributes].filter((x) => x.name.startsWith('data-') && !x.name.startsWith('data-ng')).slice(0, 6);
      if (data.length) out.data = Object.fromEntries(data.map((x) => [x.name, m(x.value, 30)]));
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.disabled = true;
      if (el.checked) out.checked = true;
      if (!isVisible(el)) out.hidden = true;
    };
    const walk = (el, depth) => {
      if (count >= SNAP.nodes || depth > SNAP.depth) return null;
      count++;
      const tag = el.tagName.toLowerCase();
      const out = { t: tag };
      if (el.id) out.id = maskText(el.id).slice(0, 40);
      const cls = [...el.classList].slice(0, 4);
      if (cls.length) out.c = cls.join(' ');
      attr(el, out);
      if (tag === 'a' && el.getAttribute('href')) out.href = maskUrl(el.getAttribute('href'), location.href);
      if (tag === 'form' && el.getAttribute('action')) out.action = maskUrl(el.getAttribute('action'), location.href);
      if (tag === 'img') { out.alt = maskText(el.alt).slice(0, 40); if (el.getAttribute('src')) out.src = maskUrl(el.getAttribute('src'), location.href); }
      if (tag === 'input' || tag === 'textarea') { if (el.value && !['radio', 'checkbox', 'submit', 'button'].includes(el.type)) out.filled = true; return out; }   // 只記「有沒有填」，不記內容
      if (tag === 'select') { out.options = [...el.options].slice(0, 30).map((o) => m(norm(o.text), 40)); out.selected = el.selectedIndex; return out; }
      if (tag === 'iframe') { out.src = maskUrl(el.getAttribute('src') || '', location.href); return out; }
      if (tag === 'canvas') { out.size = `${el.width}x${el.height}`; return out; }
      if (['script', 'style', 'noscript', 'svg', 'template', 'canvas', 'video'].includes(tag)) return out;
      const txt = norm([...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue).join(' '));
      if (txt) out.x = m(txt, SNAP.text);
      const kids = [];
      const sr = shadowOf(el);
      if (sr) kids.push({ t: '#shadow-root', mode: el.shadowRoot ? 'open' : 'closed', k: [...sr.children].map((c) => walk(c, depth + 1)).filter(Boolean) });
      for (const c of el.children) { const w = walk(c, depth + 1); if (w) kids.push(w); }
      if (kids.length) out.k = kids;
      return out;
    };
    const tree = document.body ? walk(document.body, 0) : null;
    return {
      kind: ibonPageKind(location.href), url: maskUrl(location.href), title: m(document.title, 100),
      takenAt: Date.now(), nodes: count, truncated: count >= SNAP.nodes, tree,
    };
  }

  /**
   * 填寫購票資訊（UTK0206，流程第 4 步）：照 2026-10-16 的真站快照讀，只讀看得到的字，整理交給 lib/ibon.js 的 parseBuyerInfo。
   * 用頁面上的字與 data-title 找位置，不靠 ASP.NET 產生的 id。聯絡電話、Email 只回「有沒有」，不讀內容。
   */
  /** 購票流程頁上方的保留倒數「剩餘時間 mm:ss」（2026-10-16 真站快照在 UTK0206 的頁首看到；看得見的那一個）；沒有回 null */
  function readCountdownText() {
    return $$('span').filter((el) => isVisible(el)).map((el) => norm(el.textContent)).find((t) => /^剩餘時間\s*\d{1,2}\s*[:：]\s*\d{2}$/.test(t)) || null;
  }

  function readBuyerInfo() {
    const vis = (el) => isVisible(el);
    const cardBody = (title) => {
      const h = $$('.card-header, h5').find((el) => norm(el.textContent) === title);
      return h ? (h.closest('.card') || h.parentElement) : null;
    };
    const radios = (root) => (root ? $$('input[type=radio]', root) : []).map((r) => {
      const lab = r.id ? root.querySelector(`label[for="${CSS.escape(r.id)}"]`) : null;
      return { label: norm((lab || r.parentElement || {}).textContent || ''), checked: r.checked };
    }).filter((x) => x.label);
    const steps = $$('.step-grid').map((g) => ({
      n: norm(($('.step-circle', g) || {}).textContent || ''), text: norm(($('.text', g) || {}).textContent || ''), active: g.classList.contains('active'),
    }));
    const table = $$('table').find((t) => $$('th', t).some((th) => norm(th.textContent) === '區域/座位'));
    const cell = (tr, title) => {
      const td = $$('td', tr).find((c) => norm(c.getAttribute('data-title')) === title);
      if (!td) return null;
      const sel = $('select', td);
      if (sel) return norm((sel.selectedOptions[0] || {}).textContent || '');
      const shown = $$('span', td).filter(vis);
      return norm(shown.length ? shown.map((x) => x.textContent).join(' ') : td.textContent);
    };
    const rows = table ? $$('tbody tr', table).filter((tr) => $$('td[data-title]', tr).length).map((tr) => ({
      name: cell(tr, '名稱'), time: cell(tr, '活動時間'), venue: cell(tr, '場地'), seat: cell(tr, '區域/座位'),
      type: cell(tr, '票種'), qty: cell(tr, '數量'), price: cell(tr, '價格(NT$)'),
    })) : [];
    const totalLabel = $$('div').find((el) => norm(el.textContent) === '總計(付款金額)');
    const totalEl = totalLabel && totalLabel.parentElement ? $('.total', totalLabel.parentElement) : null;
    const countdown = readCountdownText();
    const field = (labelText) => {
      const lab = $$('label').find((l) => norm(l.textContent).replace(/^\*/, '') === labelText);
      return lab ? (lab.closest('.form-group') || lab.parentElement) : null;
    };
    const phoneBox = field('聯絡電話：');
    const phoneInput = phoneBox ? $('input', phoneBox) : null;
    const emailBox = field('電子郵件：');
    const emailShown = emailBox ? !!norm(($('.col-sm-10', emailBox) || emailBox).textContent).replace('電子郵件：', '') : null;
    const agreeBox = $$('input[type=checkbox]').find((c) => {
      const l = c.id ? $(`label[for="${CSS.escape(c.id)}"]`) : null;
      return l && /同意/.test(l.textContent);
    });
    const discount = cardBody('請選擇折扣');
    const text = visibleText();
    const cap = text.match(/驗證碼|請輸入圖形|圖形驗證/);
    return {
      steps, title: norm(($('#order-wrap h1') || {}).textContent || '') || null, rows,
      total: totalEl ? norm(totalEl.textContent) : null, countdown,
      discount: discount ? norm(($('.card-body', discount) || discount).textContent) : null,
      phoneFilled: phoneInput ? norm(phoneInput.value) !== '' : null, emailShown,
      pay: radios(cardBody('選擇付款方式')), get: radios(cardBody('取票方式')),
      agree: agreeBox ? agreeBox.checked : null,
      buttons: deepAll('a, button, input[type=submit]').filter(vis).map((b) => norm(b.textContent || b.value)).filter((t) => t && t.length <= 12),
      captchaText: cap ? cap[0] : null,
    };
  }

  const IbonAdapter = {
    id: 'ibon',

    /** 頁面種類（lib/ibon.js 的 ibonPageKind：照網址） */
    pageKind: () => ibonPageKind(location.href),

    /** 活動頁：活動、場次、票價、開賣時間（真站核對過，活動 39972） */
    readActivity: readIbonActivity,

    /** 登入狀態：頁首看得到「快速登入」＝沒登入（真站看過）；看不到就說看不出來（登入後的頁首還沒在真站核對過） */
    loginState() {
      const link = deepAll('a, button').find((el) => norm(el.textContent) === '快速登入' && isVisible(el));
      if (!link && IbonAdapter.pageKind() === 'buyer-info' && deepAll('a, button').some((el) => norm(el.textContent) === '登出' && isVisible(el))) {
        return { state: 'logged-in', verified: true, msg: '頁首有「登出」：已經登入（購票流程頁，2026-10-16 真站快照看過）' };
      }
      return link
        ? { state: 'logged-out', verified: true, msg: '頁首有「快速登入」：目前沒有登入。購票前請先登入（購票須知也這樣要求）' }
        : { state: 'unknown', verified: false, msg: '頁首沒看到「快速登入」，可能已經登入（登入後的頁首還沒在真站核對過）' };
    },

    /**
     * 這一頁的狀態：頁面種類、登入、狀態提示。
     * 活動頁的場次狀態要讀場次表（readActivity）；購票頁還沒有真站結構，只照頁面上的字給提示，一律標「未驗證」。
     */
    readState() {
      const kind = IbonAdapter.pageKind();
      const page = IBON_PAGE_INFO[kind] || { label: '不是 ibon 的頁面', verified: false };
      const hints = kind === 'activity' ? [] : stateHints(visibleText());
      return { kind, label: page.label, verified: page.verified, login: IbonAdapter.loginState(), hints, policy: IBON_POLICY };
    },

    /** 填寫購票資訊（UTK0206）：訂單內容、保留時間、要你自己填選的項目（只讀） */
    readBuyerInfo: () => parseBuyerInfo(readBuyerInfo()),

    /** 保留倒數：秒數；這一頁沒有回 null（只讀） */
    readCountdown: () => parseCountdown(readCountdownText()),

    /** 這一頁助手能做什麼、要你自己做什麼（lib/ibon.js 的 IBON_POLICY） */
    supportedActions: () => IBON_POLICY,

    /** 結構快照：給開發真實購票頁的唯讀解析用 */
    snapshot: (own) => snapshotStructure(own),
  };

