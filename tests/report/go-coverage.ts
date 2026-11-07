// Go cross-package profiles repeat source blocks for each tested package.
export const mergeGoCoverageBlocks = (lines: string[]): string[] => {
	const blocks = new Map<string, { statements: number; covered: boolean }>();
	for (const line of lines) {
		const match = line.match(/^(.+:\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/);
		if (!match) throw new Error("Malformed Go coverage block");
		const key = match[1]!;
		const statements = Number(match[2]);
		const previous = blocks.get(key);
		if (previous && previous.statements !== statements) throw new Error("Inconsistent Go coverage block");
		blocks.set(key, { statements, covered: previous?.covered === true || Number(match[3]) > 0 });
	}
	return [...blocks].map(([key, block]) => `${key} ${block.statements} ${block.covered ? 1 : 0}`);
};
