import { beforeEach, describe, expect, it } from "vitest";
import {
	applyServerPressurePolicy,
	getCollabPressurePolicy,
	resetCollabPressurePolicy,
	shouldFlushCommandUpdate,
} from "./collabPressurePolicy";

describe("collab pressure policy", () => {
	beforeEach(() => {
		resetCollabPressurePolicy();
	});

	it("starts from the normal policy", () => {
		const policy = getCollabPressurePolicy();
		expect(policy).toEqual({
			level: "normal",
			cursorMinIntervalMs: 16,
			updateMinIntervalMs: 16,
			updateMinPoints: 1,
			sampleMinDistancePx: 2,
			simplificationTolerancePx: 0.4,
			maxUpdatePoints: 128,
		});
	});

	it("applies server policies with clamping and fallbacks", () => {
		const policy = applyServerPressurePolicy({
			level: "critical",
			policy: {
				cursorMinIntervalMs: 9999,
				updateMinIntervalMs: 20,
				updateMinPoints: 0,
				sampleMinDistancePx: "4",
				simplificationTolerancePx: Number.NaN,
				maxUpdatePoints: 1000,
			},
		});

		expect(policy.level).toBe("critical");
		// Out-of-range values clamp to the documented bounds.
		expect(policy.cursorMinIntervalMs).toBe(500);
		expect(policy.maxUpdatePoints).toBe(512);
		// Below-minimum values clamp up; numeric strings are accepted.
		expect(policy.updateMinPoints).toBe(1);
		expect(policy.sampleMinDistancePx).toBe(4);
		// Non-finite values fall back to the level's base policy.
		expect(policy.simplificationTolerancePx).toBe(1.8);
		expect(policy.updateMinIntervalMs).toBe(20);
		expect(getCollabPressurePolicy()).toBe(policy);
	});

	it("falls back to normal for unknown or missing levels", () => {
		for (const payload of [null, undefined, {}, { level: "mystery" }]) {
			const policy = applyServerPressurePolicy(payload);
			expect(policy.level).toBe("normal");
			expect(policy.cursorMinIntervalMs).toBe(16);
		}
	});

	it("resets back to the normal policy", () => {
		applyServerPressurePolicy({ level: "high" });
		expect(getCollabPressurePolicy().level).toBe("high");
		resetCollabPressurePolicy();
		expect(getCollabPressurePolicy().level).toBe("normal");
		expect(getCollabPressurePolicy().maxUpdatePoints).toBe(128);
	});

	it("flushes on force, capacity, or both thresholds together", () => {
		const policy = getCollabPressurePolicy();
		expect(shouldFlushCommandUpdate(policy, 0, 1000, true)).toBe(false);
		expect(shouldFlushCommandUpdate(policy, 1, 0, true)).toBe(true);
		expect(shouldFlushCommandUpdate(policy, policy.maxUpdatePoints, 0)).toBe(true);

		// Under the point threshold nothing is flushed, however long we wait.
		expect(shouldFlushCommandUpdate(policy, policy.updateMinPoints - 1, policy.updateMinIntervalMs)).toBe(false);
		// At the point threshold the interval gate still applies.
		expect(shouldFlushCommandUpdate(policy, policy.updateMinPoints, policy.updateMinIntervalMs - 1)).toBe(false);
		expect(shouldFlushCommandUpdate(policy, policy.updateMinPoints, policy.updateMinIntervalMs)).toBe(true);
	});

	it("uses the elevated thresholds after a pressure update", () => {
		const policy = applyServerPressurePolicy({ level: "elevated" });
		expect(policy.updateMinPoints).toBe(4);
		expect(policy.updateMinIntervalMs).toBe(33);
		expect(shouldFlushCommandUpdate(policy, 3, 1000)).toBe(false);
		expect(shouldFlushCommandUpdate(policy, 4, 32)).toBe(false);
		expect(shouldFlushCommandUpdate(policy, 4, 33)).toBe(true);
	});
});
