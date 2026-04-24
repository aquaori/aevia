// File role: typed event bus primitive used by editor hooks and internal event channels.
type EventHandler<T> = (payload: T) => void;

export interface TypedEventBus<EventMap extends Record<string, any>> {
	on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void;
	off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void;
	emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void;
	clear(): void;
}

export const createEventBus = <EventMap extends Record<string, any>>(): TypedEventBus<EventMap> => {
	const listeners = new Map<keyof EventMap, Set<EventHandler<any>>>();

	const on = <K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>) => {
		const handlers = listeners.get(event) ?? new Set<EventHandler<EventMap[K]>>();
		handlers.add(handler);
		listeners.set(event, handlers);

		return () => off(event, handler);
	};

	const off = <K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>) => {
		const handlers = listeners.get(event);
		if (!handlers) return;
		handlers.delete(handler);
		if (handlers.size === 0) {
			listeners.delete(event);
		}
	};

	const emit = <K extends keyof EventMap>(event: K, payload: EventMap[K]) => {
		const handlers = listeners.get(event);
		if (!handlers) return;
		handlers.forEach((handler) => handler(payload));
	};

	const clear = () => {
		listeners.clear();
	};

	return {
		on,
		off,
		emit,
		clear,
	};
};

