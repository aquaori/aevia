// A QuickJS context is a guest VM, not a browser realm. Only JSON crosses its boundary.
import {
	newQuickJSWASMModule,
	newVariant,
	RELEASE_SYNC,
	type QuickJSContext,
	type QuickJSHandle,
	type QuickJSRuntime,
	type QuickJSWASMModule,
} from "quickjs-emscripten";
// Resolve the Emscripten binary through Vite's asset pipeline. The variant's
// default `new URL("emscripten-module.wasm", import.meta.url)` points into the
// dependency prebundle directory, where the dev server answers with index.html;
// WebAssembly then fails with "expected magic word ... found <!do".
import quickJsWasmUrl from "@jitl/quickjs-wasmfile-release-sync/wasm?url";

let quickJsModule: Promise<QuickJSWASMModule> | undefined;
// Node (unit tests) can read the packaged binary itself; only the browser needs
// an explicit, host-served URL.
// `self` exists on the browser main thread and in dedicated/module workers, but
// is absent under Node (unit tests), where the packaged binary can be read directly.
const hostServesWasm = typeof self !== "undefined";
const getQuickJSModule = () =>
	(quickJsModule ??= hostServesWasm
		? newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmLocation: quickJsWasmUrl }))
		: newQuickJSWASMModule());

export type ApgInvocation = { phase: "activate" | "command" | "deactivate"; command?: string; input?: unknown };
export const APG_MAX_RESULT = 64 * 1024;
export const APG_MAX_INPUT = 512 * 1024;

// Keep the dispatcher handle private to the embedder. Guest code receives no host objects or functions.
const BOOT = `(() => {
  const commands = new Map();
  // Null prototype: a forged phase such as "__proto__"/"constructor" must never
  // resolve to an inherited function. The explicit phase allowlist below is the
  // primary guard; this removes the prototype chain as a second line of defence.
  const hooks = Object.create(null);
  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  let effects = null;
  let input = null;
  function enqueue(kind, value) {
    if (!effects || effects.length >= 16) throw new Error("APG effect limit or invalid phase");
    effects.push({kind, value});
  }
  Object.defineProperty(globalThis, "apg", { value: Object.freeze({
    registerCommand(id, handler) {
      if (typeof id !== "string" || typeof handler !== "function" || commands.has(id) || commands.size >= 64) throw new Error("Invalid command registration");
      commands.set(id, handler);
    },
    onActivate(handler) { if (typeof handler !== "function") throw new Error("Invalid hook"); hooks.activate = handler; },
    onDeactivate(handler) { if (typeof handler !== "function") throw new Error("Invalid hook"); hooks.deactivate = handler; },
    readScene() { return input?.scene ?? null; },
    readSharedState() { return input?.sharedState ?? null; },
    readResource() { return input?.resource ?? null; },
    writeSharedState(value) { enqueue("storage.shared", value); },
    preview(text) { enqueue("ui.preview", text); },
    download(file) { enqueue("ui.download", file); },
    mutate(request) { enqueue("scene.write", request); }
  }), configurable: false, writable: false });
  return (raw) => {
    const invocation = parse(raw);
    input = invocation.input ?? null;
    effects = [];
    try {
      const phase = invocation.phase;
      if (phase !== "activate" && phase !== "command" && phase !== "deactivate") throw new Error("APG invalid phase");
      if (phase === "command" && (typeof invocation.command !== "string" || invocation.command.length === 0)) throw new Error("APG invalid command");
      const fn = phase === "command" ? commands.get(invocation.command) : hooks[phase];
      if (!fn && phase === "command") throw new Error("Command not registered");
      if (fn) {
        const result = fn(input);
        if (result && typeof result.then === "function") throw new Error("Async guest handlers are not supported in API 1");
      }
      const output = stringify(effects);
      if (output.length > 65536) throw new Error("APG result too large");
      return output;
    } finally { effects = null; input = null; }
  };
})()`;

export interface ApgSandbox {
  invoke(invocation: ApgInvocation): string;
  dispose(): void;
}

export async function createApgSandbox(program: string): Promise<ApgSandbox> {
  if (new TextEncoder().encode(program).length > 128 * 1024) throw new Error("APG program too large");
  const module = await getQuickJSModule();
  const runtime: QuickJSRuntime = module.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  let deadline = Date.now() + 150;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm: QuickJSContext = runtime.newContext();
  let dispatch: QuickJSHandle | undefined;
  let disposed = false;
  const unwrap = (result: ReturnType<QuickJSContext["evalCode"]>): QuickJSHandle => {
    if (result.error) {
      result.error.dispose();
      throw new Error("APG guest execution failed or exceeded its resource budget");
    }
    return result.value;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    dispatch?.dispose();
    vm.dispose();
    runtime.dispose();
  };
  try {
    dispatch = unwrap(vm.evalCode(BOOT, "apg-bootstrap.js"));
    deadline = Date.now() + 150;
    unwrap(vm.evalCode(program, "main.js")).dispose();
    return {
      invoke(invocation) {
        if (disposed || !dispatch) throw new Error("APG sandbox disposed");
        const serialized = JSON.stringify(invocation);
        if (new TextEncoder().encode(serialized).length > APG_MAX_INPUT) throw new Error("APG input too large");
        deadline = Date.now() + 150;
        const arg = vm.newString(serialized);
        try {
          const result = unwrap(vm.callFunction(dispatch, vm.undefined, arg));
          try {
            const output = vm.getString(result);
            if (new TextEncoder().encode(output).length > APG_MAX_RESULT) throw new Error("APG result too large");
            return output;
          } finally { result.dispose(); }
        } finally { arg.dispose(); }
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
