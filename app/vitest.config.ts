import { defineConfig } from 'vitest/config'

// Tests need none of the app's Vite plugins (Start, Nitro, React).
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } })
