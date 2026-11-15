import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const isolationHeaders = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
};

// https://vite.dev/config/
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [vue()],
	server: { headers: isolationHeaders },
	preview: { headers: isolationHeaders },
	resolve: {
		alias: {
			"@collaborative-whiteboard/shared": fileURLToPath(
				new URL("../../packages/shared/src/index.ts", import.meta.url)
			),
		},
	},
});
