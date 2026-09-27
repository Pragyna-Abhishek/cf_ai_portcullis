// Prompt templates, bundled as text by the Wrangler "Text" module rule for prompts/*.txt.

import classifySymptomSystem from "../../prompts/classify-symptom.system.txt";
import classifySymptomUser from "../../prompts/classify-symptom.user.txt";
import draftRuleSystem from "../../prompts/draft-rule.system.txt";
import draftRuleUser from "../../prompts/draft-rule.user.txt";
import draftRuleTextSystem from "../../prompts/draft-rule-text.system.txt";
import draftRuleTextUser from "../../prompts/draft-rule-text.user.txt";
import hypothesizeSystem from "../../prompts/hypothesize.system.txt";
import hypothesizeUser from "../../prompts/hypothesize.user.txt";
import writeReportSystem from "../../prompts/write-report.system.txt";
import writeReportUser from "../../prompts/write-report.user.txt";
import type { PromptTemplates } from "../core/prompt";

/** Superseded by DRAFT_RULE_TEXT_TEMPLATES for the production draft step; see DESIGN.md section 7. */
export const DRAFT_RULE_TEMPLATES: PromptTemplates = { system: draftRuleSystem, user: draftRuleUser };
export const DRAFT_RULE_TEXT_TEMPLATES: PromptTemplates = { system: draftRuleTextSystem, user: draftRuleTextUser };
export const CLASSIFY_SYMPTOM_TEMPLATES: PromptTemplates = { system: classifySymptomSystem, user: classifySymptomUser };
export const HYPOTHESIZE_TEMPLATES: PromptTemplates = { system: hypothesizeSystem, user: hypothesizeUser };
export const WRITE_REPORT_TEMPLATES: PromptTemplates = { system: writeReportSystem, user: writeReportUser };
