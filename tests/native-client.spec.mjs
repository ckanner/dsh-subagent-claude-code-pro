import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import React from 'react'
import { create, act } from 'react-test-renderer'

function load() {
  let registration
  vm.runInNewContext(readFileSync(new URL('../assets/client.js',import.meta.url),'utf8'),
    {window:{__ModuleLoader__:{load:value=>{registration=value}}},navigator:{language:'en'},TextEncoder})
  assert.equal(registration.id,'dsh-subagent-claude-code-pro')
  // Real ModuleLoader contract: exactly one require argument and a returned module.
  const mod=registration.factory(id=>{assert.equal(id,'react');return React})
  assert.deepEqual(Array.from(mod.inject),['slots'])
  let component,disposed=false
  const disposers=[]
  mod.apply({effect:fn=>disposers.push(fn()),slots:{
    inject:(name,fn)=>{assert.equal(name,'plugins.row.config');return fn()},
    register:(spec,view)=>{assert.equal(spec.key,'dsh-subagent-claude-code-pro#claude-code-pro');component=view;return ()=>{disposed=true}},
  }})
  return {component,dispose:()=>disposers.forEach(fn=>fn()),isDisposed:()=>disposed}
}
const button=(root,label)=>root.findAllByType('button').find(node=>node.children.join('')===label)
test('visible DSH row settings use atomic native writes, explicit off and revision-conflict retention',async t=>{
  const module=load(),writes=[]
  let form={state:{status:'ready',writable:true,revision:3,value:{native:{version:1}}},mutate:async(ops,revision)=>{
    writes.push({ops:JSON.parse(JSON.stringify(ops)),revision});return false
  }}
  let view
  await act(async()=>{view=create(React.createElement(module.component,{view:'page',form}))})
  t.after(()=>{act(()=>view.unmount());module.dispose();assert.equal(module.isDisposed(),true)})
  const replacement='{"version":1,"agents":{"enabled":true}}'
  await act(async()=>view.root.findByType('textarea').props.onChange({target:{value:replacement}}))
  form={...form,state:{...form.state,revision:4,value:{native:null}}}
  await act(async()=>view.update(React.createElement(module.component,{view:'page',form})))
  await act(async()=>button(view.root,'Save defaults').props.onClick())
  assert.deepEqual(writes,[{ops:[{op:'set',path:['native'],value:{version:1,agents:{enabled:true}}}],revision:3}])
  assert.equal(view.root.findByType('textarea').props.value,replacement)
  assert.match(JSON.stringify(view.toJSON()),/draft is preserved/)
  await act(async()=>button(view.root,'Discard draft').props.onClick())
  assert.equal(view.root.findByType('textarea').props.value,'null')
  await act(async()=>button(view.root,'Load example').props.onClick())
  const example=JSON.parse(view.root.findByType('textarea').props.value)
  assert.equal(example.agents.enabled,true)
  assert.equal(example.agents.definitions.implementer.tools,undefined)
  assert.equal(example.agents.definitions.implementer.permissionMode,undefined)
  await act(async()=>button(view.root,'Edit to all off').props.onClick())
  form={...form,mutate:async(ops,revision)=>{writes.push({ops:JSON.parse(JSON.stringify(ops)),revision});return true}}
  await act(async()=>view.update(React.createElement(module.component,{view:'page',form})))
  await act(async()=>button(view.root,'Save defaults').props.onClick())
  assert.deepEqual(writes.at(-1),{ops:[{op:'set',path:['native'],value:null}],revision:4})
  await act(async()=>button(view.root,'Reset user override').props.onClick())
  assert.deepEqual(writes.at(-1),{ops:[{op:'unset',path:['native']}],revision:4})
})

test('settings refuse invalid definitions locally and honor host read-only state',async t=>{
  const module=load();let writes=0
  const form={state:{status:'ready',writable:true,revision:1,value:{}},mutate:async()=>{writes++;return true}}
  let view
  await act(async()=>{view=create(React.createElement(module.component,{view:'page',form}))})
  t.after(()=>{act(()=>view.unmount());module.dispose()})
  await act(async()=>view.root.findByType('textarea').props.onChange({target:{value:JSON.stringify({version:1,agents:{enabled:true,definitions:{'bad name':{description:'x',prompt:'x'}}}})}}))
  await act(async()=>button(view.root,'Save defaults').props.onClick())
  assert.equal(writes,0)
  assert.match(JSON.stringify(view.toJSON()),/invalid agent definition name/)
  await act(async()=>view.update(React.createElement(module.component,{view:'page',form:{...form,state:{...form.state,writable:false}}})))
  assert.equal(view.root.findByType('textarea').props.disabled,true)
  assert.equal(button(view.root,'Save defaults').props.disabled,true)
})
