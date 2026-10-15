/*
 * ibon-info.js —— 活動資訊讀取程式（A 類，只讀），跑在 ISOLATED world
 *
 * 載入到 ibon 的活動頁（https://ticket.ibon.com.tw/ActivityInfo/Details/*）與購票頁（https://orders.ibon.com.tw/application/UTK02/*），
 * 只有背景程式要它讀時才讀（IbonAdapter，20-adapter.js）：活動頁讀標題、場次表、節目介紹裡的票價與開賣時間；
 * 任何一頁都可以讀頁面種類、登入狀態、狀態提示，或在你按了之後記錄結構快照。整理後交給背景程式，顯示在設定頁。
 *
 * 這支程式不點任何按鈕、不填任何欄位、不送出任何東西，也不發任何網路請求；購票按鈕只讀上面的字和能不能按。
 * 自動選購的程式（agent.js）不會載入到 ibon 的頁面。
 */
(() => {
  'use strict';

  if (window.__ITH_INFO__) return;
  window.__ITH_INFO__ = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/[\s　]+/g, ' ').trim();
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  }

  /** 元素裡的文字，保留換行：段落、清單、<br> 換成換行（收合起來看不到的區塊也讀得到） */
  const BLOCK = new Set(['P', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'HR']);
  function blockText(root) {
    const out = [];
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) { out.push(n.nodeValue); return; }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      if (tag === 'BR') { out.push('\n'); return; }
      const block = BLOCK.has(tag);
      if (block) out.push('\n');
      for (const c of n.childNodes) walk(c);
      if (block) out.push('\n');
    };
    if (root) walk(root);
    return out.join('').split('\n').map((l) => l.replace(/[ \t　]+/g, ' ').trim()).filter(Boolean).join('\n');
  }

