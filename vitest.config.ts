import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scope the glob to this package's own suite.
    //
    // Vitest's default is `**/*.test.ts`, which reaches anything under the working
    // directory. The release workflow checks quaivault-contracts out into ./contracts
    // so the ABI drift check has artifacts to compare against — and that repo ships
    // its own hardhat tests, which the default glob would collect and fail on.
    include: ['test/**/*.test.ts'],

    // Belt and braces: even if `include` is widened later, nothing outside this
    // package's source gets collected.
    exclude: ['node_modules/**', 'dist/**', 'contracts/**', '.tmp/**'],

    // The suite is hermetic — no test may reach the network. Anything approaching
    // this ceiling is doing I/O it should not be doing.
    testTimeout: 15_000,
  },
});
