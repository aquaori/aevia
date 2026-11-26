import { fileURLToPath } from "node:url";
import { mergeConfig, type Plugin } from "vite";
import ts from "typescript";
import app from "../../apps/frontend/vite.config";

const selected: Record<string, readonly string[]> = {
	sceneEngine: ["renderFull", "renderDirtyRegions", "orderDirtyCandidates", "renderAtomRefs", "renderNewPenAtomsOnTop"],
	sceneCore: ["applyOperation", "queryDirtyCandidates", "computeEraseTargets", "hitTestTopmost", "queryElements", "getRenderIR", "getRenderIRDelta", "endBulkLoad", "getElementBounds", "getAtomBoundsSince", "getHistoryImpact"],
	renderIRCodec: ["encodeRenderIR", "decodeRenderIR"],
	canvasIRRenderer: ["renderIRItems"],
	canvasWorker: ["flushSceneRender", "runSlice", "runOperationSlice"],
	renderWorkerBridge: ["flushSceneBatch"],
	collabCommandHandlers: ["handleInitMeta", "handleInitComplete", "handlePushCommand", "flushInitRenderChunks", "flushInitCommandChunks"],
	roomCollabTransport: ["send", "requestPageHistory"],
	localCommandService: ["pushCommand", "undo", "redo", "clearCanvas"],
};

function avoidDiagnosticRepaint(): Plugin {
	return {
		name: "aevia-profile-observation",
		enforce: "pre",
		transform(code, id) {
			if (!/[/\\]workers[/\\]canvasWorker\.ts$/.test(id)) return;
			const anchor = /else if \(result\.value && labEnabled\(\)\) \{\s*flushSceneRender\(\);/;
			if (!anchor.test(code)) throw new Error("Worker lab repaint anchor changed");
			return code.replace(anchor, "else if (result.value && labEnabled()) {");
		},
	};
}

function spans(): Plugin {
	return {
		name: "aevia-profile-spans",
		enforce: "pre",
		transform(code, id) {
			const file = id.match(/[/\\]src[/\\].*[/\\]([^/\\]+)\.ts$/)?.[1];
			if (!file || !selected[file]) return;
			code = code.replace(/\r\n/g, "\n");
			const point = (anchor: string, statement: string) => {
				if (code.split(anchor).length !== 2) throw new Error(`Profiling anchor changed in ${file}: ${anchor}`);
				code = code.replace(anchor, () => anchor + "\n" + statement);
			};
			if (file === "renderWorkerBridge") {
				point("const batch = pendingSceneBatch.splice(0);", '__profileEvent("worker.batch", batch[0]?.epoch, batch[0]?.dispatchSeq, batch.at(-1)?.dispatchSeq, batch.length);');
				point("pendingSceneBatch.push(data);", '__profileEvent("worker.enqueued", data.epoch, data.dispatchSeq, data.dispatchSeq, pendingSceneBatch.length, cmd.id);');
			}
			if (file === "canvasWorker") {
				point('if (type === "update-command-state") {', '__profileEvent("worker.apply.start", data?.epoch, data?.dispatchSeq, data?.dispatchSeq, deferredMessages.length - deferredMessageHead, data?.cmd?.id);');
				point("const result = steps.next();\n\t\t\t\t\tif (!result.done) continue;", '__profileEvent("worker.apply.done", data.epoch, data.dispatchSeq, data.dispatchSeq, deferredMessages.length - deferredMessageHead, cmd.id);');
			}
			const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
			const edits: Array<[number, string]> = [];
			const visit = (node: ts.Node) => {
				if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isArrowFunction(node)) {
					const name = (ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent) ? node.parent.name : !ts.isArrowFunction(node) ? node.name : undefined)?.getText(source);
					const body = node.body;
					if (name && body && ts.isBlock(body) && !(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ? node.asteriskToken : false) &&
						!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) && selected[file]?.includes(name)) {
						edits.push([body.getStart(source) + 1, "\nconst __profileStart = performance.now(); try {\n"]);
						edits.push([body.end - 1, `\n} finally { __profileRecord(${JSON.stringify(file + "." + name)}, __profileStart); }\n`]);
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
			if (!edits.length) return;
			edits.sort((a, b) => b[0] - a[0]);
			for (const [at, value] of edits) code = code.slice(0, at) + value + code.slice(at);
			return code + `
function __profileEvent(name: string, epoch: number | undefined, first: number | undefined, last: number | undefined, count: number, id?: string) {
	__profileRecord(name, performance.now(), { epoch, first, last, count, id });
}
function __profileRecord(name: string, start: number, detail?: object) {
	const end = performance.now();
	const g = globalThis as typeof globalThis & { __aeviaDiagnosticSpans?: { rows: [string, number, number, object?][]; dropped: number } };
	const s = g.__aeviaDiagnosticSpans ??= { rows: [], dropped: 0 };
	if (s.rows.length < 20000) s.rows.push([name, start, end, detail]); else s.dropped++;
}
`;
		},
	};
}

const enableSpans = process.env.AEVIA_PROFILE_SPANS === "1";
export default mergeConfig(app, {
	plugins: enableSpans ? [spans()] : [],
	worker: { plugins: () => enableSpans ? [avoidDiagnosticRepaint(), spans()] : [avoidDiagnosticRepaint()] },
	build: {
		rollupOptions: {
			preserveEntrySignatures: "strict",
			input: {
				app: fileURLToPath(new URL("../../apps/frontend/index.html", import.meta.url)),
				"profile-render": fileURLToPath(new URL("./render-fixture.ts", import.meta.url)),
				"profile-pending": fileURLToPath(new URL("./pending-fixture.ts", import.meta.url)),
			},
			output: { entryFileNames: "assets/[name].js" },
		},
	},
});
