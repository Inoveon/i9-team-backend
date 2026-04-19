import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/modules/ws/parseMessageStream.test.ts', // usa node:test, não vitest
      'dist/**',
      'node_modules/**',
    ],
  },
})
