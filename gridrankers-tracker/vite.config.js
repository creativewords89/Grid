// The tracker's window (React), built into dist/ and loaded from disk by electron/main.js.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
	root: 'src/renderer',
	base: './',
	plugins: [react()],
	build: { outDir: '../../dist', emptyOutDir: true },
	test: { root: '.', include: ['test/**/*.test.js'], environment: 'node' },
});
