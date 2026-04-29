// File role: fetch lightweight page overview metadata for the room overview panel.
import { fetchProtectedPageOverview } from "./sessionApi";

export interface PageOverviewItem {
	pageId: number;
	pageNumber: number;
	collaboratorCount: number;
}

interface PageOverviewResponse {
	data?: {
		roomId?: string;
		totalPage?: number;
		pages?: PageOverviewItem[];
	};
}

export const fetchPageOverview = async (roomId: string, sessionToken: string) => {
	const response = (await fetchProtectedPageOverview(roomId, sessionToken)) as PageOverviewResponse["data"];
	return {
		totalPages: response?.totalPage ?? 0,
		pages: response?.pages ?? [],
	};
};
