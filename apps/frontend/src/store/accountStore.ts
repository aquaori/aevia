import { defineStore } from "pinia";
import { ref } from "vue";
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

	async function authenticate(mode: "login" | "register", username: string, password: string, nickname = "") {
		const response = await axios.post(apiUrl(`/v2/auth/${mode}`), { username, password, nickname });
		token.value = response.data.data.token;
		account.value = response.data.data.account;
	}

	async function refresh() {
		if (!token.value) return;
		try {
			account.value = (await axios.get(apiUrl("/v2/auth/me"), { headers: headers() })).data.data;
		} catch (error) {
			if (axios.isAxiosError(error) && error.response?.status === 401) { token.value = ""; account.value = null; }
		}
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
