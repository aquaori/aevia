// File role: single source of truth for Aevia lab instrumentation mark names.
//
// Contract: every mark is spelled `aevia.<domain>.<event>[.<phase>]`. Call
// sites import names from this module instead of writing string literals, so
// the guard spec (tests/lab/instrumentation-guard.spec.ts) can verify the
// whole surface from one table.
//
// Span bases deliberately omit the `.start` / `.end` suffix: `labSpanStart`
// and `labSpanEnd` append it, which keeps one logical span at one spelling.

export const LAB_MARK_APP_BOOT = "aevia.app.boot";

export const LAB_MARK_SESSION_BEFORE_INIT = "aevia.session.before-init";
export const LAB_MARK_SESSION_READY = "aevia.session.ready";
export const LAB_MARK_COLLAB_CONNECTED = "aevia.collab.connected";
export const LAB_MARK_PAGE_CHANGED = "aevia.page.changed";

export const LAB_MARK_RENDER_BEFORE = "aevia.render.before";
export const LAB_MARK_RENDER_AFTER = "aevia.render.after";

export const LAB_MARK_WS_OPEN = "aevia.ws.open";
export const LAB_MARK_WS_MESSAGE = "aevia.ws.message";
export const LAB_MARK_WS_SEND = "aevia.ws.send";

export const LAB_MARK_INIT_META = "aevia.init.meta";
export const LAB_MARK_INIT_FIRST_CHUNK = "aevia.init.first-chunk";
export const LAB_MARK_INIT_RENDER_COMPLETE = "aevia.init.render-complete";
export const LAB_MARK_INIT_COMMANDS_COMPLETE = "aevia.init.commands-complete";

export const LAB_MARK_PAGE_CHANGE = "aevia.page.change";
export const LAB_MARK_DELTA_META = "aevia.delta.meta";
export const LAB_MARK_DELTA_COMPLETE = "aevia.delta.complete";

export const LAB_MARK_FRAME_COMMIT = "aevia.frame.commit";
export const LAB_MARK_POINTER_DOWN = "aevia.pointer.down";
export const LAB_MARK_LOCAL_PAINT_DONE = "aevia.local.paint-done";
export const LAB_MARK_NET_FLUSH = "aevia.net.flush";

export const LAB_MARK_WORKER_FIRST_PAINT = "aevia.worker.first-paint";
export const LAB_MARK_WORKER_RENDER_COMPLETE = "aevia.worker.render-complete";
export const LAB_MARK_WORKER_ACK = "aevia.worker.ack";

export const LAB_MARK_LAB_SENTINEL = "aevia.lab.sentinel";

// Span bases (no `.start` / `.end` suffix). Each pair is closed on the same
// thread that opened it; worker marks are never used to measure a main-thread
// duration.
export const LAB_SPAN_SESSION_INIT = "aevia.session.init";
export const LAB_SPAN_DELTA_REPLAY = "aevia.delta.replay";
export const LAB_SPAN_RENDER_FRAME = "aevia.render.frame";
export const LAB_SPAN_POINTER_STROKE = "aevia.pointer.stroke";
