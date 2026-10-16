import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityUrl, eventSlug, pageKindOf, offTrackKind, isIbonHost } from '../../lib/urls.js';

test('活動網址：只收 ibon 的活動頁，整理成標準寫法', () => {
  assert.equal(activityUrl(' https://ticket.ibon.com.tw/ActivityInfo/Details/39998/?a=1 '), 'https://ticket.ibon.com.tw/ActivityInfo/Details/39998');
  assert.equal(activityUrl('http://ticket.ibon.com.tw/ActivityInfo/Details/39998'), null);
  assert.equal(activityUrl('https://ticket.ibon.com.tw.evil.com/ActivityInfo/Details/1'), null);
  assert.equal(activityUrl('https://kktix.com/events/x'), null);
  assert.equal(activityUrl(''), null);
  assert.equal(eventSlug('https://ticket.ibon.com.tw/ActivityInfo/Details/39998'), '39998');
  assert.equal(eventSlug('https://orders.ibon.com.tw/application/UTK02/UTK0206_.aspx'), null);
});

test('頁面種類：活動頁與購票流程各步驟（2026-10-16 真站網址）', () => {
  const k = (u) => pageKindOf(u);
  assert.equal(k('https://ticket.ibon.com.tw/ActivityInfo/Details/39998'), 'event');
  assert.equal(k('https://ticket.ibon.com.tw/ActivityInfo/GoTicketURL?x=1'), 'transit');
  assert.equal(k('https://orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=B0CHAEY8&PRODUCT_ID=B0CGLXWS'), 'area');
  assert.equal(k('https://orders.ibon.com.tw/application/UTK02/UTK0202_.aspx?PERFORMANCE_ID=1&GROUP_ID=2&PERFORMANCE_PRICE_AREA_ID=3'), 'qty');
  assert.equal(k('https://orders.ibon.com.tw/application/UTK02/UTK0201_001.aspx?PERFORMANCE_ID=1'), 'qty');
  assert.equal(k('https://orders.ibon.com.tw/application/UTK02/UTK0206_.aspx'), 'buyer');
  assert.equal(k('https://orders.ibon.com.tw/application/UTK02/UTK0207_.aspx'), 'confirm');
  assert.equal(k('https://orders.ibon.com.tw/application/UTK02/UTK0299_.aspx'), 'orders');
  assert.equal(k('https://example.com/ActivityInfo/Details/1'), 'other');
  assert.equal(k('http://ticket.ibon.com.tw/ActivityInfo/Details/1'), 'other');
});

test('不會自己恢復的頁面：登入頁、錯誤頁', () => {
  assert.equal(offTrackKind('https://huiwan.ibon.com.tw/Huiwan/LoginHuiwan/UserLogin.aspx?taxid=1'), 'sign-in');
  assert.equal(offTrackKind('https://ticket.ibon.com.tw/error'), 'error-page');
  assert.equal(offTrackKind('https://ticket.ibon.com.tw/ActivityInfo/Details/1'), null);
  assert.equal(offTrackKind('https://example.com/error'), null);
  assert.equal(isIbonHost('https://orders.ibon.com.tw/x'), true);
  assert.equal(isIbonHost('https://ibon.com.tw.evil.com/x'), false);
});
