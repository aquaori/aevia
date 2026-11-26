import { describe, expect, it } from "vitest";
import router from "./index";

describe("app router", () => {
	it("registers home, invite, and room routes", () => {
		const routes = router.getRoutes().map((r) => ({ name: r.name, path: r.path }));
		expect(routes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "home", path: "/" }),
				expect.objectContaining({ name: "invite", path: "/invite/:token" }),
				expect.objectContaining({ name: "room", path: "/room" }),
			]),
		);
	});
});
