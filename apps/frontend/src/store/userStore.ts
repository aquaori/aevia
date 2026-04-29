// File role: authenticated user store for token and basic user session data.
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUserStore = defineStore('user', () => {
    const token = ref('')
    const sessionExpiresAt = ref<number | null>(null)
    const userId = ref('')
    const username = ref('')

    const setToken = (newToken: string) => {
        token.value = newToken
    }

    const setSessionExpiresAt = (value: number | null) => {
        sessionExpiresAt.value = value
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

    const clearSessionExpiresAt = () => {
        sessionExpiresAt.value = null
    }

    const clearUserId = () => {
        userId.value = ''
    }

    const clearUsername = () => {
        username.value = ''
    }

    const clearAll = () => {
        clearToken()
        clearSessionExpiresAt()
        clearUserId()
        clearUsername()
    }

    return {
        token,
        sessionExpiresAt,
        userId,
        username,
        setToken,
        setSessionExpiresAt,
        setUserId,
        setUsername,
        clearToken,
        clearSessionExpiresAt,
        clearUserId,
        clearUsername,
        clearAll
    };
}, {
    persist: {
        storage: sessionStorage
    }
});
