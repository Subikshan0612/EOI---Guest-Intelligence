/**
 * Conservative section-path calculation for the knowledge chunker.
 *
 * Pure and side-effect-free: no MongoDB, no HTTP, no I/O. Given the ordered
 * headings of one document it returns, for each heading, the ordered list of
 * headings from its outermost ancestor down to itself (the "section path").
 * The last element is always the heading itself, so it always equals the
 * chunk's own `section`.
 *
 * A parent is attached ONLY on explicit structural evidence, never because a
 * heading merely happened to be the previous one in the document:
 *
 *   1. Dotted numbering. "13.1 Child" is a child of "13. Parent" (and
 *      "1.1.1" of "1.1", or of "1." if "1.1" never appeared) because the
 *      numbering itself says so. Numbering decides on its own; a numbered
 *      heading with no numeric ancestor present has no parent.
 *   2. Markdown heading levels. "## Child" is a child of the nearest earlier
 *      "# Parent" - but only for headings that BOTH carry a Markdown level,
 *      and only while no plain (non-Markdown) heading has appeared in
 *      between. A plain numbered heading such as "31. Summary" followed by
 *      "## Internal Contact Updates" gives no evidence that the second
 *      belongs to the first, so the second stands alone.
 *
 * Anything else - an unnumbered heading with no Markdown parent, a numbered
 * heading whose numeric ancestors are absent - is a root: its path is just
 * itself. Missing hierarchy is preferred to invented hierarchy.
 *
 * A heading with no body still counts as a parent, since paths are computed
 * over headings, not chunks ("13. CANCELLATION & REFUND" has no text of its
 * own yet correctly heads its children).
 */

// Dotted numbering at the start of a heading: "1.", "1.1", "1.1.", "12.3.4".
const LEADING_NUMBERING = /^((?:\d+\.)+\d*|\d+\.)(?=\s)/;

/** "13.1 Child" -> ["13","1"]; "1. Parent" -> ["1"]; anything else -> null. */
function parseNumbering(text) {
  const match = text.match(LEADING_NUMBERING);
  if (!match) return null;
  const parts = match[1].split(".").filter((part) => part.length > 0);
  return parts.length > 0 ? parts : null;
}

/**
 * @param {Array<{ text: string, level: number | null }>} headings in document
 *   order. `level` is the Markdown heading level (1-6) or null for a heading
 *   recognised by numbering alone.
 * @returns {string[][]} one path per heading, same order.
 */
export function computeSectionPaths(headings) {
  const numbered = []; // { key, path } for every numbered heading seen
  let markdownChain = []; // { level, path }, ascending level, cleared by plain headings
  const paths = [];

  for (const { text, level } of headings) {
    const numbering = parseNumbering(text);
    let path = [text];

    if (numbering && numbering.length > 1) {
      // Longest proper numeric prefix present earlier in the document.
      for (let length = numbering.length - 1; length >= 1; length -= 1) {
        const key = numbering.slice(0, length).join(".");
        let parent = null;
        for (let i = numbered.length - 1; i >= 0; i -= 1) {
          if (numbered[i].key === key) {
            parent = numbered[i];
            break;
          }
        }
        if (parent) {
          path = [...parent.path, text];
          break;
        }
      }
    } else if (level !== null) {
      while (markdownChain.length > 0 && markdownChain[markdownChain.length - 1].level >= level) {
        markdownChain.pop();
      }
      if (markdownChain.length > 0) {
        path = [...markdownChain[markdownChain.length - 1].path, text];
      }
    }

    if (level !== null) {
      while (markdownChain.length > 0 && markdownChain[markdownChain.length - 1].level >= level) {
        markdownChain.pop();
      }
      markdownChain.push({ level, path });
    } else {
      // A plain heading interrupts the Markdown outline: later Markdown
      // headings must not attach across it.
      markdownChain = [];
    }

    if (numbering) numbered.push({ key: numbering.join("."), path });
    paths.push(path);
  }

  return paths;
}
