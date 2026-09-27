import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../../src/core/scenarios";
import { selectScenarios } from "../../src/eval/select-scenarios";

describe("selectScenarios (eval harness --scenarios / --runs)", () => {
  it("with no options, returns every scenario", () => {
    expect(selectScenarios(SCENARIOS, {})).toEqual(SCENARIOS);
  });

  it("--scenarios filters to the named ids, in registry order", () => {
    const selected = selectScenarios(SCENARIOS, { ids: ["l7-trap-carrier", "cs-trap-carrier"] });
    expect(selected.map((d) => d.scenario.id)).toEqual(["cs-trap-carrier", "l7-trap-carrier"]);
  });

  it("--scenarios rejects an unknown id rather than silently ignoring it", () => {
    expect(() => selectScenarios(SCENARIOS, { ids: ["not-a-real-scenario"] })).toThrow(/unknown scenario id.*not-a-real-scenario/);
  });

  it("--runs caps the count, taken from the front of the (possibly already filtered) list", () => {
    expect(selectScenarios(SCENARIOS, { runs: 2 }).map((d) => d.scenario.id)).toEqual(SCENARIOS.slice(0, 2).map((d) => d.scenario.id));
  });

  it("--scenarios and --runs combine: filter first, then cap", () => {
    const selected = selectScenarios(SCENARIOS, { ids: ["cs-trap-carrier", "cs-trap-country", "cs-trap-shopapp"], runs: 2 });
    expect(selected.map((d) => d.scenario.id)).toEqual(["cs-trap-carrier", "cs-trap-country"]);
  });

  it("--runs rejects zero or a non-integer", () => {
    expect(() => selectScenarios(SCENARIOS, { runs: 0 })).toThrow(/positive integer/);
    expect(() => selectScenarios(SCENARIOS, { runs: 1.5 })).toThrow(/positive integer/);
  });
});
