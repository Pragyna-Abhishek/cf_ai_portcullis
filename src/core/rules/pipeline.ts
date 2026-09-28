// The verification pipeline for one model draft:
//
//   raw model string
//     -> decode against the schema            (invalid-schema on failure)
//     -> structural limits                    (invalid-schema on failure)
//     -> type check                           (invalid-types on failure)
//     -> print to Rules text                  (our code)
//     -> parse that text back                 (our code)
//     -> assert the two ASTs are deep-equal   (roundtrip-failed: our bug, never retried)
//
// The type checker runs before printing, as CLAUDE.md invariant 3 requires. Its diagnostics
// get spans afterwards, from the printer's span map, because the rendered text only exists
// once printing has happened.

import type { Diagnostic, RuleAST, RuleVersionStatus } from "../types";
import { diag, hasErrors } from "./diagnostics";
import { checkLimits } from "./limits";
import { parse } from "./parser";
import { print } from "./printer";
import { decodeModelOutput } from "./schema";
import type { SpanMap } from "./spans";
import { typecheck } from "./typecheck";

export type DraftOutcome = {
  status: Extract<RuleVersionStatus, "invalid-schema" | "invalid-types" | "roundtrip-failed" | "valid">;
  ast: RuleAST | null;
  text: string | null;
  diagnostics: Diagnostic[];
};

/** A model call that produced no text at all still becomes a recorded, diagnosed draft. */
export function modelFailureOutcome(kind: "json-mode-failed" | "error", message: string): DraftOutcome {
  return {
    status: "invalid-schema",
    ast: null,
    text: null,
    diagnostics: [diag(kind === "json-mode-failed" ? "E_JSON_MODE_FAILED" : "E_MODEL_ERROR", message, null)],
  };
}

export function verifyModelDraft(raw: string): DraftOutcome {
  const decoded = decodeModelOutput(raw);
  if (!decoded.ok) return { status: "invalid-schema", ast: null, text: null, diagnostics: decoded.diagnostics };
  return verifyAst(decoded.ast);
}

/**
 * Decodes the outer `{"rule": "RULE TEXT"}` wrapper for the text-output draft route. This is the
 * only place that touches the raw model string before it reaches the real parser; everything
 * past this point is the same lexer/parser/typechecker the operator's own typed-rule edits go
 * through (checkRuleText), so no new grammar and no new decoder logic is needed for the rule text
 * itself.
 */
function decodeRuleTextWrapper(raw: string): { ok: true; text: string } | { ok: false; diagnostics: Diagnostic[] } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, diagnostics: [diag("E_SCHEMA_NOT_JSON", null, null)] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, diagnostics: [diag("E_SCHEMA_INVALID", 'Expected an object with a "rule" property.', null)] };
  }
  const extra = Object.keys(value).filter((k) => k !== "rule");
  if (extra.length > 0) {
    return { ok: false, diagnostics: [diag("E_SCHEMA_INVALID", `Unexpected properties ${JSON.stringify(extra)}.`, null)] };
  }
  const rule = (value as Record<string, unknown>)["rule"];
  if (typeof rule !== "string") {
    return { ok: false, diagnostics: [diag("E_SCHEMA_INVALID", 'Property "rule" must be a string.', null)] };
  }
  return { ok: true, text: rule };
}

/**
 * The text-output draft route (docs/reviews/2026-09-27-first-real-model-run.md): the model emits
 * the rule as literal Rules-language text inside a flat `{"rule": string}` wrapper, instead of
 * the flat AST wire format `verifyModelDraft` decodes. The wrapper is decoded above; the text
 * itself goes through the same `parse` + `verifyAst` (limits, typecheck, print, round-trip) that
 * every other rule text goes through, so a parse failure here reuses the parser's existing
 * diagnostic codes rather than inventing new ones.
 */
export function verifyModelDraftText(raw: string): DraftOutcome {
  const wrapper = decodeRuleTextWrapper(raw);
  if (!wrapper.ok) return { status: "invalid-schema", ast: null, text: null, diagnostics: wrapper.diagnostics };
  const parsed = parse(wrapper.text);
  if (!parsed.ok) return { status: "invalid-schema", ast: null, text: wrapper.text, diagnostics: parsed.diagnostics };
  return verifyAst(parsed.ast);
}

/** Printer and parser are injectable only so a test can force a disagreement. */
export type RoundTripDeps = { print: typeof print; parse: typeof parse };
const DEFAULT_DEPS: RoundTripDeps = { print, parse };

export function verifyAst(ast: RuleAST, deps: RoundTripDeps = DEFAULT_DEPS): DraftOutcome {
  const limits = checkLimits(ast);
  if (limits.length > 0) return { status: "invalid-schema", ast: null, text: null, diagnostics: limits };

  const typeDiagnostics = typecheck(ast);

  const printed = deps.print(ast);
  const reparsed = deps.parse(printed.text);
  if (!reparsed.ok || !astEqual(ast, reparsed.ast)) {
    const why = reparsed.ok ? "ASTs differ." : `Parser rejected printer output: ${reparsed.diagnostics[0]?.message ?? ""}`;
    return {
      status: "roundtrip-failed",
      ast,
      text: printed.text,
      diagnostics: [diag("E_ROUNDTRIP_MISMATCH", why, null), ...typeDiagnostics],
    };
  }

  const placed = placeSpans(typecheck(ast, printed.spans), typeDiagnostics);
  return {
    status: hasErrors(placed) ? "invalid-types" : "valid",
    ast,
    text: printed.text,
    diagnostics: placed,
  };
}

/** The second type check pass is identical except for spans; keep the gate's verdict honest. */
function placeSpans(withSpans: Diagnostic[], gate: Diagnostic[]): Diagnostic[] {
  if (withSpans.length !== gate.length) throw new Error("type checker is not deterministic");
  return withSpans;
}

/** For operator-typed rules: parse first, then the same checks, with spans from the parser. */
export function checkRuleText(text: string): { ast: RuleAST | null; diagnostics: Diagnostic[]; spans: SpanMap | null } {
  const parsed = parse(text);
  if (!parsed.ok) return { ast: null, diagnostics: parsed.diagnostics, spans: null };
  const limits = checkLimits(parsed.ast);
  if (limits.length > 0) return { ast: null, diagnostics: limits, spans: parsed.spans };
  return { ast: parsed.ast, diagnostics: typecheck(parsed.ast, parsed.spans), spans: parsed.spans };
}

/** Structural equality for RuleAST. Absent and false `lower` are equal. */
export function astEqual(a: RuleAST, b: RuleAST): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "and":
    case "or":
      return b.kind === a.kind && astEqual(a.left, b.left) && astEqual(a.right, b.right);
    case "not":
      return b.kind === "not" && astEqual(a.operand, b.operand);
    case "compare":
      return (
        b.kind === "compare" &&
        a.field === b.field &&
        a.op === b.op &&
        a.value === b.value &&
        Boolean(a.lower) === Boolean(b.lower)
      );
    case "contains":
      return b.kind === "contains" && a.field === b.field && a.value === b.value && Boolean(a.lower) === Boolean(b.lower);
    case "in":
      return (
        b.kind === "in" &&
        a.field === b.field &&
        Boolean(a.lower) === Boolean(b.lower) &&
        a.values.length === b.values.length &&
        a.values.every((v, i) => v === b.values[i])
      );
  }
}
