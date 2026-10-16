  /* ───────────────────────── 讀 ibon 活動頁（只讀） ─────────────────────────
   * 頁面上看得到的東西：
   *   標題        <h1>
   *   售票平台    「售票平台：」「票券型態：」這類清單
   *   場次表      <app-game> 的封閉 Shadow DOM 裡：表頭（演出 / 銷售日期、場次名稱、場地 / 地區）和每一列；
   *               每列最後一格是購票按鈕（「線上購票」「已售完」…）和截止時間之類的小字
   *   節目介紹    票價、售票時間寫在這裡的文字裡（各活動寫法不同，lib/eventinfo.js 盡量認，原文也一起給你看）
   * 場次表比頁面其他部分晚出現，要等一下。等不到就照實回報「沒讀到場次表」，不猜。 */

  /** 場次表的表頭：找寫著「場次名稱」的那一格，回傳整列各格的文字；沒有就 null */
  function sessionHeader() {
    const cell = deepAll('p, th, span, div').find((el) => el.children.length === 0 && /場次名稱/.test(textOf(el) || el.textContent));
    if (!cell || !cell.parentElement) return null;
    return [...cell.parentElement.children].map((c) => norm(c.textContent));
  }

  /** 表頭各欄 → 日期、名稱、場地在第幾格；沒有表頭就照常見的順序 */
  function columnsOf(header) {
    const find = (re, dflt) => { const i = header ? header.findIndex((h) => re.test(h)) : -1; return i >= 0 ? i : dflt; };
    return { when: find(/日期|時間/, 0), name: find(/場次|名稱/, 1), venue: find(/場地|地區|地點/, 2) };
  }

  /** 場次表的每一列 */
  function sessionRows() {
    return deepAll('#GameInfoList .tr');
  }

  /** 一列 → { when, name, venue, button, disabled, note }：只讀文字和按鈕能不能按 */
  function readRow(row, col) {
    const cells = [...row.children];
    const cellText = (i) => (cells[i] ? norm(cells[i].textContent) : '');
    const btn = row.querySelector('button, a[role="button"], a.btn');
    const btnText = btn ? norm(btn.textContent) : '';
    const actionCell = btn ? cells.find((c) => c.contains(btn)) : cells[cells.length - 1];
    const note = actionCell ? norm(actionCell.textContent.replace(btn ? btn.textContent : '', '')) : '';
    const disabled = !!btn && (btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.hasAttribute('disabled'));
    return { when: cellText(col.when), name: cellText(col.name), venue: cellText(col.venue), button: btnText, disabled, note };
  }

  /** 頁面上方「售票平台：ibon機台、線上購票」「票券型態：ibon紙券」；說明區塊裡的同名字句（例如加購高鐵的取票方式）不算 */
  function offers() {
    const detail = document.getElementById('detail');
    return deepAll('li')
      .filter((li) => !(detail && detail.contains(li)))
      .map((li) => norm(li.textContent))
      .filter((t) => /^(售票平台|票券型態)\s*[:：]/.test(t))
      .map((t) => { const i = t.search(/[:：]/); return { label: t.slice(0, i).trim(), value: t.slice(i + 1).trim() }; });
  }

  /** 說明區塊：標題（「節目介紹」「購票須知」…）下面那一段的文字；找不到回空字串 */
  function sectionText(title) {
    const head = $$('#detail *, body *').find((el) => el.children.length === 0 && norm(el.textContent) === title);
    const body = head ? (head.nextElementSibling || (head.parentElement && head.parentElement.nextElementSibling)) : null;
    return body ? blockText(body) : '';
  }

  /**
   * 說明文字（保留換行）：
   *   intro   「節目介紹」：票價、開賣時間從這裡找（免得把退票規則裡的「票價 10%」當成票價）
   *   notice  「購票須知」：限購規定從這裡找（免得混進周邊商品的限購）
   *   all     所有說明區塊；上面兩段找不到時才用。說明區塊也找不到就讀整頁。
   */
  function description() {
    const detail = document.getElementById('detail');
    return { intro: sectionText('節目介紹'), notice: sectionText('購票須知'), all: blockText(detail || document.body) };
  }

  /** 等場次表出現（最多 maxMs），再把整頁讀一次 */
  async function readIbonActivity(maxMs = 15000) {
    const t0 = Date.now();
    const warnings = [];
    let rows = sessionRows();
    while (!rows.length && Date.now() - t0 < maxMs) {
      await sleep(300);
      rows = sessionRows();
    }
    if (!rows.length) warnings.push(`等了 ${Math.round(maxMs / 1000)} 秒還沒看到場次表（可能還沒開放、已下架，或頁面結構改了）`);
    const header = sessionHeader();
    if (rows.length && !header) warnings.push('場次表沒有表頭，欄位照常見順序（日期、名稱、場地）讀');
    const col = columnsOf(header);
    const h1 = $$('h1').find((h) => isVisible(h) && norm(h.textContent)) || $('h1');
    const d = description();
    if (!d.intro) warnings.push('找不到「節目介紹」區塊，票價與開賣時間改從整頁的文字找');
    return {
      url: location.href,
      title: h1 ? norm(h1.textContent) : norm(document.title),
      offers: offers(),
      sessions: rows.map((r) => readRow(r, col)),
      description: d.intro,
      notice: d.notice,
      fullText: d.all,
      warnings,
    };
  }


  /* ───────────────────────── 登入、頁面狀態 ───────────────────────── */

  /** 登入狀態：頁首看得到「快速登入」＝沒登入；購票流程頁看得到「登出」＝已登入（2026-10-16 真站快照）；其他看不出來 */
  function loginState() {
    const link = deepAll('a, button').find((el) => norm(el.textContent) === '快速登入' && isVisible(el));
    if (link) return 'logged-out';
    if (deepAll('a, button').some((el) => norm(el.textContent) === '登出' && isVisible(el))) return 'logged-in';
    return 'unknown';
  }

  /** 看得到的文字，連同 Shadow DOM（包括封閉的）裡的文字；innerText 本身不會進到 Shadow DOM */
  function visibleText() {
    const parts = [document.body ? document.body.innerText : ''];
    for (const host of deepAll('*')) {
      const sr = shadowOf(host);
      if (sr) for (const c of sr.children) if (c.innerText) parts.push(c.innerText);
    }
    return parts.join('\n');
  }

  /** 排隊、流量控管、機器人檢查的字樣（只辨識有沒有，不處理） */
  function blockerText() {
    const m = visibleText().match(/流量控管|排隊|請稍候|機器人|驗證碼|Just a moment/i);
    return m ? m[0] : null;
  }

  const SOLD_OUT = /已售完|售完|已額滿|額滿|暫無|無法購買/;

  /* ───────────────────────── 選票區頁（UTK0201_000，第 2 步） ─────────────────────────
   * 截圖看過：表格，欄位「顏色、票區、票價(NT$)、空位」，空位寫「熱賣中」。網頁結構還沒核對：
   * 列裡有連結就點連結，沒有就點整列。 */
  function areaRows() {
    return deepAll('tbody tr').filter((r) => isVisible(r) && $$('td', r).length >= 2 && /NT|\d/.test(norm(r.textContent)));
  }
  const areaRowText = (r) => norm($$('td', r).map((td) => td.textContent).join(' '));

  /* ───────────────────────── 座位/數量頁（UTK0202_，第 3 步，2026-10-16 真站快照） ─────────────────────────
   * 「票區價格」下拉（#ctl00_ContentPlaceHolder1_PRICE，多票區才有），再有「購買數量」表格（#…_DataGrid）。
   * 選了票區價格，ibon 會回傳重畫整頁；「下一步」是 #ctl00_ContentPlaceHolder1_AddShopingCart。 */
  const QTY = {
    price: '#ctl00_ContentPlaceHolder1_PRICE',
    grid: '#ctl00_ContentPlaceHolder1_DataGrid',
    next: '#ctl00_ContentPlaceHolder1_AddShopingCart',
    captcha: '#ctl00_ContentPlaceHolder1_CHK, input[id*="CHK"]',
  };
  const qtyPrice = () => { const s = $(QTY.price); return s && isVisible(s) ? s : null; };
  const qtySelects = () => {
    const grid = $(QTY.grid) || $('table.rwdtable');
    return grid ? deepAll('select.form-control-sm', grid).filter(isVisible) : [];
  };
  const qtyNext = () => $(QTY.next) || $('a[id*="AddShopingCart"]')
    || deepAll('a.btn.btn-primary.btn-block').find((b) => isVisible(b) && /下一步/.test(b.textContent)) || null;
  const qtyCaptcha = () => deepAll(QTY.captcha).find(isVisible) || null;

  /**
   * 點元素。href 是 javascript: 的連結（ibon 的「下一步」）在擴充功能的環境裡點會被擴充功能自己的 CSP 擋掉，
   * 所以標記起來，請 MAIN world 的 alert-hook.js 在頁面自己的環境代點（跟你手動按一樣）。
   * 它沒回應（沒載入）就不得已自己點。
   */
  function pageClick(el) {
    const href = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
    if (!/^\s*javascript:/i.test(href)) { el.click(); return; }
    const token = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    el.setAttribute('data-ith-click', token);
    window.postMessage({ __ith: 'click', token }, location.origin);
    setTimeout(() => { if (el.getAttribute('data-ith-click') === token) { el.removeAttribute('data-ith-click'); el.click(); } }, 500);
  }

  /** 在下拉裡設值並通知網頁（ASP.NET 的 onchange 會跟著動） */
  function setSelect(sel, value) {
    sel.value = String(value);
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value === String(value);
  }

  /* ───────────────────────── 填購票資訊頁（UTK0206_，第 4 步，2026-10-16 真站快照） ───────────────────────── */
  const buyerAgree = () => $$('input[type=checkbox]').find((c) => {
    const l = c.id ? $(`label[for="${CSS.escape(c.id)}"]`) : null;
    return l && /同意/.test(l.textContent);
  }) || null;
  const buyerNext = () => deepAll('a, button').find((b) => isVisible(b) && /^下一步/.test(norm(b.textContent))) || null;
  const buyerCountdown = () => {
    const t = $$('span').filter(isVisible).map((el) => norm(el.textContent)).find((x) => /^剩餘時間\s*\d{1,2}\s*[:：]\s*\d{2}$/.test(x));
    return t || null;
  };
