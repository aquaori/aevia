// File role: versioned built-in sticker assets with legacy Emoji fallback.
export const stickerAssets = [
	{ key: "emoji/sparkles", version: 1 as const, label: "星星", value: "✨" },
	{ key: "emoji/celebration", version: 1 as const, label: "庆祝", value: "🎉" },
	{ key: "emoji/thumbs-up", version: 1 as const, label: "点赞", value: "👍" },
	{ key: "emoji/idea", version: 1 as const, label: "灵感", value: "💡" },
];

export const stickerAssetByValue = (value: string) => stickerAssets.find((asset) => asset.value === value);
export const resolveStickerAsset = (key: string, version: number) => stickerAssets.find((asset) => asset.key === key && asset.version === version);
