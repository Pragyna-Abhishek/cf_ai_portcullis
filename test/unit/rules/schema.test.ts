import { describe, expect, it } from "vitest";
import { checkLimits } from "../../../src/core/rules/limits";
import { decodeModelOutput, decodeRuleAst, encodeRuleAst, RULE_JSON_SCHEMA } from "../../../src/core/rules/schema";
import type { RuleAST } from "../../../src/core/types";

const firstCode = (raw: string) => {
  const r = decodeModelOutput(raw);
  return r.ok ? undefined : r.diagnostics[0]?.code;
};
/** Wraps a hand-written AST the way the model would emit it: flat, wrapped in {"rule": ...}. */
const wrap = (ast: RuleAST) => JSON.stringify({ rule: encodeRuleAst(ast) });
/** For cases that need to hand-craft a malformed flat body directly. */
const wrapRaw = (rule: unknown) => JSON.stringify({ rule });

describe("model output decoder", () => {
  it("decodes every node kind, round-tripping through encodeRuleAst", () => {
    const rule: RuleAST = {
      kind: "and",
      left: { kind: "not", operand: { kind: "compare", field: "ip.src.asnum", op: "ne", value: 1 } },
      right: {
        kind: "or",
        left: { kind: "contains", field: "http.user_agent", value: "x", lower: true },
        right: { kind: "in", field: "ip.src.country", values: ["GB"] },
      },
    };
    expect(decodeModelOutput(wrap(rule))).toEqual({ ok: true, ast: rule });
  });

  it("normalizes lower: false to absent, so the round trip compares like with like", () => {
    const r = decodeModelOutput(
      wrapRaw({ root: 0, nodes: [{ id: 0, kind: "compareString", field: "http.user_agent", op: "eq", value: "x", lower: false }] }),
    );
    expect(r).toEqual({ ok: true, ast: { kind: "compare", field: "http.user_agent", op: "eq", value: "x" } });
  });

  it("a node referenced by two parents expands at each reference", () => {
    // id 1 (the leaf) is reachable via both "left" and "right" of the "or" at id 0.
    const raw = wrapRaw({
      root: 0,
      nodes: [
        { id: 0, kind: "or", left: 1, right: 1 },
        { id: 1, kind: "compareNumber", field: "ip.src.asnum", op: "eq", value: 7 },
      ],
    });
    const r = decodeModelOutput(raw);
    expect(r).toEqual({
      ok: true,
      ast: {
        kind: "or",
        left: { kind: "compare", field: "ip.src.asnum", op: "eq", value: 7 },
        right: { kind: "compare", field: "ip.src.asnum", op: "eq", value: 7 },
      },
    });
  });

  it("E_SCHEMA_NOT_JSON", () => {
    expect(firstCode("not json")).toBe("E_SCHEMA_NOT_JSON");
    expect(firstCode('{"rule": ')).toBe("E_SCHEMA_NOT_JSON");
  });

  it("E_SCHEMA_INVALID with a pointer to the problem", () => {
    const cases: Array<[unknown, RegExp]> = [
      [[], /expected an object with a "rule"/],
      [{}, /missing required property "rule"/],
      [{ rule: {}, extra: 1 }, /unexpected properties/],
    ];
    for (const [value, message] of cases) {
      const r = decodeModelOutput(JSON.stringify(value));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.diagnostics[0]?.message).toMatch(message);
    }
    const bad: Array<[unknown, RegExp]> = [
      [{ root: 0, nodes: [{ id: 0, kind: "xor", left: 1, right: 2 }] }, /\/rule\/root\/kind: unknown kind/],
      [{ root: 0, nodes: [{ id: 0, kind: "compareString", field: "http.host", op: "eq", value: "x" }] }, /\/rule\/root\/field: unknown/],
      [{ root: 0, nodes: [{ id: 0, kind: "compareNumber", field: "http.host", op: "eq", value: 1 }] }, /\/rule\/root\/field: unknown/],
      [{ root: 0, nodes: [{ id: 0, kind: "compareString", field: "ip.src.asnum", op: "eq", value: "x" }] }, /\/rule\/root\/field: unknown string field/],
      [{ root: 0, nodes: [{ id: 0, kind: "compareNumber", field: "ip.src.asnum", op: "gt", value: 1 }] }, /\/rule\/root\/op/],
      [{ root: 0, nodes: [{ id: 0, kind: "compareNumber", field: "ip.src.asnum", op: "eq", value: 1.5 }] }, /\/rule\/root\/value/],
      [{ root: 0, nodes: [{ id: 0, kind: "compareNumber", field: "ip.src.asnum", op: "eq", value: -1 }] }, /\/rule\/root\/value/],
      [{ root: 0, nodes: [{ id: 0, kind: "compareNumber", field: "ip.src.asnum", op: "eq" }] }, /missing required property "value"/],
      [{ root: 0, nodes: [{ id: 0, kind: "compareNumber", field: "ip.src.asnum", op: "eq", value: 1, why: "x" }] }, /unexpected property "why"/],
      [
        { root: 0, nodes: [{ id: 0, kind: "compareString", field: "http.user_agent", op: "eq", value: "x", lower: "yes" }] },
        /\/rule\/root\/lower/,
      ],
      [{ root: 0, nodes: [{ id: 0, kind: "contains", field: "ip.src.asnum", value: "1" }] }, /contains needs a string field/],
      [{ root: 0, nodes: [{ id: 0, kind: "contains", field: "http.user_agent", value: 1 }] }, /\/rule\/root\/value: expected a string/],
      [{ root: 0, nodes: [{ id: 0, kind: "inNumbers", field: "ip.src.asnum", values: 1 }] }, /expected an array/],
      [{ root: 0, nodes: [{ id: 0, kind: "inNumbers", field: "ip.src.asnum", values: [null] }] }, /\/rule\/root\/values\/0/],
      [{ root: 0, nodes: [{ id: 0, kind: "and", left: 1, right: 2 }] }, /references unknown node id 1/],
      [{ root: 5, nodes: [{ id: 0, kind: "compareNumber", field: "ip.src.asnum", op: "eq", value: 1 }] }, /references unknown node id 5/],
      [
        {
          root: 0,
          nodes: [
            { id: 0, kind: "compareNumber", field: "ip.src.asnum", op: "eq", value: 1 },
            { id: 0, kind: "compareNumber", field: "ip.src.asnum", op: "eq", value: 2 },
          ],
        },
        /duplicate node id 0/,
      ],
      [{ root: 0, nodes: [] }, /at least 1/i],
      ["string", /expected an object/],
    ];
    for (const [rule, message] of bad) {
      const r = decodeModelOutput(wrapRaw(rule));
      expect(r.ok, JSON.stringify(rule)).toBe(false);
      if (!r.ok) {
        expect(r.diagnostics[0]?.code, JSON.stringify(rule)).toBe("E_SCHEMA_INVALID");
        expect(r.diagnostics[0]?.message).toMatch(message);
      }
    }
  });

  it("refuses sets above the cap at the boundary", () => {
    const values = Array.from({ length: 40 }, (_, i) => i);
    expect(firstCode(wrapRaw({ root: 0, nodes: [{ id: 0, kind: "inNumbers", field: "ip.src.asnum", values }] }))).toBe(
      "E_SCHEMA_INVALID",
    );
  });

  it("stops recursing at the depth cap on a hostile chain of \"not\" nodes", () => {
    // 40 nodes total (well under the 64-entry array cap), but chained 40 deep, past maxDepth (32).
    const nodes: unknown[] = Array.from({ length: 40 }, (_, i) => ({ id: i, kind: "not", operand: i + 1 }));
    nodes.push({ id: 40, kind: "compareNumber", field: "ip.src.asnum", op: "eq", value: 1 });
    expect(firstCode(wrapRaw({ root: 0, nodes }))).toBe("E_AST_TOO_DEEP");
  });

  it("a small node list reused into an exponentially larger tree is stopped by node budget, not depth", () => {
    // 7 "or" nodes chained so each level's left and right both point at the same next node,
    // doubling the number of expansions per level. 8 array entries total (far under the 64-entry
    // array cap, and the chain is only 8 deep, far under the 32 depth cap), but a naive expander
    // that does not cap total expansions would build a tree of 2^8-1 nodes from it.
    const nodes: unknown[] = Array.from({ length: 7 }, (_, i) => ({ id: i, kind: "or", left: i + 1, right: i + 1 }));
    nodes.push({ id: 7, kind: "compareNumber", field: "ip.src.asnum", op: "eq", value: 1 });
    const r = decodeModelOutput(wrapRaw({ root: 0, nodes }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]?.code).toBe("E_AST_TOO_MANY_NODES");
  });

  it("a self-referencing node fails as too deep rather than hanging", () => {
    const r = decodeModelOutput(wrapRaw({ root: 0, nodes: [{ id: 0, kind: "not", operand: 0 }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]?.code).toBe("E_AST_TOO_DEEP");
  });

  it("decodeRuleAst works without the {rule: ...} wrapper", () => {
    const r = decodeRuleAst({ root: 0, nodes: [{ id: 0, kind: "compareNumber", field: "ip.src.asnum", op: "eq", value: 1 }] });
    expect(r.ok).toBe(true);
  });

  it("encodeRuleAst assigns each node an id equal to its own array index, and splits compare/in by value type", () => {
    const rule: RuleAST = {
      kind: "and",
      left: { kind: "compare", field: "ip.src.asnum", op: "eq", value: 1 },
      right: { kind: "compare", field: "http.request.uri.path", op: "eq", value: "/login" },
    };
    const { root, nodes } = encodeRuleAst(rule);
    nodes.forEach((n, i) => expect(n.id).toBe(i));
    expect(nodes[root]?.kind).toBe("and");
    expect(nodes.map((n) => n.kind)).toContain("compareNumber");
    expect(nodes.map((n) => n.kind)).toContain("compareString");
  });

  it("the JSON Schema has no $ref recursion, is a flat bounded array, and names exactly the fields and kinds the decoder accepts", () => {
    const asText = JSON.stringify(RULE_JSON_SCHEMA);
    expect(asText).not.toContain("$ref");
    expect(asText).not.toContain("$defs");
    expect(RULE_JSON_SCHEMA.properties.nodes.maxItems).toBeGreaterThan(0);
    const variants = RULE_JSON_SCHEMA.properties.nodes.items.anyOf.map((v) => v.properties.kind.enum[0]);
    expect(variants).toEqual(["and", "or", "not", "compareString", "compareNumber", "contains", "inStrings", "inNumbers"]);
    expect(asText).not.toContain("http.host");
    // No field takes a `["string", "integer"]` union type: every leaf variant's value/values type is singular.
    expect(asText).not.toMatch(/"type":\["?string"?,\s*"?integer"?\]/);
  });
});

// The connective-explosion pathology, from the deployed site's first real (non-fake) investigation
// (docs/reviews/2026-09-27-first-real-model-run.md). The model, given RULE_JSON_SCHEMA, produced
// a perfect binary tree of pure "or" connectives -- ids doubling, no leaf condition anywhere -- and
// ran out its 1024-token completion budget mid-object, on all 3 draft attempts.
//
// The strings below are the real head and tail bytes of two of those three attempts, exactly as
// the deployed UI's raw-output view showed them (it excerpts the first and last 400 characters).
// The middle (1359-1361 characters, depending on the attempt) was never captured anywhere: the UI
// never rendered more than the head and tail, so there is no complete original to reproduce. What
// is here is the two genuine boundary substrings concatenated with nothing invented in between --
// still truncated, unbalanced JSON, same as the real output was. The test does not depend on the
// omitted middle: any string with this shape (an object opened but never closed, a value cut off
// mid-token) must fail JSON.parse, so decodeModelOutput must reject it as E_SCHEMA_NOT_JSON either
// way. This documents that the bug was real and reproducible, not that this exact byte sequence is
// what shipped that day.
describe("regression: the real truncated connective-explosion output (2026-09-27)", () => {
  // Attempt 1 of 3 (and attempt 2, byte-identical): 2159 characters total, 1359 omitted.
  const attempt1HeadAndTail =
    '{"nodes": [{"id": 0, "kind": "and", "left": 1, "right": 2}, {"id": 1, "kind": "or", "left": 3, "right": 4}, ' +
    '{"id": 2, "kind": "or", "left": 5, "right": 6}, {"id": 3, "kind": "or", "left": 7, "right": 8}, ' +
    '{"id": 4, "kind": "or", "left": 9, "right": 10}, {"id": 5, "kind": "or", "left": 11, "right": 12}, ' +
    '{"id": 6, "kind": "or", "left": 13, "right": 14}, {"id": 7, "kind": "or", "left": 15, "right": 16' +
    // -- 1359 characters omitted: never shown by the UI, never captured --
    ', "right": 70}, {"id": 35, "kind": "or", "left": 71, "right": 72}, {"id": 36, "kind": "or", "left": 73, "right": 74}, ' +
    '{"id": 37, "kind": "or", "left": 75, "right": 76}, {"id": 38, "kind": "or", "left": 77, "right": 78}, ' +
    '{"id": 39, "kind": "or", "left": 79, "right": 80}, {"id": 40, "kind": "or", "left": 81, "right": 82}, ' +
    '{"id": 41, "kind": "or", "left": 83, "right": 84}, {"id": 42, "kind": "or",';

  // Attempt 3 of 3: 2161 characters total, 1361 omitted. Same head; the tail's boundary lands two
  // characters later, consistent with running two tokens further before the same 1024-token cutoff.
  const attempt3HeadAndTail =
    '{"nodes": [{"id": 0, "kind": "and", "left": 1, "right": 2}, {"id": 1, "kind": "or", "left": 3, "right": 4}, ' +
    '{"id": 2, "kind": "or", "left": 5, "right": 6}, {"id": 3, "kind": "or", "left": 7, "right": 8}, ' +
    '{"id": 4, "kind": "or", "left": 9, "right": 10}, {"id": 5, "kind": "or", "left": 11, "right": 12}, ' +
    '{"id": 6, "kind": "or", "left": 13, "right": 14}, {"id": 7, "kind": "or", "left": 15, "right": 16' +
    // -- 1361 characters omitted: never shown by the UI, never captured --
    '9, "right": 70}, {"id": 35, "kind": "or", "left": 71, "right": 72}, {"id": 36, "kind": "or", "left": 73, "right": 74}, ' +
    '{"id": 37, "kind": "or", "left": 75, "right": 76}, {"id": 38, "kind": "or", "left": 77, "right": 78}, ' +
    '{"id": 39, "kind": "or", "left": 79, "right": 80}, {"id": 40, "kind": "or", "left": 81, "right": 82}, ' +
    '{"id": 41, "kind": "or", "left": 83, "right": 84}, {"id": 42, "kind": "or", "';

  it("decodeModelOutput still correctly rejects the real attempt-1/2 output as E_SCHEMA_NOT_JSON", () => {
    const r = decodeModelOutput(attempt1HeadAndTail);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]?.code).toBe("E_SCHEMA_NOT_JSON");
  });

  it("decodeModelOutput still correctly rejects the real attempt-3 output as E_SCHEMA_NOT_JSON", () => {
    const r = decodeModelOutput(attempt3HeadAndTail);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]?.code).toBe("E_SCHEMA_NOT_JSON");
  });
});

describe("structural limits", () => {
  const leaf: RuleAST = { kind: "compare", field: "ip.src.asnum", op: "eq", value: 1 };

  it("accepts rules within the caps", () => {
    expect(checkLimits(leaf)).toEqual([]);
  });

  it("E_AST_TOO_DEEP", () => {
    let deep: RuleAST = leaf;
    for (let i = 0; i < 40; i++) deep = { kind: "not", operand: deep };
    expect(checkLimits(deep).map((d) => d.code)).toContain("E_AST_TOO_DEEP");
  });

  it("E_AST_TOO_MANY_NODES", () => {
    // A balanced tree: shallow, but wide.
    const tree = (d: number): RuleAST => (d === 0 ? leaf : { kind: "or", left: tree(d - 1), right: tree(d - 1) });
    expect(checkLimits(tree(7)).map((d) => d.code)).toEqual(["E_AST_TOO_MANY_NODES"]);
  });

  it("E_SET_TOO_LARGE", () => {
    const values = Array.from({ length: 33 }, (_, i) => i);
    expect(checkLimits({ kind: "in", field: "ip.src.asnum", values }).map((d) => d.code)).toEqual(["E_SET_TOO_LARGE"]);
  });

  it("E_STRING_TOO_LONG", () => {
    const value = "x".repeat(300);
    expect(checkLimits({ kind: "contains", field: "http.user_agent", value }).map((d) => d.code)).toEqual(["E_STRING_TOO_LONG"]);
    expect(checkLimits({ kind: "in", field: "http.user_agent", values: [value] }).map((d) => d.code)).toEqual([
      "E_STRING_TOO_LONG",
    ]);
  });
});
