/**
 * Job settlement for one background delegation.
 *
 * The DSH jobs contract is specific: a producer's `done` must resolve to a
 * `JobOutcome` — `{ status, detail?, result? }` — and must never reject.
 * Returning the delegation's text directly leaves a bare string where the
 * registry expects that record, which then fails validation on every read of
 * the job, so the model can never collect its own result.
 *
 * @module dsh-subagent-claude-code-pro/background
 */

import { errorMessage } from './util.js'

/**
 * Wrap one delegation's text promise as a job outcome.
 *
 * @param {Promise<string>} textPromise
 * @returns {Promise<{ status: 'completed' | 'failed', result?: string, detail?: string }>}
 */
export async function settleJob(textPromise) {
  try {
    const text = await textPromise
    return { status: 'completed', result: text }
  } catch (error) {
    return { status: 'failed', detail: errorMessage(error) }
  }
}
