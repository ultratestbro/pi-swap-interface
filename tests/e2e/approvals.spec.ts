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

test("the demo wallet's approvals, most at risk first; a revoke drops its row", async ({page}, info) => {
  await page.goto("./#/revoke?demo=1");
  const rows = page.getByTestId("approval-row");
  await expect(rows).toHaveCount(4);
  // Unlimited USDT to a plain address, then the unlimited USDC: the largest amount that could be spent leads.
  await expect(rows.nth(0)).toContainText("USDT");
  await expect(rows.nth(0)).toContainText("Unlimited");
  await expect(rows.nth(0)).toContainText("Wallet address");
  await expect(rows.nth(1)).toContainText("Verified by cp0x");
  await expect(page.getByTestId("approvals-summary")).toContainText("4");
  await expect(page.getByTestId("approvals-summary")).toContainText("could be spent");
  await expect(page.getByTestId("approvals-not-checked")).toContainText("BNB Chain");
  await expectNoHorizontalScroll(page);
  await shot(page, info, "approvals");

  await rows.nth(0).getByTestId("approval-revoke").click();
  await expect(page.getByText("Revoked on Ethereum")).toBeVisible();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).not.toContainText("USDT");
});

test("another address is checked read-only", async ({page}) => {
  await page.goto("./#/revoke?demo=1");
  await expect(page.getByTestId("approval-row")).toHaveCount(4);
  await page.getByTestId("approvals-address").fill("0x1111111111111111111111111111111111111111");
  await expect(page.getByTestId("approval-row")).toHaveCount(0);
  await expect(page.getByText("No approvals left on the networks checked")).toBeVisible();
  await page.getByTestId("approvals-address").fill("not an address");
  await expect(page.getByText("That isn't an EVM address.")).toBeVisible();
  await page.getByRole("button", {name: "My wallet"}).click();
  await expect(page.getByTestId("approval-row")).toHaveCount(4);
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
