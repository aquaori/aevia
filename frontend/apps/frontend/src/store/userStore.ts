// File role: authenticated user store for token and basic user session data.
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUserStore = defineStore('user', () => {
    const token = ref('')
    const userId = ref('')
    const username = ref('')

    const setToken = (newToken: string) => {
        token.value = newToken
    }

    const setUserId = (newUserId: string) => {
        userId.value = newUserId
    }

    const setUsername = (newUsername: string) => {
        username.value = newUsername
    }

    const clearToken = () => {
        token.value = ''
    }

    const clearUserId = () => {
        userId.value = ''
    }

    const clearUsername = () => {
        username.value = ''
    }

    const clearAll = () => {
        clearToken()
        clearUserId()
        clearUsername()
    }

    return { token, userId, username, setToken, setUserId, setUsername, clearToken, clearUserId, clearUsername, clearAll };
}, {
    persist: {
        storage: sessionStorage
    }
});
