/** Private process supervisor. It must outlive a disconnected caller until cleanup settles. */
import { runLocalClaude } from './run-local.js'

const PROTOCOL = 1
const controller = new AbortController()
let accepted = false, invocationId, finished = false, fatalError
const abort = () => controller.abort()
const reportFatal = error => { fatalError ??= error; controller.abort() }
for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(event, abort)
process.on('disconnect', abort)
process.on('uncaughtException', reportFatal)
process.on('unhandledRejection', reportFatal)

// IPC is the parent's lifeline. Sending a display event must never strand the
// native process or cause an early supervisor exit on a disconnected channel.
function send(message) {
  return new Promise(resolve => {
    if (!process.connected || typeof process.send !== 'function') { resolve(false); return }
    try {
      process.send({ protocol: PROTOCOL, ...message }, error => {
        if (error) controller.abort()
        resolve(!error)
      })
    } catch { controller.abort(); resolve(false) }
  })
}

const admissionTimer = setTimeout(() => {
  if (!accepted) {
    controller.abort()
    process.disconnect?.()
    process.exitCode = 1
  }
}, 10000)

process.on('message', async message => {
  if (finished) return
  if (message?.protocol !== PROTOCOL) { controller.abort(); return }
  if (message.type === 'cancel') { controller.abort(); return }
  if (accepted || message.type !== 'start' || typeof message.invocationId !== 'string') { controller.abort(); return }
  accepted = true
  invocationId = message.invocationId
  clearTimeout(admissionTimer)
  let response
  try {
    // A channel may have closed between delivery and this callback. The local
    // runner checks this signal before any CLI process can start.
    if (!process.connected) controller.abort()
    const result = await runLocalClaude({ ...message.options, signal: controller.signal,
      onSpawn: pid => { void send({ type: 'spawned', invocationId, pid }) },
      onEvent: event => { void send({ type: 'progress', invocationId, text: event.text }) } })
    if (fatalError) {
      response = { type: 'failure', invocationId,
        error: { facts: { stage: 'process', category: 'process', detail: 'the supervisor encountered an unexpected internal failure' }, run: result } }
    } else response = { type: 'result', invocationId, result }
  } catch (error) {
    response = { type: 'failure', invocationId, error: { facts: error?.facts, run: error?.run,
      message: error?.facts ? undefined : 'the supervisor failed without complete lifecycle evidence' } }
  }
  // This point is reached only after native cleanup. A dead parent cannot
  // receive a receipt, but must not prevent the supervisor from exiting.
  finished = true
  await send(response)
  if (process.connected) process.disconnect()
  process.exitCode = 0
})

process.once('disconnect', () => {
  if (!accepted) {
    clearTimeout(admissionTimer)
    finished = true
    process.exitCode = 0
  }
})

await send({ type: 'ready' })
