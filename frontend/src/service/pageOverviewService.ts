// File role: fetch lightweight page overview metadata for the room overview panel.
import axios from "axios";

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

export const fetchPageOverview = async (roomId: string) => {
	const apiUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:4646";
	const response = await axios.get<PageOverviewResponse>(`${apiUrl}/get-page-review?roomId=${roomId}`);
	return {
		totalPages: response.data?.data?.totalPage ?? 0,
		pages: response.data?.data?.pages ?? [],
	};
};
