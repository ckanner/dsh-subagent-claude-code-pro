/** Model identity evidence; a native cumulative usage map is not a per-turn trace. */
const ALIASES = Object.freeze({ sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5',
  haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-2', best: 'claude-opus-5-5' })
export const MODEL_BINDING_SOURCE = 'https://code.claude.com/docs/en/model-config'

export function modelMatches(requested, observed) {
  if (typeof observed !== 'string' || observed.trim() === '') return false
  if (requested === undefined || requested === observed) return true
  const base = requested?.replace(/\[1m\]$/, '')
  // [1m] requests a context window; wire model identity can omit that suffix.
  if (base?.startsWith('claude-') && base === observed.replace(/\[1m\]$/, '')) return true
  const family = base === 'best' ? 'opus' : base
  if (!Object.hasOwn(ALIASES, base)) return false
  return new RegExp(`^claude-${family}-[a-z0-9][a-z0-9.-]*(?:\\[1m\\])?$`).test(observed)
}

/** Pin documented first-party aliases before dispatch; do not infer dated IDs. */
export function resolveSubscriptionModel(requested, env = {}) {
  if (typeof requested !== 'string' || requested.trim() !== requested || !requested) throw new Error('subscription-only calls require an explicit model')
  const base = requested.replace(/\[1m\]$/, '')
  const family = base === 'best' ? 'opus' : base
  const override = env[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`]
  const model = Object.hasOwn(ALIASES, base)
    ? (override || ALIASES[base]) + (requested.endsWith('[1m]') && !(override || ALIASES[base]).endsWith('[1m]') ? '[1m]' : '')
    : requested
  if (!/^claude-(?:sonnet|opus|haiku|fable)-[a-z0-9][a-z0-9.-]*(?:\[1m\])?$/.test(model)) {
    throw new Error('subscription-only model must resolve to an explicit first-party Claude model ID')
  }
  return model
}

export function effortEnvironmentConflict(effort, env = {}) {
  const value = env.CLAUDE_CODE_EFFORT_LEVEL
  return effort !== undefined && value !== undefined && value !== '' && value !== effort
    ? 'CLAUDE_CODE_EFFORT_LEVEL overrides the requested effort; resolve the configuration conflict before dispatch' : undefined
}

/** Native model catalog is capability evidence, never proof of effective effort. */
export function effortCapabilityConflict(models, descriptor) {
  const bindings = [{ model: descriptor.options.model, effort: descriptor.options.effort },
    ...Object.values(descriptor.options.agents ?? {}).map(agent => ({
      model: !agent.model || agent.model === 'inherit' ? descriptor.options.model : agent.model,
      effort: agent.effort ?? descriptor.options.effort }))]
  for (const binding of bindings) {
    if (!binding.effort) continue
    const model = binding.model?.replace(/\[1m\]$/, '')
    const row = Array.isArray(models) && models.find(row => row?.value === model || row?.resolvedModel === model)
    if (row && (row.supportsEffort === false || (Array.isArray(row.supportedEffortLevels) && !row.supportedEffortLevels.includes(binding.effort)))) {
      return 'the initialized native model catalog does not support the requested effort; no task prompt was sent'
    }
  }
}

export function modelEvidence(requested, evidence) {
  const rootModels = evidence?.rootModels ?? []
  return { version: 1, rootModels, usageModels: evidence?.usageModels ?? [],
    rootMatched: rootModels.length ? rootModels.every(model => modelMatches(requested, model)) : null,
    source: rootModels.length ? 'assistant.message.model' : null,
    usageSource: evidence?.usageObserved ? 'result.modelUsage' : null,
    usageScope: evidence?.usageObserved ? 'native-cumulative-including-history-and-auxiliary' : 'unknown',
    wholeRunVerified: false }
}
