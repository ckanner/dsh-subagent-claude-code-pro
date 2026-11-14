// Host-owned React, slots and configuration form; no private DSH runtime imports.
window.__ModuleLoader__.load({
  id: 'dsh-subagent-claude-code-pro',
  factory: function(require, exports) {
    const React = require('react')
    const h = React.createElement
    const zh = typeof navigator !== 'undefined' && navigator.language?.startsWith('zh')
    const copy = zh ? {
      title: 'Claude 原生能力默认值', summary: 'Agent、Workflow 和 Advisor 的原生配置',
      detail: '每次委派读取最新默认值。单次 native 对象完整替换默认值；null 明确关闭全部能力。并发与深度是 CLI 控制，无法保证硬上限。独立 Review / Team 必须另行显式启动。',
      help: 'JSON 配置支持 agents.enabled / maxConcurrent / maxDepth / definitions、workflows.enabled / maxConcurrent、advisor.enabled / model。未出现的能力关闭；关闭项只能保留 enabled:false。',
      save: '保存默认值', reset: '恢复配置文件默认值', off: '编辑为全部关闭', example: '载入示例', discard: '放弃草稿',
      empty: '未设置：沿用 Claude CLI 默认值', unavailable: '当前插件配置不可写或尚未载入。',
      invalid: '配置无效：', conflict: '保存未成功，可能有更新冲突。草稿已保留；放弃草稿后重新读取，或复制草稿与最新值比较。',
      saved: '已保存；后续委派使用新配置。现有任务保持启动时的配置。',
    } : {
      title: 'Claude native defaults', summary: 'Native Agent, Workflow and Advisor configuration',
      detail: 'Every delegation reads the latest defaults. A per-call native object replaces them completely; null turns all capabilities off. Concurrency and depth are CLI controls, not guaranteed hard limits. Independent Review / Team jobs require a separate explicit action.',
      help: 'JSON supports agents.enabled / maxConcurrent / maxDepth / definitions, workflows.enabled / maxConcurrent, and advisor.enabled / model. Omitted capabilities are off; a disabled section may contain only enabled:false.',
      save: 'Save defaults', reset: 'Reset user override', off: 'Edit to all off', example: 'Load example', discard: 'Discard draft',
      empty: 'Unset: use Claude CLI defaults', unavailable: 'This plugin configuration is unavailable or read-only.',
      invalid: 'Invalid configuration: ', conflict: 'The write was not accepted, possibly because another editor changed the revision. Your draft is preserved. Discard to reload, or copy it and compare with the latest value.',
      saved: 'Saved. Future delegations use the new defaults; running jobs retain their starting snapshot.',
    }
    const example = { version: 1, agents: { enabled: true, maxConcurrent: 4, maxDepth: 2,
      definitions: { analyst: { description: 'Read-only analysis', prompt: 'Analyze the task and report evidence.', tools: ['Read', 'Grep', 'Glob'], permissionMode: 'plan' } } },
      workflows: { enabled: true, maxConcurrent: 2 }, advisor: { enabled: false } }
    const serialize = value => value === undefined ? '' : JSON.stringify(value, null, 2)
    function validate(value) {
      const object = (v, keys, label) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(label + ' must be an object')
        for (const key of Object.keys(v)) if (!keys.includes(key)) throw new Error('unknown ' + label + '.' + key)
      }
      const positive = (v, label, max = Number.MAX_SAFE_INTEGER) => {
        if (v !== undefined && (!Number.isSafeInteger(v) || v < 1 || v > max)) throw new Error(label + ' must be a positive integer')
      }
      if (value === null) return
      object(value, ['version','agents','workflows','advisor'], 'native')
      if (value.version !== 1) throw new Error('version must be 1')
      for (const [key, keys] of [['agents',['enabled','maxConcurrent','maxDepth','definitions']], ['workflows',['enabled','maxConcurrent']], ['advisor',['enabled','model']]]) {
        if (value[key] === undefined) continue
        const v = value[key]
        object(v, keys, key)
        if (typeof v.enabled !== 'boolean') throw new Error(key + '.enabled must be boolean')
        if (!v.enabled && Object.keys(v).length !== 1) throw new Error(key + ' disabled section must contain only enabled:false')
        positive(v.maxConcurrent, key + '.maxConcurrent', key === 'workflows' ? 256 : undefined)
        positive(v.maxDepth, key + '.maxDepth')
        if (key === 'advisor' && v.enabled && (typeof v.model !== 'string' || !v.model.trim())) throw new Error('advisor.model is required')
        if (v.definitions !== undefined) {
          if (!v.definitions || typeof v.definitions !== 'object' || Array.isArray(v.definitions) || Object.keys(v.definitions).length > 128) throw new Error('definitions must be an object of at most 128 agents')
          for (const [name,d] of Object.entries(v.definitions)) {
            object(d, ['description','prompt','tools','disallowedTools','model','permissionMode','maxTurns'], 'definition ' + name)
            for (const field of ['description','prompt']) if (typeof d[field] !== 'string' || !d[field].trim()) throw new Error(name + '.' + field + ' is required')
            for (const field of ['tools','disallowedTools']) if (d[field] !== undefined && (!Array.isArray(d[field]) || d[field].some(t => typeof t !== 'string' || !t.trim()))) throw new Error(name + '.' + field + ' must contain tool names')
            if (d.model !== undefined && (typeof d.model !== 'string' || !d.model.trim())) throw new Error(name + '.model must be text')
            if (d.permissionMode !== undefined && !['plan','dontAsk','acceptEdits','auto','bypassPermissions'].includes(d.permissionMode)) throw new Error(name + '.permissionMode is invalid')
            positive(d.maxTurns, name + '.maxTurns')
          }
        }
      }
    }
    function NativeSettings({ view, form }) {
      const state = form?.state
      const [draft, setDraft] = React.useState(() => serialize(state?.value?.native))
      const [revision, setRevision] = React.useState(state?.revision)
      const [dirty, setDirty] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      React.useEffect(() => {
        if (!dirty && !busy) { setDraft(serialize(state?.value?.native)); setRevision(state?.revision) }
      }, [state?.revision, state?.value?.native, dirty, busy])
      const enabled = state?.status === 'ready' && state.writable === true && Number.isInteger(state.revision) && !busy
      const edit = value => { if (!dirty) setRevision(state?.revision); setDraft(value); setDirty(true); setMessage('') }
      const submit = async reset => {
        if (!enabled) return
        let ops
        try {
          if (reset) ops = [{ op: 'unset', path: ['native'] }]
          else { const value = JSON.parse(draft); validate(value); ops = [{ op: 'set', path: ['native'], value }] }
        } catch (error) { setMessage(copy.invalid + error.message); return }
        setBusy(true)
        try {
          const accepted = await form.mutate(ops, dirty ? revision : state.revision)
          if (accepted) { setDirty(false); setMessage(copy.saved) }
          else setMessage(copy.conflict)
        } catch (error) { setMessage(copy.conflict + ' ' + error.message) }
        finally { setBusy(false) }
      }
      if (view === 'summary') return h('span', null, copy.summary)
      return h('section', { style: { display:'grid', gap:12, maxWidth:840 } },
        h('h3', null, copy.title), h('p', null, copy.detail), h('p', null, copy.help),
        !enabled && !busy ? h('p', { role:'status' }, copy.unavailable) : null,
        h('label', null, 'native', h('textarea', { 'aria-label':'native JSON', value:draft, rows:18, spellCheck:false,
          placeholder:copy.empty, disabled:!enabled, onChange:event => edit(event.target.value),
          style:{display:'block',width:'100%',boxSizing:'border-box',fontFamily:'monospace',padding:10} })),
        h('div', {style:{display:'flex',gap:8,flexWrap:'wrap'}},
          h('button',{type:'button',disabled:!enabled || !dirty,onClick:()=>submit(false)},copy.save),
          h('button',{type:'button',disabled:!enabled,onClick:()=>submit(true)},copy.reset),
          h('button',{type:'button',disabled:!enabled,onClick:()=>edit('null')},copy.off),
          h('button',{type:'button',disabled:!enabled,onClick:()=>edit(serialize(example))},copy.example),
          h('button',{type:'button',disabled:busy || !dirty,onClick:()=>{setDirty(false);setMessage('')}},copy.discard)),
        h('p',{role:'status','aria-live':'polite'},message))
    }
    exports.inject = ['slots']
    exports.apply = function(ctx) {
      ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name:'plugins.row.config',key:'dsh-subagent-claude-code-pro#claude-code-pro',
      }, NativeSettings)), 'claude-code-pro native settings')
    }
  },
})
