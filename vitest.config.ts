import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    benchmark: {
      include: ['src/**/*.bench.ts']
    },
    testTimeout: 5000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/main/**/*.ts', 'tools/*.mjs'],
      exclude: ['src/main/**/*.test.ts', 'src/main/**/*.spec.ts', 'src/main/env.d.ts']
    }
  }
})
