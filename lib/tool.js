/**
 * The model-facing delegation tool.
 *
 * The tool is registered into each Agent's own context, so the harness's
 * preset-row machinery stays out of the path. It carries the choices the
 * official `subagent_claude_code` cannot express — model, effort, session
 * lifetime, an explicit session to continue, multimodal input, structured
 * output, a background run — while keeping the same tool name so a model that
 * already knows the official tool needs no new vocabulary.
 *
 * @module dsh-subagent-claude-code-pro/tool
 */

import { allowedPermissionModes } from './cli.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Build the delegation tool definition.
 *
 * @param {{
 *   toolName: string,
 *   cwd: string,
 *   modelSelectionEnabled: boolean,
 *   backgroundEnabled: boolean,
 *   permissionMode: string,
 *   sessionMode: 'ephemeral' | 'persistent' | 'session',
 *   model?: string,
 *   reasoningEffort?: string,
 *   run: (call: any, signal: AbortSignal) => Promise<{ content: readonly { type: string, text?: string, attachment?: unknown }[] }>,
 *   startBackground: (call: any) => string,
 * }} options
 * @returns {any}
 */
export function createClaudeCodeTool(options) {
  const permissionModes = allowedPermissionModes(options.permissionMode)
  const effortHint = options.reasoningEffort === undefined
    ? ''
    : ` Leave it unset to use the configured ${options.reasoningEffort}.`
  const sessionDefault = options.sessionMode
  const sessionHint = sessionDefault === 'ephemeral'
    ? ' This installation defaults to `ephemeral`: the run leaves no durable Claude Code session behind.'
    : sessionDefault === 'session'
      ? ' This installation defaults to `session`: consecutive delegations from this conversation continue one durable Claude Code session, and the run reports its id.'
      : ' This installation defaults to `persistent`: each run gets its own durable Claude Code session and reports its id.'

  const contentShape = {
    type: 'object',
    additionalProperties: false,
    properties: { content: { type: 'array', items: {} } },
    required: ['content'],
  }
  const backgroundShape = {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', const: 'background' },
      jobId: { type: 'string' },
    },
    required: ['kind', 'jobId'],
  }

  return {
    name: options.toolName,
    description:
      'Delegate one self-contained task to the local Claude Code CLI and return its final answer. '
      + 'Claude Code runs in this session\'s working directory with its own tools and its own native settings, '
      + 'so the prompt must be complete: it cannot see this conversation. '
      + 'Prefer one delegation per independent task, and start independent delegations together in one '
      + 'assistant message. A delegation is cancelled when it exceeds the configured deadline, and the result says so.'
      + (options.modelSelectionEnabled
        ? ' `model` and `reasoning_effort` choose this delegation\'s Claude model and thinking level; omit them to use the configured defaults.'
        : '')
      + ' `images` and `documents` hand Claude pictures or PDFs by absolute path, so it receives them as '
      + 'model-native content instead of having to open files itself.'
      + ' `output_schema` makes the final answer JSON that conforms to that schema.'
      + (options.backgroundEnabled
        ? ' Set `run_in_background` for a long delegation that your next action does not depend on; the '
          + 'call returns a job id to collect with `job_output`.'
        : '')
      + sessionHint
      + ' Pass `session_id` (reported by an earlier run) to continue that Claude Code session, or set '
      + '`session_mode: "ephemeral"` for a run that must leave no trace.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          description: 'The complete task for Claude Code, including everything it needs and cannot ask for.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Deadline for this delegation in milliseconds, overriding the configured default. '
            + '`0` means no deadline. A run that passes the deadline is cancelled and says so.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute path to run the delegation in. Defaults to this session\'s working directory. '
            + 'The path must exist and be a directory. Naming one starts a fresh Claude Code session unless an '
            + 'explicit `session_id` is supplied.',
        },
        permission_mode: {
          type: 'string',
          enum: permissionModes,
          description: 'Permission mode for this delegation. Only modes that cannot expand the configured policy '
            + 'are listed. `dontAsk` runs unattended and denies anything not already approved; `plan` is planning '
            + 'only. Omit to use the configured mode.',
        },
        session_mode: {
          type: 'string',
          enum: ['ephemeral', 'persistent'],
          description: 'Lifetime of this delegation\'s Claude Code session. `persistent` keeps a durable session '
            + 'whose id is reported with the answer; `ephemeral` is a throwaway run that writes nothing resumable. '
            + 'Omit to use the configured default.',
        },
        session_id: {
          type: 'string',
          description: 'Continue an existing Claude Code session by id. Pass the id a previous delegation reported. '
            + 'An explicit id always continues that session; a failed resume is reported, never silently replaced.',
        },
        fork_session: {
          type: 'boolean',
          description: 'With `session_id`, branch the conversation into a new session instead of continuing the '
            + 'original. The new session id is reported with the answer.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths of images to show Claude alongside the task — a screenshot it should look '
            + 'at, a design it should match. PNG, JPEG, GIF and WebP; each path must exist and be readable. '
            + 'Prefer this over writing a path into `prompt`.',
        },
        documents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths of PDF documents to hand Claude alongside the task. Each path must exist '
            + 'and be readable.',
        },
        output_schema: {
          type: 'object',
          description: 'A JSON Schema (object-rooted) the final answer must conform to. Claude Code enforces it, '
            + 'so the result is JSON rather than prose to parse and hope about — use it whenever a later step '
            + 'reads the answer mechanically.',
        },
        ...options.modelSelectionEnabled
          ? {
              model: {
                type: 'string',
                description: 'Claude model for this delegation, exactly as the user named it: an alias such as '
                  + '`opus`, `sonnet`, `haiku`, or `fable`, or a full model id. Omit to use the configured default '
                  + 'or Claude Code\'s own native model setting.',
              },
              reasoning_effort: {
                type: 'string',
                description: 'Claude thinking level for this delegation: one of `low`, `medium`, `high`, `xhigh`, '
                  + `or \`max\`.${effortHint}`,
              },
            }
          : {},
        ...options.backgroundEnabled
          ? {
              run_in_background: {
                type: 'boolean',
                description: 'Run as a background job and return its id (collect with `job_output`, stop with '
                  + '`job_kill`). Defaults to false; set it unless your next action depends on the result.',
              },
            }
          : {},
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
    output: {
      schema: options.backgroundEnabled ? { oneOf: [contentShape, backgroundShape] } : contentShape,
      render: (_args, value) => {
        if (typeof value === 'object' && value !== null
          && value.kind === 'background' && typeof value.jobId === 'string') {
          return [{
            type: 'text',
            text: `Started as background job ${value.jobId}. Collect its result with job_output.`,
          }]
        }
        if (typeof value !== 'object' || value === null || !Array.isArray(value.content)) {
          return [{ type: 'text', text: '(the delegation produced no content)' }]
        }
        const blocks = []
        for (const block of value.content) {
          if (typeof block !== 'object' || block === null) continue
          if (block.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text })
          else if (block.type === 'image' && block.attachment !== undefined) blocks.push({ type: 'image', attachment: block.attachment })
        }
        if (blocks.length === 0) return [{ type: 'text', text: '(the delegation produced no text)' }]
        return blocks
      },
    },
    async execute(args, exec) {
      const request = /** @type {Record<string, unknown>} */ (typeof args === 'object' && args !== null ? args : {})
      const prompt = typeof request.prompt === 'string' ? request.prompt : ''
      if (prompt.trim() === '') throw new Error('subagent_claude_code: `prompt` is required and must not be empty')
      const label = typeof request.description === 'string' && request.description.trim() !== ''
        ? request.description.trim()
        : 'Claude Code delegation'

      const cwd = typeof request.cwd === 'string' && request.cwd !== '' ? request.cwd : undefined
      const timeoutMs = typeof request.timeout_ms === 'number' ? request.timeout_ms : undefined
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
        throw new Error('subagent_claude_code: `timeout_ms` must be a non-negative finite number')
      }
      const sessionId = typeof request.session_id === 'string' && request.session_id !== ''
        ? request.session_id
        : undefined
      if (sessionId !== undefined && !UUID_PATTERN.test(sessionId)) {
        throw new Error('subagent_claude_code: `session_id` must be a Claude Code session UUID')
      }
      const forkSession = request.fork_session === true
      if (forkSession && sessionId === undefined) {
        throw new Error('subagent_claude_code: `fork_session` requires `session_id`')
      }
      const sessionMode = request.session_mode === 'ephemeral' || request.session_mode === 'persistent'
        ? request.session_mode
        : undefined
      const permissionMode = typeof request.permission_mode === 'string' && permissionModes.includes(request.permission_mode)
        ? request.permission_mode
        : undefined
      if (request.permission_mode !== undefined && permissionMode === undefined) {
        throw new Error(`subagent_claude_code: permission_mode must be one of ${permissionModes.join(', ')}`)
      }
      const model = typeof request.model === 'string' && request.model.trim() !== '' ? request.model.trim() : undefined
      const reasoningEffort = typeof request.reasoning_effort === 'string' && request.reasoning_effort.trim() !== ''
        ? request.reasoning_effort.trim()
        : undefined
      const images = Array.isArray(request.images)
        ? request.images.filter((value) => typeof value === 'string' && value !== '')
        : undefined
      const documents = Array.isArray(request.documents)
        ? request.documents.filter((value) => typeof value === 'string' && value !== '')
        : undefined
      const outputSchema = typeof request.output_schema === 'object' && request.output_schema !== null
        && !Array.isArray(request.output_schema)
        ? /** @type {Record<string, unknown>} */ (request.output_schema)
        : undefined
      if (request.output_schema !== undefined && outputSchema === undefined) {
        throw new Error('subagent_claude_code: `output_schema` must be a JSON Schema object')
      }
      const runInBackground = request.run_in_background === true

      const call = {
        label,
        prompt,
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(sessionMode === undefined ? {} : { sessionMode }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(forkSession ? { forkSession: true } : {}),
        ...(cwd === undefined ? {} : { cwd }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(images === undefined || images.length === 0 ? {} : { images }),
        ...(documents === undefined || documents.length === 0 ? {} : { documents }),
        ...(outputSchema === undefined ? {} : { outputSchema }),
      }

      if (runInBackground && options.backgroundEnabled) {
        return { kind: 'background', jobId: options.startBackground(call) }
      }
      return options.run(call, exec.signal)
    },
  }
}
