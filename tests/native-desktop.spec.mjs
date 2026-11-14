import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { apply, Config, resolveConfig } from '../lib/index.js'
import { resolveDesktopNative, desktopSessionIdentity } from '../lib/native-desktop.js'
import { makeAgent, makeContext, makeFakeCommand, makeTempDir } from './helpers.mjs'

process.env.DSH_HOME = makeTempDir('ccpro-native-desktop-home-')
const on = { version:1, agents:{enabled:true,maxConcurrent:3,maxDepth:2,definitions:{
  implementer:{description:'Complete implementation',prompt:'Implement fully.',model:'sonnet',permissionMode:'dontAsk',maxTurns:8},
}}, workflows:{enabled:true,maxConcurrent:2}, advisor:{enabled:true,model:'opus'} }
const call = (tool, args = {}, signal = new AbortController().signal) => tool.execute({description:'native fixture',prompt:'complete task',...args},{signal})
const logs = path => { try { return readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) } catch { return [] } }
const flag = (run,name) => { const i=run.args.indexOf(name); return i<0?undefined:run.args[i+1] }
function setup(t, options={}) {
  const cwd=makeTempDir('ccpro-native-plugin-'), log=join(cwd,'calls')
  t.after(()=>rmSync(cwd,{recursive:true,force:true}))
  let current=options.native
  const source={get:()=>current}
  const raw={command:makeFakeCommand(),presets:['daily'],permissionMode:'dontAsk',runTimeoutMs:5000,disposeGraceMs:50,
    ...options, native:source, env:{FAKE_CLAUDE_LOG:log,FAKE_CLAUDE_MODE:options.mode??'normal',...(options.env??{})}}
  delete raw.mode;delete raw.services
  const {ctx,emit}=makeContext(options.services??{})
  apply(ctx,raw)
  const {agent,tools}=makeAgent(cwd)
  emit('agent/created',{agent})
  return {cwd,log,tool:tools[0],nativeTool:tools[1],agent,setNative:value=>{current=value}}
}

test('real runtime Config exposes one live native field and strict serialized validation',()=>{
  assert.equal(Config.dict.native.meta.volatile,true)
  assert.deepEqual(Object.entries(Config.dict).filter(([,s])=>s.meta.volatile).map(([k])=>k),['native'])
  assert.equal(resolveConfig(Config({})).native,undefined)
  assert.deepEqual(resolveConfig(Config({native:null})).native,{version:1})
  assert.deepEqual(resolveConfig(Config({native:on})).native,on)
  const serial=JSON.parse(JSON.stringify(Config))
  const rehydrated=new Schema(serial)
  assert.deepEqual(resolveConfig(rehydrated({native:on})).native,on)
  for(const native of [
    {version:1,unknown:true}, {version:1,agents:{enabled:false,maxConcurrent:2}},
    {version:1,agents:{enabled:true,definitions:{'bad name':{description:'x',prompt:'x'}}}},
    {version:1,agents:{enabled:true,definitions:{x:{description:'x',prompt:'x',unknown:true}}}},
    {version:1,agents:{enabled:true,definitions:{x:{description:'x',prompt:'a\0b'}}}},
    {version:1,agents:{enabled:true,definitions:{x:{description:'x',prompt:'x'.repeat(65537)}}}},
    {version:1,agents:{enabled:true,definitions:{x:{description:'x',prompt:'x',tools:Array(257).fill('Read')}}}},
    {version:1,agents:{enabled:true,maxConcurrent:Number.MAX_SAFE_INTEGER+1}},
    {version:1,advisor:{enabled:true}}, {version:1,workflows:{enabled:true,maxConcurrent:257}},
  ]) {
    assert.throws(()=>Config({native}))
    assert.throws(()=>rehydrated({native}))
  }
})

test('live Config reference is read for each operation without remounting',()=>{
  const parsed=Config({native:on})
  assert.equal(typeof parsed.native.get,'function')
  const config=resolveConfig(parsed)
  const next=Config({native:null})
  parsed.native[Symbol.for('cosmokit.volatile.write')](next.native.get())
  assert.deepEqual(config.native,{version:1})
  assert.deepEqual(on.advisor,{enabled:true,model:'opus'})
})

test('PTC inherits actual native CLI args, env, child events and non-additive receipts',async t=>{
  const f=setup(t,{native:on,mode:'native-child'})
  const value=await call(f.tool)
  assert.equal(value.native.effective.matched,true)
  assert.equal(value.native.effective.verification,'tools-only')
  assert.equal(value.native.children[0].id,'child-1')
  assert.equal(value.native.children[0].model,'actual-child')
  assert.equal(value.native.usage.childSnapshotsAreAdditive,false)
  assert.equal(value.native.usage.aggregateFamilyStatus,'unknown')
  assert.equal(value.native.resourceBounds.hard,false)
  assert.equal(value.native.completion.confirmed,true)
  assert.equal(value.native.cleanup.confirmed,true)
  const run=logs(f.log)[0]
  assert.equal(flag(run,'--advisor'),'opus')
  assert.deepEqual(JSON.parse(flag(run,'--agents')),on.agents.definitions)
  assert.equal(run.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS,'3')
  assert.equal(run.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH,'2')
  assert.equal(run.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS,'2')
  assert.equal(run.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,'0')
  assert.ok(flag(run,'--disallowedTools').includes('TeamCreate'))
})

test('object replaces native defaults; null disables and removes residual bounds',async t=>{
  const f=setup(t,{native:on,env:{CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS:'99',CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS:'98'}})
  const object=await call(f.tool,{native:{version:1,workflows:{enabled:true,maxConcurrent:4}}})
  const off=await call(f.tool,{native:null})
  assert.deepEqual(object.native.requested,{version:1,workflows:{enabled:true,maxConcurrent:4}})
  assert.deepEqual(off.native.requested,{version:1})
  const [first,second]=logs(f.log)
  assert.equal(flag(first,'--agents'),undefined)
  assert.equal(flag(first,'--advisor'),undefined)
  assert.equal(first.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS,undefined)
  assert.equal(first.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS,'4')
  assert.equal(second.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS,undefined)
  assert.equal(second.env.CLAUDE_CODE_DISABLE_WORKFLOWS,'1')
  assert.equal(second.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL,'1')
  assert.equal(second.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,'0')
  assert.equal(flag(second,'--disallowedTools'),'Agent,Task,Workflow,TeamCreate,TeamDelete')
})

test('native omission preserves CLI defaults and rejects unknown/disabled call fields',async t=>{
  const f=setup(t)
  const detached=f.tool.execute
  const value=await detached({description:'native',prompt:'default'},{signal:new AbortController().signal})
  assert.equal(value.native,undefined)
  assert.equal(flag(logs(f.log)[0],'--settings'),undefined)
  await assert.rejects(call(f.tool,{native:{version:1,unknown:true}}),/fields/)
  await assert.rejects(call(f.tool,{native:{version:1,agents:{enabled:false,maxConcurrent:2}}}),/disabled/)
  await assert.rejects(call(f.tool,{unsupported:true}),/unknown/)
  assert.equal(logs(f.log).length,1)
})

test('root permissions and modelSelection constrain explicit native replacements without deep merging',async t=>{
  const f=setup(t,{native:on,modelSelection:false})
  await call(f.tool)
  await call(f.tool,{native:null})
  await assert.rejects(call(f.tool,{native:{...on,agents:{enabled:true}}}),/retain configured models/)
  await assert.rejects(call(f.tool,{native:{...on,advisor:{enabled:true,model:'haiku'}}}),/modelSelection/)
  await assert.rejects(call(f.tool,{native:{...on,agents:{enabled:true,definitions:{implementer:{...on.agents.definitions.implementer,model:'haiku'}}}}}),/modelSelection/)
  await assert.rejects(call(f.tool,{model:'haiku'}),/disabled/)
  await assert.rejects(call(f.tool,{native:{version:1,agents:{enabled:true,definitions:{escape:{description:'x',prompt:'x',permissionMode:'bypassPermissions'}}}}}),/exceeds/)
  assert.deepEqual(resolveDesktopNative(on,{version:1,agents:{enabled:false}},'dontAsk',false),{version:1,agents:{enabled:false}})
})

test('auto sessions separate snapshots; known mismatched resume fails and unknown external resume carries controls',async t=>{
  const f=setup(t,{native:{version:1}})
  await call(f.tool)
  const id=flag(logs(f.log)[0],'--session-id')
  await call(f.tool)
  assert.equal(flag(logs(f.log)[1],'--resume'),id)
  f.setNative(on)
  await call(f.tool)
  const fresh=logs(f.log)[2]
  assert.equal(flag(fresh,'--resume'),undefined)
  assert.notEqual(flag(fresh,'--session-id'),id)
  await assert.rejects(call(f.tool,{session_id:id}),/different native/)
  const unknown='22222222-2222-4222-8222-222222222222'
  await call(f.tool,{session_id:unknown})
  assert.equal(flag(logs(f.log)[3],'--resume'),unknown)
  assert.equal(flag(logs(f.log)[3],'--advisor'),'opus')
  assert.equal(desktopSessionIdentity({native:{version:1,agents:{enabled:true,maxDepth:2}}}),
    desktopSessionIdentity({native:{agents:{maxDepth:2,enabled:true},version:1}}))
})

test('native mismatches and unresolved remote work fail instead of reporting root-only success',async t=>{
  for(const mode of ['native-mismatch','native-remote']) {
    const f=setup(t,{native:mode==='native-mismatch'?{version:1}:on,mode})
    await assert.rejects(call(f.tool),error=>{
      if(mode==='native-mismatch') {
        // The native guard may terminate before the root terminal frame arrives.
        // Assert the cause/evidence, independent of that process scheduling race.
        assert.equal(error.run?.native?.effective?.matched,false)
        assert.match(error.run?.native?.diagnostic,/system\/init did not confirm the requested native tool surface/)
        assert.equal(error.run?.cleanupConfirmed,true)
      } else assert.match(error.message,/cleanup-unconfirmed/)
      assert.match(error.message,/native=/)
      assert.equal(error.run?.native?.cleanup?.confirmed,mode==='native-remote'?false:true)
      return true
    })
  }
})

test('caller cancellation retains native cleanup evidence after stopping an observed child',async t=>{
  const f=setup(t,{native:on,mode:'native-child-hang'}),controller=new AbortController()
  const pending=call(f.tool,{},controller.signal)
  // Observe the CLI fixture startup before cancelling; bounded by the run's own deadline.
  const deadline=Date.now()+4000
  while(logs(f.log).length===0 && Date.now()<deadline) await new Promise(r=>setTimeout(r,10))
  assert.equal(logs(f.log).length,1)
  controller.abort()
  await assert.rejects(pending,error=>{assert.match(error.message,/cancelled/);assert.ok(error.run?.native);assert.equal(error.run.cleanupConfirmed,true);return true})
})

test('background native structured output remains valid JSON and publishes facts separately',async t=>{
  let running,record
  const progress=[]
  const jobs={start:spec=>{record=spec;running=spec.run({id:'structured-native',append:text=>progress.push(text),updateProgress:()=>{}});return 'structured-native'}}
  const f=setup(t,{native:{version:1},services:{jobs}})
  const started=await call(f.tool,{run_in_background:true,output_schema:{type:'object',required:['answer'],properties:{answer:{type:'integer'}},additionalProperties:false}})
  assert.equal(started.jobId,'structured-native')
  const outcome=await running.done
  assert.equal(record.owner,String(f.agent.id))
  assert.equal(outcome.status,'completed')
  assert.deepEqual(JSON.parse(outcome.result),{answer:42})
  assert.ok(progress.some(text=>text.includes('[claude native result]')))
})
