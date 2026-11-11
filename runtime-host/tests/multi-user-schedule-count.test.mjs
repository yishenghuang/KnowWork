/**
 * 定时任务的计数面（GET /v1/schedule?countOnly=true）：业务服务建任务前要先知道这个空间已经有几条
 * （上限 100），但不需要看到任何任务内容。
 * - 只认空间头，不需要用户头；
 * - 缺空间头或不认识的头值一律 400；
 * - 只回 { total }，不回任何任务内容。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHost, collectEvents, isTurnEnd } from './support/harness.mjs'
import { startOpenAiStub } from './support/openai-stub.mjs'
import { startToolsStub } from './support/tools-stub.mjs'

const TOKENS = {
  a: 'mu-count-a-'.padEnd(40, 'a'),
  b: 'mu-count-b-'.padEnd(40, 'b'),
  c: 'mu-count-c-'.padEnd(40, 'c'),
}
// a 与 b 在同一个空间，c 在另一个空间：计数按空间算，不按人算
const OWNERS = {
  a: { workspaceId: 'ws1', userId: 'alice' },
  b: { workspaceId: 'ws1', userId: 'bob' },
  c: { workspaceId: 'ws2', userId: 'carol' },
}
const LATER = 'DTSTART;TZID=Asia/Shanghai:20990101T090000\nRRULE:FREQ=DAILY;COUNT=1'

/** 按标记编排模型：每个标记只发一步工具调用，之后一律文字回话。 */
function byMarker(plans) {
  return body => {
    const messages = body.messages ?? []
    let at = -1
    let plan
    messages.forEach((m, index) => {
      if (m.role !== 'user') return
      const found = plans.find(p => JSON.stringify(m.content).includes(p.marker))
      if (found !== undefined) { at = index; plan = found }
    })
    const step = plan?.steps[messages.slice(at + 1).filter(m => m.role === 'tool').length] ?? { text: '好' }
    return typeof step === 'function' ? step(messages) : step
  }
}

/** 最后一次模型请求里这段对话的全部工具结果（每次请求都带着之前的） */
const toolResults = gateway => gateway.requests.filter(r => r.path.endsWith('/chat/completions')).at(-1)
  .body.messages.filter(m => m.role === 'tool').map(m => String(m.content))

async function startCountHost(plans) {
  const gateway = await startOpenAiStub({ pick: byMarker(plans) })
  const tools = await startToolsStub({
    toolsByToken: { [TOKENS.a]: [], [TOKENS.b]: [], [TOKENS.c]: [] },
  })
  const host = await startHost({ sequence: ['success'] }, {
    KNOWWORK_MODEL_PROVIDER: 'knowwork-gateway',
    KNOWWORK_MODEL: 'kw-chat',
    KNOWWORK_MODEL_BASE_URL: gateway.baseURL,
    KNOWWORK_MODEL_TOKEN: 'gw-token-schedule-count-01-aaaa',
    KNOWWORK_TOOLS_BASE_URL: tools.baseUrl,
  })
  const cursors = new Map()
  const get = async (path, headers = {}) => {
    const res = await fetch(`${host.base}${path}`, { headers: { authorization: `Bearer ${host.token}`, ...headers } })
    return { status: res.status, body: await res.json() }
  }
  const ask = async (sessionId, who, text) => {
    assert.equal((await host.call('POST', '/v1/sessions', { sessionId, owner: OWNERS[who], tools: { token: TOKENS[who] } })).status, 201)
    await host.call('POST', `/v1/sessions/${sessionId}/messages`, { text })
    const frames = await collectEvents(host, sessionId, isTurnEnd, { after: cursors.get(sessionId) ?? 0 })
    cursors.set(sessionId, frames.at(-1)?.cursor ?? 0)
  }
  const create = async (sessionId, who, title) => {
    await ask(sessionId, who, `${who}：建 ${title}`)
    const created = JSON.parse(toolResults(gateway).at(-1))
    assert.ok(created.id, `没建成：${JSON.stringify(created)}`)
    return created.id
  }
  return {
    host, get, create,
    stop: async () => { await host.stop(); await gateway.close(); await tools.close() },
  }
}

test('计数只按空间头算条数，只回 total，不回任务内容；缺头或头值不合规回 400', async () => {
  const env = await startCountHost([
    { marker: 'a：建 alice 的', steps: [{ tool: 'schedule_create', args: { title: 'alice 的日报', prompt: '写日报', rrule: LATER, target: 'this_session' } }] },
    { marker: 'b：建 bob 的', steps: [{ tool: 'schedule_create', args: { title: 'bob 的周报', prompt: '写周报', rrule: LATER, target: 'this_session' } }] },
    { marker: 'c：建 carol 的', steps: [{ tool: 'schedule_create', args: { title: 'carol 的月报', prompt: '写月报', rrule: LATER, target: 'this_session' } }] },
  ])
  const { get } = env
  try {
    const aliceTask = await env.create('mu-count-a', 'a', 'alice 的日报')
    const bobTask = await env.create('mu-count-b', 'b', 'bob 的周报')
    const carolTask = await env.create('mu-count-c', 'c', 'carol 的月报')

    // 同空间的两个人算在一起
    const ws1 = await get('/v1/schedule?countOnly=true', { 'x-knowwork-owner-workspace': OWNERS.a.workspaceId })
    assert.equal(ws1.status, 200)
    assert.deepEqual(ws1.body, { total: 2 }, 'ws1 里 a 与 b 各一条')
    assert.equal(ws1.body.items, undefined, '计数不回任务列表')

    // 另一个空间只数它自己的
    const ws2 = await get('/v1/schedule?countOnly=true', { 'x-knowwork-owner-workspace': OWNERS.c.workspaceId })
    assert.equal(ws2.status, 200)
    assert.deepEqual(ws2.body, { total: 1 })

    // 没有任务的空空间是 0，不是报错
    const empty = await get('/v1/schedule?countOnly=true', { 'x-knowwork-owner-workspace': 'ws-empty' })
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body, { total: 0 })

    // 只给用户头不够：计数只认空间
    const userOnly = await get('/v1/schedule?countOnly=true', { 'x-knowwork-owner-user': OWNERS.a.userId })
    assert.equal(userOnly.status, 400)
    assert.equal(userOnly.body.error.code, 'invalid_request')
    assert.match(userOnly.body.error.message, /x-knowwork-owner-workspace/)

    // 空间头的值也要合规
    const tooLong = await get('/v1/schedule?countOnly=true', { 'x-knowwork-owner-workspace': 'w'.repeat(129) })
    assert.equal(tooLong.status, 400)

    // 多带用户头也不影响：计数按空间算，不按人算（仍是 ws1 的两条）
    const both = await get('/v1/schedule?countOnly=true', {
      'x-knowwork-owner-workspace': OWNERS.a.workspaceId,
      'x-knowwork-owner-user': OWNERS.a.userId,
    })
    assert.equal(both.status, 200)
    assert.deepEqual(both.body, { total: 2 })

    // 普通 list 没被影响
    const list = await get('/v1/schedule', {
      'x-knowwork-owner-workspace': OWNERS.a.workspaceId,
      'x-knowwork-owner-user': OWNERS.a.userId,
    })
    assert.equal(list.status, 200)
    assert.equal(list.body.total, 1, '普通 list 仍只看调用者自己的')
    assert.equal(list.body.items[0].id, aliceTask)
    assert.ok(bobTask && carolTask)

    // 计数面也要令牌
    const anonymous = await fetch(`${env.host.base}/v1/schedule?countOnly=true`)
    assert.equal(anonymous.status, 401)
  } finally {
    await env.stop()
  }
})
