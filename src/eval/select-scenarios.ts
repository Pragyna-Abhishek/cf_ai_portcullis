// Scenario selection for the eval harness's --scenarios and --runs CLI flags. Pulled out of
// scripts/eval-driver.ts as a pure function so the filtering logic has a unit test independent of
// the CLI wiring and file I/O.

import type { ScenarioDefinition } from "../core/scenarios";

export type ScenarioSelection = { ids?: readonly string[]; runs?: number };

export function selectScenarios(all: readonly ScenarioDefinition[], opts: ScenarioSelection): readonly ScenarioDefinition[] {
  let selected = all;
  if (opts.ids) {
    const unknown = opts.ids.filter((id) => !all.some((d) => d.scenario.id === id));
    if (unknown.length > 0) throw new Error(`--scenarios: unknown scenario id(s): ${unknown.join(", ")}`);
    const ids = opts.ids;
    selected = all.filter((d) => ids.includes(d.scenario.id));
  }
  if (opts.runs !== undefined) {
    if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error(`--runs must be a positive integer, got ${opts.runs}`);
    selected = selected.slice(0, opts.runs);
  }
  return selected;
}
