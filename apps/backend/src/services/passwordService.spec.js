const passwordService = require("./passwordService");

describe("passwordService", () => {
	it("keeps empty rooms passwordless", () => {
		expect(passwordService.hashPassword("")).toBe("");
		expect(passwordService.verifyPassword("", "")).toBe(true);
		expect(passwordService.verifyPassword(undefined, "")).toBe(true);
	});

	it("hashes and verifies non-empty passwords", () => {
		const hashed = passwordService.hashPassword("secret");

		expect(hashed).toMatch(/^scrypt\$/);
		expect(passwordService.verifyPassword("secret", hashed)).toBe(true);
		expect(passwordService.verifyPassword("wrong", hashed)).toBe(false);
	});

	it("supports legacy plaintext room passwords", () => {
		expect(passwordService.verifyPassword("legacy", "legacy")).toBe(true);
		expect(passwordService.verifyPassword("wrong", "legacy")).toBe(false);
	});
});
