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
   * 不記錄欄位裡填的內容；文字經過 maskText（遮 Email、手機、身分證、長數字），網址只留路徑與參數名稱。
   * 姓名這類沒有固定格式的字遮不到，交出去之前請自己看過。
   */
  const SNAP = { nodes: 3000, depth: 40, text: 60 };
  function snapshotStructure() {
    let count = 0;
    const attr = (el, out) => {
      for (const a of ['name', 'type', 'role', 'aria-label', 'for', 'title', 'placeholder']) {
        if (el.hasAttribute(a)) out[a] = maskText(el.getAttribute(a)).slice(0, 40);
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.disabled = true;
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
      if (tag === 'input' || tag === 'textarea') { if (el.value) out.filled = true; return out; }   // 只記「有沒有填」，不記內容
      if (tag === 'select') { out.options = [...el.options].slice(0, 30).map((o) => maskText(norm(o.text)).slice(0, 40)); return out; }
      if (tag === 'iframe') { out.src = maskUrl(el.getAttribute('src') || '', location.href); return out; }
      if (['script', 'style', 'noscript', 'svg', 'template', 'canvas', 'video'].includes(tag)) return out;
      const own = norm([...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue).join(' '));
      if (own) out.x = maskText(own).slice(0, SNAP.text);
      const kids = [];
      const sr = shadowOf(el);
      if (sr) kids.push({ t: '#shadow-root', mode: el.shadowRoot ? 'open' : 'closed', k: [...sr.children].map((c) => walk(c, depth + 1)).filter(Boolean) });
      for (const c of el.children) { const w = walk(c, depth + 1); if (w) kids.push(w); }
      if (kids.length) out.k = kids;
      return out;
    };
    const tree = document.body ? walk(document.body, 0) : null;
    return {
      kind: ibonPageKind(location.href), url: maskUrl(location.href), title: maskText(document.title).slice(0, 100),
      takenAt: Date.now(), nodes: count, truncated: count >= SNAP.nodes, tree,
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

    /** 這一頁助手能做什麼、要你自己做什麼（lib/ibon.js 的 IBON_POLICY） */
    supportedActions: () => IBON_POLICY,

    /** 結構快照：給開發真實購票頁的唯讀解析用 */
    snapshot: snapshotStructure,
  };

