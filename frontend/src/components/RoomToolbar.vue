<script setup lang="ts">
	import { ref, onMounted, onUnmounted } from "vue";
	import {
		Pencil,
		Eraser,
		RotateCcw,
		RotateCw,
		Trash2,
		Maximize,
		Minimize,
		MousePointer2,
		ChevronLeft,
		ChevronRight,
		Grip,
	} from "lucide-vue-next";
	type Tool = "pen" | "eraser" | "cursor";
	type ActiveMenu = "pen" | "eraser" | "color" | "more" | null;

	const props = defineProps<{
		activeMenu: ActiveMenu;
		currentTool: Tool;
		currentColor: string;
		currentSize: number;
		isFullscreen: boolean;
		isToolbarCollapsed: boolean;
		colors: string[];
		toggleFullscreen: () => void;
		toggleMenu: (menu: "pen" | "eraser" | "color" | "more") => void;
		setTool: (tool: Tool) => void;
		setColor: (color: string) => void;
		clearCanvas: () => void;
		undo: () => void;
		redo: () => void;
		updateCurrentSize: (size: number) => void;
		setSizePreview: (visible: boolean) => void;
		onToggleCollapsed: (collapsed: boolean) => void;
	}>();

	const THUMB_WIDTH = 56;
	const PADDING = 4;
	const sliderX = ref(0);
	const sliderTrackRef = ref<HTMLDivElement | null>(null);
	const isDraggingToolbar = ref(false);
	const toolbarX = ref(
		typeof window !== "undefined" ? window.innerWidth / 2 : 0
	);
	const toolbarY = ref(
		typeof window !== "undefined" ? window.innerHeight - 48 : 0
	);

	let dragStartX = 0;
	let dragStartY = 0;
	let initialToolbarX = 0;
	let initialToolbarY = 0;

	const handleSizeInput = (event: Event) => {
		const value = Number((event.target as HTMLInputElement).value);
		if (!Number.isNaN(value)) {
			props.updateCurrentSize(value);
		}
	};

	const handleSliderMove = (event: MouseEvent | TouchEvent) => {
		if (!sliderTrackRef.value) return;
		const clientX =
			"touches" in event ? (event.touches[0]?.clientX ?? 0) : event.clientX;
		const trackRect = sliderTrackRef.value.getBoundingClientRect();
		const rawX = clientX - trackRect.left - THUMB_WIDTH / 2;
		const maxDist = trackRect.width - THUMB_WIDTH - PADDING * 2;
		sliderX.value = Math.max(0, Math.min(rawX, maxDist));
	};

	const handleSliderEnd = () => {
		if (!sliderTrackRef.value) return;
		const trackRect = sliderTrackRef.value.getBoundingClientRect();
		const maxDist = trackRect.width - THUMB_WIDTH - PADDING * 2;
		if (sliderX.value >= maxDist * 0.9) {
			props.clearCanvas();
			props.setTool("pen");
		}
		sliderX.value = 0;
		window.removeEventListener("mousemove", handleSliderMove);
		window.removeEventListener("mouseup", handleSliderEnd);
		window.removeEventListener("touchmove", handleSliderMove);
		window.removeEventListener("touchend", handleSliderEnd);
	};

	const handleSliderStart = (event: MouseEvent | TouchEvent) => {
		handleSliderMove(event);
		window.addEventListener("mousemove", handleSliderMove);
		window.addEventListener("mouseup", handleSliderEnd);
		window.addEventListener("touchmove", handleSliderMove);
		window.addEventListener("touchend", handleSliderEnd);
	};

	const startDragToolbar = (event: PointerEvent) => {
		if ((event.target as HTMLElement).closest("button, input, .slider-track")) return;
		isDraggingToolbar.value = true;
		dragStartX = event.clientX;
		dragStartY = event.clientY;
		initialToolbarX = toolbarX.value;
		initialToolbarY = toolbarY.value;
		(event.target as HTMLElement).setPointerCapture(event.pointerId);
	};

	const onDragToolbar = (event: PointerEvent) => {
		if (!isDraggingToolbar.value) return;
		const dx = event.clientX - dragStartX;
		const dy = event.clientY - dragStartY;
		const margin = 20;
		const maxX = window.innerWidth - margin;
		const maxY = window.innerHeight - margin;
		toolbarX.value = Math.max(margin, Math.min(initialToolbarX + dx, maxX));
		toolbarY.value = Math.max(margin, Math.min(initialToolbarY + dy, maxY));
	};

	const stopDragToolbar = (event: PointerEvent) => {
		if (!isDraggingToolbar.value) return;
		isDraggingToolbar.value = false;
		(event.target as HTMLElement).releasePointerCapture(event.pointerId);
	};

	const syncToolbarPosition = () => {
		toolbarX.value = window.innerWidth / 2;
		toolbarY.value = window.innerHeight - 48;
	};

	onMounted(() => {
		window.addEventListener("resize", syncToolbarPosition);
	});

	onUnmounted(() => {
		window.removeEventListener("resize", syncToolbarPosition);
		window.removeEventListener("mousemove", handleSliderMove);
		window.removeEventListener("mouseup", handleSliderEnd);
		window.removeEventListener("touchmove", handleSliderMove);
		window.removeEventListener("touchend", handleSliderEnd);
	});
</script>

<template>
	<div
		class="fixed z-20 touch-none flex items-center justify-center"
		:style="{
			left: toolbarX + 'px',
			top: toolbarY + 'px',
			transform: 'translate(-50%, -50%)',
			cursor: isDraggingToolbar ? 'grabbing' : 'grab',
		}"
		@pointerdown="startDragToolbar"
		@pointermove="onDragToolbar"
		@pointerup="stopDragToolbar"
		@pointercancel="stopDragToolbar"
	>
		<transition name="toolbar-pop" mode="out-in">
			<div
				v-if="!props.isToolbarCollapsed"
				key="expanded"
				class="pointer-events-auto bg-white/80 backdrop-blur-sm shadow-[0_8px_32px_rgba(0,0,0,0.12)] border border-white/40 p-1 hmd:p-2 rounded-2xl flex items-center gap-1 hmd:gap-2"
			>
				<button
					@click.stop="props.onToggleCollapsed(true)"
					class="p-1.5 hmd:p-2 cursor-pointer rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors shrink-0 z-10"
					title="收起工具栏"
				>
					<ChevronRight class="w-4 h-4 hmd:w-5 hmd:h-5 transition-transform" />
				</button>

				<div class="relative shrink-0">
					<button
						@click="props.setTool('cursor')"
						class="p-2 hmd:p-3 cursor-pointer rounded-xl transition-all"
						:class="
							props.currentTool === 'cursor'
								? 'bg-indigo-50 text-indigo-600 shadow-sm ring-1 ring-indigo-200'
								: 'text-slate-400 hover:bg-slate-50'
						"
					>
						<MousePointer2 class="w-4 h-4 hmd:w-5 hmd:h-5" />
					</button>
				</div>

				<div class="relative shrink-0">
					<transition
						enter-active-class="transition duration-200"
						enter-from-class="opacity-0 translate-y-4 scale-95"
						enter-to-class="opacity-100 translate-y-0 scale-100"
						leave-active-class="transition duration-150"
						leave-from-class="opacity-100 translate-y-0 scale-100"
						leave-to-class="opacity-0 translate-y-4 scale-95"
					>
						<div
							v-if="props.activeMenu === 'pen'"
							class="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 p-3 hmd:p-4 bg-white/90 backdrop-blur-sm border border-white rounded-xl shadow-xl w-40 hmd:w-48 origin-bottom"
						>
							<div
								class="text-[10px] hmd:text-xs font-bold text-slate-400 mb-1.5 hmd:mb-2 flex justify-between"
							>
								<span>画笔粗细</span>
								<span>{{ props.currentSize }}px</span>
							</div>
							<input
								:value="props.currentSize"
								@input="handleSizeInput"
								@pointerdown="props.setSizePreview(true)"
								@pointerup="props.setSizePreview(false)"
								@pointercancel="props.setSizePreview(false)"
								type="range"
								min="1"
								max="30"
								class="w-full h-1.5 hmd:h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
							/>
						</div>
					</transition>
					<button
						@click="props.toggleMenu('pen')"
						class="p-2 hmd:p-3 cursor-pointer rounded-xl transition-all relative z-10"
						:class="
							props.currentTool === 'pen'
								? 'bg-indigo-50 text-indigo-600 shadow-sm ring-1 ring-indigo-200'
								: 'text-slate-400 hover:bg-slate-50'
						"
					>
						<Pencil class="w-4 h-4 hmd:w-5 hmd:h-5" />
					</button>
				</div>

				<div class="relative shrink-0">
					<transition
						enter-active-class="transition duration-200"
						enter-from-class="opacity-0 translate-y-4 scale-95"
						enter-to-class="opacity-100 translate-y-0 scale-100"
						leave-active-class="transition duration-150"
						leave-from-class="opacity-100 translate-y-0 scale-100"
						leave-to-class="opacity-0 translate-y-4 scale-95"
					>
						<div
							v-if="props.activeMenu === 'eraser'"
							class="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 p-3 hmd:p-4 bg-white/90 backdrop-blur-sm border border-white rounded-xl shadow-xl w-48 hmd:w-56 origin-bottom"
						>
							<div class="space-y-3 hmd:space-y-4">
								<div>
									<div
										class="text-[10px] hmd:text-xs font-bold text-slate-400 mb-1.5 hmd:mb-2 flex justify-between"
									>
										<span>橡皮粗细</span>
										<span>{{ props.currentSize }}px</span>
									</div>
									<input
										:value="props.currentSize"
										@input="handleSizeInput"
										@pointerdown="props.setSizePreview(true)"
										@pointerup="props.setSizePreview(false)"
										@pointercancel="props.setSizePreview(false)"
										type="range"
										min="5"
										max="50"
										class="w-full h-1.5 hmd:h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
									/>
								</div>
								<div class="h-px bg-slate-100"></div>
								<div
									ref="sliderTrackRef"
									@mousedown="handleSliderStart"
									@touchstart.passive="handleSliderStart"
									class="slider-track relative h-8 hmd:h-10 bg-slate-100 rounded-lg flex items-center p-1 cursor-pointer overflow-hidden select-none"
								>
									<div
										class="absolute inset-0 flex items-center justify-center text-[9px] hmd:text-[10px] text-slate-400 font-bold uppercase tracking-wider"
									>
										滑动清空画布
									</div>
									<div
										class="absolute top-1 bottom-1 w-10 hmd:w-12 bg-white rounded-md shadow-sm border border-slate-200 flex items-center justify-center text-red-500 z-10"
										:style="{ transform: 'translateX(' + sliderX + 'px)' }"
									>
										<Trash2 class="w-3.5 h-3.5 hmd:w-4 hmd:h-4" />
									</div>
								</div>
							</div>
						</div>
					</transition>
					<button
						@click="props.toggleMenu('eraser')"
						class="p-2 hmd:p-3 cursor-pointer rounded-xl transition-all relative z-10"
						:class="
							props.currentTool === 'eraser'
								? 'bg-indigo-50 text-indigo-600 shadow-sm ring-1 ring-indigo-200'
								: 'text-slate-400 hover:bg-slate-50'
						"
					>
						<Eraser class="w-4 h-4 hmd:w-5 hmd:h-5" />
					</button>
				</div>

				<div class="w-px h-6 hmd:h-8 bg-slate-200 mx-0.5 hmd:mx-1 shrink-0"></div>

				<div class="relative shrink-0">
					<transition
						enter-active-class="transition duration-200"
						enter-from-class="opacity-0 translate-y-4 scale-95"
						enter-to-class="opacity-100 translate-y-0 scale-100"
						leave-active-class="transition duration-150"
						leave-from-class="opacity-100 translate-y-0 scale-100"
						leave-to-class="opacity-0 translate-y-4 scale-95"
					>
						<div
							v-if="props.activeMenu === 'color'"
							class="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 p-2 hmd:p-3 bg-white/90 backdrop-blur-sm border border-white rounded-xl shadow-xl w-48 hmd:w-64 origin-bottom grid grid-cols-6 gap-1.5 hmd:gap-2"
						>
							<button
								v-for="c in props.colors"
								:key="c"
								@click="props.setColor(c)"
								class="w-6 h-6 cursor-pointer hmd:w-8 hmd:h-8 rounded-full border border-slate-100 shadow-sm hover:scale-110 transition-transform relative"
								:style="{ backgroundColor: c }"
							>
								<div
									v-if="props.currentColor === c"
									class="absolute inset-0 flex items-center justify-center"
								>
									<div
										class="w-2 h-2 hmd:w-2.5 hmd:h-2.5 bg-white rounded-full shadow-sm"
										:class="{ 'bg-black': c === '#ffffff' }"
									></div>
								</div>
							</button>
						</div>
					</transition>
					<button
						@click="props.toggleMenu('color')"
						class="p-2 hmd:p-3 cursor-pointer rounded-xl transition-all relative z-10 hover:bg-slate-50 group"
					>
						<div
							class="w-4 h-4 hmd:w-5 hmd:h-5 rounded-full border-2 border-slate-200 shadow-sm group-hover:scale-110 transition-transform"
							:style="{ backgroundColor: props.currentColor }"
						></div>
					</button>
				</div>

				<div class="w-px h-6 hmd:h-8 bg-slate-200 mx-0.5 hmd:mx-1 shrink-0"></div>

				<div class="flex items-center bg-slate-100 rounded-xl p-0.5 space-x-0.5 shrink-0">
					<button
						@click="props.undo"
						class="p-1.5 hmd:p-2.5 cursor-pointer rounded-lg text-slate-500 hover:bg-white hover:text-slate-700 hover:shadow-sm transition-all disabled:opacity-30 disabled:hover:bg-transparent"
						title="撤销 (Ctrl+Z)"
					>
						<RotateCcw class="w-3.5 h-3.5 hmd:w-4 hmd:h-4" />
					</button>
					<button
						@click="props.redo"
						class="p-1.5 hmd:p-2.5 cursor-pointer rounded-lg text-slate-500 hover:bg-white hover:text-slate-700 hover:shadow-sm transition-all disabled:opacity-30 disabled:hover:bg-transparent"
						title="重做 (Ctrl+Y)"
					>
						<RotateCw class="w-3.5 h-3.5 hmd:w-4 hmd:h-4" />
					</button>
				</div>

				<button
					@click="props.toggleFullscreen"
					class="p-2 hmd:p-3 rounded-xl cursor-pointer text-slate-400 hover:bg-slate-50 hover:text-slate-600 transition-colors shrink-0"
					title="全屏 (F)"
				>
					<Maximize v-if="!props.isFullscreen" class="w-4 h-4 hmd:w-5 hmd:h-5" />
					<Minimize v-else class="w-4 h-4 hmd:w-5 hmd:h-5" />
				</button>

				<div class="w-px h-6 hmd:h-8 bg-slate-200 mx-0.5 hmd:mx-1 shrink-0"></div>

				<div
					class="px-1.5 hmd:px-2 py-1 text-slate-300 hover:text-indigo-500 cursor-grab active:cursor-grabbing shrink-0 transition-colors group"
					title="按住拖拽工具栏"
				>
					<Grip
						class="w-4 h-4 hmd:w-5 hmd:h-5 group-hover:scale-110 group-active:scale-100 transition-transform"
					/>
				</div>
			</div>

			<div
				v-else
				key="collapsed"
				class="pointer-events-auto bg-white/80 backdrop-blur-sm shadow-[0_8px_32px_rgba(0,0,0,0.12)] border border-white/40 p-1 hmd:p-2 rounded-2xl flex items-center gap-1 hmd:gap-2"
			>
				<button
					@click.stop="props.onToggleCollapsed(false)"
					class="p-1.5 hmd:p-2 cursor-pointer rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors shrink-0 z-10"
					title="展开工具栏"
				>
					<ChevronLeft class="w-4 h-4 hmd:w-5 hmd:h-5 transition-transform" />
				</button>

				<div class="relative shrink-0">
					<button
						class="p-2 hmd:p-3 cursor-pointer rounded-xl bg-indigo-50 text-indigo-600 shadow-sm ring-1 ring-indigo-200"
					>
						<MousePointer2
							v-if="props.currentTool === 'cursor'"
							class="w-4 h-4 hmd:w-5 hmd:h-5"
						/>
						<Pencil
							v-else-if="props.currentTool === 'pen'"
							class="w-4 h-4 hmd:w-5 hmd:h-5"
						/>
						<Eraser
							v-else-if="props.currentTool === 'eraser'"
							class="w-4 h-4 hmd:w-5 hmd:h-5"
						/>
						<div
							v-else
							class="w-4 h-4 hmd:w-5 hmd:h-5 rounded-full"
							:style="{ backgroundColor: props.currentColor }"
						></div>
					</button>
				</div>

				<div class="w-px h-6 hmd:h-8 bg-slate-200 mx-0.5 hmd:mx-1 shrink-0"></div>

				<div
					class="px-1.5 hmd:px-2 py-1 text-slate-300 hover:text-indigo-500 cursor-grab active:cursor-grabbing shrink-0 transition-colors group"
					title="按住拖拽工具栏"
				>
					<Grip
						class="w-4 h-4 hmd:w-5 hmd:h-5 group-hover:scale-110 group-active:scale-100 transition-transform"
					/>
				</div>
			</div>
		</transition>
	</div>
</template>
