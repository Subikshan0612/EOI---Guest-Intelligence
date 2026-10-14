/**
 * Phase 26.5 - exports EXACTLY the texts that would be sent to an embedding provider for the synthetic Phase 26 evaluation, and nothing else.
 *
 *   node evaluation/retrieval/real/export-manifest.mjs [--out <file>]
 *
 * No database, no network, no provider key. Documents are cut with the PRODUCTION chunker and turned into embedding input with the
 * PRODUCTION `buildEmbeddingText`; queries are built with the PRODUCTION `buildRetrievalQueryText`. Every text comes from
 * evaluation/retrieval/dataset.json (synthetic by construction); the manifest records each text with its sha256 so what was sent can be proven.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkContent } from "../../../src/services/knowledge/knowledgeChunker.js";
import { buildEmbeddingText, EMBEDDING_INPUT_VERSION } from "../../../src/services/knowledge/embeddingText.js";
import { buildRetrievalQueryText } from "../../../src/services/knowledgeRetrievalService.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATASET = path.join(here, "..", "dataset.json");
export const DEFAULT_MANIFEST = path.join(here, "..", "..", "results", "phase26_5-embedding-manifest.json");
const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

export function buildManifest() {
  const raw = fs.readFileSync(DATASET);
  const dataset = JSON.parse(raw.toString("utf8"));
  const entries = [];
  for (const doc of dataset.corpus.documents) {
    for (const piece of chunkContent(doc.content)) {
      const text = buildEmbeddingText({ sectionPath: piece.sectionPath.length ? piece.sectionPath : undefined, section: piece.section, text: piece.text });
      entries.push({ kind: "document", source: `${doc.key}#${piece.section}`, workspace: doc.workspace, visibility: doc.visibility, sha256: sha(text), chars: text.length, text });
    }
  }
  const seenQueries = new Set();
  for (const c of [...dataset.cases, ...dataset.securityCases]) {
    const text = buildRetrievalQueryText({ signal: c.signal });
    if (seenQueries.has(text)) continue;
    seenQueries.add(text);
    entries.push({ kind: "query", source: c.caseId, sha256: sha(text), chars: text.length, text });
  }
  return {
    schema: 1,
    purpose: "synthetic Phase 26 evaluation texts only (no production data)",
    datasetVersion: dataset.datasetVersion,
    datasetSha256: crypto.createHash("sha256").update(raw).digest("hex"),
    embeddingInputVersion: EMBEDDING_INPUT_VERSION,
    counts: { documents: entries.filter((e) => e.kind === "document").length, queries: entries.filter((e) => e.kind === "query").length, totalChars: entries.reduce((n, e) => n + e.chars, 0) },
    entries,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : DEFAULT_MANIFEST;
  const manifest = buildManifest();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest: ${manifest.counts.documents} document texts + ${manifest.counts.queries} query texts, ${manifest.counts.totalChars} characters -> ${out}`);
}
