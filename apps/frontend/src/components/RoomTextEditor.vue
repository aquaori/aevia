<script setup lang="ts">
	import { computed, nextTick, onBeforeUnmount, ref } from "vue";
	import { AlignCenter, AlignLeft, AlignRight, Bold, Check, Minus, Plus, X } from "lucide-vue-next";
	import type { SceneElementStyle, aabbBox } from "@collaborative-whiteboard/shared";

	type TextKind = "text" | "sticky";
	type TextAlign = NonNullable<SceneElementStyle["textAlign"]>;

	const visible = ref(false);
	const draft = ref("");
	const kind = ref<TextKind>("text");
	const editorStyle = ref<Record<string, string>>({});
	const textarea = ref<HTMLTextAreaElement | null>(null);
	const fontFamily = ref("Aevia Sans, Inter, sans-serif");
	const fontSize = ref(20);
	const fontWeight = ref<400 | 700>(400);
	const textAlign = ref<TextAlign>("left");
	let composing: boolean = false;
	let resolveRequest: ((value: string | null) => void) | null = null;
	let changeListener: ((value: string, reason: "input" | "ime") => void) | null = null;
	let styleListener: ((style: Partial<SceneElementStyle>) => void) | null = null;
	let activeElementId: string | null = null;
	let groupBoundaryListener: (() => void) | null = null;

	const inputStyle = computed(() => ({
		fontFamily: fontFamily.value,
		fontSize: `${fontSize.value}px`,
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
		resolve?.(value);
	};

	const submit = () => close(draft.value.trim() ? draft.value : null);
	const cancel = () => close(null);

	const handleKeydown = (event: KeyboardEvent) => {
		if (composing) return;
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
		if (composing) return;
		changeListener?.((event.target as HTMLTextAreaElement).value, "input");
	};
	const handleCompositionStart = () => {
		composing = true;
	};

	const handleCompositionEnd = (event: CompositionEvent) => {
		composing = false;
		changeListener?.((event.target as HTMLTextAreaElement).value, "ime");
	};

	const open = (input: {
		kind: TextKind;
		elementId: string;
		box: aabbBox;
		initialText?: string;
		initialStyle?: Partial<SceneElementStyle>;
		onChange?: (value: string, reason: "input" | "ime") => void;
		onStyleChange?: (style: Partial<SceneElementStyle>) => void;
		onGroupBoundary?: () => void;
	}) => {
		if (resolveRequest) resolveRequest(null);
		kind.value = input.kind;
		draft.value = input.initialText ?? "";
		changeListener = input.onChange ?? null;
		styleListener = input.onStyleChange ?? null;
		activeElementId = input.elementId;
		groupBoundaryListener = input.onGroupBoundary ?? null;
		fontFamily.value = input.initialStyle?.fontFamily ?? "Aevia Sans, Inter, sans-serif";
		fontSize.value = input.initialStyle?.fontSize ?? 20;
		fontWeight.value = input.initialStyle?.fontWeight ?? 400;
		textAlign.value = input.initialStyle?.textAlign ?? "left";

		const viewportWidth = Math.max(1, window.innerWidth);
		const viewportHeight = Math.max(1, window.innerHeight);
		const minimumWidth = input.kind === "sticky" ? 260 : 180;
		const minimumHeight = input.kind === "sticky" ? 190 : 80;
		const width = Math.min(viewportWidth - 24, Math.max(minimumWidth, input.box.width * viewportWidth));
		const height = Math.min(viewportHeight - 24, Math.max(minimumHeight, input.box.height * viewportHeight));
		const left = Math.max(12, Math.min(input.box.minX * viewportWidth, viewportWidth - width - 12));
		const toolbarSpace = input.kind === "text" ? 54 : 12;
		const top = Math.max(toolbarSpace, Math.min(input.box.minY * viewportHeight, viewportHeight - height - 12));
		editorStyle.value = {
			left: `${left}px`,
			top: `${top}px`,
			width: `${width}px`,
			height: `${height}px`,
		};
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
	defineExpose({ open, notifyRemotePatch });
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
						<option value="Aevia Sans, Inter, sans-serif">默认字体</option>
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

				<div class="room-text-editor" :class="{ 'room-text-editor--sticky': kind === 'sticky' }">
					<span v-if="kind === 'text'" v-for="handle in 8" :key="handle" class="selection-handle" :class="`handle-${handle}`" aria-hidden="true"></span>
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
		border: 1.5px solid #4f7cff;
		background: rgba(255, 255, 255, 0.94);
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

	.room-text-editor--sticky {
		overflow: hidden;
		flex-direction: column;
		border: 1px solid rgba(171, 145, 56, 0.26);
		border-radius: 10px 10px 18px 10px;
		background: linear-gradient(145deg, #fffbea 0%, #fff3ba 100%);
		box-shadow: 0 18px 42px rgba(71, 59, 30, 0.18), 0 2px 8px rgba(71, 59, 30, 0.08);
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
		letter-spacing: 0.01em;
		caret-color: #4f46e5;
	}
	.room-text-editor__input::placeholder { color: rgba(71, 85, 105, 0.42); }
	.room-text-editor--sticky .room-text-editor__input { padding: 18px 20px 12px; color: #3d3520; caret-color: #b7791f; }

	.room-text-editor__footer {
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
