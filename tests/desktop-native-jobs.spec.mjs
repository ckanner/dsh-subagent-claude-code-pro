import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, existsSync, writeFileSync, mkdirSync, chmodSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, resolveConfig } from '../lib/index.js'
import { createNativeJobTool } from '../lib/desktop-native-jobs.js'
import { MachineJournal } from '../lib/machine-recovery.js'
import * as machine from '../lib/native-jobs.js'
import { makeAgent, makeContext, makeFakeCommand, makeTempDir } from './helpers.mjs'

process.env.DSH_HOME=makeTempDir('ccpro-jobs-home-')
const hash=value=>createHash('sha256').update(value).digest('hex')
const ownerRoot=owner=>join(process.env.DSH_HOME,'data','claude-code-pro','native-jobs',hash(owner))
const recordPath=(owner,id)=>join(ownerRoot(owner),hash(id)+'.json')
const logLines=path=>{try{return readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)}catch{return []}}
function registry() {
  const records=[]
  return {records,start(spec){
    const id='job-'+(records.length+1)+'-'+Date.now()+'-'+Math.random().toString(36).slice(2)
    const progress=[],record={id,spec,progress}
    records.push(record)
    record.running=spec.run({id,append:value=>progress.push(value),updateProgress:value=>{record.progressText=value}})
    return id
  }}
}
function setup(t,{mode='normal',env={},owner='native-owner',jobs=registry(),tmuxCommand}={}) {
  const cwd=makeTempDir('ccpro-desktop-job-'),log=join(cwd,'calls')
  t.after(async()=>{for(const record of jobs?.records??[]) {record.running.cancel();await record.running.done}rmSync(cwd,{recursive:true,force:true})})
  const {ctx,emit}=makeContext({jobs})
  apply(ctx,{command:makeFakeCommand(),tmuxCommand,presets:['daily'],runTimeoutMs:5000,disposeGraceMs:50,
    env:{FAKE_CLAUDE_MODE:mode,FAKE_CLAUDE_LOG:log,FAKE_TMUX_HOME:cwd,...env}})
  const {agent,tools}=makeAgent(cwd,{id:owner})
  emit('agent/created',{agent})
  return {cwd,log,tool:tools[1],jobs,owner}
}
test('explicit review PTC reaches native command, durable recovery, exact owner and credentials',async t=>{
  const f=setup(t,{env:{ANTHROPIC_API_KEY:'fixture-explicit-key'}})
  assert.equal(logLines(f.log).length,0)
  await assert.rejects(f.tool.execute({action:'review'}),/consent/)
  const started=await f.tool.execute({action:'review',consent:true,target:'main',timeout_minutes:2},{callId:'call-1',rootCallId:'root-1'})
  const record=f.jobs.records[0]
  assert.equal(started.jobId,record.id)
  assert.deepEqual(record.spec.toolCall,{callId:'call-1',rootCallId:'root-1'})
  assert.equal(record.spec.owner,f.owner)
  const outcome=await record.running.done
  assert.equal(outcome.status,'completed',JSON.stringify(outcome))
  const receipt=JSON.parse(outcome.result)
  assert.equal(receipt.ok,true)
  assert.equal(receipt.remote.state,'completed')
  const command=logLines(f.log)[0]
  assert.deepEqual(command.args,['ultrareview','main','--json','--no-post','--timeout','2'])
  assert.equal(command.env.ANTHROPIC_API_KEY,'fixture-explicit-key')
  const mapping=JSON.parse(readFileSync(recordPath(f.owner,started.jobId),'utf8'))
  assert.equal(mapping.runId,receipt.runId)
  assert.equal(mapping.owner,f.owner)
  assert.doesNotMatch(JSON.stringify(mapping),/fixture-explicit-key|ANTHROPIC/)
  const recovered=await f.tool.execute({action:'recover',job_id:started.jobId})
  assert.equal(recovered.status,'terminal')
  assert.deepEqual(recovered.receipt,receipt)
  assert.equal(logLines(f.log).length,1,'recovery must not replay review')
  const other=setup(t,{owner:'different-agent'})
  await assert.rejects(other.tool.execute({action:'recover',job_id:started.jobId}))
  await assert.rejects(f.tool.execute({action:'recover',job_id:started.jobId,recoveryDirectory:'/tmp'}),/unsupported/)
})
test('native review failures and cancellation settle failed/killed with unresolved cloud responsibility',async t=>{
  const bad=setup(t,{mode:'review-bad'})
  await bad.tool.execute({action:'review',consent:true})
  const failed=await bad.jobs.records[0].running.done
  assert.equal(failed.status,'failed')
  assert.equal(JSON.parse(failed.result).remote.state,'unknown')
  const f=setup(t,{mode:'review-hang'})
  const started=await f.tool.execute({action:'review',consent:true})
  const record=f.jobs.records[0],deadline=Date.now()+4000
  while(!logLines(f.log).length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10))
  assert.equal(logLines(f.log).length,1)
  record.running.cancel('stop')
  const killed=await record.running.done,receipt=JSON.parse(killed.result)
  assert.equal(killed.status,'killed')
  assert.equal(receipt.cleanup.confirmed,true)
  assert.equal(receipt.native.cleanup.confirmed,false)
  assert.equal(receipt.remote.replaySafe,false)
  const recovered=await f.tool.execute({action:'recover',job_id:started.jobId})
  assert.deepEqual(recovered.receipt,receipt)
})
test('all independent starts require jobs and reject paths, irrelevant arguments and implicit trust',async t=>{
  const f=setup(t,{jobs:undefined})
  // The explicit no-jobs context does not register a runner.
  const tool=createNativeJobTool({agent:{id:f.owner},config:resolveConfig({command:makeFakeCommand()}),cwd:f.cwd})
  await assert.rejects(tool.execute({action:'review',consent:true}),/jobs service/)
  await assert.rejects(tool.execute({action:'review',consent:true,run_in_background:false}),/unsupported/)
  await assert.rejects(tool.execute({action:'review',consent:true,trust_workspace:'true'}),/boolean/)
  await assert.rejects(tool.execute({action:'team',prompt:'task',permission_mode:'bypassPermissions'}),/permission/)
})
test('team start snapshots defaults; persisted lifecycle gates owner-only pending/ready controls',async t=>{
  const cwd=makeTempDir('ccpro-team-wrapper-'),owner='team-owner'
  t.after(()=>rmSync(cwd,{recursive:true,force:true}))
  const native={version:1,agents:{enabled:true,maxConcurrent:2,definitions:{worker:{description:'Implement',prompt:'Complete task',model:'sonnet'}}}}
  const configured=resolveConfig({command:makeFakeCommand(),native,modelSelection:false})
  const jobs=registry(),ready=Promise.withResolvers(),finish=Promise.withResolvers()
  let runtime,request,journal,sequence=0
  const runId='55555555-5555-4555-8555-555555555555'
  const api={...machine,runInteractiveTeam:async(req,rt)=>{
    request=req;runtime=rt
    assert.equal(existsSync(rt.recoveryDirectory),false,'wrapper must not pre-create exclusive machine run directory')
    journal=new MachineJournal(rt.recoveryDirectory,req.requestId,runId,{operation:'interactive-team',socketName:'ccpro-'+runId,tmuxCommand:'tmux'})
    const event={lifecycleVersion:1,type:'lifecycle',requestId:req.requestId,runId,sequence:++sequence,event:'dispatch-intent',threadId:null,turnId:null,persistent:true,configuration:null,dispatch:'not-dispatched',outcome:'unknown',cleanupConfirmed:false}
    journal.lifecycle(event);await rt.onLifecycle(event)
    assert.equal(JSON.parse(readFileSync(recordPath(owner,req.requestId),'utf8')).runId,runId,'durable mapping before ACK')
    ready.resolve()
    rt.signal.addEventListener('abort',()=>finish.resolve({protocol:1,type:'result',requestId:req.requestId,runId,ok:false,execution:{cancelled:true},cleanup:{confirmed:true}}),{once:true})
    return finish.promise
  }}
  const tool=createNativeJobTool({agent:{id:owner},config:configured,jobs,cwd,api})
  const started=await tool.execute({action:'team',prompt:'Implement fully'})
  await ready.promise
  assert.deepEqual(request.native,native)
  const pending=await tool.execute({action:'control',job_id:started.jobId,control:'capture'})
  assert.equal(pending.status,'pending')
  runtime.onNativeEvent({version:1,sequence:1,kind:'interactive-ready',id:runId,parentId:null,state:'running'})
  const attached=await tool.execute({action:'control',job_id:started.jobId,control:'attach'})
  assert.equal(attached.displayOnly,true)
  assert.deepEqual(attached.args,['-L','ccpro-'+runId,'attach-session','-t','ccpro'])
  await assert.rejects(tool.execute({action:'control',job_id:started.jobId,control:'capture',text:'ignored'}),/unsupported/)
  jobs.records[0].running.cancel()
  assert.equal((await jobs.records[0].running.done).status,'killed')
})
test('ownership records refuse symlink substitution',async t=>{
  const f=setup(t)
  const started=await f.tool.execute({action:'review',consent:true})
  await f.jobs.records[0].running.done
  const path=recordPath(f.owner,started.jobId),copy=path+'.copy'
  writeFileSync(copy,readFileSync(path),{mode:0o600})
  rmSync(path);symlinkSync(copy,path)
  await assert.rejects(f.tool.execute({action:'recover',job_id:started.jobId}))
})

test('PTC team entry actually enables the terminal Team CLI and settles real control/cancel lifecycle',async t=>{
  const tmuxCommand=fileURLToPath(new URL('./fixtures/fake-tmux.mjs',import.meta.url))
  chmodSync(tmuxCommand,0o755)
  const f=setup(t,{mode:'team-hang',tmuxCommand})
  const prior=process.env.FAKE_TMUX_HOME
  process.env.FAKE_TMUX_HOME=f.cwd
  t.after(()=>{if(prior===undefined)delete process.env.FAKE_TMUX_HOME;else process.env.FAKE_TMUX_HOME=prior})
  const started=await f.tool.execute({action:'team',prompt:'Implement complete feature',native:{version:1,agents:{enabled:true,maxConcurrent:2},workflows:{enabled:true,maxConcurrent:3},advisor:{enabled:true,model:'opus'}}})
  const record=f.jobs.records[0],deadline=Date.now()+4000
  let settled=false;record.running.done.then(()=>{settled=true})
  while(!record.progress.some(line=>line.includes('interactive-ready'))&&!settled&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10))
  assert.ok(record.progress.some(line=>line.includes('interactive-ready')),JSON.stringify(record.progress))
  const captured=await f.tool.execute({action:'control',job_id:started.jobId,control:'capture'})
  assert.equal(captured.text,'TEAM_OUTPUT\n')
  await f.tool.execute({action:'control',job_id:started.jobId,control:'send',text:'finish fully'})
  await f.tool.execute({action:'control',job_id:started.jobId,control:'resize',columns:100,rows:30})
  const attach=await f.tool.execute({action:'control',job_id:started.jobId,control:'attach'})
  assert.equal(attach.command,tmuxCommand)
  const cancel=await f.tool.execute({action:'control',job_id:started.jobId,control:'cancel'})
  assert.equal(cancel.requested,true)
  assert.equal(cancel.cleanupConfirmed,false)
  const outcome=await record.running.done,receipt=JSON.parse(outcome.result)
  assert.equal(outcome.status,'killed')
  assert.equal(receipt.cleanup.confirmed,true,JSON.stringify(receipt))
  assert.equal(receipt.completion.businessOutcome,'unknown')
  const native=logLines(f.log)[0]
  assert.equal(native.args.includes('-p'),false)
  assert.equal(native.args[native.args.indexOf('--teammate-mode')+1],'in-process')
  assert.equal(native.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,'1')
  assert.equal(native.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS,'2')
  assert.equal(native.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS,'3')
  assert.equal(native.args[native.args.indexOf('--advisor')+1],'opus')
})

test('job identity is recoverable before a deferred DSH runner starts',async t=>{
  const cwd=makeTempDir('ccpro-job-admission-');t.after(()=>rmSync(cwd,{recursive:true,force:true}))
  let spec
  const jobs={start:value=>{spec=value;return 'deferred-'+Date.now()}}
  const tool=createNativeJobTool({agent:{id:'deferred-owner'},config:resolveConfig({command:makeFakeCommand()}),jobs,cwd})
  const started=await tool.execute({action:'review',consent:true})
  const recovered=await tool.execute({action:'recover',job_id:started.jobId})
  assert.equal(recovered.status,'pending')
  assert.match(recovered.reason,/No acknowledged lifecycle/)
  assert.equal(typeof spec.run,'function')
})
