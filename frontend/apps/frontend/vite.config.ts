import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// https://vite.dev/config/
export default defineConfig({
	plugins: [vue()],
	resolve: {
		alias: {
			"@collaborative-whiteboard/shared": fileURLToPath(
				new URL("../../packages/shared/src/index.ts", import.meta.url)
			),
		},
	},
});
