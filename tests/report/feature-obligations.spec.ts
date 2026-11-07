import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { EXTERNAL_CASES } from "../catalog/external-cases";

type FeatureObligation = {
	id: string;
	kind: "http" | "ws" | "scene" | "frontend";
	surface: string;
	state: "obligation_verified" | "partial" | "uncovered" | "rejection_contract_verified";
	oracle: string;
	evidence: string[];
};

const catalog = JSON.parse(
	readFileSync(new URL("../catalog/feature-obligations.json", import.meta.url), "utf8")
) as { schemaVersion: number; scope: string; obligations: FeatureObligation[] };
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

const findNode = <T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T | undefined => {
	let result: T | undefined;
	const visit = (node: ts.Node) => {
		if (predicate(node)) {
			result = node;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(root);
	return result;
};

const property = (object: ts.ObjectLiteralExpression, name: string) => object.properties.find((entry): entry is ts.PropertyAssignment =>
	ts.isPropertyAssignment(entry) &&
	((ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === name)
);

const stringValue = (node: ts.Expression | undefined) =>
	node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

const readTypeScript = (relativePath: string) => {
	const fullPath = path.join(projectRoot, relativePath);
	return ts.createSourceFile(fullPath, readFileSync(fullPath, "utf8"), ts.ScriptTarget.Latest, true);
};

const frontendSourceSurfaces = () => {
	const router = readTypeScript("apps/frontend/src/router/index.ts");
	const routerDeclaration = findNode(router, (node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "router"
	);
	const routerCall = routerDeclaration?.initializer;
	const routerOptions = routerCall && ts.isCallExpression(routerCall) ? routerCall.arguments[0] : undefined;
	const routeValue = routerOptions && ts.isObjectLiteralExpression(routerOptions) ? property(routerOptions, "routes")?.initializer : undefined;
	const routeArray = routeValue && ts.isArrayLiteralExpression(routeValue) ? routeValue : undefined;
	const routes = (routeArray?.elements || []).flatMap((entry) => {
		if (!ts.isObjectLiteralExpression(entry)) return [];
		const routePath = property(entry, "path");
		const value = routePath && ts.isPropertyAssignment(routePath) ? stringValue(routePath.initializer) : undefined;
		return value === undefined ? [] : [`route:${value}`];
	});

	const toolsSource = readTypeScript("apps/frontend/src/scene/toolRegistry.ts");
	const toolsDeclaration = findNode(toolsSource, (node): node is ts.VariableDeclaration =>
		ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "tools"
	);
	const toolsValue = toolsDeclaration?.initializer;
	const toolArray = toolsValue && ts.isArrayLiteralExpression(toolsValue) ? toolsValue : undefined;
	const tools = (toolArray?.elements || []).flatMap((entry) => {
		if (!ts.isObjectLiteralExpression(entry)) return [];
		const idProperty = property(entry, "id");
		const id = idProperty && ts.isPropertyAssignment(idProperty) ? stringValue(idProperty.initializer) : undefined;
		return id === undefined ? [] : [`tool:${id}`];
	});
	return [...routes, ...tools].sort();
};

describe("feature obligation catalog", () => {
	it("has unique, observable obligations and valid evidence references", () => {
		const ids = catalog.obligations.map((obligation) => obligation.id);
		const externalIDs = new Set(Object.values(EXTERNAL_CASES).map((testCase) => testCase.id));
		const errors: string[] = [];

		if (catalog.schemaVersion !== 1) errors.push(`unsupported schema version ${catalog.schemaVersion}`);
		if (!catalog.scope.trim()) errors.push("catalog scope must be explicit");
		if (new Set(ids).size !== ids.length) errors.push("surface ids must be unique");
		for (const obligation of catalog.obligations) {
			if (!obligation.id.trim() || !obligation.surface.trim() || !obligation.oracle.trim()) {
				errors.push(`${obligation.id || "<missing id>"}: surface and observable oracle are required`);
			}
			for (const reference of obligation.evidence) {
				const [kind, name] = reference.split(":", 2);
				if (kind === "external" && !externalIDs.has(name)) errors.push(`${obligation.id}: unknown external case ${name}`);
				else if (kind !== "external" && kind !== "go") errors.push(`${obligation.id}: unsupported evidence kind ${kind}`);
			}
		}

		expect(errors).toEqual([]);
	});

	it("keeps every currently exposed backend surface represented", () => {
		const counts = catalog.obligations.reduce<Record<string, Set<string>>>((result, obligation) => {
			result[obligation.kind] ??= new Set();
			result[obligation.kind]!.add(obligation.surface);
			return result;
		}, {} as Record<string, Set<string>>);

		expect(counts.http?.size).toBe(26);
		expect(counts.ws?.size).toBe(15);
		expect(counts.scene?.size).toBe(9);
		expect(counts.frontend?.size).toBe(17);
	});

	it("matches frontend routes and registered tools from TypeScript ASTs", () => {
		const registered = [...new Set(catalog.obligations.filter((obligation) => obligation.kind === "frontend").map((obligation) => obligation.surface))].sort();
		expect(registered).toEqual(frontendSourceSurfaces());
	});
});
