import test from 'node:test'
import assert from 'node:assert/strict'

import {
  allowedPermissionModes,
  buildArguments,
  childEnvironment,
  resolvePermissionOverride,
  sessionArguments,
} from '../lib/cli.js'
import { chooseSession, sessionMarker } from '../lib/sessions.js'

const UUID = '11111111-1111-4111-8111-111111111111'

test('new durable session argv carries the session id, name and stream-json', () => {
  const args = buildArguments({
    session: { kind: 'new', sessionId: UUID, name: 'DSH · probe' },
    permissionMode: 'dontAsk',
    model: 'haiku',
    reasoningEffort: 'low',
    settingSources: ['user', 'project', 'local'],
  })
  assert.ok(args.includes('--input-format'))
  assert.ok(args.includes('stream-json'))
  assert.ok(args.includes('--output-format'))
  assert.ok(args.includes('--verbose'))
  assert.ok(args.includes('--permission-prompts'))
  assert.ok(args.includes('none'))
  assert.deepEqual(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 2), ['--session-id', UUID])
  assert.deepEqual(args.slice(args.indexOf('-n'), args.indexOf('-n') + 2), ['-n', 'DSH · probe'])
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'haiku'])
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'low'])
  assert.ok(args.includes('--setting-sources'))
  assert.ok(!args.includes('--resume'))
  assert.ok(!args.includes('--no-session-persistence'))
})

test('resume argv continues a session, and fork adds only --fork-session', () => {
  const args = buildArguments({ session: { kind: 'resume', resumeId: UUID }, permissionMode: 'dontAsk' })
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', UUID])
  assert.ok(!args.includes('--fork-session'))
  const forked = sessionArguments({ kind: 'resume', resumeId: UUID, forkSession: true })
  assert.deepEqual(forked, ['--resume', UUID, '--fork-session'])
})

test('ephemeral argv writes nothing resumable and has no session id', () => {
  const args = buildArguments({ session: { kind: 'ephemeral' }, permissionMode: 'dontAsk' })
  assert.ok(args.includes('--no-session-persistence'))
  assert.ok(!args.includes('--session-id'))
  assert.ok(!args.includes('--resume'))
})

test('bypassPermissions adds the explicit dangerous flag', () => {
  const args = buildArguments({ session: { kind: 'ephemeral' }, permissionMode: 'bypassPermissions' })
  assert.ok(args.includes('--dangerously-skip-permissions'))
})

test('percent permission modes narrow, never widen', () => {
  assert.deepEqual(allowedPermissionModes('dontAsk'), ['plan', 'dontAsk'])
  assert.deepEqual(allowedPermissionModes('acceptEdits'), ['plan', 'dontAsk', 'acceptEdits'])
  assert.deepEqual(allowedPermissionModes('bypassPermissions').length, 5)
  assert.equal(resolvePermissionOverride('dontAsk', undefined), 'dontAsk')
  assert.equal(resolvePermissionOverride('dontAsk', 'plan'), 'plan')
  assert.throws(() => resolvePermissionOverride('dontAsk', 'acceptEdits'), /exceeds the configured/)
  assert.throws(() => resolvePermissionOverride('plan', 'dontAsk'), /exceeds the configured/)
})

test('child environment drops DSH facts and credential-shaped names, then applies config', () => {
  const env = childEnvironment(
    { EXTRA: '1', ANTHROPIC_API_KEY: 'from-config' },
    {
      PATH: '/bin',
      HOME: '/home/me',
      DSH_HOME: '/dsh',
      DEEPSEEK_API_KEY: 'secret',
      ANTHROPIC_BASE_URL: 'https://relay.example',
    },
  )
  assert.equal(env.PATH, '/bin')
  assert.equal(env.HOME, '/home/me')
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://relay.example')
  assert.equal(env.EXTRA, '1')
  assert.equal(env.ANTHROPIC_API_KEY, 'from-config')
  assert.equal(env.DSH_HOME, undefined)
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
})

test('session choice: explicit wins, remembered is reused only in its cwd, busy starts fresh', () => {
  const remembered = { sessionId: UUID, cwd: '/work' }
  assert.equal(chooseSession({ explicitSessionId: 'x', requestedMode: undefined, configuredMode: 'ephemeral', remembered, cwd: '/work', busy: false }).kind, 'resume')
  assert.equal(chooseSession({ requestedMode: undefined, configuredMode: 'session', remembered, cwd: '/work', busy: false }).kind, 'resume')
  assert.equal(chooseSession({ requestedMode: undefined, configuredMode: 'session', remembered, cwd: '/other', busy: false }).kind, 'new')
  assert.equal(chooseSession({ requestedMode: undefined, configuredMode: 'session', remembered, cwd: '/work', busy: true }).kind, 'new')
  assert.equal(chooseSession({ requestedMode: 'ephemeral', configuredMode: 'session', remembered, cwd: '/work', busy: false }).kind, 'ephemeral')
})

test('session marker names the id and how to continue', () => {
  assert.match(sessionMarker(UUID), new RegExp(UUID))
  assert.match(sessionMarker(UUID), /session_id/)
})
