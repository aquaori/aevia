import js from "@eslint/js";
import vue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

const typescriptFiles = ["**/*.{ts,tsx}"];
const typescriptRecommended = tseslint.configs.recommended.map((config) => ({
	...config,
	files: typescriptFiles,
}));
const typescriptRecommendedRules = Object.assign(
	{},
	...tseslint.configs.recommended.map((config) => config.rules),
);

export default defineConfig(
	globalIgnores([
		"**/node_modules/**",
		"**/dist/**",
		"**/coverage/**",
		"**/playwright-report/**",
		"**/test-results/**",
		"apps/frontend/tests/e2e/external/reports/**",
		"apps/frontend/tests/e2e/external/baselines/**",
		"apps/frontend/tests/e2e/external/history/**",
		"tests/reports/**",
		"data/**",
		".agents/**",
		".codex/**",
		".vscode/**",
		// Go build/module cache. Vendored JS in there (pprof, x/tools) produced
		// 800+ bogus errors and made `npm run lint` useless.
		".cache/**",
		"apps/go-backend/**",
	]),
	js.configs.recommended,
	...typescriptRecommended,
	...vue.configs["flat/essential"],
	{
		files: ["**/*.vue"],
		languageOptions: {
			parserOptions: {
				parser: tseslint.parser,
			},
		},
		plugins: {
			"@typescript-eslint": tseslint.plugin,
		},
		rules: typescriptRecommendedRules,
	},
	{
		files: [
			"apps/backend/**/*.{js,cjs}",
			"packages/shared/cjs/**/*.cjs",
		],
		languageOptions: {
			sourceType: "commonjs",
			globals: {
				...globals.node,
				crypto: "off",
				WebSocket: "off",
			},
		},
	},
	{
		files: [
			"eslint.config.mjs",
			"vitest.config.ts",
			"scripts/**/*.mjs",
			"tests/**/*.ts",
			"apps/frontend/*.config.{js,ts}",
			"apps/frontend/tests/**/*.ts",
		],
		languageOptions: {
			globals: globals.node,
		},
	},
	{
		files: ["apps/frontend/src/**/*.{ts,tsx,vue}"],
		languageOptions: {
			globals: globals.browser,
		},
	},
	{
		files: ["apps/frontend/src/workers/**/*.ts"],
		languageOptions: {
			globals: globals.worker,
		},
	},
	{
		files: [
			"**/*.spec.{js,ts}",
			"**/*.bench.ts",
			"apps/frontend/tests/browser/**/*.ts",
		],
		languageOptions: {
			globals: globals.vitest,
		},
	},
	{
		files: ["**/*.{js,cjs,mjs}"],
		rules: {
			"no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					ignoreRestSiblings: true,
				},
			],
		},
	},
	{
		files: ["**/*.{ts,tsx,vue}"],
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					ignoreRestSiblings: true,
				},
			],
		},
	},
);
