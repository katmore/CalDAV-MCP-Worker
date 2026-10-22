import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside the Workers runtime (workerd) using the committed wrangler.jsonc,
// with test-only values for every secret. Nothing here reaches a real account.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          GITHUB_CLIENT_ID: 'test-client-id',
          GITHUB_CLIENT_SECRET: 'test-client-secret',
          COOKIE_ENCRYPTION_KEY: 'test-cookie-encryption-key',
          ALLOWED_GITHUB_LOGIN: 'owner',
          CALDAV_USERNAME: 'user',
          CALDAV_PASSWORD: 'pass',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/env.d.ts'],
      reporter: ['text', 'html'],
      // Every line, statement and function must be exercised. Branch coverage is
      // reported but not yet enforced: see the three unreachable branches noted in the
      // vendored Cloudflare code.
      thresholds: { lines: 100, statements: 100, functions: 100 },
    },
  },
});
