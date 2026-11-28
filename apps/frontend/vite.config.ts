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
	worker: { format: "es" },
	// Worker-only imports are not always seen by Vite's initial dependency scan.
	// Prebundle before the first plugin runs; otherwise Vite reloads every room
	// in the middle of its first executable command.
	optimizeDeps: { include: ["quickjs-emscripten"] },
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
