import { realpathSync } from "node:fs";
import path from "node:path";
import { playwright } from "@vitest/browser-playwright";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";
import { resolveChromiumLaunchOptions, selectedBrowser } from "./tests/browser-launch";

const projectRoot = realpathSync(process.cwd());
const chromiumLaunchOptions = resolveChromiumLaunchOptions();
const browserName = selectedBrowser();
const browserApiPort = Number(process.env.AEVIA_TEST_BROWSER_PORT) || 51204;
const fromRoot = (relativePath: string) => path.resolve(projectRoot, relativePath);

const sharedAlias = {
	"@collaborative-whiteboard/shared": fromRoot("./packages/shared/src/index.ts"),
};

const frontendAlias = {
	...sharedAlias,
	"@": fromRoot("./apps/frontend/src"),
};

export default defineConfig({
	root: projectRoot,
	test: {
		globals: true,
		coverage: {
			provider: "v8",
			reportsDirectory: "tests/reports/vitest/coverage",
			reporter: ["text", "json", "json-summary", "html"],
			include: [
				"apps/frontend/src/**/*.{ts,tsx,vue}",
				"packages/shared/src/**/*.{ts,tsx,vue}",
			],
			exclude: ["**/*.spec.ts", "**/*.unit.spec.ts", "**/*.d.ts"],
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
				plugins: [vue()],
				test: {
					name: "frontend-unit",
					globals: true,
					environment: "happy-dom",
					include: [
						"apps/frontend/src/utils/**/*.spec.ts",
						"apps/frontend/src/states/**/*.spec.ts",
						"apps/frontend/src/scene/**/*.spec.ts",
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
					exclude: ["apps/frontend/src/service/**/*.unit.spec.ts"],
					include: [
						"apps/frontend/src/service/**/*.spec.ts",
						"apps/frontend/src/store/**/*.spec.ts",
					],
				},
				resolve: {
					alias: frontendAlias,
				},
			},
			{
				test: {
					name: "harness-unit",
					globals: true,
					environment: "node",
					include: ["tests/report/**/*.spec.ts"],
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
						provider: playwright(browserName === "chromium" ? { launchOptions: chromiumLaunchOptions } : {}),
						headless: true,
						instances: [{ browser: browserName }],
						// Vitest's default browser port (63315) falls inside the range
						// Windows reserves for Hyper-V/WSL, so the server fails to bind
						// with EACCES before any test loads. Managed runs allocate a free
						// port; direct suite runs use a stable fallback.
						api: { port: browserApiPort },
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
