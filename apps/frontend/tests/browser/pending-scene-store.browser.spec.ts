import { expect, it } from "vitest";
import { PendingSceneStore } from "../../src/service/pendingSceneStore";

it("restores pending operations in order only for the same room instance and actor", async () => {
	const room = `test-${crypto.randomUUID()}`;
	const writer = await PendingSceneStore.open(room, 1, "alice");
	await writer.load();
	await Promise.all([writer.put("z-create", { kind: "create" }), writer.put("a-append", { kind: "append" })]);
	const reopened = await PendingSceneStore.open(room, 1, "alice");
	expect(await reopened.load()).toEqual([["z-create", { kind: "create" }], ["a-append", { kind: "append" }]]);
	expect(await (await PendingSceneStore.open(room, 2, "alice")).load()).toEqual([]);
	expect(await (await PendingSceneStore.open(room, 1, "bob")).load()).toEqual([]);
	await reopened.delete("z-create");
	expect(await reopened.load()).toEqual([["a-append", { kind: "append" }]]);
	await reopened.delete("a-append");
});
