<script setup lang="ts">
import type { ApgCatalog } from "../service/apgCatalog";
defineProps<{ catalog: ApgCatalog; enabled: (id: string) => boolean; busy: string; preview: { pluginId: string; text: string } | null; ready: boolean }>();
const emit = defineEmits<{ toggle: [id: string, value: boolean]; run: [id: string, command: string]; close: [] }>();
</script>
<template>
  <details v-if="catalog.plugins.some(p => p.program)" class="fixed right-4 top-24 z-40 max-w-xs rounded-lg border border-slate-200 bg-white p-3 shadow-sm" data-testid="apg-panel">
    <summary class="cursor-pointer font-medium text-sm">APG 插件</summary>
    <div v-for="plugin in catalog.plugins.filter(p => p.program)" :key="plugin.manifest.id" class="mt-2 border-t border-slate-100 pt-2">
      <div class="flex items-center justify-between gap-2 text-sm">
        <span>{{ plugin.manifest.name }}</span>
        <button v-if="plugin.manifest.scope === 'user'" type="button" class="rounded border px-2 py-1 text-xs" @click="emit('toggle', plugin.manifest.id, !enabled(plugin.manifest.id))">{{ enabled(plugin.manifest.id) ? '关闭' : '开启' }}</button>
        <span v-else class="text-xs text-slate-500">系统级</span>
      </div>
      <button v-for="command in enabled(plugin.manifest.id) ? plugin.manifest.contributes.commands : []" :key="command.id" type="button" :disabled="!ready || !!busy" class="mt-1 block w-full rounded bg-slate-100 px-2 py-1 text-left text-sm disabled:opacity-50" :data-apg-command="plugin.manifest.id + ':' + command.id" @click="emit('run', plugin.manifest.id, command.id)">{{ command.label }}<span v-if="command.shortcut" class="ml-1 text-xs text-slate-500">{{ command.shortcut }}</span></button>
    </div>
    <div v-if="preview" class="mt-3 border-t pt-2" role="status">
      <button type="button" class="float-right text-xs" @click="emit('close')">关闭</button>
      <p class="whitespace-pre-wrap break-words text-sm">{{ preview.text }}</p>
    </div>
  </details>
</template>
