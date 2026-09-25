/**
 * The single, canonical definition of what text a knowledge chunk is embedded
 * as. Pure and deterministic: no I/O, no identifiers, no clock.
 *
 * Retrieval quality depends on a chunk's heading as much as its body - a
 * chunk that says "Guests may cancel up to 48 hours before arrival" never
 * mentions "refund" if that word lives only in its parent heading - so the
 * section path is placed in front of the chunk text before embedding. The
 * result is used ONLY as embedding input; it is never stored (a stored copy
 * could drift from `sectionPath` + `text`) and never shown to the LLM as the
 * chunk's text.
 *
 * EMBEDDING_INPUT_VERSION identifies this exact recipe. It is stored on each
 * embedded chunk as `embeddingInputVersion`. Any change to what this function
 * returns for the same chunk MUST bump it, so vectors made under an older
 * recipe can be recognised and re-embedded instead of silently mixed in.
 *
 *   1 = each `sectionPath` heading on its own line, then the chunk text.
 */
export const EMBEDDING_INPUT_VERSION = 1;

/**
 * @param {{ sectionPath?: string[], section?: string, text: string }} chunk
 * @returns {string}
 *
 * Falls back to `[section]` when `sectionPath` is absent or empty but
 * `section` is set (a chunk created before `sectionPath` existed), and to the
 * bare text when there is no heading at all. The chunk text itself is
 * appended unchanged.
 */
export function buildEmbeddingText({ sectionPath, section, text }) {
  let headings = Array.isArray(sectionPath) ? sectionPath : [];
  headings = headings.map((heading) => String(heading).trim()).filter((heading) => heading.length > 0);

  if (headings.length === 0 && typeof section === "string" && section.trim().length > 0) {
    headings = [section.trim()];
  }

  return headings.length === 0 ? text : `${headings.join("\n")}\n${text}`;
}
