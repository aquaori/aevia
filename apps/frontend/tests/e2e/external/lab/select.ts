// File role: `--case-ids` / `--case-keys` selection helpers (P2).
//
// Selection is applied at each suite's case enumeration site, before any room
// or browser work happens, so a filtered suite returns only the selected cases
// and the aggregate report can compare `expectedCases` strictly.
import type { ExternalConfig } from "../types";

export type CaseSelectionConfig = Pick<ExternalConfig, "caseIds" | "caseKeys">;

/**
 * Stable case key, identical to `tests/report/aggregate.ts` caseKeyOf:
 * `<case id>|<environment>|<scale>` with empty parts for absent values.
 */
export const caseKeyOf = (
	id: string,
	environment: string | undefined,
	scale: number | null | undefined
): string => `${id}|${environment ?? ""}|${scale == null ? "" : String(scale)}`;

export const hasCaseSelection = (config: CaseSelectionConfig): boolean =>
	config.caseIds.length > 0 || config.caseKeys.length > 0;

export const isCaseSelected = (
	config: CaseSelectionConfig,
	id: string,
	environment: string | undefined,
	scale: number | null | undefined = null
): boolean => {
	if (config.caseIds.length > 0 && !config.caseIds.includes(id)) return false;
	if (config.caseKeys.length > 0 && !config.caseKeys.includes(caseKeyOf(id, environment, scale))) return false;
	return true;
};

export const describeCaseSelection = (config: CaseSelectionConfig): string =>
	[
		config.caseIds.length > 0 ? `caseIds=${config.caseIds.join(",")}` : "",
		config.caseKeys.length > 0 ? `caseKeys=${config.caseKeys.join(",")}` : "",
	]
		.filter(Boolean)
		.join(" ");
