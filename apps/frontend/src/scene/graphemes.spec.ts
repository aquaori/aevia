import { describe, expect, it } from "vitest";
import { splitGraphemes } from "./graphemes";

describe("splitGraphemes", () => {
	it("splits plain ASCII into one grapheme per code point", () => {
		expect(splitGraphemes("abc")).toEqual(["a", "b", "c"]);
		expect(splitGraphemes("")).toEqual([]);
	});

	it("keeps combining marks attached to their base character", () => {
		// "e" + combining acute accent (U+0301) is one user-perceived character.
		expect(splitGraphemes("e\u0301x")).toEqual(["e\u0301", "x"]);
	});

	it("keeps variation selectors attached to the preceding character", () => {
		// U+2764 HEAVY BLACK HEART + U+FE0F VARIATION SELECTOR-16.
		expect(splitGraphemes("\u2764\ufe0fx")).toEqual(["\u2764\ufe0f", "x"]);
	});

	it("keeps zero-width-joiner emoji sequences as one grapheme", () => {
		const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
		expect(splitGraphemes(family + "!")).toEqual([family, "!"]);
	});

	it("keeps skin-tone modifiers attached to the emoji", () => {
		const thumbsUp = "\u{1f44d}\u{1f3fb}";
		expect(splitGraphemes(thumbsUp)).toEqual([thumbsUp]);
	});

	it("pairs regional indicators into flags instead of single letters", () => {
		// Regional indicator symbols form flags in pairs; an odd trailing symbol
		// stays on its own.
		expect(splitGraphemes("\u{1f1fb}\u{1f1f3}\u{1f1fa}\u{1f1f8}")).toEqual([
			"\u{1f1fb}\u{1f1f3}",
			"\u{1f1fa}\u{1f1f8}",
		]);
		expect(splitGraphemes("\u{1f1fb}\u{1f1f3}x")).toEqual(["\u{1f1fb}\u{1f1f3}", "x"]);
	});
});
