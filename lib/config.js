/** Real DSH Settings schema. Only native defaults change without remounting. */
import z from '@deepseek-ai/schemastery'
const text = () => z.string()
const positive = () => z.number().step(1).min(1)
const optionalObject = fields => z.object(fields).default(undefined)
const strings = () => z.array(text()).default(undefined)
const definition = optionalObject({
  description: text().required(), prompt: text().required(), tools: strings(), disallowedTools: strings(),
  model: text(), permissionMode: z.union(['plan','dontAsk','acceptEdits','auto','bypassPermissions']), maxTurns: positive(),
})
export const Config = z.object({
  toolName: text(), command: text(), presets: strings(), modelSelection: z.boolean(),
  permissionMode: z.union(['plan','dontAsk','acceptEdits','auto','bypassPermissions']),
  sessionMode: z.union(['ephemeral','persistent','session']),
  runTimeoutMs: z.number().min(0), disposeGraceMs: z.number().min(0),
  model: text(), reasoningEffort: text(), settingSources: strings(), env: z.dict(text()).default(undefined).role('secret'),
  native: optionalObject({
    version: z.const(1).required(),
    agents: optionalObject({ enabled: z.boolean().required(), maxConcurrent: positive(), maxDepth: positive(),
      definitions: z.dict(definition).default(undefined) }),
    workflows: optionalObject({ enabled: z.boolean().required(), maxConcurrent: positive().max(256) }),
    advisor: optionalObject({ enabled: z.boolean().required(), model: text() }),
  }).volatile().description('Claude native defaults: omitted inherits CLI settings; null explicitly disables all; an object replaces all native controls.'),
})
