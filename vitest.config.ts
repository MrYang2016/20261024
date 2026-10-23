import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

/**
 * 根 vitest 配置：
 * - server 项目：node 环境，覆盖 apps/server 与 packages/shared
 * - ui 项目：jsdom 环境，覆盖 apps/pusher 与 apps/watch（含 .vue 测试）
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          globals: true,
          include: [
            'apps/server/**/*.{test,spec}.ts',
            'packages/**/*.{test,spec}.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
      {
        plugins: [vue()],
        test: {
          name: 'ui',
          environment: 'jsdom',
          globals: true,
          include: [
            'apps/pusher/**/*.{test,spec}.ts',
            'apps/watch/**/*.{test,spec}.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
    ],
  },
});
