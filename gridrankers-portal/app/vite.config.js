import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built into app/dist and enqueued by includes/class-frontend.php from the manifest.
// Relative base so font/CSS URLs resolve inside the plugin folder.
export default defineConfig({
	plugins: [react()],
	base: './',
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		manifest: true,
		rollupOptions: {
			input: 'src/main.jsx',
		},
	},
	test: {
		environment: 'jsdom',
	},
});
