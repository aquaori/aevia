import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useUserStore } from "./userStore";

describe("user store", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	it("stores the authenticated session fields", () => {
		const store = useUserStore();
		store.setToken("session-token");
		store.setSessionExpiresAt(1234567890);
		store.setUserId("user-1");
		store.setUsername("Ann");

		expect(store.token).toBe("session-token");
		expect(store.sessionExpiresAt).toBe(1234567890);
		expect(store.userId).toBe("user-1");
		expect(store.username).toBe("Ann");
	});

	it("clears individual fields", () => {
		const store = useUserStore();
		store.setToken("session-token");
		store.setSessionExpiresAt(1);
		store.setUserId("user-1");
		store.setUsername("Ann");

		store.clearToken();
		expect(store.token).toBe("");
		store.clearSessionExpiresAt();
		expect(store.sessionExpiresAt).toBeNull();
		store.clearUserId();
		expect(store.userId).toBe("");
		store.clearUsername();
		expect(store.username).toBe("");
		// Clearing one field must not touch the others.
		store.setToken("still-here");
		expect(store.token).toBe("still-here");
	});

	it("clears every session field at once", () => {
		const store = useUserStore();
		store.setToken("session-token");
		store.setSessionExpiresAt(1);
		store.setUserId("user-1");
		store.setUsername("Ann");

		store.clearAll();

		expect(store.token).toBe("");
		expect(store.sessionExpiresAt).toBeNull();
		expect(store.userId).toBe("");
		expect(store.username).toBe("");
	});
});
