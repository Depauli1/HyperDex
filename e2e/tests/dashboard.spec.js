const { test, expect } = require('@playwright/test');

test.describe('Dashboard E2E', () => {
  test('Redirects to price impact on root', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/price-impact/);
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
