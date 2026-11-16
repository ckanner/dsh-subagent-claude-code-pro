/** Remember ambient task identities because later progress omits the ambient flag. */
const identity = value => typeof value === 'string' && value.trim() !== '' && !value.includes('\0') && Buffer.byteLength(value) <= 65536
const keyFor = task => identity(task?.task_id) && (task.run_id === undefined || identity(task.run_id))
  ? JSON.stringify([task.task_id, task.run_id ?? null]) : undefined

export class AmbientTasks {
  #runs = new Map(); #current = new Map(); #bytes = 0; #overflow = false
  get overflow() { return this.#overflow }
  #remember(task, current) {
    const key = keyFor(task)
    if (key === undefined || this.#overflow) return
    if (!this.#runs.has(key)) {
      const bytes = Buffer.byteLength(key)
      if (this.#runs.size >= 4096 || this.#bytes + bytes > 1024 * 1024) { this.#overflow = true; return }
      this.#bytes += bytes
    }
    this.#runs.set(key, task.ambient === true)
    // The provider orders one task's run IDs by plain-string comparison.
    // Snapshots may arrive out of order, including an old run never seen here.
    // A legacy unversioned entry cannot replace an established versioned run.
    const prior = this.#current.get(task.task_id)
    if (!prior || (current && (prior.runId === undefined || (task.run_id !== undefined && task.run_id > prior.runId)))) {
      this.#current.set(task.task_id, { key, runId: task.run_id })
    }
  }
  observe(event) {
    if (event?.type !== 'system') return
    if (event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
      for (const task of event.tasks) this.#remember(task, true)
    } else if (event.subtype === 'task_started') this.#remember(event, true)
    else if (event.subtype === 'task_notification' && typeof event.ambient === 'boolean') this.#remember(event, false)
  }
  excludes(task, { exactRun = false } = {}) {
    if (task?.ambient === true) return true
    const key = keyFor(task)
    if (key === undefined) return false
    // A run ID identifies that exact run; an old ambient run must not hide a
    // resumed ordinary run. Unversioned notifications use the current task even
    // if its history also includes a legacy run with no run_id.
    return this.#runs.get(task.run_id === undefined && !exactRun ? this.#current.get(task.task_id)?.key : key) === true
  }
  clear() { this.#runs.clear(); this.#current.clear(); this.#bytes = 0 }
}
