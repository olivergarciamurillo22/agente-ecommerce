import path from "node:path";
import { intelligenceDataDir, readJsonRecovering, writeJsonAtomic } from "./persistence";
import type { HunterPipelineResult } from "./pipeline";

const target = () => path.join(intelligenceDataDir(), "hunter-pipeline-runs.json");
export function listPipelineRuns(): HunterPipelineResult[] { return readJsonRecovering(target(), () => [] as HunterPipelineResult[]); }
export function savePipelineRun(run: HunterPipelineResult): void { writeJsonAtomic(target(), [run, ...listPipelineRuns().filter((item) => item.runId !== run.runId)].slice(0, 100)); }

