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
