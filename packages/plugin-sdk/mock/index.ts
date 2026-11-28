import { runInNewContext } from "node:vm";
import type { Json, MutateRequest, PluginAPI, SceneSnapshot, SharedState } from "../index";

/**
 * Development-only host for plugin authors. It runs a plugin program in a plain
 * Node `vm` context with the same `apg` shape the QuickJS guest receives, so a
 * `main.js` can be exercised without a browser, a worker, or a signed package.
 *
 * This is NOT a security boundary: it has no memory, stack or timeout limits and
 * it is not what the product runs. Never use it to make claims about isolation.
 */
export interface ApgMockHostOptions {
	scene?: SceneSnapshot | null;
	sharedState?: SharedState | null;
	resource?: Json;
}

export interface ApgMockCall {
	command: string;
	preview: string | null;
	mutations: MutateRequest[];
	writes: Json[];
	downloads: { name: string; mime: string; text: string }[];
}

export interface ApgMockHost {
	api: PluginAPI;
	commands: string[];
	previews: string[];
	mutations: MutateRequest[];
	writes: Json[];
	downloads: { name: string; mime: string; text: string }[];
	sharedState: SharedState | null;
	activated: boolean;
	/** Evaluate a plugin program (the contents of `main.js`) against this host. */
	load(program: string): void;
	activate(): void;
	deactivate(): void;
	runCommand(id: string): ApgMockCall;
	lastCall(): ApgMockCall | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

export const createApgMockHost = (options: ApgMockHostOptions = {}): ApgMockHost => {
	const commands = new Map<string, () => void>();
	let activateHandler: (() => void) | undefined;
	let deactivateHandler: (() => void) | undefined;
	const previews: string[] = [];
	const mutations: ShapeRequest[] = [];
	const writes: Json[] = [];
	const downloads: { name: string; mime: string; text: string }[] = [];
	let call: ApgMockCall | null = null;

	const host: ApgMockHost = {
		api: {
			registerCommand(id, handler) {
				if (typeof id !== "string" || !id) throw new Error("APG mock: command id must be a non-empty string");
				if (typeof handler !== "function") throw new Error("APG mock: command handler must be a function");
				if (commands.has(id)) throw new Error(`APG mock: duplicate command ${id}`);
				commands.set(id, handler);
			},
			onActivate(handler) {
				activateHandler = handler;
			},
			onDeactivate(handler) {
				deactivateHandler = handler;
			},
			readScene() {
				return options.scene ?? null;
			},
			readSharedState() {
				return host.sharedState;
			},
			readResource() {
				return options.resource ?? null;
			},
			writeSharedState(value) {
				const revision = (host.sharedState?.revision ?? 0) + 1;
				host.sharedState = { revision, value };
				writes.push(value);
			},
			preview(text) {
				if (typeof text !== "string") throw new Error("APG mock: preview takes a string");
				previews.push(text);
			},
			download(file) {
				// The mock records the request instead of writing a file; the real host owns
				// naming, MIME allowlisting and the 64 KiB budget.
				if (!isRecord(file) || typeof file.name !== "string" || typeof file.mime !== "string" || typeof file.text !== "string") {
					throw new Error("APG mock: download takes { name, mime, text }");
				}
				downloads.push({ name: file.name, mime: file.mime, text: file.text });
			},
			mutate(request) {
				const bundle = Array.isArray(request) ? request : [request];
				if (bundle.length === 0 || bundle.length > 8) throw new Error("APG mock: mutate expects 1..8 shapes");
				for (const shape of bundle) {
					if (!isRecord(shape) || (shape.kind !== "shape.create" && shape.kind !== "text.create" && shape.kind !== "sticky.create")) throw new Error("APG mock: invalid native element request");
					mutations.push(shape as unknown as MutateRequest);
				}
			},
		},
		commands: [],
		previews,
		mutations,
		writes,
		downloads,
		sharedState: options.sharedState ?? null,
		activated: false,
		load(program) {
			if (typeof program !== "string" || program.length === 0) throw new Error("APG mock: program must be a non-empty string");
			runInNewContext(program, { apg: host.api });
			host.commands = [...commands.keys()];
		},
		activate() {
			host.activated = true;
			activateHandler?.();
		},
		deactivate() {
			host.activated = false;
			deactivateHandler?.();
		},
		runCommand(id) {
			const handler = commands.get(id);
			if (!handler) throw new Error(`APG mock: unknown command ${id}`);
			previews.length = 0;
			mutations.length = 0;
			writes.length = 0;
			downloads.length = 0;
			call = { command: id, preview: null, mutations, writes, downloads };
			handler();
			call.preview = previews.length ? previews[previews.length - 1] : null;
			return call;
		},
		lastCall() {
			return call;
		},
	};
	return host;
};
