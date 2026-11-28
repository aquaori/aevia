<!-- File role: toolbar UI plus local toolbar-only interactions like dragging, sliders, and color picking. -->
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
		PenTool,
		Highlighter,
		Minus,
		ArrowUpRight,
		Square,
		Circle,
		Type,
		StickyNote,
		Shapes,
	} from "lucide-vue-next";
	import type { EditorTool, StrokePattern } from "@collaborative-whiteboard/shared";
	import type { ApgBrushView, ApgPaletteView } from "../service/apgCatalog";
	import { builtinToolRegistry } from "../scene/toolRegistry";
	import { stickerAssets } from "../scene/stickerAssets";
	type Tool = EditorTool;
	type ActiveMenu = "pen" | "eraser" | "color" | "more" | null;
	const penTools = builtinToolRegistry.list().filter((tool) => tool.inputMode === "freehand").map((tool) => ({ ...tool, id: tool.id as Tool }));
	const moreTools = [
		...builtinToolRegistry.list().filter((tool) => ["shape", "text"].includes(tool.inputMode)).map((tool) => ({ id: tool.id as Tool, label: tool.label, sticker: "" })),
		...builtinToolRegistry.list().filter((tool) => tool.id === "object-eraser").map((tool) => ({ id: tool.id as Tool, label: tool.label, sticker: "" })),
		...stickerAssets.map((asset) => ({ id: "sticker" as const, label: asset.label, sticker: asset.value })),
	];
	const COLORS = [
		"#000000",
		"#ef4444",
		"#f97316",
		"#fbbf24",
		"#84cc16",
		"#22c55e",
		"#06b6d4",
		"#3b82f6",
		"#6366f1",
		"#a855f7",
		"#ec4899",
		"#ffffff",
	] as const;

	const props = defineProps<{
		activeMenu: ActiveMenu;
		currentTool: Tool;
		currentColor: string;
		currentSize: number;
		currentStrokePattern: StrokePattern;
		currentSticker: string;
		apgPalettes?: ApgPaletteView[];
		apgBrushes?: ApgBrushView[];
		isFullscreen: boolean;
		isToolbarCollapsed: boolean;
		toggleFullscreen: () => void;
		toggleMenu: (menu: "pen" | "eraser" | "color" | "more") => void;
		setTool: (tool: Tool) => void;
		setColor: (color: string) => void;
		activateApgBrush?: (brush: ApgBrushView) => void;
		toggleApgPalette?: (pluginId: string, enabled: boolean) => void;
		setStrokePattern: (pattern: StrokePattern) => void;
		setSticker: (sticker: string) => void;
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
							class="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 p-3 hmd:p-4 bg-white/95 backdrop-blur-sm border border-white rounded-xl shadow-xl w-64 origin-bottom"
						>
							<div class="grid grid-cols-3 gap-1 mb-3">
								<button
									v-for="tool in penTools"
									:key="tool.id"
									@click="props.setTool(tool.id)"
									class="rounded-lg px-2 py-2 text-xs font-medium transition-colors"
									:class="props.currentTool === tool.id ? 'bg-indigo-50 text-indigo-600' : 'text-slate-500 hover:bg-slate-50'"
								>{{ tool.label }}</button>
							</div>
								<div v-if="props.apgBrushes?.length" class="mb-3 border-t border-slate-100 pt-2">
									<div class="mb-1.5 text-[10px] font-semibold text-slate-400">插件画笔</div>
									<div class="grid grid-cols-2 gap-1">
										<button
											v-for="brush in props.apgBrushes"
											:key="brush.pluginId + ':' + brush.id"
											@click="props.activateApgBrush?.(brush)"
											class="rounded-lg bg-slate-50 px-2 py-1.5 text-left text-[10px] font-medium text-slate-600 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
											:title="brush.pluginName"
										>{{ brush.label }}</button>
									</div>
								</div>
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
						title="画笔工具"
						aria-label="画笔工具"
						class="p-2 hmd:p-3 cursor-pointer rounded-xl transition-all relative z-10"
						:class="
							['pen', 'pencil', 'highlighter'].includes(props.currentTool) && props.activeMenu !== 'more'
								? 'bg-indigo-50 text-indigo-600 shadow-sm ring-1 ring-indigo-200'
								: 'text-slate-400 hover:bg-slate-50'
						"
					>
						<Highlighter v-if="props.currentTool === 'highlighter'" class="w-4 h-4 hmd:w-5 hmd:h-5" />
						<PenTool v-else-if="props.currentTool === 'pen'" class="w-4 h-4 hmd:w-5 hmd:h-5" />
						<Pencil v-else class="w-4 h-4 hmd:w-5 hmd:h-5" />
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
							v-if="props.activeMenu === 'more'"
							class="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 p-2 bg-white/95 backdrop-blur-sm border border-white rounded-xl shadow-xl w-72 origin-bottom"
						>
							<div class="grid grid-cols-4 gap-1">
								<button
								v-for="item in moreTools"
								:key="item.id + item.sticker"
								@click="item.id === 'sticker' ? props.setSticker(item.sticker) : props.setTool(item.id)"
								class="flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[10px] font-medium transition-colors"
								:class="props.currentTool === item.id && (item.id !== 'sticker' || props.currentSticker === item.sticker) ? 'bg-indigo-50 text-indigo-600' : 'text-slate-500 hover:bg-slate-50'"
							>
								<Minus v-if="item.id === 'line'" class="w-4 h-4" />
								<ArrowUpRight v-else-if="item.id === 'arrow'" class="w-4 h-4" />
								<Square v-else-if="item.id === 'rectangle' || item.id === 'rounded-rectangle'" class="w-4 h-4" />
								<Circle v-else-if="item.id === 'ellipse'" class="w-4 h-4" />
								<Type v-else-if="item.id === 'text'" class="w-4 h-4" />
								<StickyNote v-else-if="item.id === 'sticky'" class="w-4 h-4" />
								<span v-else-if="item.id === 'sticker'" class="text-base leading-4">{{ item.sticker }}</span>
								<Eraser v-else class="w-4 h-4" />
									<span>{{ item.label }}</span>
								</button>
							</div>
							<div
								v-if="['line', 'arrow', 'rectangle', 'rounded-rectangle', 'ellipse'].includes(props.currentTool)"
								class="mt-2 border-t border-slate-100 pt-2"
							>
								<div class="mb-1.5 text-[10px] font-semibold text-slate-400">图形线型</div>
								<div class="grid grid-cols-5 gap-1">
									<button
										v-for="pattern in ([['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线'], ['dash-dot', '点划'], ['double', '双线']] as const)"
										:key="pattern[0]"
										@click.stop="props.setStrokePattern(pattern[0])"
										class="rounded-md px-1 py-1.5 text-[10px] transition-colors"
										:class="props.currentStrokePattern === pattern[0] ? 'bg-slate-800 text-white' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'"
									>{{ pattern[1] }}</button>
								</div>
							</div>
						</div>
					</transition>
					<button
						@click="props.toggleMenu('more')"
						class="p-2 hmd:p-3 cursor-pointer rounded-xl transition-all"
						:class="props.activeMenu === 'more' || !['cursor', 'pen', 'pencil', 'highlighter', 'eraser'].includes(props.currentTool) ? 'bg-indigo-50 text-indigo-600 shadow-sm ring-1 ring-indigo-200' : 'text-slate-400 hover:bg-slate-50'"
						title="形状与内容"
					>
						<Shapes class="w-4 h-4 hmd:w-5 hmd:h-5" />
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
								class="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 max-h-80 w-60 hmd:w-72 origin-bottom overflow-y-auto rounded-xl border border-white bg-white/95 p-2 hmd:p-3 shadow-xl backdrop-blur-sm"
						>
								<div class="grid grid-cols-6 gap-1.5 hmd:gap-2">
									<button
										v-for="c in COLORS"
										:key="c"
										@click="props.setColor(c)"
										class="relative h-7 w-7 cursor-pointer rounded-full border border-slate-100 shadow-sm transition-transform hover:scale-110 hmd:h-8 hmd:w-8"
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
								<div
									v-for="palette in props.apgPalettes || []"
									:key="palette.pluginId + ':' + palette.id"
									class="mt-2 border-t border-slate-100 pt-2"
								>
									<div class="mb-1.5 flex items-center justify-between gap-2">
										<div class="min-w-0">
											<div class="truncate text-[10px] font-semibold text-slate-500">{{ palette.label }}</div>
											<div class="truncate text-[9px] text-slate-400">{{ palette.pluginName }}</div>
										</div>
										<button
											v-if="palette.toggleable"
											@click.stop="props.toggleApgPalette?.(palette.pluginId, !palette.enabled)"
											class="shrink-0 rounded-md px-1.5 py-1 text-[9px] font-medium transition-colors"
											:class="palette.enabled ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-100 text-slate-400'"
										>{{ palette.enabled ? '已启用' : '已停用' }}</button>
									</div>
									<div v-if="palette.enabled" class="grid grid-cols-6 gap-1.5 hmd:gap-2">
										<button
											v-for="c in palette.colors"
											:key="c"
											@click="props.setColor(c)"
											:aria-label="'调色板颜色 ' + c"
											class="relative h-7 w-7 cursor-pointer rounded-full border border-slate-100 shadow-sm transition-transform hover:scale-110 hmd:h-8 hmd:w-8"
											:style="{ backgroundColor: c }"
										>
											<div v-if="props.currentColor === c" class="absolute inset-0 flex items-center justify-center">
												<div class="h-2 w-2 rounded-full bg-white shadow-sm hmd:h-2.5 hmd:w-2.5" :class="{ 'bg-black': c === '#ffffff' }"></div>
											</div>
										</button>
									</div>
								</div>
						</div>
					</transition>
					<button
						@click="props.toggleMenu('color')"
						title="颜色"
						aria-label="颜色"
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
