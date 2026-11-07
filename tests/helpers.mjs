/**
 * Shared test helpers: a fake `claude` command and a minimal Cordis context.
 */

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const fixturePath = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))

/** Create an executable shell wrapper that runs the fake CLI with node. */
export function makeFakeCommand() {
  const dir = mkdtempSync(join(tmpdir(), 'ccpro-bin-'))
  const script = join(dir, 'claude')
  writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`)
  chmodSync(script, 0o755)
  return script
}

/** Create a fresh temporary directory. */
export function makeTempDir(prefix = 'ccpro-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Minimal Cordis context whose events the test can fire directly.
 *
 * @returns {{ ctx: any, emit: (event: string, ...args: any[]) => void, handlers: Map<string, Function> }}
 */
export function makeContext() {
  /** @type {Map<string, Function>} */
  const handlers = new Map()
  const ctx = {
    /** @param {string} name */
    get: () => undefined,
    /**
     * @param {string} event
     * @param {Function} handler
     */
    on: (event, handler) => {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    logger: { info: () => {}, warn: () => {} },
  }
  return {
    ctx,
    handlers,
    emit: (event, ...args) => handlers.get(event)?.(...args),
  }
}

/**
 * Minimal Agent-like object that records tool registrations.
 *
 * @param {string} cwd
 * @param {{ id?: string, preset?: string }} [options]
 */
export function makeAgent(cwd, options = {}) {
  /** @type {any[]} */
  const tools = []
  const agent = {
    id: options.id ?? 'agent-1',
    session: { header: { cwd, agentPreset: options.preset ?? 'daily' } },
    ctx: {
      tools: {
        /** @param {any} definition */
        register: (definition) => {
          tools.push(definition)
          return () => {}
        },
      },
      systemPrompt: { section: () => () => {} },
    },
  }
  return { agent, tools }
}
