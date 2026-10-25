import { defineConfig } from 'vitest/config';

// Integration tests run only when TEST_DATABASE_URL / TEST_REDIS_URL point at disposable services (CI does this).
export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      APP_URL: 'http://localhost:3000',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://x',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://x',
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      META_APP_SECRET: 'test-meta-secret',
      META_GRAPH_BASE: 'http://127.0.0.1:9',
      TELEGRAM_BOT_TOKEN: 'test',
      TELEGRAM_BOT_USERNAME: 'test_bot',
      TELEGRAM_WEBHOOK_SECRET: 'test-telegram-secret-123',
      TELEGRAM_API_BASE: 'http://127.0.0.1:9',
    },
  },
});
