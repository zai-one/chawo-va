// Playwright e2e of the built app (`pnpm e2e:pw` builds first). One app at a time: each test starts
// its own Electron with a temp profile. Under Linux without a display run it via xvfb-run.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  outputDir: 'test-results',
});
