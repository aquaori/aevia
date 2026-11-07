// File role: EditorPlugin adapter that mirrors whiteboard session hooks into lab marks.
import type { EditorPlugin } from "../utils/editorTypes";
import {
	LAB_MARK_COLLAB_CONNECTED,
	LAB_MARK_PAGE_CHANGED,
	LAB_MARK_RENDER_AFTER,
	LAB_MARK_RENDER_BEFORE,
	LAB_MARK_SESSION_BEFORE_INIT,
	LAB_MARK_SESSION_READY,
	LAB_SPAN_SESSION_INIT,
} from "./labMarkNames";
import { labEnabled, labMark, labSpanEnd, labSpanStart } from "./labMarks";

export const LAB_INSTRUMENTATION_PLUGIN_NAME = "lab-instrumentation";

/**
 * Wires the session event bus into the lab mark stream. Registration itself is
 * gated by `labEnabled()` at the composition root (RoomView), and the plugin
 * also no-ops when it is set up through another host.
 */
export const createLabInstrumentationPlugin = (): EditorPlugin => ({
	name: LAB_INSTRUMENTATION_PLUGIN_NAME,
	setup: (host) => {
		if (!labEnabled()) {
			return () => {
				/* lab mode disabled: no subscriptions to dispose */
			};
		}

		const unsubscribers = [
			host.events.on("session:before-init", () => {
				labMark(LAB_MARK_SESSION_BEFORE_INIT);
				labSpanStart(LAB_SPAN_SESSION_INIT);
			}),
			host.events.on("session:ready", () => {
				labMark(LAB_MARK_SESSION_READY);
				labSpanEnd(LAB_SPAN_SESSION_INIT);
			}),
			host.events.on("collab:connected", () => {
				labMark(LAB_MARK_COLLAB_CONNECTED);
			}),
			host.events.on("page:changed", (payload) => {
				labMark(LAB_MARK_PAGE_CHANGED, { pageId: payload.pageId });
			}),
			host.events.on("render:before", (payload) => {
				labMark(LAB_MARK_RENDER_BEFORE, { reason: payload.reason });
			}),
			host.events.on("render:after", (payload) => {
				labMark(LAB_MARK_RENDER_AFTER, { reason: payload.reason });
			}),
		];

		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	},
});
