/** Private supervised machine host. Native cleanup and journal completion outlive the caller. */
import { runNativeJobLocal, nativeJobContext } from './native-jobs.js'
import { runMachineLocal } from "./machine-local.js"
import { MachineJournal } from "./machine-recovery.js"
const abort = new AbortController()
let started = false, finished = false, runId
let acknowledgement
const cancel = () => {
  abort.abort()
  acknowledgement?.reject(new Error('machine caller disconnected or cancelled'))
  acknowledgement = undefined
}
for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP'])
  process.on(event, cancel)
process.on('disconnect', cancel)
function send(message) {
  return new Promise(resolve => {
    if (!process.connected || process.send === undefined) {
      resolve(false)
      return
    }
    try {
      process.send({ protocol: 1, runId, ...message }, error => {
        if (error !== null)
          cancel()
        resolve(error === null)
      })
    }
    catch {
      cancel()
      resolve(false)
    }
  })
}
const admissionTimer = setTimeout(() => {
  if (!started) {
    cancel()
    if (process.connected)
      process.disconnect()
    process.exitCode = 1
  }
}, 10_000)
process.on('disconnect', () => { if (!started) {
  clearTimeout(admissionTimer)
  process.exitCode = 0
} })
process.on('message', (raw) => {
  if (finished)
    return
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    cancel()
    return
  }
  const message = raw
  if (message.protocol !== 1 || (started && message.runId !== runId)) {
    cancel()
    return
  }
  if (message.type === 'cancel') {
    cancel()
    return
  }
  if (message.type === 'ack') {
    if (acknowledgement === undefined || message.sequence !== acknowledgement.sequence || typeof message.ok !== 'boolean') {
      cancel()
      return
    }
    const pending = acknowledgement
    acknowledgement = undefined
    if (message.ok)
      pending.resolve()
    else {
      pending.reject(new Error('machine lifecycle checkpoint was rejected'))
      abort.abort()
    }
    return
  }
  if (started || message.type !== 'start' || typeof message.runId !== 'string') {
    cancel()
    return
  }
  started = true
  runId = message.runId
  clearTimeout(admissionTimer)
  void execute(message.request, message.options)
})
async function execute(request, options) {
  try {
    if (!process.connected)
      cancel()
    const journal = options.recoveryDirectory === undefined ? undefined : new MachineJournal(options.recoveryDirectory, request.requestId, runId, nativeJobContext(request, runId))
    const onLifecycle = async (event) => {
      journal?.lifecycle(event)
      if (!process.connected || abort.signal.aborted)
        throw new Error('machine caller is no longer awaiting this checkpoint')
      const ack = new Promise((resolve, reject) => { acknowledgement = { sequence: event.sequence, resolve, reject }; })
      // Attach the handler before a send can synchronously trigger disconnect.
      const waiting = ack.catch((error) => { throw error; })
      waiting.catch(() => { })
      const timeout = setTimeout(cancel, 10_000)
      try {
        if (!await send({ type: 'lifecycle', event }))
          cancel()
        await waiting
      }
      finally {
        clearTimeout(timeout)
      }
    }
    const receipt = await (request.operation === 'native-review' || request.operation === 'interactive-team' ? runNativeJobLocal : runMachineLocal)(request, {
      signal: abort.signal, env: options.env, credentialEnv: options.credentialEnv, recoveryDirectory: options.recoveryDirectory, onLifecycle,
      onNativeEvent: event => { void send({ type: 'native-event', event }) },
      onProgress: text => { void send({ type: 'progress', text: text.slice(0, 16_384) }); },
    }, runId, value => { journal?.receipt(value); })
    await send({ type: 'result', receipt })
  }
  catch {
    await send({ type: 'failure' })
  }
  finally {
    finished = true
    acknowledgement?.reject(new Error('machine supervisor completed'))
    acknowledgement = undefined
    if (process.connected)
      process.disconnect()
    process.exitCode = 0
  }
}
await send({ type: 'ready' })
