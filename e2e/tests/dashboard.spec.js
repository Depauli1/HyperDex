const { test, expect } = require('@playwright/test');

test.describe('Dashboard E2E', () => {
  test('Redirects to the swap panel on root', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/swap/);
  });

  test('Swap panel is usable and offers the wallet button', async ({ page }) => {
    await page.goto('/swap');
    await expect(page.getByTestId('swap-panel')).toBeVisible();
    await expect(page.getByTestId('wallet-connect')).toBeVisible();
    await expect(page.getByLabel('pool')).toBeVisible();
  });

  test('Bridge panel asks for a token and a fee', async ({ page }) => {
    await page.goto('/bridge');
    await expect(page.getByTestId('bridge-panel')).toBeVisible();
    await expect(page.getByLabel('token')).toBeVisible();
    await expect(page.getByLabel('bridge fee')).toBeVisible();
  });

  test('Liquidity panel exposes the fee tiers', async ({ page }) => {
    await page.goto('/liquidity');
    await expect(page.getByTestId('liquidity-panel')).toBeVisible();
    await expect(page.getByLabel('fee tier')).toBeVisible();
    await expect(page.getByLabel('slippage')).toBeVisible();
  });

  test('Price Impact chart loads', async ({ page }) => {
    await page.goto('/price-impact');
    await page.waitForSelector('[data-testid="price-impact-chart"]');
    const el = await page.$('[data-testid="price-impact-chart"]');
    expect(el).toBeTruthy();
  });

  test('Slippage chart loads', async ({ page }) => {
    await page.goto('/slippage');
    await page.waitForSelector('[data-testid="slippage-chart"]');
    expect(await page.$('[data-testid="slippage-chart"]')).toBeTruthy();
  });

  test('Efficiency chart loads', async ({ page }) => {
    await page.goto('/efficiency');
    await page.waitForSelector('[data-testid="efficiency-chart"]');
    expect(await page.$('[data-testid="efficiency-chart"]')).toBeTruthy();
  });

  test('Oracle Prices chart loads', async ({ page }) => {
    await page.goto('/oracle-prices');
    await page.waitForSelector('[data-testid="oracle-prices-chart"]');
    expect(await page.$('[data-testid="oracle-prices-chart"]')).toBeTruthy();
  });
});
