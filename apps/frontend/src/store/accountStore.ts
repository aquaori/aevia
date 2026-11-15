import { defineStore } from "pinia";
import { nextTick, ref } from "vue";
import axios from "axios";
import { apiUrl } from "../config/endpoints";

export interface Account {
	id: string;
	username: string;
	nickname: string;
}

export const useAccountStore = defineStore("account", () => {
	const token = ref("");
	const account = ref<Account | null>(null);
	const headers = () => ({ Authorization: `Bearer ${token.value}` });
	const syncStoredSession = () => {
		const saved = localStorage.getItem("account");
		if (!saved) return;
		try {
			const session = JSON.parse(saved) as { token?: string; account?: Account | null };
			token.value = session.token || "";
			account.value = session.account || null;
		} catch { /* The persisted session will be replaced on the next login. */ }
	};
	window.addEventListener("storage", (event) => {
		if (event.key === "account") syncStoredSession();
	});

	async function authenticate(mode: "login" | "register", username: string, password: string, nickname = "") {
		const response = await axios.post(apiUrl(`/v2/auth/${mode}`), { username, password, nickname });
		token.value = response.data.data.token;
		account.value = response.data.data.account;
	}

	async function refresh() {
		if (!token.value) return;
		const rotate = async () => {
			syncStoredSession();
			if (!token.value) return;
			try {
				const response = await axios.post(apiUrl("/v2/auth/refresh"), {}, { headers: headers() });
				token.value = response.data.data.token;
				account.value = response.data.data.account;
				await nextTick();
			} catch (error) {
				if (axios.isAxiosError(error) && error.response?.status === 401) { token.value = ""; account.value = null; }
			}
		};
		if (navigator.locks) await navigator.locks.request("aevia-account-refresh", rotate);
		else await rotate();
	}

	async function setNickname(nickname: string) {
		account.value = (await axios.patch(apiUrl("/v2/auth/me"), { nickname }, { headers: headers() })).data.data;
	}

	async function logout() {
		await axios.post(apiUrl("/v2/auth/logout"), {}, { headers: headers() });
		token.value = "";
		account.value = null;
	}

	return { token, account, headers, authenticate, refresh, setNickname, logout };
}, { persist: { storage: localStorage } });
