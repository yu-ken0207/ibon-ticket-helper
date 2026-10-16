  /* ───────────────────────── 畫面面板 ───────────────────────── */

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
    hd.append(mk('span', '', 'ibon 訂票助手'), btn);
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

