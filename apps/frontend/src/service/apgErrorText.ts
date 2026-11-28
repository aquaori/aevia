/**
 * Turns a failed APG command into something the user can act on. The runtime and the host
 * throw for very different reasons (revoked context, exhausted worker budget, HTTP status
 * from the shared-state CAS), and "插件执行失败或权限已撤销" is not useful for all of them.
 */
const httpStatus = (error: unknown): number | undefined => {
	if (!error || typeof error !== "object") return undefined;
	const response = (error as { response?: unknown }).response;
	if (!response || typeof response !== "object") return undefined;
	const status = (response as { status?: unknown }).status;
	return typeof status === "number" ? status : undefined;
};

const message = (error: unknown): string => {
	if (!error || typeof error !== "object") return "";
	const value = (error as { message?: unknown }).message;
	return typeof value === "string" ? value : "";
};

export const describeApgCommandError = (error: unknown): string => {
	switch (httpStatus(error)) {
		case 409:
			// CAS lost: the authoritative value moved under us. The next command re-reads it,
			// so retrying the same command is the correct action — no silent overwrite.
			return "共享状态已被其他成员修改，请重试";
		case 403:
			return "权限已撤销或不足";
		case 429:
			return "操作过于频繁，请稍后重试";
	}
	const detail = message(error);
	if (detail.includes("APG context revoked")) return "房间或页面已切换，操作已取消";
	if (detail.includes("APG active worker limit")) return "插件运行时已满，请稍后再试";
	if (detail.includes("APG command unavailable")) return "该命令当前不可用";
	if (detail.includes("Shared state write denied")) return "当前角色不能修改共享状态";
	if (detail.includes("Scene mutation denied")) return "当前角色不能在画布上插入内容";
	return "APG 插件执行失败或权限已撤销";
};
