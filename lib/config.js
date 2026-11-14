/** Runtime schema for DSH settings. Only native is live; CLI/auth configuration stays static. */
import z from '@deepseek-ai/schemastery'
import { parseNativeRequest } from './native.js'

const text = () => z.string()
const strings = () => z.array(text()).default(undefined)
export const Config = z.object({
  toolName: text(), command: text(), tmuxCommand: text(), presets: strings(), modelSelection: z.boolean(),
  permissionMode: z.union(['plan','dontAsk','acceptEdits','auto','bypassPermissions']),
  sessionMode: z.union(['ephemeral','persistent','session']),
  runTimeoutMs: z.number().min(0), disposeGraceMs: z.number().min(0),
  model: text(), reasoningEffort: text(), settingSources: strings(),
  env: z.dict(text()).default(undefined).role('secret'),
  // any preserves unknown input keys for the strict native validator. An object
  // transform would strip them before validation. The self-contained callback
  // also survives the Host's serialized plain-form schema.
  native: z.transform(z.any(), parseNativeRequest).default(undefined).volatile()
    .description('Native Agent/Workflow/Advisor defaults. Unset inherits the CLI, null turns all off. A per-call object replaces this whole value.'),
})
