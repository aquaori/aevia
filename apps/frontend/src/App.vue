<script setup lang="ts">
import { RouterView } from 'vue-router'
import { Toaster } from 'vue-sonner'
import RoomTransitionCurtain from './components/RoomTransitionCurtain.vue'
</script>

<template>
  <RouterView />
  <RoomTransitionCurtain />
  <Toaster position="top-center" richColors />
</template>
