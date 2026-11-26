import { defineComponent } from "vue";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { WhiteboardSession } from "../utils/editorTypes";
import {
	provideRoomSession,
	useRoomSession,
	useRoomSessionEmitHook,
	useRoomSessionRef,
} from "./roomSessionContext";

describe("roomSessionContext", () => {
	it("provides, accesses, and emits hooks for an initialized room session", () => {
		const emitHook = vi.fn();
		const fakeSession = { emitHook } as unknown as WhiteboardSession;

		const Child = defineComponent({
			setup() {
				const ref = useRoomSessionRef();
				const session = useRoomSession();
				const emit = useRoomSessionEmitHook();
				emit("session:ready", {});
				return { hasRef: Boolean(ref.value), sameSession: session === fakeSession };
			},
			template: "<div>{{ hasRef }}-{{ sameSession }}</div>",
		});

		const Parent = defineComponent({
			components: { Child },
			setup() {
				provideRoomSession(fakeSession);
				return {};
			},
			template: "<Child />",
		});

		const wrapper = mount(Parent);
		expect(wrapper.text()).toBe("true-true");
		expect(emitHook).toHaveBeenCalledWith("session:ready", {});
	});

	it("throws when session is null inside provider", () => {
		const UninitChild = defineComponent({
			setup() {
				useRoomSession();
				return {};
			},
			template: "<div />",
		});
		const Parent = defineComponent({
			components: { UninitChild },
			setup() {
				provideRoomSession(undefined);
				return {};
			},
			template: "<UninitChild />",
		});
		expect(() => mount(Parent)).toThrow("Room session has not been initialized.");
	});
});
