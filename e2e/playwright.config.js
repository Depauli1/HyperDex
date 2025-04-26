// @ts-check
const { devices } = require('@playwright/test');
/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: './tests',
  timeout: 30 * 1000,
  use: {
    headless: true,
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    actionTimeout: 10 * 1000,
  },
};
