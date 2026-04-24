import { spawn } from "node:child_process";

const processes = [
	{
		name: "backend",
		command: "npm run dev --workspace @collaborative-whiteboard/backend",
	},
	{
		name: "frontend",
		command: "npm run dev --workspace @collaborative-whiteboard/frontend",
	},
];

const children = processes.map(({ name, command }) => {
	const child = spawn(command, [], {
		stdio: "inherit",
		env: process.env,
		shell: true,
	});

	child.on("exit", (code, signal) => {
		if (signal) {
			console.log(`[${name}] exited with signal ${signal}`);
			return;
		}
		if (code && code !== 0) {
			console.error(`[${name}] exited with code ${code}`);
			shutdown(code);
		}
	});

	child.on("error", (error) => {
		console.error(`[${name}] failed to start`, error);
		shutdown(1);
	});

	return child;
});

let shuttingDown = false;

function shutdown(exitCode = 0) {
	if (shuttingDown) return;
	shuttingDown = true;

	for (const child of children) {
		if (!child.killed) {
			child.kill("SIGTERM");
		}
	}

	process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
