# ibon Ticket Helper

**English** | [繁體中文](README.zh-TW.md)

A Chrome extension (Manifest V3) for the ibon ticketing site (ticket.ibon.com.tw). It opens the event page on time, syncs its clock with ibon's servers, picks the session, the ticket area and the number of tickets by your keywords, ticks the terms box and clicks Next. CAPTCHAs, queues and payment are always left to you; it never touches the final confirmation or payment.

It follows the same design as my KKTIX booking helper (not public): the same scheduling, countdown, retries, health check, black box and log. What is specific to ibon is reading the event page and choosing a session first, since one ibon event page can list several sessions.

## 1. Install

1. Open `chrome://extensions` and switch on Developer mode (top right).
2. Click "Load unpacked" and pick this folder. Disable any older version of this helper first; a KKTIX helper does not conflict.
3. After changing the code, click this extension's reload button in `chrome://extensions`. Scheduled tasks are picked up again (see 4.3).

## 2. Use

1. Paste the event URL (`https://ticket.ibon.com.tw/ActivityInfo/Details/<number>`).
2. Click "Read event". A background tab reads the sessions, sale time and prices, then closes. The session list is filled in. Only a sale time that is **still ahead** is filled in (when you switch sessions and that session has its own sale time, that one is used; the page shows Taiwan time, which is converted to this computer's time zone).
3. Pick a session.
4. Enter ticket area keywords: one set per line, higher lines first; words on one line separated by spaces must all appear. Suggestions appear under the box, click one to add it:
   - areas of this event the helper saw on the purchase pages last time (it records them on the area page and the seat/quantity page)
   - price names from the event description
   - names containing an excluded word are marked "excluded" and cannot be added
   For a first purchase, when nothing has been recorded yet, you can turn on "If no keyword matches, pick the first area still on sale" under Advanced.
5. Set the number of tickets (1 to 4; ibon allows at most 4 per order).
6. Log in to ibon.
7. Click "Schedule". 90 seconds before the sale the helper opens the event page and counts down. At sale time it reloads; once the session's "Buy online" button can be clicked it clicks it, then picks the area and quantity, ticks the terms box and clicks Next.
8. On a CAPTCHA, a verification question it cannot answer, no matching area, real-name registration and so on, the helper stops and tells you. Once you have dealt with it and reached the next page, it carries on.
9. Reaching the buyer information page means your seats are held. The helper tells you ("seats held", with the time left that ibon shows), ticks the terms box and clicks Next.
10. On the order confirmation page the helper stops. Confirming the order and paying are up to you.

"Run now": looks for the session on the event page right away and, if it can be bought, starts the purchase without waiting for the sale time.

### Advanced settings

| Setting | Default | What it does |
|---|---|---|
| Open the page early (s) | 90 | How many seconds before the sale the page is opened |
| Sync the clock with ibon | on | Catches the moment the server's Date header ticks to the next second; about 20 ms error |
| Reload every (ms) before the sale opens | 1000 | Reload interval when "Buy online" still cannot be clicked after sale time |
| Reload at most | 30 | Then it is handed to you |
| Exclude these words | 輪椅, 身障, 身心, 障礙, 愛心, Restricted View, 燈柱遮蔽, 視線不完整 | Areas whose names contain these are never picked |
| Pick the first area if no keyword matches | off | Excluded areas are still never picked |
| Retries after the site refuses | 3 | When the site answers Next with an alert (sold out, for example) |
| Tick the terms box | on | Off: the buyer information page waits for you |
| Accept non-adjacent seats | off | Ticks "accept non-adjacent seats" on the seat/quantity page when it is there (selector from tickets_hunter) |
| Member code / presale code | empty | One per line. On a verification question page they are filled in question order; "last N digits / first N digits" in the question is cut automatically. Stored in the settings, hidden in exported logs |
| First digits of the card number | empty | Filled in on the cardholder presale page (`/Vaildate/…`); if empty, the first member code is used. Hidden in exported logs |

**Keyword matching (since 0.9.8)**
- Case does not matter.
- Thousands separators in prices are ignored: `6980` matches ibon's `6,980` and the other way round, full-width commas included.
- Words on one line separated by spaces must all appear in the area name. `VIP 6980` matches "VIP 6,980 熱賣中" but not "A 6,380".
- One set per line, higher lines first.

## 3. What it does and does not do

Based on two written replies from the ibon ticketing customer service center (2026-10-16):

- **Allowed**: reading event information automatically, choosing the session, the area and the quantity, clicking Next, ticking the terms box, reloading (no fixed limit, but unusually frequent requests are handled by the site's protection, such as an IP block; it should follow normal human behaviour). For personal purchases only.
- **Not allowed**: payment must be made by the buyer in person; verification, queues, purchase limits and other safety measures must not be bypassed; resale, buying on behalf of others and selling across entities are not allowed. One account on one device is recommended.

What the helper does:

| Stage | Action |
|---|---|
| Before the sale | Opens the event page, syncs the clock, checks your session, counts down |
| Event page | Reloads at sale time; clicks your session's "Buy online" once it can be clicked; otherwise retries as not yet on sale |
| Verification question (UTK0201_0, URL with rn=) | Answers with your member codes: one question, cut by "last N / first N digits"; several, in order. With no code set, or too few, it stops and hands over to you |
| Cardholder presale page (`ticket.ibon.com.tw/Vaildate/…`) | Fills in the first digits of the card number, or the first member code if none is set |
| Area page (UTK0201_000) | Picks the area by keywords and excluded words; skips rows that cannot be bought (class disabled), areas with too few seats left, legend rows and areas already sold out in this attempt; if the purchase method offers "computer-assigned seats" it picks that first; clicks the centre of the row, as tickets_hunter does; if the quantity appears on this page it is handled like the seat/quantity page |
| Seat/quantity page (UTK0202_) | Picks the area price (only when there are several), the quantity and, if switched on, non-adjacent seats; waits for ibon's background update to finish before clicking Next; stops on a CAPTCHA. If the area is sold out (only 0 to choose, or ibon says so after Next) it notes that and picks another area on the same page, or goes back to the area page to pick another one (within the retry allowance) |
| Buyer information page (UTK0206_) | The seats are held: tells you, ticks the terms box, clicks Next. Phone and email come from your ibon member data and are left alone; real-name details are left to you; if the site blocks Next it does not reload (so the seats are not lost) and hands over to you |
| Order confirmation page (UTK0207_) | Only shows "seats held" and clicks nothing (payment comes next) |

If the task tab is sent back to the ibon home page, the helper takes it back to the event page (as the KKTIX helper does).

What it **does not** do: CAPTCHAs, verification it cannot answer, queues, traffic control or bot checks (when it sees those words it leaves the whole page alone and tells you); the "verifying you are human" check page (it waits for it to pass and does not reload meanwhile); the final confirmation; payment.

## 4. Why it is built this way

### 4.1 An ISOLATED-world page script, plus an alert hook in the MAIN world

The session table on ibon's event page lives in a closed Shadow DOM, which only `chrome.dom.openOrClosedShadowRoot` (an extension API) can read. So the page script (`page-agent.js`) runs in the ISOLATED world, where it can use `chrome.runtime` directly and needs no bridge.

`alert-hook.js` runs in the MAIN world (the page's own context) and does two things:

1. ibon reports results such as "sold out" with `alert()`, which the ISOLATED world cannot catch. The hook records the text of alerts and confirms and passes it on with postMessage. Normally dialogs show as usual; only for the few seconds while the page script waits for the result of a click does it take over: the alert is not shown (it would freeze the page until you click OK) and its text goes to the panel; a confirm containing "cancel, do not keep, give up, delete, clear" (in Chinese) is answered No, anything else Yes.
2. It clicks links whose `href` is `javascript:`. ibon's Next is `javascript:__doPostBack(...)`, and clicking it from the extension's context is blocked by the extension's own CSP (see 4.7). The page script marks the element with a one-time tag and the hook clicks it in the page's context, just like a manual click.

### 4.2 Two-stage scheduling, clock sync and a safety net

`chrome.alarms` is not precise enough to hit the sale time, so it only opens the event page early (90 seconds by default) in its own window; the countdown in the page handles the moment itself.

- Clock sync: the HTTP Date header has only one-second resolution, so the helper catches the moment the server's second ticks over, in two stages (a probe every 140 ms, then probes every 20 ms around the predicted tick). It requests `/assets/favicon.ico` (a static file, so the time is the CDN's). Chrome slows timers in background tabs; a measurement taken that way is not used.
- Safety net: 25 seconds before the sale the background script wakes itself up; 0.1 s after the sale it checks that the page has reloaded and reloads it itself if not.
- It reloads 30 ms after the sale time (`fireOffsetMs`) to absorb uneven network delay.

### 4.3 Reloading the extension

Reloading an extension clears its alarms, and the old page script on an open event page loses its connection to the background script. On start (`restoreAlarms`) the background script sets the pending schedules again and reloads the event page so the new version takes over; a task whose sale time has passed is cancelled.

### 4.4 Task states

`armed` scheduled, waiting for the sale; `fired` sale time reached; `running` (run now); `waiting-user` your turn (CAPTCHA, no matching area…); `done` finished; `cancelled`.

After `waiting-user`, once you have dealt with it and the next page reports in, the task goes back to `running` and the helper carries on. If "Buy online" opens a new tab, the task moves to it (by `openerTabId`).

### 4.5 Where the page structure comes from

| Page | Source | Checked |
|---|---|---|
| Event page session table (`#GameInfoList .tr`, closed Shadow DOM) | The live site, 2026-10-15 (event 39972) and 2026-10-16 (event 39998) | Yes |
| Verification question (UTK0201_0.aspx?rn=) | Selectors and cutting rules from tickets_hunter `nodriver_ibon_verification_question` | Question `#content div.form-group span`, field `#content div.form-group input`, submit `#content a.btn`; "last N / first N digits". Not seen on the live site |
| Cardholder presale page (`/Vaildate/…`) | Selectors from tickets_hunter `nodriver_ibon_card_vaildate` | Field `#content input[type=text]`, submit `#content a.btn`; the value is set with the native setter so Angular's ngModel sees it. Not seen on the live site |
| Area page (UTK0201_000) | A screenshot (2026-10-16) and tickets_hunter's `ibon.py` | The table is in a closed Shadow DOM, 4 cells per row (colour, area, price, seats left), header in THEAD, rows that cannot be bought have class disabled, "seat taken", "seat sold" and "stage" are legend rows, the whole row is clicked. Clicking the row reached the next page in a 0.9.2 test. Not checked against a structure snapshot |
| Seat/quantity page (UTK0202_) | Live-site structure snapshot, 2026-10-16 | Yes: `#ctl00_ContentPlaceHolder1_PRICE`, `select.form-control-sm` in `#…_DataGrid`, `#…_AddShopingCart` |
| Buyer information page (UTK0206_) | Live-site structure snapshot, 2026-10-16 | Yes: `#agreen` and the Next link; reached in a 0.9.2 test |
| Order confirmation page (UTK0207_) | URL from tickets_hunter (which also leaves this step alone; payment comes next) | Reached in a 2026-10-16 test; recognised by URL only |

If the helper does nothing on some page, look at the black box in the exported log (the page's text and buttons) and add what is missing. Reading ibon's purchase pages from a script is blocked (HTTP 403 with "verifying you are human"), so their structure can only be seen in your own Chrome.

### 4.6 Code layout

```
manifest.json
background.js          task state, scheduling, retry allowance, notifications, watching the task tab
page-agent.js          ISOLATED-world page script (built by tools/build.mjs from src/agent/ and lib/; do not edit)
alert-hook.js          MAIN world: passes the site's alerts on
popup.html/css/js      the popup
lib/urls.js            URLs and page kinds
lib/areas.js           matching sessions and areas (keywords, excluded words, fallback)
lib/eventinfo.js       event page information (session state, prices, sale time, limits)
lib/{format,backoff,clock,health,box}.js
src/agent/             00-core basics and messages, 05-dom finding elements (closed Shadow DOM too),
                       10-ibon reading the event page and shared actions, 25-panel the on-page panel,
                       30-clock clock sync, 60-flow shared flow tools and dispatch,
                       one file per page: 61-countdown, 62-event, 63-verify, 64-area, 65-qty, 66-buyer,
                       67-check (read event), 68-validate; 70-health, 75-blackbox, 90-boot
tools/build.mjs        builds page-agent.js
tools/deploy.py        copies the extension to your machines
test/                  unit, background script and page script tests
```

### 4.7 Pitfalls found on the live site (2026-10-16)

| What happened | Why | Fix |
|---|---|---|
| The event page reloaded about every 7 s during the countdown (0.9.0) | The event page is a single-page app whose load state changes once more without the helper reporting in again; the tab watcher took it for a Chrome connection error page | Ask the helper on the page whether it is still there (`ping`) before reloading (0.9.1) |
| Spinning forever after Next (0.9.1) | Next is a `javascript:` link, blocked by the extension's own CSP when clicked from the extension's context; and only 4 ms passed between choosing the quantity and clicking Next, before ibon's background update finished | `javascript:` links are clicked by alert-hook.js in the page context; after choosing the quantity it waits for the page to settle, and chooses again if the quantity was reset (0.9.2: at least 0.8 s; 0.9.5: watches network requests, see 4.8) |
| Reading purchase pages from a script returns 403 | ibon blocks non-browser requests with a "verifying you are human" page | Not bypassed. When the page script sees that text it waits for the check to pass and does not reload (0.9.3) |
| Clicking an area did nothing for 30 s (0.9.5, a concert) | This event offered "choose seats / computer-assigned"; the helper called `click()` on the `<tr>`, which misses a handler attached to an element inside the row (tickets_hunter clicks the row's centre); or the default was choosing seats and a seat map appeared. The black box kept only the first 800 characters without the Shadow DOM, so it could not tell which | Click the innermost element at the row's centre; pick "computer-assigned" first when offered; the black box keeps 2000 characters including the Shadow DOM, plus the purchase method and the shape of the area rows (0.9.6) |
| Still nothing for 30 s after clicking an area (0.9.6, a festival with computer-assigned seats only) | The 0.9.6 black box showed the rows are `<tr id="area code">` **without onclick**; ibon's script attaches the handler later, and the helper clicked 0.43 s after load. The helper loads at document_start, so on DOMContentLoaded it runs before ibon's own setup and clicked before the handler existed | Wait until the number of rows has been stable for 0.15 s and at least 0.1 s after DOMContentLoaded (tickets_hunter also waits for two equal row counts); if nothing changes and no request goes out within 1.2 s, click again another way, at most 3 times, and never again once a request went out (0.9.7) |

### 4.8 Speed (0.9.5)

ibon's older purchase flow loads a full page for each step (ASP.NET WebForms) and takes three page changes before the seats are held (event page, area page, seat/quantity page, buyer information page); KKTIX uses a single-page app and assigns seats with one Next. Most of the time on ibon goes to waiting for its pages, which a tool cannot change. The waits the helper adds itself were shortened in 0.9.5:

| How | Detail |
|---|---|
| Watch network requests to tell when ibon's background update is done | alert-hook.js counts the page's own pending XHR and fetch calls (calls pending for more than 5 s are ignored, usually long-lived connections); once all are back and the page has not changed for 0.15 s it clicks, waiting at least 0.25 s so the page has time to send its requests. Up to 0.9.4 it waited at least 0.8 s |
| React as soon as the page changes | Waiting for an element uses a MutationObserver plus a look every 50 ms (changes inside a closed Shadow DOM are not observed). Up to 0.9.4: every 300 ms |
| Connect early | 3 s before the sale, and when the event page loads after it, adds `<link rel="preconnect" href="https://orders.ibon.com.tw">`, saving DNS, TCP and TLS on the jump to the purchase pages |
| Stop when the page starts leaving | After picking the area price, 0.9.4 always waited 4 s; now it watches `beforeunload`: if the whole page is replaced it stops and the new page takes over, otherwise it waits for the background update and goes on, so it never acts on a page that is being left |

Measured on local fake pages (no network delay), median of 5 runs:

| Page | 0.9.4 | 0.9.5 |
|---|---|---|
| Event page: load to clicking "Buy online" | 1240 ms | 1042 ms |
| Area page: table appears to click | 225 ms | 8 ms |
| Seat/quantity page: load to clicking Next | 843 ms | 291 ms |
| Buyer information page: load to clicking Next | 797 ms | 247 ms |

Every click in the log says "N ms after this page loaded", so the exported log shows how long each step took on the live site.

Limit: if ibon's background update were a pure front-end timer longer than 0.25 s instead of a network request, this would miss it (0.9.4's fixed 0.8 s would not). ibon appears to update from its server; not yet verified on the live site.

## 5. Known limits

- The area page (UTK0201_000) was checked only against a screenshot and tickets_hunter, not a structure snapshot (see 4.5); the verification question page, the cardholder page and the confirmation page are recognised by URL only.
- On the buyer information page it only ticks the terms box and clicks Next; phone and email come from your ibon member data, and if they are missing the helper does not fill them in (it stops there and tells you when it cannot find Next).
- CAPTCHAs: it only notices one; it never reads, fills in or bypasses it.
- The quantity page: only the first "quantity" dropdown is set (one ticket type). With several ticket type rows only the first is set.
- It does not pick seats on a seat map. When the purchase method can be chosen it picks computer-assigned seats; for events where you must choose seats yourself, it hands over after clicking the area.
- Only the older purchase flow (`orders.ibon.com.tw/application/UTK02/…`) is supported. ibon also has a newer one (`ticket.ibon.com.tw/Event/…`, `/EventBuy/…`, supported by tickets_hunter); on events using it the helper does nothing.
- Keyword suggestions include area names only after the helper has been on this event's purchase pages; the event page itself rarely lists the areas.
- The final confirmation and payment are always yours.

## 6. Tests

```
npm test           # or: node tools/build.mjs --check && node --test 'test/unit/*.test.mjs' test/background.test.mjs test/agent.test.mjs
```

- `test/unit/`: URL parsing, session and area matching, event information, retry intervals, clock sync maths, health summary, black box.
- `test/background.test.mjs`: fakes `chrome.*` and walks through schedule, countdown, sale, area, seat/quantity (CAPTCHA handed to you), buyer information and confirmation, checking states, retry allowance, tab binding and the message allowlist.
- `test/agent.test.mjs`: opens Chromium with Playwright on the pages in `test/fixtures/` and fake pages in the tests (built after live-site snapshots), with the background script faked. Needs Playwright: set `PLAYWRIGHT_PATH`, or it looks for `../ticket-sim/tools/node_modules/playwright`; without it these tests are skipped.

## 7. Deploying and versions

```
python3 tools/deploy.py            # copy to every machine in tools/targets.local.json
python3 tools/deploy.py --check    # only compare each machine with this folder
```

`tools/targets.example.json` is the template. Before writing, the target folder is copied whole to `<folder>.bak-<old version>`; afterwards every file is checked by SHA-256. Reload the extension in `chrome://extensions` after deploying.

Version: `version` in `manifest.json`. 0.9.0 moved to the KKTIX helper's structure; 0.8.x was an older content-script version (only in the git history).

## 8. Compared with tickets_hunter

Based on tickets_hunter's `src/platforms/ibon.py` and `src/nodriver_tixcraft.py` (the version of 2026-10-16).

| | tickets_hunter | This helper |
|---|---|---|
| Form | A Python program driving the browser over CDP with zendriver (nodriver) | A Chrome extension in the Chrome you are logged in to |
| Login | Logs in again with the cookie from its settings | Uses your logged-in Chrome; hands over when asked to log in |
| Timing | Local clock (`refresh_datetime`) | Clock synced with ibon's servers, page opened 90 s early, background safety net |
| Sent back to the home page | Goes back to the target page | Goes back to the event page |
| Areas | Fetches seats left from the CDN and jumps straight to the quantity page (live.map fast path), clicks through the pages if that fails | Clicks through the pages |
| Area sold out | Goes back to the area page for another | Picks another area on the same page if there is one, otherwise goes back to the area page |
| Non-adjacent seats | Option | Option |
| Site alerts | Caught over CDP | Taken over for the seconds it waits for a result, shown as usual otherwise |
| CAPTCHA | Read with ddddocr and submitted | Stops and hands over to you (ibon: verification must not be bypassed) |
| Verification questions, cardholder check | Answered from a dictionary in its settings, card digits filled in (`nodriver_ibon_verification_question`, `nodriver_ibon_card_vaildate`) | Since 0.9.8: member codes filled in on the question page ("last N / first N digits" cut), card digits on the cardholder page. Confirmed as allowed with ibon customer service |
| Newer purchase pages (`ticket.ibon.com.tw/Event/…`, `/EventBuy/…`) | Supported | Not supported |
| Page structure | Maintained for ibon over a long time | Seat/quantity and buyer information pages checked against live-site snapshots; area page after tickets_hunter and a screenshot, worked in a 0.9.2 test |

## 9. License

MIT, see [LICENSE](LICENSE). Use it within ibon's terms of service and the law; it is meant for buying your own tickets, not for resale or buying on behalf of others.
