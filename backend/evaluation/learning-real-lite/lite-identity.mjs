import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CASES, DATASET_VERSION } from "../learning-real/dataset.mjs";
import { buildManifest } from "../learning-real/manifest.mjs";
import { AI_DIR, EVALUATION_ID, LITE_MODEL, LITE_PROVIDER, REPETITIONS, RESULTS_DIR_NAME } from "./lite-config.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fileSha = (p) => sha256(fs.readFileSync(p));

/** Hash of the exact Phase 33 dataset this evaluation consumes (imported unchanged from ../learning-real/dataset.mjs). */
export const datasetSha256 = () => sha256(JSON.stringify(CASES));

/** What makes this evaluation comparable to Phase 33: the same dataset and the same prompt/client code. Recorded, never edited. */
export function evaluationIdentity() {
  return {
    evaluationId: EVALUATION_ID,
    separateFromPhase33: true,
    provider: LITE_PROVIDER,
    model: LITE_MODEL,
    resultsNamespace: RESULTS_DIR_NAME,
    datasetVersion: DATASET_VERSION,
    datasetSha256: datasetSha256(),
    cases: CASES.length,
    arms: 2,
    repetitionsPerArm: REPETITIONS,
    totalSlots: CASES.length * 2 * REPETITIONS,
    promptFileSha256: fileSha(path.join(AI_DIR, "app", "services", "analysis_prompt.py")),
    geminiClientFileSha256: fileSha(path.join(AI_DIR, "app", "services", "gemini_analysis_client.py")),
  };
}

/** Same manifest builder as Phase 33 (unchanged), with the Lite model and the identity block attached. */
export function liteManifest() {
  return { ...buildManifest({ provider: LITE_PROVIDER, model: LITE_MODEL, repetitions: REPETITIONS }), identity: evaluationIdentity() };
}
