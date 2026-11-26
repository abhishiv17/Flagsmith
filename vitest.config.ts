import { defineConfig } from 'vitest/config';

// Unit tests for server code (vite.config.ts roots Vite at web/, which has no tests).
export default defineConfig({ test: { include: ['server/**/*.test.ts'], environment: 'node' } });
