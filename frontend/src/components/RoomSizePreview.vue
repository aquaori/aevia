<script setup lang="ts">
	const props = defineProps<{
		visible: boolean;
		currentSize: number;
		currentTool: "pen" | "eraser" | "cursor";
		currentColor: string;
	}>();
</script>

<template>
	<transition
		enter-active-class="transition duration-200 ease-out"
		enter-from-class="opacity-0 scale-50"
		enter-to-class="opacity-100 scale-100"
		leave-active-class="transition duration-150 ease-in"
		leave-from-class="opacity-100 scale-100"
		leave-to-class="opacity-0 scale-50"
	>
		<div
			v-if="props.visible"
			class="fixed inset-0 pointer-events-none z-80 flex items-center justify-center"
		>
			<div
				class="bg-white/80 backdrop-blur-md rounded-3xl p-6 shadow-2xl border border-white/50 flex flex-col items-center gap-4"
			>
				<div
					class="rounded-full shadow-inner border border-slate-200 transition-all duration-75"
					:style="{
						width: props.currentSize + 'px',
						height: props.currentSize + 'px',
						backgroundColor: props.currentTool === 'eraser' ? '#cbd5e1' : props.currentColor,
					}"
				></div>
				<div class="text-slate-500 font-bold font-mono text-lg">{{ props.currentSize }}px</div>
			</div>
		</div>
	</transition>
</template>
