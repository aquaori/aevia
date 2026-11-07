import { existsSync } from "node:fs";
import { chromium, firefox, webkit, type LaunchOptions } from "playwright";

export type AeviaBrowser = "chromium" | "firefox" | "webkit";

export const selectedBrowser = (): AeviaBrowser => {
	const browser = process.env.AEVIA_TEST_BROWSER;
	return browser === "firefox" || browser === "webkit" ? browser : "chromium";
};

export const selectedBrowserType = () => {
	const browser = selectedBrowser();
	return browser === "firefox" ? firefox : browser === "webkit" ? webkit : chromium;
};

const chromePaths = () => {
	if (process.platform === "win32") {
		return [
			process.env.AEVIA_CHROMIUM_EXECUTABLE,
			process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
			process.env["PROGRAMFILES(X86)"] && `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
		].filter((value): value is string => Boolean(value));
	}
	if (process.platform === "darwin") {
		return [process.env.AEVIA_CHROMIUM_EXECUTABLE, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
			.filter((value): value is string => Boolean(value));
	}
	return [process.env.AEVIA_CHROMIUM_EXECUTABLE, "/usr/bin/google-chrome", "/usr/bin/chromium"]
		.filter((value): value is string => Boolean(value));
};

export const resolveChromiumLaunchOptions = (): LaunchOptions => {
	const configuredPath = process.env.AEVIA_CHROMIUM_EXECUTABLE;
	if (configuredPath) return { executablePath: configuredPath };
	if (existsSync(chromium.executablePath())) return { executablePath: chromium.executablePath() };
	const installedChrome = chromePaths().find((candidate) => existsSync(candidate));
	if (installedChrome) return { executablePath: installedChrome };
	return { channel: "chrome" };
};

export const chromiumAvailability = () => {
	const launchOptions = resolveChromiumLaunchOptions();
	const executablePath = launchOptions.executablePath || (launchOptions.channel ? `channel:${launchOptions.channel}` : chromium.executablePath());
	const available = process.env.AEVIA_CHROMIUM_EXECUTABLE
		? existsSync(process.env.AEVIA_CHROMIUM_EXECUTABLE)
		: existsSync(chromium.executablePath()) || chromePaths().some((candidate) => existsSync(candidate));
	return {
		available,
		executablePath,
	};
};

export const browserAvailability = (browser = selectedBrowser()) => {
	if (browser === "chromium") return chromiumAvailability();
	const executablePath = browser === "firefox" ? firefox.executablePath() : webkit.executablePath();
	return { available: existsSync(executablePath), executablePath };
};
