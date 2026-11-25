import { defineConfig } from 'vitest/config'

// Nur src: tsc legt die Tests auch nach dist.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })
