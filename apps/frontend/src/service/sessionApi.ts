import axios from "axios";

const apiUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:4646";

const buildSessionHeaders = (sessionToken: string) => ({
	Authorization: `Bearer ${sessionToken}`,
});

export interface SessionAuthPayload {
	sessionToken: string;
	token?: string;
	expiresAt: number | null;
}

export interface InviteMetaPayload {
	roomId: string;
	roomName: string;
	roomCreatedAt: number;
	passwordRequired: boolean;
}

export interface ShareInvitePayload {
	inviteToken: string;
	token?: string;
	passwordRequired: boolean;
}

export const getInviteMeta = async (inviteToken: string) => {
	const response = await axios.get<{ data: InviteMetaPayload }>(
		`${apiUrl}/get-token-info?token=${encodeURIComponent(inviteToken)}`
	);
	return response.data.data;
};

export const renewRoomSession = async (sessionToken: string) => {
	const response = await axios.post<{ data: SessionAuthPayload }>(
		`${apiUrl}/renew-room-session`,
		{},
		{
			headers: buildSessionHeaders(sessionToken),
		}
	);
	return response.data.data;
};

export const generateShareInvite = async (roomId: string, sessionToken: string) => {
	const response = await axios.get<{ data: ShareInvitePayload }>(
		`${apiUrl}/generate-share-token?roomId=${encodeURIComponent(roomId)}`,
		{
			headers: buildSessionHeaders(sessionToken),
		}
	);
	return response.data.data;
};

export const fetchProtectedPageOverview = async (roomId: string, sessionToken: string) => {
	const response = await axios.get(`${apiUrl}/get-page-review?roomId=${encodeURIComponent(roomId)}`, {
		headers: buildSessionHeaders(sessionToken),
	});
	return response.data?.data ?? {};
};
