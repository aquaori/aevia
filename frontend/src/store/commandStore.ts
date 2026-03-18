import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type { Command, Point, FlatPoint } from "../utils/type";
import { reRenderDirtyRect } from "../utils/dirtyRedraw";
import { canvasRef, ctx } from "../service/canvas";
import { toast } from "vue-sonner";

export const useCommandStore = defineStore("command", () => {
	const commands = shallowRef<Command[]>([]);
	// 辅助 Map：用于实现 O(1) 命令查找 (不具备响应性，仅用于索引)
	const commandMap = new Map<string, Command>();
	// 待处理的更新点
	const pendingUpdates = ref<Map<string, Point[]>>(new Map());
	// 当前命令指针，用于非线性历史管理
	const currentCommandIndex = ref(-1);
	// 缓存 Worker 返回的已排序点集，用于局部重绘的同步查询
	const lastSortedPoints = ref<FlatPoint[]>([]);
	// 存储异步渲染请求的回调 (用于处理预览图等)
	const pendingRenderCallbacks = new Map<string, (points: FlatPoint[]) => void>();

	const insertCommand = (cmd: Command) => {
		const cmds: Command[] = commands.value;

		// 性能优化：使用 markRaw 标记点位数组，防止 Vue 递归包装海量点位对象
		if (cmd.points) {
			cmd.points = markRaw(cmd.points);
		}

		// 【新增防线】：CRDT 幂等性去重，防止接收端由于乱序导致同一条线段被拆分插入多次
		if (commandMap.has(cmd.id)) {
			return;
		}

		commandMap.set(cmd.id, cmd);

		// 1. 检查是否需要重绘
		if (resolveConflict(cmd, cmds[cmds.length - 1] ?? cmd) === cmd) {
			reRenderDirtyRect(cmd.box, ctx.value!, canvasRef.value!);
			// 2. 二分查找 (双向夹逼、自然收敛法则)
			let left = 0;
			let right = cmds.length - 1;

			// 当 left > right 时，上下界重合，left 就是唯一合法的插入点
			while (left <= right) {
				const mid = left + ((right - left) >> 1); // 位运算取中间值，提升效率防溢出
				const c = cmds[mid];

				// 如果 cmd 应该排在 c 前面，说明插入点在左侧或当前 mid 的位置
				if (resolveConflict(cmd, c!) === cmd) {
					// 【下界左压】：当前 mid 是合法备选，但我们逼迫下界向左移，寻找更极限的位置
					right = mid - 1;
				} else {
					// 【上界右推】：当前 mid 完全不合格，连同它左边的都要全部抛弃，上界向右推
					left = mid + 1;
				}
			}
			if (left === cmds.length) {
				commands.value.push(cmd);
			} else {
				commands.value.splice(left, 0, cmd);
			}
		} else {
			commands.value.push(cmd);
		}
	};

	const resolveConflict = (cmd1: Command, cmd2: Command) => {
		if (cmd1.lamport < cmd2.lamport) {
			return cmd1;
		} else if (cmd1.lamport > cmd2.lamport) {
			return cmd2;
		} else {
			// cmdId是uuid，直接比较即可
			if (cmd1.id.toLocaleLowerCase() < cmd2.id.toLocaleLowerCase()) {
				return cmd1;
			} else {
				return cmd2;
			}
		}
	};

	const updateLastSortedPoints = (points: FlatPoint[]) => {
		lastSortedPoints.value = points;
	};

	const setCurrentCommandIndex = (index: number) => {
		currentCommandIndex.value = index;
	};

	const clearClearedCommands = (clearCmd: Command, username = "有用户") => {
		const clearCmdIndex = commands.value.findIndex((c) => c.id === clearCmd.id);
		if (clearCmdIndex !== -1) {
			// 同步更新 commandMap
			const toRemove = commands.value.slice(0, clearCmdIndex + 1);
			toRemove.forEach((c) => {
				if (c.pageId === clearCmd.pageId) {
					commandMap.delete(c.id);
				}
			});

			// 类 v8 GC 机制：过滤删除清屏操作前的、属于本页的所有旧命令
			commands.value = commands.value.filter((c, index) => {
				return index > clearCmdIndex || c.pageId !== clearCmd.pageId;
			});
			toast.info(`${username} 在 页面${clearCmd.pageId + 1} 执行了清屏操作`);
		}
	};

	return {
		commands,
		commandMap,
		pendingUpdates,
		currentCommandIndex,
		lastSortedPoints,
		pendingRenderCallbacks,
		insertCommand,
		updateLastSortedPoints,
		setCurrentCommandIndex,
		resolveConflict,
		clearClearedCommands,
	};
});
