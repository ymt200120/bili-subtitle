/*
 * Shared source-packing rule used by both the build script and the test
 * harness.
 *
 * Every file except the first (the BS namespace file) is wrapped in its
 * own IIFE so top-level helpers (e.g. multiple `discover` functions)
 * cannot shadow each other across files. Cross-file communication goes
 * exclusively through the BS namespace object.
 */

export function packSources(entries) {
  return entries
    .map(({ code }, index) =>
      index === 0 ? code : `;(function () {\n${code}\n})();`
    )
    .join('\n');
}
