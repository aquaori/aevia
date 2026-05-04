import { fileURLToPath, URL } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const sharedAlias = {
	"@collaborative-whiteboard/shared": fromRoot("./packages/shared/src/index.ts"),
};

const frontendAlias = {
	...sharedAlias,
	"@": fromRoot("./apps/frontend/src"),
};

export default defineConfig({
	test: {
		globals: true,
		coverage: {
			provider: "v8",
			reportsDirectory: "tests/reports/vitest/coverage",
			reporter: ["text", "json", "html"],
		},
		projects: [
			{
				test: {
					name: "shared-unit",
					globals: true,
					environment: "node",
					include: ["packages/shared/src/**/*.spec.ts"],
				},
				resolve: {
					alias: sharedAlias,
				},
			},
			{
				test: {
					name: "backend-unit",
					globals: true,
					environment: "node",
					include: [
						"apps/backend/src/**/*.spec.js",
						"!apps/backend/src/app.spec.js",
					],
					setupFiles: ["apps/backend/tests/setup.cjs"],
				},
			},
			{
				test: {
					name: "backend-integration",
					globals: true,
					environment: "node",
					include: ["apps/backend/tests/integration/**/*.spec.js"],
					setupFiles: ["apps/backend/tests/setup.cjs"],
				},
			},
			{
				plugins: [vue()],
				test: {
					name: "frontend-unit",
					globals: true,
					environment: "happy-dom",
					include: [
						"apps/frontend/src/utils/**/*.spec.ts",
						"apps/frontend/src/states/**/*.spec.ts",
						"apps/frontend/src/service/**/*.unit.spec.ts",
					],
				},
				resolve: {
					alias: frontendAlias,
				},
			},
			{
				plugins: [vue()],
				test: {
					name: "frontend-module",
					globals: true,
					environment: "happy-dom",
					include: [
						"apps/frontend/src/service/**/*.spec.ts",
						"!apps/frontend/src/service/**/*.unit.spec.ts",
						"apps/frontend/src/store/**/*.spec.ts",
					],
				},
				resolve: {
					alias: frontendAlias,
				},
			},
			{
				plugins: [vue()],
				test: {
					name: "frontend-browser",
					globals: true,
					include: ["apps/frontend/tests/browser/**/*.spec.ts"],
					browser: {
						enabled: true,
						provider: playwright(),
						headless: true,
						instances: [{ browser: "chromium" }],
					},
				},
				resolve: {
					alias: frontendAlias,
				},
			},
			{
				test: {
					name: "micro-bench",
					globals: true,
					environment: "node",
					include: ["apps/frontend/tests/bench/**/*.bench.ts"],
					benchmark: {
						include: ["apps/frontend/tests/bench/**/*.bench.ts"],
					},
				},
				resolve: {
					alias: frontendAlias,
				},
			},
		],
	},
});
