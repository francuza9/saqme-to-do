import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

// Two projects: pure logic runs in Node, D1/HTTP integration runs inside workerd (Miniflare).
export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'node', include: ['test/node/**/*.test.js'], environment: 'node' },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.dev.toml' },
            miniflare: {
              bindings: {
                AUTH_TOKEN: 'test-token-0123456789abcdef0123456789abcdef0123',
                TEST_MIGRATIONS: await readD1Migrations('./migrations'),
              },
            },
          })),
        ],
        test: { name: 'workers', include: ['test/workers/**/*.test.js'], setupFiles: ['test/workers/setup.js'] },
      },
    ],
  },
});
