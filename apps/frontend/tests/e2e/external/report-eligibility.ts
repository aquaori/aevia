import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export const assertReportEligible = (payload: unknown, sourcePath?: string): void => {
	const report = payload as { validity?: { status?: string; aborted?: boolean }; run?: { dirtyPatchSha256?: string }; results?: { status?: string }[] };
	if (!report || report.validity?.status !== "valid" || report.validity.aborted ||
		report.run?.dirtyPatchSha256 !== createHash("sha256").update("").digest("hex") ||
		!Array.isArray(report.results) || report.results.length === 0 || report.results.some(result => result.status !== "passed")) {
		throw new Error("History/baseline requires a nonempty, valid, clean-source report with every case passed");
	}
	if (sourcePath) {
		let directory = path.dirname(path.resolve(sourcePath));
		while (true) {
			const manifestPath = path.join(directory, "run-manifest.json");
			if (fs.existsSync(manifestPath)) {
				const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
				if (manifest.status !== "passed" || manifest.recorded !== true || manifest.rerun || manifest.profile === "single" || manifest.validity?.status !== "valid" || !manifest.steps?.some((step: { id: string; status: string }) => step.id === "source-check" && step.status === "passed")) {
					throw new Error("Managed report requires a recorded successful terminal run and source-check");
				}
				break;
			}
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}
};
