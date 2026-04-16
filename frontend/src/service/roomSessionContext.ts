// File role: provide/inject helpers for the room-scoped whiteboard session host.
import { inject, provide, shallowRef, type InjectionKey, type ShallowRef } from "vue";
import type { EditorHookMap, WhiteboardSession } from "../utils/editorTypes";

const roomSessionKey: InjectionKey<ShallowRef<WhiteboardSession | null>> = Symbol("room-session");
let activeRoomSessionRef: ShallowRef<WhiteboardSession | null> | null = null;

export const provideRoomSession = (session?: WhiteboardSession) => {
	const sessionRef = shallowRef<WhiteboardSession | null>(session ?? null);
	activeRoomSessionRef = sessionRef;
	provide(roomSessionKey, sessionRef);
	return sessionRef;
};

export const useRoomSessionRef = () => {
	const sessionRef = inject(roomSessionKey, activeRoomSessionRef);
	if (!sessionRef) {
		throw new Error("Room session has not been provided.");
	}
	return sessionRef;
};

export const useRoomSession = () => {
	const sessionRef = useRoomSessionRef();
	const session = sessionRef.value;
	if (!session) {
		throw new Error("Room session has not been initialized.");
	}
	return session;
};

export const useRoomSessionEmitHook = () => {
	const sessionRef = useRoomSessionRef();
	return <K extends keyof EditorHookMap>(event: K, payload: EditorHookMap[K]) => {
		sessionRef.value?.emitHook(event, payload);
	};
};
