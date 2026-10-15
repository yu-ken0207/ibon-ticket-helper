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

