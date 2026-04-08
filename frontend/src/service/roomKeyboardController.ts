// File role: keyboard shortcut controller for editor commands and UI toggles.
interface RoomKeyboardControllerOptions {
	undo: () => void;
	redo: () => void;
	setTool: (tool: "pen" | "eraser" | "cursor") => void;
	openColorMenu: () => void;
	toggleShortcuts: () => void;
	toggleFullscreen: () => void;
}

export const createRoomKeyboardController = (options: RoomKeyboardControllerOptions) => {
	const handleKeydown = (event: KeyboardEvent) => {
		if ((event.target as HTMLElement).tagName === "INPUT") return;

		if (event.ctrlKey || event.metaKey) {
			if (event.shiftKey && event.key.toLowerCase() === "z") {
				event.preventDefault();
				options.redo();
				return;
			}
			if (event.key.toLowerCase() === "z") {
				event.preventDefault();
				options.undo();
				return;
			}
			if (event.key.toLowerCase() === "y") {
				event.preventDefault();
				options.redo();
			}
			return;
		}

		switch (event.key.toLowerCase()) {
			case "p":
				options.setTool("pen");
				break;
			case "e":
				options.setTool("eraser");
				break;
			case "c":
				options.openColorMenu();
				break;
			case "?":
				options.toggleShortcuts();
				break;
			case "f":
				options.toggleFullscreen();
				break;
		}
	};

	const mount = () => window.addEventListener("keydown", handleKeydown);
	const unmount = () => window.removeEventListener("keydown", handleKeydown);

	return {
		handleKeydown,
		mount,
		unmount,
	};
};

