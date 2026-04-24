// File role: session plugin that activates benchmark runtime only for explicit benchmark/test runs.
import { watch, type Ref } from "vue";
import { canvasRef } from "../../service/canvas";
import { setRuntimeInstrumentationAdapter } from "../../instrumentation/runtimeInstrumentation";
import { renderPageContentFromPoints } from "../../service/canvas";
import {
	activateBenchmarkRuntime,
	benchmarkRuntimeInstrumentationAdapter,
	deactivateBenchmarkRuntime,
	setRuntimeSnapshot,
	shouldEnableBenchmarkRuntime,
} from "./benchmarkRuntime";
import type { Command } from "@collaborative-whiteboard/shared";
import type { EditorPlugin } from "../../utils/editorTypes";

interface BenchmarkPluginOptions {
	commands: Ref<Command[]>;
	currentColor: Ref<string>;
}

export const createBenchmarkPlugin = (
	options: BenchmarkPluginOptions
): EditorPlugin => ({
	name: "benchmark",
	setup(host) {
		activateBenchmarkRuntime({
			getMainCanvas: () => canvasRef.value,
			commands: options.commands as Ref<Array<{ id: string }>>,
			currentColor: options.currentColor,
			exposeGlobals: true,
			debugLogs: false,
		});
		setRuntimeInstrumentationAdapter(benchmarkRuntimeInstrumentationAdapter);
		if (typeof window !== "undefined") {
			window.__benchmarkRenderPageContentFromPoints =
				renderPageContentFromPoints as unknown as typeof window.__benchmarkRenderPageContentFromPoints;
			window.__benchmarkRunMicroRender = async () => {
				const sampleCanvasSignature = (canvas: HTMLCanvasElement) => {
					const context = canvas.getContext("2d", { willReadFrequently: true });
					if (!context) return "";
					const parts: number[] = [];
					const sampleSize = 8;
					const stepX = Math.max(1, Math.floor(canvas.width / sampleSize));
					const stepY = Math.max(1, Math.floor(canvas.height / sampleSize));
					for (let row = 0; row < sampleSize; row += 1) {
						for (let col = 0; col < sampleSize; col += 1) {
							const x = Math.min(canvas.width - 1, col * stepX);
							const y = Math.min(canvas.height - 1, row * stepY);
							const data = context.getImageData(x, y, 1, 1).data;
							parts.push(data[0] || 0, data[1] || 0, data[2] || 0, data[3] || 0);
						}
					}
					return parts.join("-");
				};

				const canvas = document.createElement("canvas");
				canvas.width = 1280;
				canvas.height = 720;
				canvas.style.position = "fixed";
				canvas.style.left = "0";
				canvas.style.top = "0";
				canvas.style.pointerEvents = "none";
				document.body.appendChild(canvas);
				const context = canvas.getContext("2d");
				if (!context) {
					canvas.remove();
					return {
						microAppRenderMs: 0,
						microVisiblePaintMs: 0,
						microPoints: 0,
						microCostPerPoint: 0,
					};
				}

				const points = Array.from({ length: 2000 }).map((_, index) => ({
					x: ((index % 100) + 20) / 1280,
					y: (Math.floor(index / 100) + 20) / 720,
					p: 0.6,
					cmdId: `micro-${Math.floor(index / 25)}`,
					userId: "benchmark-micro",
					color: "#111111",
					size: 3,
					tool: "pen",
					isDeleted: false,
					lamport: index + 1,
				}));

				const beforeSignature = sampleCanvasSignature(canvas);
				const startedAt = performance.now();
				renderPageContentFromPoints(context, 1280, 720, points as any);
				const microAppRenderMs = performance.now() - startedAt;
				const commitTs = performance.now();
				await new Promise<void>((resolve) => {
					requestAnimationFrame(() => {
						requestAnimationFrame(() => resolve());
					});
				});
				const afterSignature = sampleCanvasSignature(canvas);
				const microVisiblePaintMs = performance.now() - commitTs;
				canvas.remove();

				return {
					microAppRenderMs,
					microVisiblePaintMs: beforeSignature === afterSignature ? 0 : microVisiblePaintMs,
					microPoints: points.length,
					microCostPerPoint: points.length > 0 ? microAppRenderMs / points.length : 0,
				};
			};
		}

		const stopCommandWatch = watch(
			() => options.commands.value,
			(commands) => {
				setRuntimeSnapshot({
					commandCount: commands.length,
					currentPageId: host.state.currentPageId.value,
					totalPages: host.state.totalPages.value,
					lastCommandDigest: commands.map((command) => command.id).join(",").substring(0, 200),
				});
			},
			{ deep: false, immediate: true }
		);

		const stopPageWatch = watch(
			() => host.state.currentPageId.value,
			(pageId) => {
				setRuntimeSnapshot({
					currentPageId: pageId,
					totalPages: host.state.totalPages.value,
				});
			},
			{ immediate: true }
		);

		const stopPageCountWatch = watch(
			() => host.state.totalPages.value,
			(totalPages) => {
				setRuntimeSnapshot({
					currentPageId: host.state.currentPageId.value,
					totalPages,
				});
			},
			{ immediate: true }
		);

		return () => {
			stopCommandWatch();
			stopPageWatch();
			stopPageCountWatch();
			if (typeof window !== "undefined") {
				delete window.__benchmarkRenderPageContentFromPoints;
				delete window.__benchmarkRunMicroRender;
			}
			setRuntimeInstrumentationAdapter(null);
			deactivateBenchmarkRuntime();
		};
	},
});

export { shouldEnableBenchmarkRuntime };
