import { describe, expect, it } from "vitest";
import { excerpt } from "../../src/core/text-excerpt";

describe("excerpt", () => {
  it("returns short text whole, untruncated", () => {
    const e = excerpt("hello world", 400);
    expect(e).toEqual({ length: 11, head: "hello world", tail: "", truncated: false });
  });

  it("returns text exactly at the 2*chars boundary whole", () => {
    const text = "a".repeat(800);
    const e = excerpt(text, 400);
    expect(e.truncated).toBe(false);
    expect(e.head).toBe(text);
    expect(e.tail).toBe("");
  });

  it("truncates text one character past the boundary into a 400/400 head and tail", () => {
    const text = "x".repeat(801);
    const e = excerpt(text, 400);
    expect(e.truncated).toBe(true);
    expect(e.length).toBe(801);
    expect(e.head).toHaveLength(400);
    expect(e.tail).toHaveLength(400);
    expect(e.head).toBe("x".repeat(400));
    expect(e.tail).toBe("x".repeat(400));
  });

  it("head is the true prefix and tail is the true suffix of the original text", () => {
    const text = "0123456789".repeat(200); // 2000 chars, distinguishable by position
    const e = excerpt(text, 400);
    expect(e.head).toBe(text.slice(0, 400));
    expect(e.tail).toBe(text.slice(1600));
  });

  it("passes HTML and script tags through untouched: this is truncation, not sanitization", () => {
    const malicious = `<script>alert(1)</script>` + "y".repeat(2000) + `<img src=x onerror="alert(2)">`;
    const e = excerpt(malicious, 400);
    expect(e.truncated).toBe(true);
    // The head keeps the leading script tag byte-for-byte; nothing here escapes or strips it.
    expect(e.head.startsWith("<script>alert(1)</script>")).toBe(true);
    expect(e.head).not.toContain("&lt;");
    // The tail keeps the trailing malicious markup byte-for-byte too.
    expect(e.tail.endsWith(`<img src=x onerror="alert(2)">`)).toBe(true);
    expect(e.tail).not.toContain("&lt;");
  });

  it("handles the empty string", () => {
    expect(excerpt("", 400)).toEqual({ length: 0, head: "", tail: "", truncated: false });
  });

  it("rejects a negative chars argument", () => {
    expect(() => excerpt("abc", -1)).toThrow();
  });

  it("chars of 0 truncates any non-empty text into two empty excerpts", () => {
    const e = excerpt("abc", 0);
    expect(e).toEqual({ length: 3, head: "", tail: "", truncated: true });
  });
});
