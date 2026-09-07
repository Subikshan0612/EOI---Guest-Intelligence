import { promptCategories, prompts } from "../../data/mockData";

export function listPromptCategories() {
  return promptCategories;
}

export function listPrompts() {
  return prompts;
}

export function groupPromptsByCategory() {
  return promptCategories.map((category) => ({
    category,
    prompts: prompts.filter((prompt) => prompt.category === category),
  }));
}

const SUGGESTED_PROMPT_IDS = [
  "prm_analyze_complaint",
  "prm_stay_risk",
  "prm_service_recovery",
];

export function listSuggestedPrompts() {
  return SUGGESTED_PROMPT_IDS.map((id) => prompts.find((prompt) => prompt.id === id)).filter(
    Boolean,
  );
}
