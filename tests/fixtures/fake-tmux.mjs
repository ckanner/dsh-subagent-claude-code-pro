#!/usr/bin/env node
/** Offline argv contract fixture with real independently owned native process groups. */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
const args = process.argv.slice(2)
const delay = ms => new Promise(r => setTimeout(r, ms))
if (args[0] === '--server') {
  const directory = args[1], nativeArgs = JSON.parse(args[2])
  const child = spawn(nativeArgs[0], nativeArgs.slice(1), { detached: true, stdio: 'ignore', env: process.env })
  const state = { serverPid: process.pid, pid: child.pid, dead: 0, code: null, socket: join(directory, 'socket') }
  const save = () => writeFileSync(join(directory, 'state'), JSON.stringify(state))
  writeFileSync(state.socket, '')
  save()
  child.on('exit', code => { state.dead = 1; state.code = code ?? 1; save() })
  child.on('error', () => { state.dead = 1; state.code = 1; save() })
  const timer = setInterval(() => {}, 1000)
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0) })
} else {
  const namespace = args[1]
  const directory = join(process.env.FAKE_TMUX_HOME ?? tmpdir(), namespace)
  let i = 2
  if (args[i] === '-f') i += 2
  const operation = args[i], remaining = args.slice(i + 1)
  const state = () => JSON.parse(readFileSync(join(directory, 'state'), 'utf8'))
  if (operation === 'new-session') {
    mkdirSync(directory, { recursive: true })
    let at = 0
    while (remaining[at]?.startsWith('-')) at += ['-s', '-x', '-y', '-c'].includes(remaining[at]) ? 2 : 1
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--server', directory, JSON.stringify(remaining.slice(at))], { detached: true, stdio: 'ignore', env: process.env })
    child.unref()
    for (let n = 0; n < 100 && !existsSync(join(directory, 'state')); n++) await delay(10)
    process.exit(existsSync(join(directory, 'state')) ? 0 : 1)
  } else if (operation === 'display-message') {
    const current = state()
    if (process.env.FAKE_TMUX_BAD_IDENTITY === '1' && remaining.at(-1).includes('socket_path')) { process.stdout.write('invalid identity\n'); process.exit(0) }
    process.stdout.write(remaining.at(-1).includes('socket_path') ? `${current.serverPid} ${current.pid} ${current.socket}\n` : `${current.dead} ${current.code ?? ''}\n`)
  } else if (operation === 'capture-pane') process.stdout.write('TEAM_OUTPUT\n')
  else if (operation === 'load-buffer') {
    let input = ''; for await (const chunk of process.stdin) input += chunk
    writeFileSync(join(directory, 'input'), input)
  } else if (operation === 'paste-buffer' || operation === 'send-keys' || operation === 'resize-window') {
    appendFileSync(join(directory, 'controls'), JSON.stringify({ operation, remaining }) + '\n')
  } else if (operation === 'kill-server') {
    if (!existsSync(join(directory, 'state'))) process.exit(1)
    const current = state()
    rmSync(current.socket, { force: true })
    try { process.kill(current.serverPid, 'SIGTERM') } catch {}
  } else process.exit(1)
}
