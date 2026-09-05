// File role: declarative built-in tools that compile into the shared primitive recipes.
import type {
	ElementKind,
	PrimitiveRecipeId,
	SceneElementDescriptor,
	SceneElementStyle,
	ShapeKind,
} from "@collaborative-whiteboard/shared";

export type ToolInputMode = "freehand" | "shape" | "text" | "sticker" | "eraser" | "cursor";

export interface ToolDefinition {
	id: string;
	label: string;
	inputMode: ToolInputMode;
	elementKind?: ElementKind;
	recipeId?: PrimitiveRecipeId;
	shapeKind?: ShapeKind;
	defaultStyle?: Partial<SceneElementStyle>;
}

export class ToolRegistry {
	private readonly tools = new Map<string, ToolDefinition>();

	register(definition: ToolDefinition) {
		if (this.tools.has(definition.id)) throw new Error(`Tool already registered: ${definition.id}`);
		this.tools.set(definition.id, { ...definition });
		return () => this.tools.delete(definition.id);
	}

	get(id: string) {
		return this.tools.get(id);
	}

	list() {
		return Array.from(this.tools.values());
	}

	descriptor(id: string, style: SceneElementStyle): SceneElementDescriptor {
		const tool = this.tools.get(id);
		if (!tool?.elementKind || !tool.recipeId) throw new Error(`Tool cannot create elements: ${id}`);
		return {
			elementKind: tool.elementKind,
			toolId: tool.id,
			recipeId: tool.recipeId,
			shapeKind: tool.shapeKind,
			style: { ...tool.defaultStyle, ...style },
		};
	}
}

export const createBuiltinToolRegistry = () => {
	const registry = new ToolRegistry();
	const tools: ToolDefinition[] = [
		{ id: "cursor", label: "选择", inputMode: "cursor" },
		{ id: "pen", label: "钢笔", inputMode: "freehand", elementKind: "path", recipeId: "stroke" },
		{ id: "pencil", label: "铅笔", inputMode: "freehand", elementKind: "path", recipeId: "stroke", defaultStyle: { opacity: 0.78 } },
		{ id: "highlighter", label: "荧光笔", inputMode: "freehand", elementKind: "path", recipeId: "stroke", defaultStyle: { opacity: 0.32 } },
		{ id: "eraser", label: "路径橡皮", inputMode: "eraser" },
		{ id: "object-eraser", label: "对象橡皮", inputMode: "eraser" },
		{ id: "line", label: "直线", inputMode: "shape", elementKind: "shape", recipeId: "shape", shapeKind: "line" },
		{ id: "arrow", label: "箭头", inputMode: "shape", elementKind: "shape", recipeId: "shape", shapeKind: "arrow" },
		{ id: "rectangle", label: "矩形", inputMode: "shape", elementKind: "shape", recipeId: "shape", shapeKind: "rectangle" },
		{ id: "rounded-rectangle", label: "圆角矩形", inputMode: "shape", elementKind: "shape", recipeId: "shape", shapeKind: "rounded-rectangle" },
		{ id: "ellipse", label: "椭圆", inputMode: "shape", elementKind: "shape", recipeId: "shape", shapeKind: "ellipse" },
		{ id: "text", label: "文字", inputMode: "text", elementKind: "text", recipeId: "glyph" },
		{ id: "sticky", label: "便签", inputMode: "text", elementKind: "sticky", recipeId: "glyph", defaultStyle: { fillColor: "#fff7cc", fontSize: 20 } },
		{ id: "sticker", label: "贴纸", inputMode: "sticker", elementKind: "sticker", recipeId: "bitmap" },
	];
	for (const tool of tools) registry.register(tool);
	return registry;
};

export const builtinToolRegistry = createBuiltinToolRegistry();
