// Verify published Host contracts and the exact current-desktop source, without a model call.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import { assertSupportedJsonSchema as publishedAssert } from '@deepseek-ai/dsh-tools'
import { jsonSchemaToTs as publishedTypes, renderToolsSdk as publishedSdk } from '@deepseek-ai/dsh-tool-executor-ptc'
import { createClaudeCodeTool } from '../lib/tool.js'
import { createNativeJobTool } from '../lib/desktop-native-jobs.js'
import { resolveConfig } from '../lib/index.js'

const reference = '39163dd30f703a79079e2d2446545cff3c453738'
const entries = [
  ['packages/core/tools/src/json-schema.ts', 'c064fb294c7bb6349befc825699e3dc841766d30'],
  ['packages/core/tool-executor-ptc/src/ts-types.ts', 'a2fcfd57a206d7cc735c18822566df91ec7d139e'],
]
const sources = await Promise.all(entries.map(async ([path, expected]) => {
  const response = await fetch('https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/' + reference + '/' + path, { signal: AbortSignal.timeout(30000) })
  assert.equal(response.ok, true, 'could not fetch pinned DSH contract ' + path)
  const source = await response.text()
  const bytes = Buffer.from(source)
  const blob = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
  assert.equal(blob, expected, 'pinned DSH contract bytes changed: ' + path)
  return stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: path })
}))
const replaceImport = (source, specifier, replacement) => {
  const before = "from '" + specifier + "'"
  assert.ok(source.includes(before), 'upstream import boundary changed: ' + specifier)
  return source.replaceAll(before, 'from ' + JSON.stringify(replacement))
}
const dataModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
let jsonSource = replaceImport(sources[0], '@deepseek-ai/dsh-llm', import.meta.resolve('@deepseek-ai/dsh-llm'))
jsonSource = replaceImport(jsonSource, '@deepseek-ai/dsh-util-values', import.meta.resolve('@deepseek-ai/dsh-util-values'))
const jsonURL = dataModule(jsonSource)
const current = await import(jsonURL)
const types = await import(dataModule(replaceImport(sources[1], '@deepseek-ai/dsh-tools', jsonURL)))

let checked = 0
for (const modelSelection of [false, true]) for (const backgroundEnabled of [false, true]) {
  const config = resolveConfig({ modelSelection })
  const normal = createClaudeCodeTool({ toolName:config.toolName, cwd:process.cwd(), modelSelectionEnabled:modelSelection,
    backgroundEnabled, permissionMode:config.permissionMode, sessionMode:config.sessionMode,
    run:async()=>{throw new Error('contract validation must not dispatch')}, startBackground:()=>{throw new Error('contract validation must not dispatch')} })
  const native = createNativeJobTool({ agent:{id:'schema-check'}, config, cwd:process.cwd(),
    jobs:backgroundEnabled?{start(){throw new Error('contract validation must not dispatch')}}:undefined })
  for (const definition of [normal,native]) {
    for (const validate of [publishedAssert,current.assertSupportedJsonSchema]) {
      validate(definition.parameters)
      validate(definition.output.schema)
    }
    for (const render of [publishedTypes,types.jsonSchemaToTs]) {
      const parameters=render(definition.parameters)
      assert.notEqual(parameters,'unknown',definition.name+' lost its PTC arguments')
      assert.match(parameters,/\bnative\??:/)
      assert.match(parameters,definition===normal?/\bprompt:/ : /\baction:/)
      const output=render(definition.output.schema)
      assert.notEqual(output,'unknown',definition.name+' lost its PTC return type')
      if(definition===native) assert.match(output,/\bjobId: string/)
    }
    checked++
  }
  const schemas=[normal,native].map(definition=>({name:definition.name,description:definition.description,parameters:definition.parameters,output:definition.output.schema}))
  for(const render of [publishedSdk,types.renderToolsSdk]) {
    const sdk=render(schemas)
    assert.match(sdk,/interface ToolArgsMap/)
    assert.doesNotMatch(sdk,/subagent_claude_code(?:_native_job)?: unknown;/)
    assert.match(sdk,/\bnative\??:/)
    assert.match(sdk,/\baction:/)
    assert.match(sdk,/\bjobId: string/)
  }
}
console.log('DSH contract verified: '+checked+' tool combinations; published and '+reference+' schema/PTC generation; no native dispatch.')
