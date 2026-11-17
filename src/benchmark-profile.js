export function isCleanBenchmarkProfile(text) {
  return typeof text === 'string' && /^BENCHMARK_PROMPT_PROFILE=clean$/m.test(text);
}

export function applyBenchmarkPromptProfile(options) {
  if (!options || !isCleanBenchmarkProfile(options.appendSystemPrompt)) return false;
  options.contextFiles = [];
  options.skills = [];
  return true;
}
