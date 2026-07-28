import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

// WxtVitest wires up the `@/` alias, WXT auto-imports, and a fake extension
// API, so lib/ modules can be tested exactly as they're written.
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'node',
  },
});
