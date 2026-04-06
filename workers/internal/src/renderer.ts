/**
 * Markdown-to-HTML rendering powered by `marked`.
 */

import { marked } from "marked";

// Configure marked with sensible defaults
marked.setOptions({
  gfm: true,
  breaks: true,
});

/** Convert a Markdown string to an HTML fragment. */
export function renderMarkdown(md: string): string {
  // marked.parse() can return string | Promise<string> depending on
  // configuration.  With synchronous extensions only it returns string.
  const result = marked.parse(md);
  if (typeof result === "string") return result;
  // Fallback: shouldn't happen with default config, but be safe.
  return md;
}
