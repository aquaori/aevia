import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { SuiteContext, CaseResult } from "./types";
import { createRoomWithUsers, joinRoom } from "./protocol-driver";
import { drawLine, openRoomPage, pressRedo, pressUndo } from "./ui-driver";
import { captureCanvasSample, waitForCanvasChange, waitForNonBlankCanvas, compareCanvasPages, measureInk } from "./canvas-observer";

export async function runApgBusiness(context: SuiteContext): Promise<Omit<CaseResult,"id"|"durationMs">> {
  const binary = process.env.AEVIA_TEST_APG_BINARY;
  const dir = process.env.AEVIA_TEST_APG_DIR;
  if (!binary || !dir) throw new Error("APG E2E requires the managed, signed test fixture");
  const cli = (...args: string[]) => execFileSync(binary, ["--dir", dir, ...args], { env: { ...process.env, APG_TRUST_STORE: dir + "/trust.json", APG_TRUST_POLICY: "require-signed" }, timeout: 15000 });
  const { roomId, users } = await createRoomWithUsers(context.config, ["APGA", "APGB"]);
  const diagnostics: string[] = [];
  const open = (user: typeof users[number]) => openRoomPage(context.browser, context.config, user, page => {
    page.on("pageerror", error => diagnostics.push("page: " + error.message));
    page.on("console", message => { if (["warning","error"].includes(message.type())) diagnostics.push(message.type() + ": " + message.text()); });
    page.on("requestfailed", request => diagnostics.push(request.url() + ": " + request.failure()?.errorText));
    page.on("response", response => { if (response.url().includes("/api/apg/") && response.status() >= 400) diagnostics.push(response.status() + " " + response.url()); });
  });
  const a = await open(users[0]!);
  const b = await open(users[1]!);
  let disabled = false;
  let late: Awaited<ReturnType<typeof openRoomPage>> | undefined;
  try {
    for (const client of [a,b]) await client.page.getByTestId("apg-panel").locator("summary").click();
    const run = async (client: typeof a, id: string, text: string) => {
      await client.page.locator('[data-apg-command="' + id + '"]').click({timeout:20000});
      await client.page.getByTestId("apg-panel").getByRole("status").filter({hasText:text}).waitFor({timeout:15000});
    };
    await run(a,"aevia.shared-counter:increment","Counter: 1");
    await run(b,"aevia.shared-counter:read","Counter: 1");
    await run(a,"aevia.shape-template:insert","Card inserted");
    await waitForNonBlankCanvas(b.page, { timeoutMs: 20000 });
    const pixels = await captureCanvasSample(b.page);
    if (pixels.nonBlankRatio <= 0) throw new Error("Native template has no remote pixels");
    const diff = await compareCanvasPages(a.page,b.page,{threshold:0.012});
    if (diff.diffRatio > diff.passThreshold) throw new Error("APG native scene divergence");
    // The native bundle shares one host history group, so a single undo must remove the
    // whole template on every client, and redo must bring it back. History rides the normal
    // scene path: no plugin runs for either direction.
    const cardWidth = a.page.viewportSize()!.width;
    const cardHeight = a.page.viewportSize()!.height;
    const cardRoi = { x: Math.round(cardWidth*0.25), y: Math.round(cardHeight*0.25), width: Math.round(cardWidth*0.4), height: Math.round(cardHeight*0.25) };
    const cardBeforeUndo = await captureCanvasSample(b.page, cardRoi);
    await pressUndo(a.page);
    await waitForCanvasChange(b.page, cardBeforeUndo, { roi: cardRoi, timeoutMs: 15000 });
    const cardAfterUndo = await captureCanvasSample(b.page, cardRoi);
    if (cardAfterUndo.nonBlankRatio > 0.002) throw new Error("Undo left part of the plugin template behind: " + cardAfterUndo.nonBlankRatio);
    await pressRedo(a.page);
    await waitForNonBlankCanvas(b.page, { timeoutMs: 20000 });
    await run(b,"aevia.scene-inspector:inspect","Visible elements: 2");
    // A user-scoped export must reach the real download path: the host writes the file, the
    // guest only supplies inert text. It is triggered by the real Alt+Shift+4 shortcut rather
    // than a panel click, so the keyboard contribution path is exercised end to end.
    const [download] = await Promise.all([
      b.page.waitForEvent("download", { timeout: 20000 }),
      b.page.keyboard.press("Alt+Shift+4"),
      b.page.getByTestId("apg-panel").getByRole("status").filter({hasText:"Scene exported"}).waitFor({timeout:15000}),
    ]);
    const exportedPath = await download.path();
    if (!exportedPath) throw new Error("Export produced no file");
    if (download.suggestedFilename() !== "aevia-scene.json") throw new Error("Unexpected export name: " + download.suggestedFilename());
    const exported = JSON.parse(readFileSync(exportedPath, "utf8")) as { elements?: number; primitives?: Record<string, number>; revision?: number };
    if (typeof exported.elements !== "number" || exported.elements < 2) throw new Error("Export is missing scene elements: " + JSON.stringify(exported));
    if (!exported.primitives?.shape) throw new Error("Export did not count native shapes: " + JSON.stringify(exported));
    // The user-scoped palette must reach the native colour path, not just the toolbar state:
    // pick a contributed swatch, paint with the default pen, and require that ink colour.
    const paletteWidth = a.page.viewportSize()!.width;
    const paletteHeight = a.page.viewportSize()!.height;
    await a.page.getByRole("button",{name:"颜色"}).click();
    await a.page.getByRole("button",{name:"调色板颜色 #DB2777"}).click();
    await a.page.keyboard.press("Escape");
    // Keep the palette stroke clear of the inserted card (normalised x 0.25-0.65, y 0.25-0.5).
    const paletteRoi = { x: Math.round(paletteWidth*0.66), y: Math.round(paletteHeight*0.14), width: Math.round(paletteWidth*0.28), height: Math.round(paletteHeight*0.18) };
    const beforePalette = await captureCanvasSample(a.page, paletteRoi);
    await drawLine(a.page, paletteWidth*0.7, paletteHeight*0.2, paletteWidth*0.9, paletteHeight*0.25, 24);
    const inkColor = measureInk(beforePalette, await captureCanvasSample(a.page, paletteRoi));
    if (inkColor.coverage <= 0.0005) throw new Error("Palette stroke left no ink");
    if (Math.abs(inkColor.r-0xdb) > 70 || Math.abs(inkColor.g-0x27) > 70 || Math.abs(inkColor.b-0x77) > 70) {
      throw new Error(`Palette colour not applied: ${JSON.stringify(inkColor)}`);
    }
    // The contributed preset must reach the native pointer path: pick Soft Pencil, paint a
    // stroke, and require the peer's canvas to pick up the new ink.
    await a.page.getByRole("button",{name:"画笔工具"}).click();
    await a.page.getByRole("button",{name:"Marker"}).click();
    const viewport = a.page.viewportSize()!;
    // A single stroke is small next to the whole canvas, so watch the band it will occupy.
    const inkRoi = { x: Math.round(viewport.width*0.2), y: Math.round(viewport.height*0.6), width: Math.round(viewport.width*0.5), height: Math.round(viewport.height*0.22) };
    const beforeStroke = await captureCanvasSample(b.page, inkRoi);
    await drawLine(a.page, viewport.width*0.26, viewport.height*0.66, viewport.width*0.62, viewport.height*0.74, 24);
    await waitForCanvasChange(b.page, beforeStroke, {roi: inkRoi, timeoutMs: 15000});
    const inkDiff = await compareCanvasPages(a.page,b.page,{threshold:0.012});
    if (inkDiff.diffRatio > inkDiff.passThreshold) throw new Error("APG preset stroke diverged between clients");
    // Native text and a sticky note are also plugin output: the peer must render them, and
    // the inspector must count each element once (two card shapes + note background + caption).
    const noteRoi = { x: Math.round(viewport.width*0.66), y: Math.round(viewport.height*0.32), width: Math.round(viewport.width*0.28), height: Math.round(viewport.height*0.3) };
    const beforeNote = await captureCanvasSample(b.page, noteRoi);
    await run(a,"aevia.note-template:insert","Note inserted");
    await waitForCanvasChange(b.page, beforeNote, {roi: noteRoi, timeoutMs: 15000});
    await b.page.locator('[data-apg-command="aevia.scene-inspector:inspect"]').click({timeout:20000});
    const counted = b.page.getByTestId("apg-panel").getByRole("status").filter({hasText:/Visible elements: \d+/});
    await counted.waitFor({timeout:15000});
    const countedText = (await counted.textContent()) ?? "";
    const countedNumber = Number(/Visible elements: (\d+)/.exec(countedText)?.[1] ?? "0");
    if (countedNumber < 4) throw new Error("Scene inspector did not count the plugin text elements: " + countedText);
    cli("disable","aevia.shape-template");
    disabled = true;
    const insertButton = a.page.locator('[data-apg-command="aevia.shape-template:insert"]');
    await insertButton.waitFor({state:"detached",timeout:30000});
    // Re-enabling must reach an already open room through the catalog poll, not only a
    // fresh page load; otherwise a deployer's change would need every client to reload.
    cli("enable","aevia.shape-template");
    await insertButton.waitFor({state:"visible",timeout:30000});
    // Leave it disabled for the late joiner: history must replay without the plugin.
    cli("disable","aevia.shape-template");
    await insertButton.waitFor({state:"detached",timeout:30000});
    const user = await joinRoom(context.config,roomId,"APGLate");
    late = await open(user);
    await waitForNonBlankCanvas(late.page, { timeoutMs: 20000 });
    const replay = await compareCanvasPages(b.page,late.page,{threshold:0.012});
    if (replay.diffRatio > replay.passThreshold) throw new Error("APG history requires disabled plugin");
    await late.page.getByTestId("apg-panel").locator("summary").click();
    await run(late,"aevia.shared-counter:read","Counter: 1");
    return {status:"passed",failureType:"none",metrics:{diffRatio:diff.diffRatio,replayDiffRatio:replay.diffRatio,inkDiffRatio:inkDiff.diffRatio},artifacts:[]};
  } catch (error) {
    throw new Error(String(error) + "\nAPG browser diagnostics:\n" + diagnostics.slice(-20).join("\n"), { cause: error });
  } finally {
    if (disabled) cli("enable","aevia.shape-template");
    await Promise.all([a.close(),b.close(),late?.close()]);
  }
}
