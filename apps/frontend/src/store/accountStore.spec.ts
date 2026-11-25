import axios from "axios";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountStore } from "./accountStore";

describe("useAccountStore", () => {
	beforeEach(() => {
		localStorage.clear();
		setActivePinia(createPinia());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("authenticates, refreshes (including 401 eviction), updates nickname, syncs storage events, and logs out", async () => {
		const postSpy = vi.spyOn(axios, "post").mockResolvedValue({
			data: { data: { token: "tok-1", account: { id: "u1", username: "alice", nickname: "Alice" } } },
		});
		const patchSpy = vi.spyOn(axios, "patch").mockResolvedValue({
			data: { data: { id: "u1", username: "alice", nickname: "Alice 2" } },
		});

		const store = useAccountStore();
		await store.authenticate("login", "alice", "secret");
		expect(store.token).toBe("tok-1");
		expect(store.headers()).toEqual({ Authorization: "Bearer tok-1" });

		// Sync via storage event
		localStorage.setItem(
			"account",
			JSON.stringify({ token: "tok-stored", account: { id: "u1", username: "alice", nickname: "Stored" } }),
		);
		window.dispatchEvent(new StorageEvent("storage", { key: "account" }));
		expect(store.token).toBe("tok-stored");

		// Refresh rotates token
		postSpy.mockResolvedValueOnce({
			data: { data: { token: "tok-2", account: { id: "u1", username: "alice", nickname: "Refreshed" } } },
		});
		await store.refresh();
		expect(store.token).toBe("tok-2");

		// Nickname patch
		await store.setNickname("Alice 2");
		expect(patchSpy).toHaveBeenCalled();
		expect(store.account?.nickname).toBe("Alice 2");

		// 401 on refresh clears account session
		vi.spyOn(axios, "isAxiosError").mockReturnValue(true);
		postSpy.mockRejectedValueOnce({ response: { status: 401 } });
		await store.refresh();
		expect(store.token).toBe("");
		expect(store.account).toBeNull();

		// Logout calls endpoint and resets state
		await store.authenticate("register", "alice", "secret", "Alice");
		postSpy.mockResolvedValueOnce({});
		await store.logout();
		expect(store.token).toBe("");
		expect(store.account).toBeNull();
	});
});
