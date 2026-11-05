// Browser-side timers cannot bound a blocked renderer or a pending CDP command.
export const withDeadline = async <T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms (host deadline)`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};
