// File role: single source of truth for backend endpoint URLs.
//
// These fallbacks were previously inlined at every call site (a dozen copies of
// `import.meta.env.VITE_API_URL || "http://127.0.0.1:4646"` in HomeView alone),
// so changing a default meant finding every duplicate.

const DEFAULT_API_URL = "http://127.0.0.1:4646";
const DEFAULT_WS_URL = "ws://127.0.0.1:4646/ws";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

/** Base URL for backend HTTP calls, without a trailing slash. */
export const apiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_URL || DEFAULT_API_URL);

/** Builds an absolute API URL from a root-relative path such as `/join-room`. */
export const apiUrl = (path: string) =>
	`${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;

/** WebSocket origin plus `/ws`, normalized so callers can append a query string. */
export const wsBaseUrl = (() => {
	const configured = import.meta.env.VITE_WS_URL || DEFAULT_WS_URL;
	return `${trimTrailingSlash(configured).replace(/\/ws$/, "")}/ws`;
})();
