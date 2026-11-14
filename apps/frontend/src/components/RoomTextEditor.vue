<script setup lang="ts">
	import { computed, nextTick, onBeforeUnmount, ref } from "vue";
	import { AlignCenter, AlignLeft, AlignRight, Bold, Check, Minus, Plus, X } from "lucide-vue-next";
	import type { AffineMatrix, SceneElementDescriptor, SceneElementStyle, aabbBox } from "@collaborative-whiteboard/shared";

	type TextKind = "text" | "sticky";
	type TextAlign = NonNullable<SceneElementStyle["textAlign"]>;

	const visible = ref(false);
	const draft = ref("");
	const kind = ref<TextKind>("text");
	const editorStyle = ref<Record<string, string>>({});
	const textarea = ref<HTMLTextAreaElement | null>(null);
	const fontFamily = ref("Arial, sans-serif");
	const fontSize = ref(20);
	const fontWeight = ref<400 | 700>(400);
	const textAlign = ref<TextAlign>("left");
	const textColor = ref("#172033");
	const scale = ref(1);
	const lineScale = ref(1);
	let textLayout: SceneElementDescriptor["textLayout"];
	let matrix: AffineMatrix = [1, 0, 0, 1, 0, 0];
	const composing = ref(false);
	let resolveRequest: ((value: string | null) => void) | null = null;
	let changeListener: ((value: string, reason: "input" | "ime") => void) | null = null;
	let styleListener: ((style: Partial<SceneElementStyle>) => void) | null = null;
	let activeElementId: string | null = null;
	let groupBoundaryListener: (() => void) | null = null;
	let activeBox: aabbBox | null = null;
	let getCanvasRect: (() => { left: number; top: number; width: number; height: number }) | null = null;
	let boxListener: ((box: aabbBox) => boolean | void) | null = null;
	let resize: { pointerId: number; handle: number; x: number; y: number; box: aabbBox } | null = null;

	const updateEditorPosition = () => {
		if (!activeBox || !getCanvasRect) return;
		const canvas = getCanvasRect();
		if (textLayout) {
			scale.value = canvas.width / textLayout.referenceWidth;
			lineScale.value = textLayout.aspectRatio * canvas.height / canvas.width;
		}
		const [a, b, c, d, x, y] = matrix;
		editorStyle.value = {
			left: `${canvas.left + (a * activeBox.minX + c * activeBox.minY + x) * canvas.width}px`,
			top: `${canvas.top + (b * activeBox.minX + d * activeBox.minY + y) * canvas.height}px`,
			width: `${activeBox.width * canvas.width}px`,
			height: `${activeBox.height * canvas.height}px`,
			transformOrigin: "top left",
			transform: `matrix(${a}, ${b * canvas.height / canvas.width}, ${c * canvas.width / canvas.height}, ${d}, 0, 0)`,
		};
	};

	const moveResize = (event: PointerEvent) => {
		if (!resize || event.pointerId !== resize.pointerId || !getCanvasRect) return;
		const canvas = getCanvasRect();
		const screenX = (event.clientX - resize.x) / Math.max(1, canvas.width);
		const screenY = (event.clientY - resize.y) / Math.max(1, canvas.height);
		const [a, b, c, d] = matrix;
		const determinant = a * d - b * c;
		if (!determinant) return;
		const dx = (d * screenX - c * screenY) / determinant;
		const dy = (a * screenY - b * screenX) / determinant;
		const minimumWidth = 16 / Math.max(1, canvas.width);
		const minimumHeight = 16 / Math.max(1, canvas.height);
		let { minX, minY, maxX, maxY } = resize.box;
		if ([1, 7, 8].includes(resize.handle)) minX = Math.max(0, Math.min(maxX - minimumWidth, minX + dx));
		if ([3, 4, 5].includes(resize.handle)) maxX = Math.min(1, Math.max(minX + minimumWidth, maxX + dx));
		if ([1, 2, 3].includes(resize.handle)) minY = Math.max(0, Math.min(maxY - minimumHeight, minY + dy));
		if ([5, 6, 7].includes(resize.handle)) maxY = Math.min(1, Math.max(minY + minimumHeight, maxY + dy));
		activeBox = { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
		updateEditorPosition();
	};

	const finishResize = (event: PointerEvent) => {
		if (!resize || event.pointerId !== resize.pointerId) return;
		const previous = resize.box;
		resize = null;
		window.removeEventListener("pointermove", moveResize);
		window.removeEventListener("pointerup", finishResize);
		window.removeEventListener("pointercancel", cancelResize);
		if (activeBox && JSON.stringify(previous) !== JSON.stringify(activeBox) && boxListener?.({ ...activeBox }) === false) {
			activeBox = previous;
			updateEditorPosition();
		}
		focusEditor();
	};

	const cancelResize = (event: PointerEvent) => {
		if (!resize || event.pointerId !== resize.pointerId) return;
		activeBox = resize.box;
		updateEditorPosition();
		finishResize(event);
	};

	const beginResize = (event: PointerEvent, handle: number) => {
		if (!activeBox || !getCanvasRect) return;
		event.preventDefault();
		event.stopPropagation();
		resize = { pointerId: event.pointerId, handle, x: event.clientX, y: event.clientY, box: { ...activeBox } };
		window.addEventListener("pointermove", moveResize);
		window.addEventListener("pointerup", finishResize);
		window.addEventListener("pointercancel", cancelResize);
	};

	const inputStyle = computed(() => ({
		fontFamily: fontFamily.value,
		fontSize: `${fontSize.value * scale.value}px`,
		lineHeight: String(1.5 * lineScale.value),
		padding: `${fontSize.value * scale.value * (kind.value === "sticky" ? 0.85 : 0.4)}px`,
		color: textColor.value,
		fontWeight: String(fontWeight.value),
		textAlign: textAlign.value,
	}));

	const focusEditor = () => void nextTick(() => textarea.value?.focus());

	const emitStyle = () => {
		styleListener?.({
			fontFamily: fontFamily.value,
			fontSize: fontSize.value,
			fontWeight: fontWeight.value,
			textAlign: textAlign.value,
		});
		focusEditor();
	};

	const changeFontSize = (delta: number) => {
		fontSize.value = Math.max(10, Math.min(96, fontSize.value + delta));
		emitStyle();
	};

	const setAlignment = (alignment: TextAlign) => {
		textAlign.value = alignment;
		emitStyle();
	};

	const toggleBold = () => {
		fontWeight.value = fontWeight.value === 700 ? 400 : 700;
		emitStyle();
	};

	const close = (value: string | null) => {
		if (!visible.value) return;
		visible.value = false;
		const resolve = resolveRequest;
		resolveRequest = null;
		changeListener = null;
		styleListener = null;
		activeElementId = null;
		groupBoundaryListener = null;
		boxListener = null;
		resize = null;
		window.removeEventListener("pointermove", moveResize);
		window.removeEventListener("pointerup", finishResize);
		window.removeEventListener("pointercancel", cancelResize);
		activeBox = null;
		getCanvasRect = null;
		window.removeEventListener("resize", updateEditorPosition);
		window.removeEventListener("scroll", updateEditorPosition, true);
		resolve?.(value);
	};

	const submit = () => close(draft.value.trim() ? draft.value : null);
	const cancel = () => close(null);

	const handleKeydown = (event: KeyboardEvent) => {
		if (composing.value) return;
		if (event.key === "Escape") {
			event.preventDefault();
			cancel();
			return;
		}
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submit();
		}
	};

	const handleInput = (event: Event) => {
		if (composing.value) return;
		changeListener?.((event.target as HTMLTextAreaElement).value, "input");
	};
	const handleCompositionStart = () => {
		composing.value = true;
	};

	const handleCompositionEnd = (event: CompositionEvent) => {
		composing.value = false;
		changeListener?.((event.target as HTMLTextAreaElement).value, "ime");
	};

	const open = (input: {
		kind: TextKind;
		elementId: string;
		box: aabbBox;
		getCanvasRect?: () => { left: number; top: number; width: number; height: number };
		initialText?: string;
		textLayout?: SceneElementDescriptor["textLayout"];
		matrix?: AffineMatrix;
		initialStyle?: Partial<SceneElementStyle>;
		onChange?: (value: string, reason: "input" | "ime") => void;
		onStyleChange?: (style: Partial<SceneElementStyle>) => void;
		onGroupBoundary?: () => void;
		onBoxChange?: (box: aabbBox) => boolean | void;
	}) => {
		if (resolveRequest) resolveRequest(null);
		composing.value = false;
		kind.value = input.kind;
		textLayout = input.textLayout;
		matrix = input.matrix ?? [1, 0, 0, 1, 0, 0];
		scale.value = 1;
		lineScale.value = 1;
		textColor.value = input.initialStyle?.color ?? "#172033";
		draft.value = input.initialText ?? "";
		changeListener = input.onChange ?? null;
		styleListener = input.onStyleChange ?? null;
		activeElementId = input.elementId;
		groupBoundaryListener = input.onGroupBoundary ?? null;
		boxListener = input.onBoxChange ?? null;
		fontFamily.value = input.initialStyle?.fontFamily ?? "Arial, sans-serif";
		fontSize.value = input.initialStyle?.fontSize ?? 20;
		fontWeight.value = input.initialStyle?.fontWeight ?? 400;
		textAlign.value = input.initialStyle?.textAlign ?? "left";

		activeBox = { ...input.box };
		getCanvasRect = input.getCanvasRect ?? (() => ({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }));
		updateEditorPosition();
		window.addEventListener("resize", updateEditorPosition);
		window.addEventListener("scroll", updateEditorPosition, true);
		visible.value = true;
		focusEditor();
		return new Promise<string | null>((resolve) => {
			resolveRequest = resolve;
		});
	};

	const notifyRemotePatch = (elementId: string) => {
		if (visible.value && activeElementId === elementId) groupBoundaryListener?.();
	};

	onBeforeUnmount(() => close(null));
	defineExpose({ open, notifyRemotePatch, submit });
</script>

<template>
	<Teleport to="body">
		<Transition name="text-editor-pop">
			<section
				v-if="visible"
				class="room-text-editor-shell"
				:class="{ 'is-sticky': kind === 'sticky' }"
				:style="editorStyle"
				role="dialog"
				aria-label="文字编辑器"
				@pointerdown.stop
			>
				<div v-if="kind === 'text'" class="room-text-toolbar" role="toolbar" aria-label="文字排版">
					<select v-model="fontFamily" aria-label="字体" @change="emitStyle">
						<option value="Arial, sans-serif">默认字体</option>
						<option value="Microsoft YaHei UI, sans-serif">微软雅黑</option>
						<option value="SimSun, serif">宋体</option>
						<option value="JetBrains Mono, Consolas, monospace">等宽字体</option>
					</select>
					<div class="toolbar-group size-group">
						<button type="button" aria-label="减小字号" @click="changeFontSize(-2)"><Minus :size="14" /></button>
						<span>{{ fontSize }}</span>
						<button type="button" aria-label="增大字号" @click="changeFontSize(2)"><Plus :size="14" /></button>
					</div>
					<div class="toolbar-group">
						<button type="button" aria-label="粗体" :class="{ active: fontWeight === 700 }" @click="toggleBold"><Bold :size="15" /></button>
						<button type="button" aria-label="左对齐" :class="{ active: textAlign === 'left' }" @click="setAlignment('left')"><AlignLeft :size="15" /></button>
						<button type="button" aria-label="居中" :class="{ active: textAlign === 'center' }" @click="setAlignment('center')"><AlignCenter :size="15" /></button>
						<button type="button" aria-label="右对齐" :class="{ active: textAlign === 'right' }" @click="setAlignment('right')"><AlignRight :size="15" /></button>
					</div>
					<div class="toolbar-spacer"></div>
					<button type="button" class="toolbar-action" aria-label="取消" @click="cancel"><X :size="15" /></button>
					<button type="button" class="toolbar-action confirm" aria-label="完成" @click="submit"><Check :size="15" /></button>
				</div>

				<div class="room-text-editor" :class="{ 'room-text-editor--sticky': kind === 'sticky', 'is-composing': composing }">
					<template v-if="kind === 'text'">
						<span v-for="handle in 8" :key="handle" class="selection-handle" :class="`handle-${handle}`" aria-hidden="true" @pointerdown="beginResize($event, handle)"></span>
					</template>
					<textarea
						ref="textarea"
						v-model="draft"
						class="room-text-editor__input"
						:style="inputStyle"
						:placeholder="kind === 'sticky' ? '写下一件值得留下的事…' : '输入文字'"
						spellcheck="false"
						@keydown="handleKeydown"
						@input="handleInput"
						@compositionstart="handleCompositionStart"
						@compositionend="handleCompositionEnd"
					></textarea>
					<footer v-if="kind === 'sticky'" class="room-text-editor__footer">
						<span>Ctrl / ⌘ + Enter 完成</span>
						<div class="room-text-editor__actions">
							<button type="button" aria-label="取消" @click="cancel"><X :size="15" /></button>
							<button type="button" class="confirm" aria-label="完成" @click="submit"><Check :size="15" /></button>
						</div>
					</footer>
				</div>
			</section>
		</Transition>
	</Teleport>
</template>

<style scoped>
	.room-text-editor-shell {
		position: fixed;
		z-index: 80;
		isolation: isolate;
	}

	.room-text-toolbar {
		position: absolute;
		left: 0;
		bottom: calc(100% + 10px);
		display: flex;
		align-items: center;
		gap: 6px;
		width: max-content;
		min-width: 100%;
		padding: 6px;
		border: 1px solid rgba(15, 23, 42, 0.1);
		border-radius: 11px;
		background: rgba(255, 255, 255, 0.98);
		box-shadow: 0 12px 34px rgba(15, 23, 42, 0.16);
		backdrop-filter: blur(14px);
	}

	.room-text-toolbar select {
		height: 30px;
		max-width: 112px;
		border: 0;
		border-radius: 7px;
		outline: 0;
		background: #f8fafc;
		padding: 0 8px;
		color: #334155;
		font: 600 12px/1 "Microsoft YaHei UI", sans-serif;
	}

	.toolbar-group { display: flex; align-items: center; gap: 2px; padding-left: 6px; border-left: 1px solid #e2e8f0; }
	.toolbar-group button,
	.toolbar-action {
		display: grid;
		width: 30px;
		height: 30px;
		place-items: center;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: #475569;
		cursor: pointer;
	}
	.toolbar-group button:hover,
	.toolbar-group button.active,
	.toolbar-action:hover { background: #eef2ff; color: #4f46e5; }
	.size-group span { min-width: 26px; color: #334155; text-align: center; font: 700 12px/1 Inter, sans-serif; }
	.toolbar-spacer { flex: 1; min-width: 4px; }
	.toolbar-action.confirm { background: #4f46e5; color: white; }

	.room-text-editor {
		position: relative;
		display: flex;
		width: 100%;
		height: 100%;
		border: 0;
		outline: 1.5px solid #4f7cff;
		background: transparent;
		box-shadow: 0 0 0 1px rgba(79, 124, 255, 0.08);
	}

	.selection-handle {
		position: absolute;
		z-index: 2;
		width: 7px;
		height: 7px;
		border: 1px solid #4f7cff;
		background: white;
		transform: translate(-50%, -50%);
	}
	.handle-1 { left: 0; top: 0; }
	.handle-2 { left: 50%; top: 0; }
	.handle-3 { left: 100%; top: 0; }
	.handle-4 { left: 100%; top: 50%; }
	.handle-5 { left: 100%; top: 100%; }
	.handle-6 { left: 50%; top: 100%; }
	.handle-7 { left: 0; top: 100%; }
	.handle-8 { left: 0; top: 50%; }
	.handle-1, .handle-5 { cursor: nwse-resize; }
	.handle-3, .handle-7 { cursor: nesw-resize; }
	.handle-2, .handle-6 { cursor: ns-resize; }
	.handle-4, .handle-8 { cursor: ew-resize; }

	.room-text-editor--sticky {
		flex-direction: column;
		border: 0;
		outline: 1px solid rgba(171, 145, 56, 0.26);
		border-radius: 10px 10px 18px 10px;
		background: linear-gradient(135deg, #fffbea 0%, #fff3ba 100%);
		box-shadow: 0 7px 14px rgba(71, 59, 30, 0.18);
	}

	.room-text-editor--sticky::after {
		content: "";
		position: absolute;
		right: 0;
		bottom: 0;
		width: 26px;
		height: 26px;
		background: linear-gradient(135deg, rgba(221, 199, 110, 0.35) 0 48%, #fffdf4 52% 100%);
		border-radius: 9px 0 0 0;
		pointer-events: none;
	}

	.room-text-editor__input {
		flex: 1;
		width: 100%;
		min-height: 0;
		resize: none;
		border: 0;
		outline: 0;
		background: transparent;
		padding: 10px 12px;
		color: #172033;
		line-height: 1.5;
		letter-spacing: 0;
		font-kerning: none;
		font-variant-ligatures: none;
		word-break: break-all;
		overflow-wrap: anywhere;
		caret-color: #4f46e5;
	}
	.room-text-editor:not(.room-text-editor--sticky):not(.is-composing) .room-text-editor__input { -webkit-text-fill-color: transparent; }
	.room-text-editor.is-composing:not(.room-text-editor--sticky) { background: white; }
	.room-text-editor__input::placeholder { color: rgba(71, 85, 105, 0.42); }
	.room-text-editor--sticky .room-text-editor__input { caret-color: #b7791f; }

	.room-text-editor__footer {
		position: absolute;
		left: 0;
		right: 0;
		bottom: -48px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 12px 10px 20px;
		color: #8a7440;
		font: 600 11px/1.2 "Microsoft YaHei UI", sans-serif;
	}
	.room-text-editor__actions { display: flex; gap: 6px; margin-right: 24px; }
	.room-text-editor__actions button {
		display: grid;
		width: 28px;
		height: 28px;
		place-items: center;
		border: 0;
		border-radius: 8px;
		background: rgba(120, 98, 34, 0.1);
		color: #6b5b2a;
		cursor: pointer;
	}
	.room-text-editor__actions .confirm { background: #c28a22; color: white; }

	.text-editor-pop-enter-active,
	.text-editor-pop-leave-active { transition: opacity 120ms ease, transform 140ms ease; }
	.text-editor-pop-enter-from,
	.text-editor-pop-leave-to { opacity: 0; transform: translateY(3px) scale(0.99); }
</style>
