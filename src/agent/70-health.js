  /* ───────────────────────── 健檢 ─────────────────────────
   * 檢查活動頁還是不是助手認得的樣子。不按任何東西，也不改任何欄位。
   * 每一項：ok 正常、warn 可能有問題、fail 開賣時一定會卡、skip 現在沒辦法檢查。
   * 購票流程的各頁（票區、座位/數量、填資料）要進去才看得到，這裡檢查不了。 */
  const BUNDLE_RE = /\/(main|runtime|polyfills|vendor)[.\-][\w.\-]*\.js/i;

  function bundleNames() {
    return [...document.scripts].map((s) => s.src || '').filter((src) => BUNDLE_RE.test(src))
      .map((src) => src.split('/').pop().split('?')[0]);
  }

  function healthItems(cfg = {}) {
    const items = [];
    const add = (key, label, status, detail = '') => items.push({ key, label, status, detail });

    const bundles = bundleNames();
    add('bundle', '活動頁程式檔', bundles.length ? 'ok' : 'warn', bundles.length ? bundles.join('、') : '找不到帶雜湊的程式檔，ibon 可能改了檔名');

    const rows = sessionRows();
    add('rows', '場次表', rows.length ? 'ok' : 'fail', rows.length ? `${rows.length} 列` : '找不到場次表（#GameInfoList）。ibon 可能改版了，或這個活動還沒開放');
    if (rows.length) {
      const col = columnsOf(sessionHeader());
      const infos = rows.map((r) => readRow(r, col));
      const noDate = infos.filter((r) => !parseDateTime(r.when)).length;
      add('dates', '場次日期', noDate ? 'warn' : 'ok', noDate ? `${noDate} 列讀不到日期` : `例如「${infos[0].when}」`);
      const withBtn = infos.filter((r) => r.button).length;
      add('buttons', '購票按鈕', withBtn === infos.length ? 'ok' : withBtn ? 'warn' : 'fail', `${withBtn}/${infos.length} 列有按鈕，例如「${(infos.find((r) => r.button) || {}).button || '沒有'}」`);
      const odd = infos.filter((r) => r.button && sessionStatus(r.button, r.disabled).status === 'unknown' && !(r.disabled && /線上購票/.test(r.button)));
      add('status', '場次狀態判讀', odd.length ? 'warn' : 'ok', odd.length ? `${odd.length} 列看不出狀態，例如「${odd[0].button}」` : '都認得');
      if (cfg.sessionWhen) {
        const hit = infos.filter((r) => sessionKey(r.when) === sessionKey(cfg.sessionWhen));
        add('session', '你選的場次', hit.length === 1 ? 'ok' : 'fail', hit.length === 1 ? sessionKey(cfg.sessionWhen) : hit.length ? '有多列相同的演出時間' : `頁面上找不到「${sessionKey(cfg.sessionWhen)}」`);
      }
    }

    const sale = parseSaleTimes(sectionText('節目介紹') || blockText($('#detail') || document.body));
    add('sale', '開賣時間', sale.length ? 'ok' : 'warn', sale.length ? sale.map((s) => s.at.replace('T', ' ')).join('、') : '節目介紹裡讀不到開賣時間，要自己設定');

    const login = loginState();
    add('login', '登入狀態', login === 'logged-in' ? 'ok' : 'warn', login === 'logged-out' ? '目前沒有登入' : login === 'logged-in' ? '已登入' : '認不出登入狀態（登入後活動頁的頁首還沒核對過）');

    return { worst: worstOf(items), items, bundles };
  }

  /** 「健檢」按鈕：在背景分頁檢查活動頁，回報後由 background 關掉分頁 */
  async function runHealth(d) {
    const report = (r) => call('health-result', r, 1500);
    panel();
    setStatus('健檢中：檢查活動頁是不是助手認得的樣子…', 'ok');
    await domReady();
    if (pageKind() !== 'event') return report({ ok: false, error: '這不是活動頁，沒辦法健檢', items: [], bundles: [] });
    await waitSessions(15000);
    const h = healthItems((d && d.cfg) || {});
    setStatus(h.worst === 'ok' ? '健檢通過' : h.worst === 'warn' ? '健檢有幾項要注意' : '健檢發現問題，開賣時可能會卡住', h.worst === 'ok' ? 'ok' : h.worst === 'warn' ? 'warn' : 'err');
    return report({ ok: h.worst !== 'fail', worst: h.worst, items: h.items, bundles: h.bundles });
  }
