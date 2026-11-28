import { describe, expect, it } from "vitest";
import { describeApgCommandError } from "./apgErrorText";

const httpError = (status: number) => Object.assign(new Error("Request failed with status code " + status), {
	response: { status },
});

describe("APG command error text", () => {
	it("asks the user to retry when the shared-state CAS loses", () => {
		expect(describeApgCommandError(httpError(409))).toBe("共享状态已被其他成员修改，请重试");
	});

	it("separates permission, throttling and revocation failures", () => {
		expect(describeApgCommandError(httpError(403))).toBe("权限已撤销或不足");
		expect(describeApgCommandError(httpError(429))).toBe("操作过于频繁，请稍后重试");
		expect(describeApgCommandError(new Error("APG context revoked"))).toBe("房间或页面已切换，操作已取消");
		expect(describeApgCommandError(new Error("APG active worker limit"))).toBe("插件运行时已满，请稍后再试");
		expect(describeApgCommandError(new Error("APG command unavailable"))).toBe("该命令当前不可用");
	});

	it("explains role-based host refusals and keeps a generic fallback", () => {
		expect(describeApgCommandError(new Error("Shared state write denied"))).toBe("当前角色不能修改共享状态");
		expect(describeApgCommandError(new Error("Scene mutation denied"))).toBe("当前角色不能在画布上插入内容");
		expect(describeApgCommandError(new Error("APG capability denied"))).toBe("APG 插件执行失败或权限已撤销");
		expect(describeApgCommandError("not an error")).toBe("APG 插件执行失败或权限已撤销");
		expect(describeApgCommandError(undefined)).toBe("APG 插件执行失败或权限已撤销");
	});
});
