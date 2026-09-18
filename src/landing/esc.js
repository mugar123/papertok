/**
 * One escaper, imported by both builders. It was written out twice —
 * byte-identical, in page.js and graphMap.js — which is the arrangement where
 * a fix reaches one copy and not the other. Both are prerender-time modules:
 * nothing here ships to the browser, so sharing it costs the page nothing.
 *
 * For text nodes and quoted attribute VALUES only. A value that becomes part
 * of a bare identifier — a class name, a token spliced into `var(...)` —
 * needs assertSafeToken in page.js instead, which checks the shape rather
 * than escaping characters this leaves untouched.
 */
export const esc = (v) => String(v)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
