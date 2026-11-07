import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "./editorEventBus";

interface TestEvents {
	"point:added": { id: string };
	ping: number;
	status: { ok: boolean };
}

describe("createEventBus", () => {
	it("delivers payloads to every subscriber of an event", () => {
		const bus = createEventBus<TestEvents>();
		const first = vi.fn();
		const second = vi.fn();
		bus.on("ping", first);
		bus.on("ping", second);

		bus.emit("ping", 42);

		expect(first).toHaveBeenCalledWith(42);
		expect(second).toHaveBeenCalledWith(42);
	});

	it("keeps event namespaces isolated", () => {
		const bus = createEventBus<TestEvents>();
		const ping = vi.fn();
		const status = vi.fn();
		bus.on("ping", ping);
		bus.on("status", status);

		bus.emit("status", { ok: true });

		expect(ping).not.toHaveBeenCalled();
		expect(status).toHaveBeenCalledWith({ ok: true });
	});

	it("removes listeners via off and the returned unsubscribe function", () => {
		const bus = createEventBus<TestEvents>();
		const removed = vi.fn();
		const unsubscribe = bus.on("ping", removed);

		bus.off("ping", removed);
		bus.emit("ping", 1);
		expect(removed).not.toHaveBeenCalled();

		const unsubscribed = vi.fn();
		const off = bus.on("ping", unsubscribed);
		off();
		// A detached unsubscribe must stay harmless even when called twice.
		off();
		bus.emit("ping", 2);
		expect(unsubscribed).not.toHaveBeenCalled();
		expect(unsubscribe).toBeTypeOf("function");
	});

	it("clears every listener", () => {
		const bus = createEventBus<TestEvents>();
		const ping = vi.fn();
		const status = vi.fn();
		bus.on("ping", ping);
		bus.on("status", status);

		bus.clear();
		bus.emit("ping", 1);
		bus.emit("status", { ok: true });

		expect(ping).not.toHaveBeenCalled();
		expect(status).not.toHaveBeenCalled();
	});

	it("treats unknown events and missing handlers as no-ops", () => {
		const bus = createEventBus<TestEvents>();
		expect(() => bus.emit("point:added", { id: "p1" })).not.toThrow();
		expect(() => bus.off("ping", () => undefined)).not.toThrow();
	});

	it("supports listeners that unsubscribe from inside a handler", () => {
		const bus = createEventBus<TestEvents>();
		const later = vi.fn();
		const first = vi.fn(() => bus.off("ping", first));
		bus.on("ping", first);
		bus.on("ping", later);

		bus.emit("ping", 1);

		expect(first).toHaveBeenCalledTimes(1);
		expect(later).toHaveBeenCalledTimes(1);

		bus.emit("ping", 2);
		expect(first).toHaveBeenCalledTimes(1);
		expect(later).toHaveBeenCalledTimes(2);
	});
});
