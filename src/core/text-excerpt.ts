// A pure, deterministic truncation for showing untrusted model text in the UI without shipping
// the whole thing over the wire and into the DOM. This never sanitizes or escapes; that is the
// renderer's job (render as plain text, never HTML -- see CLAUDE.md invariant 3 and DESIGN.md
// section 11). This module only decides which characters to keep.

export type TextExcerpt = {
  /** The text's full length, before truncation. */
  length: number;
  /** The first `chars` characters, or the whole text when it fits within `2 * chars`. */
  head: string;
  /** The last `chars` characters. Empty when the text was not truncated. */
  tail: string;
  /** True when `head` and `tail` do not cover the whole text. */
  truncated: boolean;
};

/**
 * Head and tail excerpts of `text`, `chars` characters each (UTF-16 code units, matching
 * `String.prototype.slice`). Text no longer than `2 * chars` is returned whole, in `head`, with
 * `tail` empty and `truncated` false: there is nothing in the middle worth omitting.
 */
export function excerpt(text: string, chars: number): TextExcerpt {
  if (chars < 0) throw new Error("chars must not be negative");
  if (text.length <= chars * 2) return { length: text.length, head: text, tail: "", truncated: false };
  return { length: text.length, head: text.slice(0, chars), tail: text.slice(text.length - chars), truncated: true };
}
