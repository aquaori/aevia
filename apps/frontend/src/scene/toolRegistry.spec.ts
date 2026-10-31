import { describe, expect, it } from "vitest";
import type { SceneElementStyle } from "@collaborative-whiteboard/shared";
import { createBuiltinToolRegistry, builtinToolRegistry, ToolRegistry } from "./toolRegistry";

const style = (overrides: Partial<SceneElementStyle> = {}): SceneElementStyle => ({
	color: "#111111",
	size: 4,
	...overrides,
});

describe("tool registry", () => {
	it("registers the built-in tools once each", () => {
		const registry = createBuiltinToolRegistry();
		const ids = registry.list().map((tool) => tool.id);
		expect(ids).toContain("pen");
		expect(ids).toContain("eraser");
		expect(ids).toContain("text");
		expect(ids).toContain("sticker");
		expect(new Set(ids).size).toBe(ids.length);
		expect(registry.get("pen")).toMatchObject({
			inputMode: "freehand",
			elementKind: "path",
			recipeId: "stroke",
		});
		expect(builtinToolRegistry.get("sticker")).toMatchObject({ recipeId: "bitmap" });
	});

	it("rejects duplicate registrations and supports unregistering", () => {
		const registry = new ToolRegistry();
		registry.register({ id: "custom", label: "Custom", inputMode: "cursor" });
		expect(() => registry.register({ id: "custom", label: "Again", inputMode: "cursor" })).toThrow(
			"Tool already registered: custom"
		);

		const unregister = registry.register({ id: "temporary", label: "Temp", inputMode: "cursor" });
		expect(registry.get("temporary")).toBeDefined();
		unregister();
		expect(registry.get("temporary")).toBeUndefined();
	});

	it("builds descriptors by merging the tool defaults with the current style", () => {
		const registry = createBuiltinToolRegistry();
		const descriptor = registry.descriptor("pencil", style({ color: "#abcdef" }));

		expect(descriptor).toMatchObject({
			elementKind: "path",
			toolId: "pencil",
			recipeId: "stroke",
		});
		expect(descriptor.style).toEqual({ color: "#abcdef", size: 4, opacity: 0.78 });
		// The merged style is a copy, not a reference to the tool definition.
		descriptor.style.color = "#000000";
		expect(registry.descriptor("pencil", style()).style.color).toBe("#111111");

		const sticky = registry.descriptor("sticky", style({ size: 12 }));
		expect(sticky).toMatchObject({ elementKind: "sticky", recipeId: "glyph" });
		expect(sticky.style.fillColor).toBe("#fff7cc");
		expect(sticky.style.fontSize).toBe(20);
		expect(sticky.style.size).toBe(12);

		const rectangle = registry.descriptor("rectangle", style());
		expect(rectangle).toMatchObject({ elementKind: "shape", recipeId: "shape", shapeKind: "rectangle" });
	});

	it("refuses to build descriptors for non-creating tools", () => {
		const registry = createBuiltinToolRegistry();
		for (const toolId of ["cursor", "eraser", "object-eraser"]) {
			expect(() => registry.descriptor(toolId, style())).toThrow(
				`Tool cannot create elements: ${toolId}`
			);
		}
		expect(() => registry.descriptor("unknown-tool", style())).toThrow(
			"Tool cannot create elements: unknown-tool"
		);
	});
});
