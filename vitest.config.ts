import { defineConfig } from 'vitest/config'

// Only src: tsc puts the tests into dist too.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })
