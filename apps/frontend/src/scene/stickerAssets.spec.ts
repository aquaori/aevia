import { describe, expect, it } from "vitest";
import { resolveStickerAsset, stickerAssetByValue, stickerAssets } from "./stickerAssets";

describe("stickerAssets", () => {
	it("resolves built-in stickers by value and key/version", () => {
		expect(stickerAssets.length).toBeGreaterThan(0);
		expect(stickerAssetByValue("✨")?.key).toBe("emoji/sparkles");
		expect(resolveStickerAsset("emoji/idea", 1)?.value).toBe("💡");
		expect(resolveStickerAsset("missing", 1)).toBeUndefined();
	});
});
