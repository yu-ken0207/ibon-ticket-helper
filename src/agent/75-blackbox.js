  /* ───────────────────────── 黑盒子 ─────────────────────────
   * 遇到失敗、交手、被拒、排隊頁時，記下當下頁面的重點，可以從擴充功能匯出。
   * 真站沒測過的狀況一旦真的發生，就能拿回來補進假網站。只記頁面上看得到的字，不記導覽列和個人資料；
   * 網址只留路徑，不帶參數。 */
  function safeUrl() {
    return location.origin + location.pathname;
  }

  /**
   * 元素的結構骨架（標籤、id、class、會動作的屬性、短短的文字），給沒看過的頁面變化用：例如點了票區沒反應，
   * 看得出點擊是掛在哪一層。不記輸入框的值；文字只留前 20 個字。最多 120 個節點。
   */
  function skeleton(el, budget = { n: 0 }, depth = 0) {
    if (!el || budget.n >= 120 || depth > 8) return '';
    if (el.hasAttribute && el.hasAttribute('data-ith')) return '';   // 助手自己的面板不記
    budget.n++;
    const tag = el.tagName ? el.tagName.toLowerCase() : '#';
    const attrs = [];
    if (el.id) attrs.push(`id="${String(el.id).slice(0, 40)}"`);
    if (el.className && typeof el.className === 'string') attrs.push(`class="${el.className.slice(0, 60)}"`);
    for (const a of ['type', 'name', 'role', 'onclick', 'href', 'for', 'aria-checked', 'aria-selected', 'data-id']) {
      if (el.hasAttribute && el.hasAttribute(a)) attrs.push(`${a}="${String(el.getAttribute(a)).slice(0, 60)}"`);
    }
    if (el.checked) attrs.push('checked');
    if (el.disabled) attrs.push('disabled');
    const own = norm([...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue).join(' ')).slice(0, 20);
    const sr = shadowOf(el);
    const kids = [...(sr ? [{ shadow: true }] : []), ...el.children];
    const inner = kids.map((k) => (k.shadow ? `<#shadow>${[...sr.children].map((c) => skeleton(c, budget, depth + 1)).join('')}</#shadow>` : skeleton(k, budget, depth + 1))).join('');
    return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${own}${inner}</${tag}>`;
  }

  /** 這一頁重點區塊的骨架：「購票方式」那一段、票區表格的前兩列（選票區頁） */
  function keyParts() {
    const parts = [];
    // 「購票方式」：從寫著這幾個字的最裡層元素往外找，找到把選項也包進來的那一層（最多往上三層）
    const marks = deepAll('*').filter((el) => /^購票方式/.test(norm(el.textContent)) && norm(el.textContent).length < 60);
    let how = marks.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length)[0] || null;
    if (how) {
      const base = norm(how.textContent).length;
      for (let i = 0; i < 3 && how.parentElement && norm(how.textContent).length <= base + 2; i++) how = how.parentElement;
      parts.push('購票方式：' + skeleton(how));
    }
    if (pageKind() === 'area') {
      const rows = areaRows();
      const ok = rows.filter((r) => !/已售完/.test(r.textContent)).slice(0, 2);
      for (const r of (ok.length ? ok : rows.slice(0, 2))) parts.push('票區列：' + skeleton(r));
    }
    return parts.join('\n').slice(0, 4000);
  }

  function snapshot(kind, msg) {
    const vis = [...document.querySelectorAll('button, a.btn, input[type="submit"]')].filter(isVisible);
    const rows = pageKind() === 'area' ? areaRows().map((r) => areaInfo(r, 1).text) : sessionRows().map((r) => norm(r.textContent));
    return {
      at: Date.now(), kind, msg: String(msg || '').slice(0, 300),
      url: safeUrl(), title: norm(document.title).slice(0, 80), page: pageKind(), login: loginState(),
      rows: rows.length, rowSample: rows.slice(0, 4).map((r) => r.slice(0, 60)),
      buttons: vis.map((b) => norm(b.textContent || b.value).slice(0, 30)).filter(Boolean).slice(0, 15),
      modals: [...document.querySelectorAll('.modal, [role="dialog"], .alert')].filter(isVisible).map((m) => norm(m.innerText).slice(0, 200)).slice(0, 5),
      alerts: state.alerts.slice(-3),
      text: norm(visibleText()).slice(0, 2000),   // 連同 Shadow DOM 裡的字（票區表、座位圖都在裡面）
      html: keyParts(),
    };
  }

  const boxed = new Set();
  /** 記一筆黑盒子；once 為真時同一種狀況在這一頁只記一次 */
  function blackbox(kind, msg, once = false) {
    if (once && boxed.has(kind)) return;
    boxed.add(kind);
    try { send('blackbox', snapshot(kind, msg)); } catch (_) { /* 記錄失敗不影響流程 */ }
  }
