// File role: stable, dependency-free grapheme clustering for scene text atoms.
const isVariationSelector = (codePoint: number) =>
	(codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
	(codePoint >= 0xe0100 && codePoint <= 0xe01ef);

const isEmojiModifier = (codePoint: number) => codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
const isRegionalIndicator = (codePoint: number) => codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
const isCombiningMark = (value: string) => /\p{Mark}/u.test(value);

export const splitGraphemes = (text: string) => {
	const codePoints = Array.from(text);
	const graphemes: string[] = [];
	let regionalCount = 0;
	for (const value of codePoints) {
		const codePoint = value.codePointAt(0) ?? 0;
		const previous = graphemes[graphemes.length - 1];
		const joinsPrevious = Boolean(
			previous &&
			(isCombiningMark(value) ||
				isVariationSelector(codePoint) ||
				isEmojiModifier(codePoint) ||
				codePoint === 0x200d ||
				previous.codePointAt(previous.length - 1) === 0x200d ||
				(isRegionalIndicator(codePoint) && regionalCount % 2 === 1))
		);
		if (joinsPrevious) graphemes[graphemes.length - 1] = previous + value;
		else graphemes.push(value);
		regionalCount = isRegionalIndicator(codePoint) ? regionalCount + 1 : 0;
	}
	return graphemes;
};
