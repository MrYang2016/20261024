import { defineConfig, devices } from '@playwright/test';

/**
 * e2e 配置：三个 app 都起本地 dev server（推流端 5173 / 观看页 5174 / 服务端 3000）。
 * 端口默认按计划固定；本机 3000 被占用时可用 E2E_API_PORT 换一个端口跑（前端自动指向它）。
 */
const API_PORT = process.env.E2E_API_PORT ?? '3000';
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const FRONTEND_API_ENV = API_PORT === '3000' ? '' : `VITE_API_BASE_URL=${API_BASE} `;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    permissions: ['camera', 'microphone'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `PORT=${API_PORT} npm run dev:server`,
      url: `${API_BASE}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `${FRONTEND_API_ENV}npm run dev:pusher`,
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `${FRONTEND_API_ENV}npm run dev:watch`,
      url: 'http://localhost:5174',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
