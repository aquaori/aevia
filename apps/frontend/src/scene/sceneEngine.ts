// File role: Canvas adapter for the canonical scene core.
import { compareRenderOrder, type AabbBox, type AffineMatrix, type RenderOrderKey } from "@collaborative-whiteboard/shared";
import { renderIRItems, renderIRItemsSteps } from "./canvasIRRenderer";
import { SceneCore } from "./sceneCore";
import type { DirtyRenderMetrics } from "./sceneTypes";
import type { RenderIRItem } from "./renderIR";

type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const DIRTY_PADDING = 20;
const PREFIX_CACHE_MIN_ATOMS = 512;
const PREFIX_TAIL_MARGIN = 256;
const PREFIX_ADVANCE_TAIL_LIMIT = 1024;
const EMPTY_ELEMENT_SET = new Set<string>();

interface SettledPrefixCache {
	canvas: OffscreenCanvas;
	ctx: OffscreenCanvasRenderingContext2D;
	pixelWidth: number;
	pixelHeight: number;
	logicalWidth: number;
	logicalHeight: number;
	maxOrder: RenderOrderKey;
	atomCount: number;
}

interface PendingPrefixRebuild {
	canvas: OffscreenCanvas;
	ctx: OffscreenCanvasRenderingContext2D;
	pixelWidth: number;
	pixelHeight: number;
	logicalWidth: number;
	logicalHeight: number;
	refs: number[];
	index: number;
	maxOrder: RenderOrderKey;
	tailCount: number;
}

const canvasTextMeasurer = () => {
	let context: DrawingContext | null | undefined;
	return (text: string, font: string) => {
		if (context === undefined) {
			context = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1).getContext("2d") : typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
		}
		if (!context) return Number.parseFloat(font.match(/([\d.]+)px/)?.[1] ?? "20");
		context.font = font;
		return context.measureText(text).width;
	};
};

export class SceneEngine extends SceneCore {
	private prefixCache: SettledPrefixCache | null = null;
	private prefixCacheValid = false;
	private preferTailMargin = false;
	private tailAtomsSinceRebuild = 0;
	private pendingPrefixRebuild: PendingPrefixRebuild | null = null;

	constructor() { super(canvasTextMeasurer()); }

	protected override onPrefixMayInvalidate(order?: RenderOrderKey, fullReset = false, fromAppend = false) {
		if (fullReset || !order) {
			this.prefixCacheValid = false;
			this.tailAtomsSinceRebuild = 0;
			this.pendingPrefixRebuild = null;
			if (fullReset) this.preferTailMargin = false;
			return;
		}
		if (this.pendingPrefixRebuild && compareRenderOrder(order, this.pendingPrefixRebuild.maxOrder) <= 0) {
			this.pendingPrefixRebuild = null;
		}
		if (!this.prefixCacheValid || !this.prefixCache) return;
		if (compareRenderOrder(order, this.prefixCache.maxOrder) <= 0) {
			this.prefixCacheValid = false;
			this.tailAtomsSinceRebuild = 0;
			this.preferTailMargin = fromAppend;
		} else if (fromAppend) {
			this.tailAtomsSinceRebuild += 1;
		}
	}

	override setLegacyCommandState(cmd: Parameters<SceneCore["setLegacyCommandState"]>[0]) {
		this.onPrefixMayInvalidate(undefined, true);
		super.setLegacyCommandState(cmd);
	}

	override removeElement(elementId: string) {
		const existing = this.elements.get(elementId);
		this.onPrefixMayInvalidate(existing ? { ...existing.createOrder, subIndex: -1 } : undefined, !existing);
		return super.removeElement(elementId);
	}

	override finishElement(elementId: string) {
		const existing = this.elements.get(elementId);
		if (
			existing &&
			existing.points.length === 1 &&
			(existing.descriptor.toolId === "pencil" || existing.descriptor.toolId === "highlighter")
		) {
			this.onPrefixMayInvalidate({ ...existing.createOrder, subIndex: -1 });
		}
		return super.finishElement(elementId);
	}

	hasValidPrefixCache() {
		return this.prefixCacheValid && this.prefixCache !== null;
	}

	lastAtomOrder(): RenderOrderKey | null {
		const ref = this.order.lastRef();
		return ref === undefined ? null : { ...this.atoms[ref]!.order };
	}

	// Only paint directly when every new pen atom sorts after all old atoms.
	// Otherwise existing pixels may need to cover it or a layer may need recomposition.
	renderNewPenAtomsOnTop(ctx: DrawingContext, firstRef: number, previousOrder: RenderOrderKey | null, width: number, height: number): boolean {
		const refs: number[] = [];
		for (let ref = firstRef; ref < this.atoms.length; ref += 1) refs.push(ref);
		if (refs.length === 0) return false;
		const items = Array.from(this.renderItemsForRefs(refs, EMPTY_ELEMENT_SET));
		if (items.length !== refs.length) return false;
		let last = previousOrder;
		for (const item of items) {
			if (item.atom.toolId !== "pen" || item.eraseMasks.length > 0 || item.erasedIntervals.length > 0 ||
				(last && compareRenderOrder(last, item.atom.order) >= 0)) return false;
			last = item.atom.order;
		}
		renderIRItems(ctx, items, width, height);
		return true;
	}

	renderFull(
		ctx: DrawingContext,
		logicalWidth: number,
		logicalHeight: number,
		excludedElementIds: ReadonlySet<string> = new Set(),
		clear = true
	) {
		if (clear) {
			const cached = this.canUsePrefixCache(ctx, logicalWidth, logicalHeight, excludedElementIds)
				? this.prefixCache
				: null;
			if (cached) {
				ctx.save();
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
				ctx.drawImage(cached.canvas, 0, 0);
				ctx.restore();
				const tailRefs: number[] = [];
				this.order.forEach((ref) => {
					const atom = this.atoms[ref];
					if (atom && compareRenderOrder(atom.order, cached.maxOrder) > 0) tailRefs.push(ref);
				});
				const tailPainted = this.renderAtomRefs(ctx, tailRefs, logicalWidth, logicalHeight, excludedElementIds);
				if (this.tailAtomsSinceRebuild >= PREFIX_ADVANCE_TAIL_LIMIT) {
					this.advancePrefixCache(ctx, logicalWidth, logicalHeight);
				}
				return cached.atomCount + tailPainted;
			}
			this.clearContext(ctx, logicalWidth, logicalHeight);
		}
		const refs: number[] = [];
		this.order.forEach((ref) => refs.push(ref));
		if (clear && this.canSnapshotFullScene(excludedElementIds) && refs.length >= PREFIX_CACHE_MIN_ATOMS + PREFIX_TAIL_MARGIN) {
			const split = this.splitIndexForTailMargin(refs);
			if (split > 0) {
				const prefixPainted = this.renderAtomRefs(ctx, refs.slice(0, split), logicalWidth, logicalHeight, excludedElementIds);
				this.capturePrefixCacheFromCanvas(
					ctx,
					logicalWidth,
					logicalHeight,
					{ ...this.atoms[refs[split - 1]!]!.order },
					split,
					refs.length - split
				);
				const tailPainted = this.renderAtomRefs(ctx, refs.slice(split), logicalWidth, logicalHeight, excludedElementIds);
				return prefixPainted + tailPainted;
			}
		}
		const painted = this.renderAtomRefs(ctx, refs, logicalWidth, logicalHeight, excludedElementIds);
		if (clear && this.canSnapshotFullScene(excludedElementIds)) {
			this.capturePrefixCacheFromCanvas(ctx, logicalWidth, logicalHeight);
		}
		return painted;
	}

	*renderFullSteps(ctx: DrawingContext, logicalWidth: number, logicalHeight: number, excludedElementIds: ReadonlySet<string> = new Set()): Generator<void, number> {
		this.clearContext(ctx, logicalWidth, logicalHeight);
		if (this.canSnapshotFullScene(excludedElementIds)) {
			const orderedRefs: number[] = [];
			this.order.forEach((ref) => orderedRefs.push(ref));
			const split = orderedRefs.length >= PREFIX_CACHE_MIN_ATOMS + PREFIX_TAIL_MARGIN
				? this.splitIndexForTailMargin(orderedRefs)
				: 0;
			if (split > 0) {
				let painted = 0;
				for (let index = 0; index < split; index += 256) {
					const chunk = orderedRefs.slice(index, Math.min(split, index + 256));
					painted += yield* renderIRItemsSteps(
						ctx,
						this.renderItemsForRefs(chunk, excludedElementIds),
						logicalWidth,
						logicalHeight,
						null,
						Infinity
					);
					yield;
				}
				this.capturePrefixCacheFromCanvas(
					ctx,
					logicalWidth,
					logicalHeight,
					{ ...this.atoms[orderedRefs[split - 1]!]!.order },
					split,
					orderedRefs.length - split
				);
				for (let index = split; index < orderedRefs.length; index += 256) {
					const chunk = orderedRefs.slice(index, Math.min(orderedRefs.length, index + 256));
					painted += yield* renderIRItemsSteps(
						ctx,
						this.renderItemsForRefs(chunk, excludedElementIds),
						logicalWidth,
						logicalHeight,
						null,
						Infinity
					);
					if (index + 256 < orderedRefs.length) yield;
				}
				return painted;
			}
		}
		const painted = yield* renderIRItemsSteps(ctx, this.fullRenderItemsInSteps(excludedElementIds), logicalWidth, logicalHeight, null, Infinity);
		if (this.canSnapshotFullScene(excludedElementIds)) {
			this.capturePrefixCacheFromCanvas(ctx, logicalWidth, logicalHeight);
		}
		return painted;
	}

	private *fullRenderItemsInSteps(excludedElementIds: ReadonlySet<string>): Generator<RenderIRItem | null> {
		let refs: number[] = [];
		for (const ref of this.order.refs()) {
			refs.push(ref);
			if (refs.length < 256) continue;
			yield* this.renderItemsForRefs(refs, excludedElementIds);
			refs = [];
			yield null;
		}
		yield* this.renderItemsForRefs(refs, excludedElementIds);
	}

	renderAtomRefs(
		ctx: DrawingContext,
		refs: number[],
		logicalWidth: number,
		logicalHeight: number,
		excludedElementIds: ReadonlySet<string> = new Set(),
		deltaMatrix: AffineMatrix | null = null
	) {
		return renderIRItems(ctx, this.renderItemsForRefs(refs, excludedElementIds), logicalWidth, logicalHeight, deltaMatrix);
	}

	renderElements(
		ctx: DrawingContext,
		elementIds: ReadonlySet<string>,
		deltaMatrix: AffineMatrix | null,
		logicalWidth: number,
		logicalHeight: number
	) {
		const refs: number[] = [];
		this.order.forEach((ref) => {
			const atom = this.atoms[ref];
			if (atom && elementIds.has(atom.elementId)) refs.push(ref);
		});
		return this.renderAtomRefs(ctx, refs, logicalWidth, logicalHeight, new Set(), deltaMatrix);
	}

	renderDirty(
		ctx: DrawingContext,
		dirtyRect: AabbBox,
		logicalWidth: number,
		logicalHeight: number,
		excludedElementIds: ReadonlySet<string> = new Set()
	): DirtyRenderMetrics {
		return this.renderDirtyRegions(ctx, [dirtyRect], logicalWidth, logicalHeight, excludedElementIds);
	}

	renderDirtyRegions(
		ctx: DrawingContext,
		dirtyRects: AabbBox[],
		logicalWidth: number,
		logicalHeight: number,
		excludedElementIds: ReadonlySet<string> = new Set()
	): DirtyRenderMetrics {
		if (dirtyRects.length === 0) return { mode: "dirty", gridCells: 0, candidateChunks: 0, candidateAtoms: 0, renderedAtoms: 0 };
		this.dirtyRegions.clear();
		for (const dirtyRect of dirtyRects) {
			const padding = this.maxStrokeWidth * 2;
			this.dirtyRegions.add({
				minX: dirtyRect.minX - padding, minY: dirtyRect.minY - padding,
				maxX: dirtyRect.maxX + padding, maxY: dirtyRect.maxY + padding,
				width: dirtyRect.width + padding * 2, height: dirtyRect.height + padding * 2,
			});
		}
		const regions = this.dirtyRegions.toArray().map((dirtyRect) => {
			// Clear, clip and candidate lookup must cover the same pixel-aligned area.
			// Otherwise a narrow redraw can erase parts of neighbouring strokes.
			const scaleX = ctx.canvas.width / logicalWidth;
			const scaleY = ctx.canvas.height / logicalHeight;
			const minX = Math.floor((dirtyRect.minX - DIRTY_PADDING) * scaleX) / scaleX;
			const minY = Math.floor((dirtyRect.minY - DIRTY_PADDING) * scaleY) / scaleY;
			const maxX = Math.ceil((dirtyRect.maxX + DIRTY_PADDING) * scaleX) / scaleX;
			const maxY = Math.ceil((dirtyRect.maxY + DIRTY_PADDING) * scaleY) / scaleY;
			const paintRect = { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
			return { dirtyRect: paintRect, ...this.queryDirtyCandidates(paintRect, logicalWidth, logicalHeight, excludedElementIds, false) };
		});
		if (!this.prefixCacheValid && this.preferTailMargin && this.canSnapshotFullScene(excludedElementIds)) {
			this.stepPrefixCacheRebuildWithTailMargin(ctx, logicalWidth, logicalHeight);
		}
		const activePrefix = this.canUsePrefixCache(ctx, logicalWidth, logicalHeight, excludedElementIds)
			? this.prefixCache
			: null;
		const uniqueCandidates = new Set<number>();
		const uniqueTailCandidates = activePrefix ? new Set<number>() : null;
		for (const region of regions) {
			for (const ref of region.candidateRefs) {
				uniqueCandidates.add(ref);
				if (uniqueTailCandidates && activePrefix) {
					const atom = this.atoms[ref];
					if (atom && compareRenderOrder(atom.order, activePrefix.maxOrder) > 0) uniqueTailCandidates.add(ref);
				}
			}
		}
		const gridCells = regions.reduce((sum, region) => sum + region.gridCells, 0);
		const candidateChunks = regions.reduce((sum, region) => sum + region.candidateChunks, 0);
		const effectiveCandidates = uniqueTailCandidates ? uniqueTailCandidates.size : uniqueCandidates.size;
		this.dirtyFullMode = this.dirtyRegions.shouldRenderFull(
			logicalWidth,
			logicalHeight,
			effectiveCandidates,
			this.visibleAtomCount,
			this.dirtyFullMode
		);
		if (this.dirtyFullMode) {
			const renderedAtoms = this.renderFull(ctx, logicalWidth, logicalHeight, excludedElementIds);
			return { mode: "full", gridCells, candidateChunks, candidateAtoms: uniqueCandidates.size, renderedAtoms };
		}

		const scaleX = ctx.canvas.width / Math.max(1, logicalWidth);
		const scaleY = ctx.canvas.height / Math.max(1, logicalHeight);

		let renderedAtoms = 0;
		for (const region of regions) {
			const dirtyRect = region.dirtyRect;
			const rawRefs = activePrefix
				? region.candidateRefs.filter((ref) => {
						const atom = this.atoms[ref];
						return Boolean(atom && compareRenderOrder(atom.order, activePrefix.maxOrder) > 0);
				  })
				: region.candidateRefs;
			const refs = this.orderDirtyCandidates(rawRefs);
			ctx.save();
			ctx.beginPath();
			ctx.clearRect(dirtyRect.minX, dirtyRect.minY, dirtyRect.width, dirtyRect.height);
			ctx.rect(dirtyRect.minX, dirtyRect.minY, dirtyRect.width, dirtyRect.height);
			ctx.clip();
			if (activePrefix) {
				const sx = Math.max(0, Math.floor(dirtyRect.minX * scaleX) - 1);
				const sy = Math.max(0, Math.floor(dirtyRect.minY * scaleY) - 1);
				const ex = Math.min(activePrefix.pixelWidth, Math.ceil(dirtyRect.maxX * scaleX) + 1);
				const ey = Math.min(activePrefix.pixelHeight, Math.ceil(dirtyRect.maxY * scaleY) + 1);
				const sw = Math.max(0, ex - sx);
				const sh = Math.max(0, ey - sy);
				if (sw > 0 && sh > 0) {
					ctx.save();
					ctx.setTransform(1, 0, 0, 1, 0, 0);
					ctx.drawImage(activePrefix.canvas, sx, sy, sw, sh, sx, sy, sw, sh);
					ctx.restore();
				}
			}
			renderedAtoms += this.renderAtomRefs(ctx, refs, logicalWidth, logicalHeight, excludedElementIds);
			ctx.restore();
		}
		if (this.canSnapshotFullScene(excludedElementIds)) {
			if (!this.prefixCacheValid && !this.preferTailMargin) {
				this.capturePrefixCacheFromCanvas(ctx, logicalWidth, logicalHeight);
			} else if (this.prefixCacheValid && this.tailAtomsSinceRebuild >= PREFIX_ADVANCE_TAIL_LIMIT) {
				this.advancePrefixCache(ctx, logicalWidth, logicalHeight);
			}
		}
		return { mode: "dirty", gridCells, candidateChunks, candidateAtoms: uniqueCandidates.size, renderedAtoms };
	}

	private canSnapshotFullScene(excludedElementIds: ReadonlySet<string>) {
		return (
			excludedElementIds.size === 0 &&
			!this.bulkLoading &&
			!this.needsResync &&
			!this.hasPendingDependencies() &&
			!this.hasQuarantinedElements() &&
			this.visibleAtomCount >= PREFIX_CACHE_MIN_ATOMS
		);
	}

	private canUsePrefixCache(
		ctx: DrawingContext,
		logicalWidth: number,
		logicalHeight: number,
		excludedElementIds: ReadonlySet<string>
	) {
		return (
			this.prefixCacheValid &&
			this.prefixCache !== null &&
			excludedElementIds.size === 0 &&
			!this.bulkLoading &&
			!this.needsResync &&
			!this.hasPendingDependencies() &&
			!this.hasQuarantinedElements() &&
			ctx.canvas.width === this.prefixCache.pixelWidth &&
			ctx.canvas.height === this.prefixCache.pixelHeight &&
			logicalWidth === this.prefixCache.logicalWidth &&
			logicalHeight === this.prefixCache.logicalHeight
		);
	}

	private ensurePrefixCacheTarget(pixelWidth: number, pixelHeight: number) {
		if (typeof OffscreenCanvas === "undefined" || pixelWidth <= 0 || pixelHeight <= 0) return null;
		let canvas = this.prefixCache?.canvas ?? null;
		let cacheCtx = this.prefixCache?.ctx ?? null;
		if (!canvas || canvas.width !== pixelWidth || canvas.height !== pixelHeight || !cacheCtx) {
			canvas = new OffscreenCanvas(pixelWidth, pixelHeight);
			cacheCtx = canvas.getContext("2d");
		}
		if (!cacheCtx || typeof cacheCtx.drawImage !== "function") return null;
		return { canvas, ctx: cacheCtx };
	}

	private capturePrefixCacheFromCanvas(
		ctx: DrawingContext,
		logicalWidth: number,
		logicalHeight: number,
		maxOrderOverride?: RenderOrderKey,
		atomCountOverride?: number,
		tailCountOverride = 0
	) {
		const pixelWidth = ctx.canvas.width;
		const pixelHeight = ctx.canvas.height;
		const maxOrder = maxOrderOverride ?? this.lastAtomOrder();
		if (!maxOrder) return false;
		const target = this.ensurePrefixCacheTarget(pixelWidth, pixelHeight);
		if (!target) return false;
		target.ctx.save();
		target.ctx.setTransform(1, 0, 0, 1, 0, 0);
		target.ctx.clearRect(0, 0, pixelWidth, pixelHeight);
		target.ctx.drawImage(ctx.canvas, 0, 0);
		target.ctx.restore();
		this.prefixCache = {
			canvas: target.canvas,
			ctx: target.ctx,
			pixelWidth,
			pixelHeight,
			logicalWidth,
			logicalHeight,
			maxOrder,
			atomCount: atomCountOverride ?? this.visibleAtomCount,
		};
		this.prefixCacheValid = true;
		this.preferTailMargin = false;
		this.pendingPrefixRebuild = null;
		this.tailAtomsSinceRebuild = tailCountOverride;
		return true;
	}

	private splitIndexForTailMargin(orderedRefs: number[]) {
		const margin = Math.min(PREFIX_TAIL_MARGIN, Math.floor(orderedRefs.length / 4));
		let split = Math.max(1, orderedRefs.length - margin);
		while (
			split > 0 &&
			split < orderedRefs.length &&
			compareRenderOrder(this.atoms[orderedRefs[split - 1]!]!.order, this.atoms[orderedRefs[split]!]!.order) === 0
		) {
			split -= 1;
		}
		return split;
	}

	private advancePrefixCache(ctx: DrawingContext, logicalWidth: number, logicalHeight: number) {
		const cached = this.prefixCache;
		if (
			!this.prefixCacheValid ||
			!cached ||
			cached.pixelWidth !== ctx.canvas.width ||
			cached.pixelHeight !== ctx.canvas.height ||
			cached.logicalWidth !== logicalWidth ||
			cached.logicalHeight !== logicalHeight
		) {
			return false;
		}
		const afterRefs: number[] = [];
		this.order.forEach((ref) => {
			const atom = this.atoms[ref];
			const element = atom ? this.elements.get(atom.elementId) : undefined;
			if (
				atom &&
				compareRenderOrder(atom.order, cached.maxOrder) > 0 &&
				this.isAtomVisible(atom, element, EMPTY_ELEMENT_SET)
			) {
				afterRefs.push(ref);
			}
		});
		if (afterRefs.length <= PREFIX_TAIL_MARGIN) {
			this.tailAtomsSinceRebuild = afterRefs.length;
			return true;
		}
		let settleEnd = afterRefs.length - PREFIX_TAIL_MARGIN;
		while (
			settleEnd > 0 &&
			settleEnd < afterRefs.length &&
			compareRenderOrder(this.atoms[afterRefs[settleEnd - 1]!]!.order, this.atoms[afterRefs[settleEnd]!]!.order) === 0
		) {
			settleEnd -= 1;
		}
		if (settleEnd <= 0) return false;
		const newlySettled = afterRefs.slice(0, settleEnd);
		const scaleX = cached.pixelWidth / Math.max(1, logicalWidth);
		const scaleY = cached.pixelHeight / Math.max(1, logicalHeight);
		cached.ctx.save();
		cached.ctx.setTransform(1, 0, 0, 1, 0, 0);
		cached.ctx.scale(scaleX, scaleY);
		cached.ctx.lineCap = "round";
		cached.ctx.lineJoin = "round";
		this.renderAtomRefs(cached.ctx, newlySettled, logicalWidth, logicalHeight, EMPTY_ELEMENT_SET);
		cached.ctx.restore();
		cached.maxOrder = { ...this.atoms[newlySettled[newlySettled.length - 1]!]!.order };
		cached.atomCount += newlySettled.length;
		this.tailAtomsSinceRebuild = afterRefs.length - settleEnd;
		return true;
	}

	private stepPrefixCacheRebuildWithTailMargin(ctx: DrawingContext, logicalWidth: number, logicalHeight: number) {
		const pixelWidth = ctx.canvas.width;
		const pixelHeight = ctx.canvas.height;
		let rebuild = this.pendingPrefixRebuild;
		if (
			!rebuild ||
			rebuild.pixelWidth !== pixelWidth ||
			rebuild.pixelHeight !== pixelHeight ||
			rebuild.logicalWidth !== logicalWidth ||
			rebuild.logicalHeight !== logicalHeight
		) {
			const visibleRefs: number[] = [];
			this.order.forEach((ref) => {
				const atom = this.atoms[ref];
				const element = atom ? this.elements.get(atom.elementId) : undefined;
				if (atom && this.isAtomVisible(atom, element, EMPTY_ELEMENT_SET)) visibleRefs.push(ref);
			});
			if (visibleRefs.length < PREFIX_CACHE_MIN_ATOMS) return false;
			const split = this.splitIndexForTailMargin(visibleRefs);
			if (split <= 0) return false;
			const target = this.ensurePrefixCacheTarget(pixelWidth, pixelHeight);
			if (!target) return false;
			target.ctx.save();
			target.ctx.setTransform(1, 0, 0, 1, 0, 0);
			target.ctx.clearRect(0, 0, pixelWidth, pixelHeight);
			target.ctx.restore();
			rebuild = {
				canvas: target.canvas,
				ctx: target.ctx,
				pixelWidth,
				pixelHeight,
				logicalWidth,
				logicalHeight,
				refs: visibleRefs.slice(0, split),
				index: 0,
				maxOrder: { ...this.atoms[visibleRefs[split - 1]!]!.order },
				tailCount: visibleRefs.length - split,
			};
			this.pendingPrefixRebuild = rebuild;
		}
		const batchEnd = rebuild.refs.length <= 2048 ? rebuild.refs.length : Math.min(rebuild.refs.length, rebuild.index + 512);
		const scaleX = pixelWidth / Math.max(1, logicalWidth);
		const scaleY = pixelHeight / Math.max(1, logicalHeight);
		rebuild.ctx.save();
		rebuild.ctx.setTransform(1, 0, 0, 1, 0, 0);
		rebuild.ctx.scale(scaleX, scaleY);
		rebuild.ctx.lineCap = "round";
		rebuild.ctx.lineJoin = "round";
		this.renderAtomRefs(rebuild.ctx, rebuild.refs.slice(rebuild.index, batchEnd), logicalWidth, logicalHeight, EMPTY_ELEMENT_SET);
		rebuild.ctx.restore();
		rebuild.index = batchEnd;
		if (rebuild.index < rebuild.refs.length) return false;
		this.prefixCache = {
			canvas: rebuild.canvas,
			ctx: rebuild.ctx,
			pixelWidth,
			pixelHeight,
			logicalWidth,
			logicalHeight,
			maxOrder: rebuild.maxOrder,
			atomCount: rebuild.refs.length,
		};
		this.pendingPrefixRebuild = null;
		this.prefixCacheValid = true;
		this.preferTailMargin = false;
		this.tailAtomsSinceRebuild = rebuild.tailCount;
		return true;
	}

	private orderDirtyCandidates(refs: number[]) {
		// Dense regions benefit from scanning the existing order rather than
		// comparing many candidates; sparse regions should not scan the scene.
		if (refs.length >= 2048 && refs.length >= this.atoms.length * 0.25) {
			const selected = new Set(refs);
			const ordered: number[] = [];
			for (const ref of this.order.refs()) if (selected.has(ref)) ordered.push(ref);
			return ordered;
		}
		refs.sort((left, right) => compareRenderOrder(this.atoms[left]!.order, this.atoms[right]!.order));
		return refs;
	}

	private clearContext(ctx: DrawingContext, _width: number, _height: number) {
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
		ctx.restore();
	}
}
