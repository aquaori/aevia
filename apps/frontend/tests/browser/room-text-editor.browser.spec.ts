import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import RoomTextEditor from "../../src/components/RoomTextEditor.vue";

describe("RoomTextEditor canvas placement", () => {
	it("refreshes remote text without interrupting an IME composition", async () => {
		const wrapper = mount(RoomTextEditor, { attachTo: document.body });
		const onRemoteText = vi.fn(() => "你好 B");
		const onChange = vi.fn();
		void wrapper.vm.open({ kind: "text", elementId: "shared", box: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 }, initialText: "你好", onRemoteText, onChange });
		await nextTick();
		const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
		input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		wrapper.vm.notifyRemotePatch("shared");
		expect(onRemoteText).not.toHaveBeenCalled();
		input.value = "你好";
		input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
		await nextTick();
		expect(onChange).toHaveBeenCalledWith("你好", "ime");
		expect(input.value).toBe("你好 B");
		wrapper.unmount();
	});
	it("uses the canvas rectangle and keeps the requested text bounds", async () => {
		const wrapper = mount(RoomTextEditor, { attachTo: document.body });
		let canvasRect = { left: 80, top: 40, width: 800, height: 400 };
		const box = { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4, width: 0.2, height: 0.2 };
		void wrapper.vm.open({ kind: "text", elementId: "t1", box, getCanvasRect: () => canvasRect });
		await nextTick();
		const shell = document.querySelector<HTMLElement>(".room-text-editor-shell")!;
		expect(shell.style.left).toBe("160px");
		expect(shell.style.top).toBe("120px");
		expect(shell.style.width).toBe("160px");
		expect(shell.style.height).toBe("80px");
		canvasRect = { left: 20, top: 10, width: 1000, height: 500 };
		window.dispatchEvent(new Event("resize"));
		await nextTick();
		expect(shell.style.left).toBe("120px");
		expect(shell.style.width).toBe("200px");
		wrapper.unmount();
	});

	it("resizes a text box from its right handle and reports page bounds", async () => {
		const wrapper = mount(RoomTextEditor, { attachTo: document.body });
		const onBoxChange = vi.fn();
		void wrapper.vm.open({ kind: "text", elementId: "t2", box: { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4, width: 0.2, height: 0.2 },
			getCanvasRect: () => ({ left: 80, top: 40, width: 800, height: 400 }), onBoxChange });
		await nextTick();
		const handle = document.querySelector<HTMLElement>(".handle-4")!;
		handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 320, clientY: 160 }));
		window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 400, clientY: 160 }));
		await nextTick();
		const shell = document.querySelector<HTMLElement>(".room-text-editor-shell")!;
		expect(parseFloat(shell.style.width)).toBeCloseTo(240);
		window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 400, clientY: 160 }));
		expect(onBoxChange).toHaveBeenCalledOnce();
		expect(onBoxChange.mock.calls[0]![0].maxX).toBeCloseTo(0.4);
		wrapper.unmount();
	});

	it("keeps a transformed text box in place when it is edited and resized", async () => {
		const wrapper = mount(RoomTextEditor, { attachTo: document.body });
		const onBoxChange = vi.fn();
		void wrapper.vm.open({ kind: "text", elementId: "transformed", box: { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4, width: 0.2, height: 0.2 },
			getCanvasRect: () => ({ left: 0, top: 0, width: 800, height: 400 }), matrix: [2, 0, 0, 1, 0.1, 0], onBoxChange });
		await nextTick();
		const shell = document.querySelector<HTMLElement>(".room-text-editor-shell")!;
		expect(parseFloat(shell.style.left)).toBeCloseTo(240);
		expect(shell.style.transform).toBe("matrix(2, 0, 0, 1, 0, 0)");
		document.querySelector<HTMLElement>(".handle-4")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, clientX: 560 }));
		window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 720 }));
		window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, clientX: 720 }));
		expect(onBoxChange.mock.calls[0]![0].maxX).toBeCloseTo(0.4);
		wrapper.unmount();
	});

	it("accepts input after an interrupted IME composition and reopening", async () => {
		const wrapper = mount(RoomTextEditor, { attachTo: document.body });
		const box = { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4, width: 0.2, height: 0.2 };
		void wrapper.vm.open({ kind: "text", elementId: "first", box });
		await nextTick();
		document.querySelector("textarea")!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		document.querySelector<HTMLButtonElement>('[aria-label="取消"]')!.click();
		await nextTick();
		const onChange = vi.fn();
		void wrapper.vm.open({ kind: "text", elementId: "second", box, onChange });
		await nextTick();
		const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
		input.value = "中文";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		expect(onChange).toHaveBeenCalledWith("中文", "input");
		wrapper.unmount();
	});

	it("restores bounds if the resize cannot be sent or the gesture is cancelled", async () => {
		const wrapper = mount(RoomTextEditor, { attachTo: document.body });
		const onBoxChange = vi.fn(() => false);
		void wrapper.vm.open({ kind: "text", elementId: "t3", box: { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4, width: 0.2, height: 0.2 },
			getCanvasRect: () => ({ left: 0, top: 0, width: 800, height: 400 }), onBoxChange });
		await nextTick();
		const shell = document.querySelector<HTMLElement>(".room-text-editor-shell")!;
		const handle = document.querySelector<HTMLElement>(".handle-4")!;
		const gesture = async (finish: "pointerup" | "pointercancel") => {
			handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 240 }));
			window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 320 }));
			window.dispatchEvent(new PointerEvent(finish, { pointerId: 1, clientX: 320 }));
			await nextTick();
		};
		await gesture("pointerup");
		expect(parseFloat(shell.style.width)).toBeCloseTo(160);
		expect(onBoxChange).toHaveBeenCalledOnce();
		await gesture("pointercancel");
		expect(parseFloat(shell.style.width)).toBeCloseTo(160);
		expect(onBoxChange).toHaveBeenCalledOnce();
		wrapper.unmount();
	});

	it("applies remote undo/delete patch cleanly after IME composition finishes (H55/H58)", async () => {
		const wrapper = mount(RoomTextEditor, { attachTo: document.body });
		let remoteState = "Hello";
		const onRemoteText = vi.fn(() => remoteState);
		const onChange = vi.fn();
		void wrapper.vm.open({
			kind: "text",
			elementId: "shared-undo",
			box: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 },
			initialText: "Hello",
			onRemoteText,
			onChange,
		});
		await nextTick();
		const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
		input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		remoteState = "Hello world";
		wrapper.vm.notifyRemotePatch("shared-undo");
		remoteState = "Hell";
		wrapper.vm.notifyRemotePatch("shared-undo");
		expect(onRemoteText).not.toHaveBeenCalled();
		input.value = "Hello中";
		input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
		await nextTick();
		expect(onChange).toHaveBeenCalledWith("Hello中", "ime");
		expect(input.value).toBe("Hell");
		wrapper.unmount();
	});
});
