// Cooperative slices keep scene mutations ordered while allowing independent
// background work to make progress under sustained foreground traffic.
type Lane = "foreground" | "background";
type Task = (deadline: number) => void;

export class WorkerTaskScheduler {
	private readonly foreground: Task[] = [];
	private readonly background: Array<{ task: Task; queuedAt: number }> = [];
	private scheduled = false;
	private foregroundTurns = 0;

	schedule(lane: Lane, task: Task) {
		if (lane === "foreground") this.foreground.push(task);
		else this.background.push({ task, queuedAt: performance.now() });
		if (!this.scheduled) {
			this.scheduled = true;
			setTimeout(() => this.run(), 0);
		}
	}

	private run() {
		this.scheduled = false;
		const oldest = this.background[0];
		const runBackground = !!oldest && (this.foreground.length === 0 || this.foregroundTurns >= 3 || performance.now() - oldest.queuedAt >= 32);
		if (runBackground) {
			this.foregroundTurns = 0;
			this.background.shift()!.task(performance.now() + 2);
		} else {
			const task = this.foreground.shift();
			if (task) { this.foregroundTurns += 1; task(performance.now() + 4); }
		}
		if (!this.scheduled && (this.foreground.length > 0 || this.background.length > 0)) {
			this.scheduled = true;
			setTimeout(() => this.run(), 0);
		}
	}
}
