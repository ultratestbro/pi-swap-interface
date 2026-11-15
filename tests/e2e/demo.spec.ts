/**
 * Demo mode end to end (D15), at the phone, tablet and desktop widths: the swap screen streams routes, refused venues
 * read by section with their disclosure, the token sheet, review sheet, deposit panel and activity drawer open, the
 * review and the swap's status fit without scrolling (D34),
 * Settings' Custom network picker works by pointer and keyboard, the phone's "N more" route sheet works, the header's wallets open one dropdown (D33), and preview prices before a wallet are never reviewable and paced (D7, D29). Every test also proves the page threw nothing, logged no console error, never
 * scrolled sideways and — demo being offline — made no request outside its own origin (so certainly none to a cp0x
 * domain, D24). Screenshots land in docs/screens/<width>-<state>.png.
 */
import {expect, test as base, type Page} from "@playwright/test";
import {expectNoHorizontalScroll, isCp0xHost, isPhone, shot, watchPage, type PageWatch} from "./helpers";

const test = base.extend<{watch: PageWatch}>({
  watch: [
    async ({page, baseURL}, use) => {
      const watch = watchPage(page);
      await use(watch);
      const origin = new URL(baseURL!).origin;
      expect(watch.errors, "page errors / console errors").toEqual([]);
      expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
      expect(
        watch.requests.filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:")),
        "demo mode must stay offline",
      ).toEqual([]);
    },
    {auto: true},
  ],
});

/** Every demo venue has answered (no "Quoting…" row), so screenshots show a settled list. */
async function routesSettled(page: Page): Promise<void> {
  await expect(page.getByRole("radio").first()).toBeVisible();
  await expect(page.locator('[data-testid^="swap-route-pending-"]')).toHaveCount(0, {timeout: 15_000});
}

test("swap screen streams routes", async ({page}, info) => {
  await page.goto("./#/?demo=1");
  await expect(page.getByTestId("swap-amount")).toBeVisible();
  await routesSettled(page);
  await expect(page.getByTestId("swap-review")).toBeEnabled();
  await expect(page.getByText("Demo", {exact: true})).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, info, "swap");

  if (isPhone(info)) {
    // Phones show the best route plus "N more", which opens the full list in a bottom sheet — with the coverage line.
    await page.getByTestId("swap-more-routes").click();
    const sheet = page.getByTestId("swap-route-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("radio").first()).toBeVisible();
    await expect(sheet.locator('[data-testid^="swap-route-pending-"]')).toHaveCount(0, {timeout: 15_000});
    await expect(sheet.getByTestId("swap-coverage")).toHaveText(/venues serve this pair$/);
    await expectNoHorizontalScroll(page);
    await shot(page, info, "routes-sheet");
  }
});

test("refused routes read plainly, by section, with the technical reason one tap away", async ({page}, info) => {
  await page.goto("./#/demo/refused?demo=1");
  await routesSettled(page);
  let list = page.getByTestId("swap-routes");
  if (isPhone(info)) {
    // The compact list shows the chosen route; the refusals live in the full list's sheet.
    await page.getByTestId("swap-more-routes").click();
    list = page.getByTestId("swap-route-sheet");
    await expect(list).toBeVisible();
  }
  const safety = list.getByRole("list", {name: "Skipped for your safety"});
  await expect(safety).toBeVisible({timeout: 15_000});
  await expect(list.getByRole("list", {name: "Needs a different amount"})).toContainText("Minimum 0.01 ETH");
  const lifi = safety.getByTestId("swap-route-refused-lifi");
  await expect(lifi).toContainText("Can't confirm it pays you");
  await lifi.locator("summary").first().click();
  await expect(lifi.getByText(/could pay an address we couldn't confirm is yours/)).toBeVisible();
  await lifi.getByText("Technical reason").click();
  await expect(lifi.getByTestId("swap-refused-raw")).toContainText("does not match the quote");
  await expect(lifi.getByRole("button", {name: "Copy technical reason"})).toBeVisible();
  await list.getByTestId("swap-uncovered-toggle").click();
  await expect(list.getByRole("list", {name: "Not for this pair"})).toContainText("Same-network swaps only");
  await lifi.scrollIntoViewIfNeeded();
  await expectNoHorizontalScroll(page);
  await shot(page, info, "refused");
});

test("before a wallet: preview prices, the connect CTA, never the review, and a paced refresh", async ({page}, info) => {
  await page.goto("./#/demo/preview?demo=1");
  await routesSettled(page);
  await expect(page.getByRole("radio").first()).toContainText("Preview");
  const cta = page.getByTestId("swap-review");
  await expect(cta).toHaveText("Connect EVM wallet to swap");
  await expect(cta).toHaveAttribute("data-state", "connect");
  if (!isPhone(info)) {
    // LI.FI waits for the live quote (demo has no cp0x proxy to ask it through): a quiet group of its own, never
    // "Didn't quote" or "Needs a change on your side".
    await expect(page.getByTestId("swap-deferred-toggle")).toHaveText("Quoted after you connect (1)");
    await expect(page.getByTestId("swap-refused-toggle")).toHaveCount(0);
  }
  await expectNoHorizontalScroll(page);
  await shot(page, info, "preview");

  // Enter on a preview route presses the CTA: the wallets open, never the review.
  if (!isPhone(info)) {
    await page.getByRole("radio").first().focus();
    await page.keyboard.press("Enter");
  } else {
    await cta.click();
  }
  await expect(page.getByTestId("swap-connect")).toBeVisible();
  await expect(page.getByTestId("swap-review-sheet")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("swap-connect")).toBeHidden();

  // The scene's first round spent one of the tab's five preview rounds; four refreshes later refresh waits.
  const refresh = page.getByTestId("swap-refresh");
  for (let i = 0; i < 4; i++) {
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(page.getByRole("status", {name: "Refreshing routes"})).toBeVisible();
    await expect(refresh).toBeVisible();
  }
  await expect(refresh).toBeDisabled();
  await expect(page.getByTestId("swap-refresh-wait")).toHaveText(/^\d+ s$/);
  await expect(page.getByTestId("swap-review-sheet")).toHaveCount(0);
});

/** One frame of the swap screen's layout: where the blocks a re-quote must not move are, and what the CTA says. */
interface LayoutFrame {
  scrollY: number;
  panel: {y: number; h: number};
  summary: {y: number; h: number} | null;
  cta: {y: number; text: string};
}

/** Record the layout every animation frame until stopLayout(); positions are page coordinates. */
async function sampleLayout(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {__frames: LayoutFrame[]; __stop: boolean};
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {y: r.y + window.scrollY, h: r.height};
    };
    w.__frames = [];
    w.__stop = false;
    const tick = () => {
      const cta = document.querySelector('[data-testid="swap-review"]')!;
      w.__frames.push({
        scrollY: window.scrollY,
        panel: box(document.querySelector('[data-testid="swap-routes"]'))!,
        summary: box(document.querySelector('[data-testid="swap-form"] dl')),
        cta: {y: box(cta)!.y, text: cta.textContent ?? ""},
      });
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopLayout(page: Page): Promise<LayoutFrame[]> {
  return page.evaluate(() => {
    const w = window as unknown as {__frames: LayoutFrame[]; __stop: boolean};
    w.__stop = true;
    return w.__frames;
  });
}

const spread = (values: readonly number[]) => Math.max(...values) - Math.min(...values);

test("a new slippage re-quotes in place: the route list, the summary and the CTA keep their size and place (D32)", async ({page}, info) => {
  await page.goto("./#/?demo=1");
  await routesSettled(page);
  const status = page.getByTestId("swap-routes-status");
  await expect(status).toHaveText(/^2 routes · updated/, {timeout: 15_000});
  const minBefore = await page.getByTestId("swap-min-received").textContent();
  await page.getByTestId("swap-slippage").click();
  const sheet = page.getByRole("dialog", {name: "Max slippage"});
  await expect(sheet).toBeVisible();
  // Scrolled to the bottom, as a phone user picking the slippage is: a page that got shorter would pull the scroll up
  // with it, which the scroll check below must be able to see (at the top, nothing can clamp it).
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  if (info.project.name === "phone") expect(await page.evaluate(() => window.scrollY), "the phone page scrolled").toBeGreaterThan(0);

  await sampleLayout(page);
  // 1 % is typed: the presets are 0.01 %, 0.05 % and 0.3 %.
  await sheet.getByLabel("Custom").fill("1");
  await sheet.getByLabel("Custom").press("Enter");
  await expect(sheet).toBeHidden();
  // The new round is in: every venue answered for 1 %, and the summary holds the new minimum.
  await expect(status).toHaveText(/^2 routes · updated/, {timeout: 15_000});
  await expect(page.getByTestId("swap-review")).toHaveText("Review via Uniswap");
  await expect(page.getByTestId("swap-min-received")).not.toHaveText(minBefore!);
  const frames = await stopLayout(page);

  expect(frames.length, "frames sampled").toBeGreaterThan(10);
  expect(frames.every((f) => f.summary !== null), "the summary stayed").toBe(true);
  expect(spread(frames.map((f) => f.panel.h)), "route list height").toBeLessThanOrEqual(2);
  expect(spread(frames.map((f) => f.panel.y)), "route list position").toBeLessThanOrEqual(2);
  expect(spread(frames.map((f) => f.summary!.y)), "summary position").toBeLessThanOrEqual(2);
  expect(spread(frames.map((f) => f.summary!.h)), "summary height").toBeLessThanOrEqual(2);
  expect(spread(frames.map((f) => f.cta.y)), "CTA position").toBeLessThanOrEqual(2);
  expect(spread(frames.map((f) => f.scrollY)), "the page never scrolled by itself").toBe(0);
  // Between the two quotes the CTA waited: a number quoted for 0.5 % is never reviewable at 1 %.
  expect(frames.some((f) => f.cta.text === "Updating quote…"), "the CTA said it was updating").toBe(true);
});

test("token sheet opens and searches", async ({page}, info) => {
  await page.goto("./#/?demo=1");
  await routesSettled(page);
  await page.getByTestId("swap-pay-token").click();
  const sheet = page.getByTestId("swap-token-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-testid^="swap-token-"][data-testid*=":"]').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, info, "tokens");

  await page.getByTestId("swap-token-search").fill("usdc");
  await expect(sheet.getByTestId("swap-token-arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

/** The sheet's last button is fully on screen and its body doesn't scroll: the whole sheet is read without scrolling (D34). */
async function expectFits(page: Page, sheetId: string, lastId: string): Promise<void> {
  const sheet = page.getByTestId(sheetId);
  await expect(sheet.getByTestId(lastId)).toBeInViewport({ratio: 1});
  const body = await sheet.evaluate((el) => {
    const b = el.lastElementChild!;
    return {scroll: b.scrollHeight, client: b.clientHeight};
  });
  expect(body.scroll, `${sheetId} scrolls`).toBeLessThanOrEqual(body.client + 1);
}

/** The review with Confirm on screen. */
const expectReviewFits = (page: Page) => expectFits(page, "swap-review-sheet", "swap-confirm");

test("review sheet opens with the guaranteed minimum and fits without scrolling", async ({page}, info) => {
  await page.goto("./#/?demo=1");
  await routesSettled(page);
  await page.getByTestId("swap-review").click();
  const sheet = page.getByTestId("swap-review-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Minimum received")).toBeVisible();
  await expect(page.getByTestId("swap-confirm")).toBeVisible();
  // The common case — the own address, no approval, no warning — with Confirm on screen (1280×800 on desktop).
  await expect(sheet.getByTestId("swap-review-approval")).toHaveText("Not needed");
  await expect(sheet.getByTestId("swap-review-other")).toHaveCount(0);
  await expectReviewFits(page);
  await expectNoHorizontalScroll(page);
  await shot(page, info, "review");
});

test("the heavier review — an approval and another recipient — still fits at 1280×900, Confirm in view once confirmed", async ({page}, info) => {
  test.skip(info.project.name !== "desktop", "one desktop height");
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto("./#/demo/review?demo=1");
  const sheet = page.getByTestId("swap-review-sheet");
  await expect(sheet.getByTestId("swap-review-approval")).toHaveText(/^Exact /, {timeout: 15_000});
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.getByTestId("swap-recipient-toggle").click();
  await page.getByTestId("swap-recipient").fill("0x8ba1f109551bD432803012645Ac136ddd64DBA72");
  await routesSettled(page);
  await expect(page.getByTestId("swap-review")).toHaveText(/^Review via /, {timeout: 15_000});
  await page.getByTestId("swap-review").click();
  await expect(sheet.getByTestId("swap-review-other")).toContainText("0x8ba1f109551bD432803012645Ac136ddd64DBA72");
  await expect(sheet.getByTestId("swap-review-approval")).toHaveText(/^Exact /);
  await expectReviewFits(page);
  // Confirmed: the steps take the fine print's place and the review outgrows the sheet — Confirm and the wallet hint
  // are what the user watches while the wallet asks, so the sheet scrolls them back into view.
  await page.getByTestId("swap-confirm").click();
  await expect(sheet.getByTestId("swap-step-approve-active")).toBeVisible();
  await expect(page.getByTestId("swap-confirm")).toBeInViewport({ratio: 1});
  await expect(page.getByTestId("swap-review-body").getByRole("status")).toBeInViewport({ratio: 1});
});

test("after Confirm the review stays, locked, until the swap is broadcast; then it is the swap's status", async ({page}) => {
  await page.goto("./#/demo/executing?demo=1");
  const body = page.getByTestId("swap-review-body");
  // The demo wallet is asked for the approval first: the steps follow it inside the review, nothing reads as sent.
  await expect(body.getByTestId("swap-step-approve-active")).toBeVisible({timeout: 15_000});
  await expect(page.getByTestId("swap-confirm")).toBeDisabled();
  await expect(body.getByRole("status")).toHaveText(/^Check your wallet/);
  await expect(body.getByTestId("sheet-close")).toHaveCount(0);
  await expect(page.getByTestId("swap-status-view")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(body).toBeVisible();
  await expectNoHorizontalScroll(page);
  // The swap's hash is on the record: the sheet becomes its status.
  const status = page.getByTestId("swap-status-view");
  await expect(status).toBeVisible({timeout: 15_000});
  await expect(status.getByTestId("swap-step-approve-done")).toBeVisible();
  await expect(body).toHaveCount(0);
  // The heavier status — four steps, then a claim with both transactions — still fits, Done on screen (D34).
  await expect(status.getByTestId("swap-status")).toHaveText("In progress", {timeout: 15_000});
  await expectFits(page, "swap-review-sheet", "swap-done");
  await expect(status.getByTestId("swap-status")).toHaveText("Claim needed", {timeout: 15_000});
  await expect(status.getByTestId("swap-claim")).toBeInViewport({ratio: 1});
  await expectFits(page, "swap-review-sheet", "swap-done");
});

test("the swap's status fits without scrolling: in progress, then delivered with both links, Done on screen (D34)", async ({page}) => {
  // A native pair (no approval, three steps) whose best venue delivers by itself, as in the owner's screenshot.
  await page.goto("./#/?demo=1&pay=arbitrum:native&receive=ethereum:native&amount=0.01");
  await routesSettled(page);
  await page.getByTestId("swap-review").click();
  const sheet = page.getByTestId("swap-review-sheet");
  await expect(sheet.getByTestId("swap-review-min")).toBeVisible();
  await page.getByTestId("swap-confirm").click();
  const status = sheet.getByTestId("swap-status");
  await expect(status).toHaveText("In progress", {timeout: 15_000});
  // Refresh status beside the source link, Done under them.
  await expect(sheet.getByTestId("swap-refresh-status")).toBeInViewport({ratio: 1});
  await expect(sheet.getByTestId("swap-explorer-source")).toBeInViewport({ratio: 1});
  await expectFits(page, "swap-review-sheet", "swap-done");
  await expect(status).toHaveText("Completed", {timeout: 15_000});
  await expect(sheet.getByTestId("swap-explorer-dest")).toBeInViewport({ratio: 1});
  await expectFits(page, "swap-review-sheet", "swap-done");
  await expectNoHorizontalScroll(page);
});

test("deposit panel renders a QR for a wallet-less payer", async ({page}, info) => {
  await page.goto("./#/demo/deposit?demo=1");
  const panel = page.getByTestId("swap-deposit");
  await expect(panel).toBeVisible({timeout: 15_000});
  await expect(page.getByTestId("swap-deposit-address")).toHaveText("demo-address-do-not-send");
  await expect(panel.locator("svg").first()).toBeVisible();
  await expect(page.getByTestId("swap-deposit-expired")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await shot(page, info, "deposit");
});

test("activity drawer lists swaps", async ({page}, info) => {
  await page.goto("./#/?demo=1");
  await routesSettled(page);
  await page.getByTestId("swap-activity-open").click();
  const drawer = page.getByTestId("swap-activity");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-testid^="swap-activity-"]').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, info, "activity");
});

test("closing a sheet puts keyboard focus back on what opened it", async ({page}) => {
  await page.goto("./#/?demo=1");
  await routesSettled(page);
  const payToken = page.getByTestId("swap-pay-token");
  await payToken.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("swap-token-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("swap-token-sheet")).toBeHidden();
  await expect(payToken).toBeFocused();

  const cta = page.getByTestId("swap-review");
  await cta.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("swap-review-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("swap-review-sheet")).toBeHidden();
  await expect(cta).toBeFocused();
});

test("Settings → Custom: the network picker is the app's own list with logos (popover, or a bottom sheet on phones)", async ({page}, info) => {
  await page.goto("./#/demo/settings?demo=1");
  const settings = page.getByTestId("swap-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("settings-mode-custom").check();
  const trigger = settings.getByTestId("settings-custom-network");
  await expect(trigger).toHaveText("Ethereum");
  await trigger.click();
  const list = page.getByRole("listbox", {name: "Networks"});
  await expect(list).toBeVisible();
  await expect(list.getByRole("option")).toHaveCount(32);
  await expect(list.getByRole("option", {name: "Ethereum"}).locator("img")).toBeVisible();
  if (isPhone(info)) await expect(page.getByTestId("settings-custom-network-sheet")).toBeVisible();
  else await expect(page.getByRole("combobox", {name: "Search networks"})).toBeFocused();
  await expectNoHorizontalScroll(page);
  await list.getByRole("option", {name: "Arbitrum"}).click();
  await expect(list).toBeHidden();
  await expect(trigger).toHaveText("Arbitrum");
  await expect(trigger).toBeFocused();
  await expect(settings).toBeVisible();

  // Keyboard: open, filter, pick; Escape closes only the list.
  await page.keyboard.press("ArrowDown");
  await expect(list).toBeVisible();
  await page.getByRole("combobox", {name: "Search networks"}).fill("sol");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(list).toBeHidden();
  await expect(trigger).toHaveText("Solana");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(settings).toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText("Solana");
  await expectNoHorizontalScroll(page);
});

test("narrow phones (320 and 360 px) never scroll sideways, with or without a wallet", async ({page}, info) => {
  test.skip(!isPhone(info), "phone widths only");
  for (const width of [320, 360]) {
    for (const wallets of ["none", "evm", "both"]) {
      await page.setViewportSize({width, height: 700});
      await page.goto(`./#/?demo=1&demoWallets=${wallets}`);
      await expect(page.getByTestId("swap-amount")).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
  }
});

test("the header's connected wallets: one button, one dropdown with copy and disconnect per wallet (D33)", async ({page}, info) => {
  await page.goto("./#/?demo=1&demoWallets=both");
  const pill = page.getByTestId("swap-wallet-pill");
  await expect(pill).toHaveText("2 wallets");
  await expect(pill.getByTestId("swap-wallet-pill-evm")).toBeVisible();
  await expect(pill.getByTestId("swap-wallet-pill-solana")).toBeVisible();

  await pill.click();
  const menu = page.getByTestId("swap-wallets-menu");
  await expect(menu).toBeVisible();
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByTestId("swap-wallet-row-evm")).toContainText("MetaMask · EVM");
  await expect(menu.getByTestId("swap-wallet-row-solana")).toContainText("Phantom · Solana");
  await expect(menu.getByRole("button", {name: "Copy Solana address"})).toBeVisible();
  await expectNoHorizontalScroll(page);
  if (!isPhone(info)) {
    // Under the button, right-aligned to it (a phone gets the bottom sheet).
    const [p, m] = [(await pill.boundingBox())!, (await menu.boundingBox())!];
    expect(Math.abs(p.x + p.width - (m.x + m.width))).toBeLessThanOrEqual(1);
    expect(m.y).toBeGreaterThan(p.y + p.height);
  }
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(pill).toBeFocused();
  if (!isPhone(info)) {
    // Focus leaving it closes it: Shift+Tab off the button.
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(menu).toBeHidden();
    await expect(pill).not.toBeFocused();
  }

  // "Connect another wallet" is the wallet sheet: a third wallet joins the stack, and closing it hands focus back to
  // the button (on a phone the wallet sheet waits for the list's sheet to hand it there first).
  await pill.click();
  await menu.getByTestId("swap-wallets-connect-more").click();
  await page.getByTestId("swap-connect-tron:org.tronlink.www").click();
  await expect(page.getByTestId("swap-wallet-tron")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("swap-connect")).toBeHidden();
  await expect(pill).toBeFocused();
  await expect(pill).toHaveText("3 wallets");
  await expect(pill.getByTestId("swap-wallet-pill-tron")).toBeVisible();

  // A disconnect hands focus to the next row's disconnect, not to <body>.
  await pill.click();
  await menu.getByTestId("swap-wallet-disconnect-solana").click();
  await expect(menu.getByTestId("swap-wallet-row-solana")).toHaveCount(0);
  await expect(menu.getByTestId("swap-wallet-disconnect-tron")).toBeFocused();
  await expect(pill).toHaveText("2 wallets");
  await expectNoHorizontalScroll(page);
});
