import { createApgSandbox, type ApgInvocation, type ApgSandbox } from "./apgSandbox";
let sandbox: ApgSandbox | undefined;
let busy = false;
self.onmessage = async (event: MessageEvent<{ id: number; program?: string; invocation: ApgInvocation }>) => {
  const { id, program, invocation } = event.data;
  // Overlapping requests are a protocol error: answer immediately instead of
  // letting the host wait for a timeout on a message that can never be served.
  if (busy) {
    self.postMessage({ id, error: "APG sandbox busy" });
    return;
  }
  busy = true;
  try {
    if (program !== undefined) {
      sandbox?.dispose();
      sandbox = await createApgSandbox(program);
    }
    if (!sandbox) throw new Error("APG sandbox not initialized");
    const output = sandbox.invoke(invocation);
    if (invocation.phase === "deactivate") {
      sandbox.dispose();
      sandbox = undefined;
    }
    self.postMessage({ id, output });
  } catch {
    sandbox?.dispose();
    sandbox = undefined;
    self.postMessage({ id, error: "APG sandbox execution failed" });
  } finally { busy = false; }
};
