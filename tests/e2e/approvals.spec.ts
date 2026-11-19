/**
 * The Approvals section in demo mode (D46), at the phone, tablet and desktop widths: the demo wallet's approvals are
 * listed most at risk first with what could be spent, the header links the section both ways, a revoke drops its row,
 * and another address is checked read-only (no Revoke). Demo stays offline, throws nothing and never scrolls sideways.
 */
import {expect, test as base} from "@playwright/test";
import {expectNoHorizontalScroll, isPhone, shot, watchPage, type PageWatch} from "./helpers";

const test = base.extend<{watch: PageWatch}>({
  watch: [
    async ({page, baseURL}, use) => {
      const watch = watchPage(page);
      await use(watch);
      const origin = new URL(baseURL!).origin;
      expect(watch.errors, "page errors / console errors").toEqual([]);
      expect(
        watch.requests.filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:")),
        "demo mode must stay offline",
      ).toEqual([]);
    },
    {auto: true},
  ],
});

test("the demo wallet's approvals as a table, newest first; a revoke drops its row; a selection revokes in turn", async ({page}, info) => {
  await page.goto("./#/revoke?demo=1");
  const rows = page.getByTestId("approval-row");
  await expect(rows).toHaveCount(5);
  // Newest first: the unlimited USDT to a plain address, then LI.FI's USDC (verified).
  await expect(rows.nth(0)).toContainText("USDT");
  await expect(rows.nth(0)).toContainText("Unlimited");
  await expect(rows.nth(0)).toContainText("Wallet");
  await expect(rows.nth(0)).toContainText("2,450 USDT");
  await expect(rows.nth(1)).toContainText("Verified");
  // A token the wallet holds none of: $0.00 at risk; an NFT collection it holds some of: Unknown.
  await expect(rows.nth(3)).toContainText("0 USDC ($0.00)");
  await expect(rows.nth(4)).toContainText("2 NFTs");
  await expect(rows.nth(4)).toContainText("Unknown");
  await expect(page.getByTestId("approvals-summary")).toContainText("5");
  await expect(page.getByTestId("approvals-summary")).toContainText("at risk");
  await expect(page.getByTestId("approvals-not-checked")).toContainText("BNB Chain");
  await expectNoHorizontalScroll(page);
  await shot(page, info, "approvals");

  // Sort by value at risk, search by spender.
  await page.getByTestId("approvals-sort").selectOption("risk");
  await expect(rows.nth(0)).toContainText("USDT");
  await expect(rows.nth(1)).toContainText("WETH");
  await page.getByTestId("approvals-search").fill("li.fi");
  await expect(rows).toHaveCount(1);
  await page.getByTestId("approvals-search").fill("");
  await page.getByTestId("approvals-sort").selectOption("newest");

  await rows.nth(0).getByTestId("approval-revoke").click();
  await expect(page.getByText("Revoked on Ethereum")).toBeVisible();
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).not.toContainText("USDT");

  // Two picked, revoked one after the other.
  await rows.nth(0).getByRole("checkbox").check();
  await rows.nth(1).getByRole("checkbox").check();
  await page.getByTestId("approvals-revoke-selected").click();
  await expect(rows).toHaveCount(2, {timeout: 8000});
});

test("another address is checked read-only", async ({page}) => {
  await page.goto("./#/revoke?demo=1");
  await expect(page.getByTestId("approval-row")).toHaveCount(5);
  await page.getByTestId("approvals-address").fill("0x1111111111111111111111111111111111111111");
  await expect(page.getByTestId("approval-row")).toHaveCount(0);
  await expect(page.getByText("No approvals left on the networks checked")).toBeVisible();
  await page.getByTestId("approvals-address").fill("not an address");
  await expect(page.getByText("That isn't an EVM address.")).toBeVisible();
  await page.getByRole("button", {name: "My wallet"}).click();
  await expect(page.getByTestId("approval-row")).toHaveCount(5);
  await expect(page.getByTestId("approval-revoke").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("the Rev0ke button, bottom right, opens the section; the brand goes back", async ({page}, info) => {
  await page.goto("./?demo=1#/");
  const button = page.getByTestId("nav-approvals");
  await expect(button).toBeVisible();
  await expect(button).toHaveText("Rev0ke");
  // Bottom right: the screen's corner; a phone's page corner, under its CTA (never on it).
  const box = (await button.boundingBox())!;
  const view = page.viewportSize()!;
  expect(view.width - (box.x + box.width)).toBeLessThanOrEqual(isPhone(info) ? 20 : 28);
  if (isPhone(info)) {
    const cta = (await page.getByTestId("swap-review").boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(cta.y + cta.height);
  } else expect(view.height - (box.y + box.height)).toBeLessThanOrEqual(28);
  await expectNoHorizontalScroll(page);
  await shot(page, info, "revoke-button");
  await button.click();
  await expect(page.getByTestId("approvals")).toBeVisible();
  await expect(page.getByTestId("nav-approvals")).toHaveCount(0);
  await page.getByRole("link", {name: "cp0x Swap, home"}).click();
  await expect(page.getByTestId("swap-form")).toBeVisible();
});
