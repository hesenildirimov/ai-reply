import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { env: { APP_URL: 'http://localhost:3000', DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') } },
});
