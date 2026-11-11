/**
 * 管理端停用（票 #9）：空间管理员在业务服务的审计页上停掉本空间的自动化任务。
 * - 管理端没有「某个人的身份」：它带的是 x-knowwork-admin-workspace，说清停的是哪个空间的任务；
 * - 全量读（不带调用者身份头）每条任务要带 owner，业务服务才分得清哪些属于本空间；
 * - 管理端只能停用：patch 不是恰好 {active:false} 一律 400，改内容与重新启用都不走这条路；
 * - 别的空间的任务一律 404（和「不存在」同一个样子，不泄漏有没有这条任务）；
 * - 普通个人写侧（不带管理端头）行为不变：仍必须带调用者身份。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHost, collectEvents, isTurnEnd } from './support/harness.mjs'
import { startOpenAiStub } from './support/openai-stub.mjs'
import { startToolsStub } from './support/tools-stub.mjs'

const TOKENS = {
  a: 'mu-admin-a-'.padEnd(40, 'a'),
  b: 'mu-admin-b-'.padEnd(40, 'b'),
  c: 'mu-admin-c-'.padEnd(40, 'c'),
}
// a 与 b 在同一个空间（管理员该看见两条），c 在另一个空间（管理端看不见也停不了）
const OWNERS = {
  a: { workspaceId: 'ws1', userId: 'alice' },
  b: { workspaceId: 'ws1', userId: 'bob' },
  c: { workspaceId: 'ws2', userId: 'carol' },
}
const HEADERS = {
  a: { 'x-knowwork-owner-workspace': OWNERS.a.workspaceId, 'x-knowwork-owner-user': OWNERS.a.userId },
  b: { 'x-knowwork-owner-workspace': OWNERS.b.workspaceId, 'x-knowwork-owner-user': OWNERS.b.userId },
  c: { 'x-knowwork-owner-workspace': OWNERS.c.workspaceId, 'x-knowwork-owner-user': OWNERS.c.userId },
}
const ADMIN_WS1 = { 'x-knowwork-admin-workspace': 'ws1' }
// 远期的一次性任务：这些用例只改状态，不要让任务当场到点
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

async function startAdminHost(plans) {
  const gateway = await startOpenAiStub({ pick: byMarker(plans) })
  const tools = await startToolsStub({
    toolsByToken: { [TOKENS.a]: [], [TOKENS.b]: [], [TOKENS.c]: [] },
  })
  const host = await startHost({ sequence: ['success'] }, {
    KNOWWORK_MODEL_PROVIDER: 'knowwork-gateway',
    KNOWWORK_MODEL: 'kw-chat',
    KNOWWORK_MODEL_BASE_URL: gateway.baseURL,
    KNOWWORK_MODEL_TOKEN: 'gw-token-schedule-admin-01',
    KNOWWORK_TOOLS_BASE_URL: tools.baseUrl,
  })
  const cursors = new Map()
  // harness 的 call 只带宿主管家令牌；调用者身份与管理端头要自己往请求头里放
  const request = async (method, path, headers = {}, body) => {
    const res = await fetch(`${host.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${host.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
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
    host, request, create,
    stop: async () => { await host.stop(); await gateway.close(); await tools.close() },
  }
}

test('全量读每条任务带属主；带身份头的个人列表仍只有自己的且不带属主', async () => {
  const env = await startAdminHost([
    { marker: 'a：建 alice 的', steps: [{ tool: 'schedule_create', args: { title: 'alice 的日报', prompt: '写日报', rrule: LATER, target: 'this_session' } }] },
    { marker: 'b：建 bob 的', steps: [{ tool: 'schedule_create', args: { title: 'bob 的周报', prompt: '写周报', rrule: LATER, target: 'this_session' } }] },
    { marker: 'c：建 carol 的', steps: [{ tool: 'schedule_create', args: { title: 'carol 的月报', prompt: '写月报', rrule: LATER, target: 'this_session' } }] },
  ])
  try {
    const aliceTask = await env.create('mu-admin-a', 'a', 'alice 的日报')
    const bobTask = await env.create('mu-admin-b', 'b', 'bob 的周报')
    const carolTask = await env.create('mu-admin-c', 'c', 'carol 的月报')

    // 管理端全量读：整个宿主的任务都在，每条都带着归属，业务服务才能按空间筛
    const all = await env.request('GET', '/v1/schedule')
    assert.equal(all.status, 200)
    assert.equal(all.body.total, 3)
    const byId = new Map(all.body.items.map(entry => [entry.id, entry]))
    assert.deepEqual(byId.get(aliceTask).owner, OWNERS.a)
    assert.deepEqual(byId.get(bobTask).owner, OWNERS.b)
    assert.deepEqual(byId.get(carolTask).owner, OWNERS.c)

    // 个人列表：仍只有自己的，且不带 owner（适配层已经过滤，不必把账本泄漏给页面）
    const mine = await env.request('GET', '/v1/schedule', HEADERS.a)
    assert.equal(mine.status, 200)
    assert.equal(mine.body.total, 1)
    assert.equal(mine.body.items[0].id, aliceTask)
    assert.equal(mine.body.items[0].owner, undefined, '个人列表不带属主')
  } finally {
    await env.stop()
  }
})

test('管理端停用本空间的任务：变成 paused，创建者自己的列表里也是 paused', async () => {
  const env = await startAdminHost([
    { marker: 'a：建 alice 的', steps: [{ tool: 'schedule_create', args: { title: 'alice 的日报', prompt: '写日报', rrule: LATER, target: 'this_session' } }] },
  ])
  try {
    const aliceTask = await env.create('mu-admin-a', 'a', 'alice 的日报')
    assert.equal((await env.request('GET', `/v1/schedule/${aliceTask}`, HEADERS.a)).body.status, 'active')

    // 管理端请求不带调用者身份头：管理端代表空间，不代表某个人
    const disabled = await env.request('PATCH', `/v1/schedule/${aliceTask}`, ADMIN_WS1, { patch: { active: false } })
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body))
    assert.equal(disabled.body.status, 'paused')

    assert.equal((await env.request('GET', `/v1/schedule/${aliceTask}`, HEADERS.a)).body.status, 'paused', '创建者也看到它停了')
    // 停用后不再出现在「进行中」的筛选里，也就是到点不会被触发
    assert.equal((await env.request('GET', '/v1/schedule?active=true', HEADERS.a)).body.total, 0)
    assert.equal((await env.request('GET', '/v1/schedule?active=false', HEADERS.a)).body.total, 1)

    // 创建者仍能自己改回来：管理端只是停了它，没有把任务锁死
    const resumed = await env.request('PATCH', `/v1/schedule/${aliceTask}`, HEADERS.a, { patch: { active: true } })
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
    assert.equal(resumed.body.status, 'active')
  } finally {
    await env.stop()
  }
})

test('管理端停别的空间的任务：404，任务不动', async () => {
  const env = await startAdminHost([
    { marker: 'c：建 carol 的', steps: [{ tool: 'schedule_create', args: { title: 'carol 的月报', prompt: '写月报', rrule: LATER, target: 'this_session' } }] },
    { marker: 'a：建 alice 的', steps: [{ tool: 'schedule_create', args: { title: 'alice 的日报', prompt: '写日报', rrule: LATER, target: 'this_session' } }] },
  ])
  try {
    const carolTask = await env.create('mu-admin-c', 'c', 'carol 的月报')
    const aliceTask = await env.create('mu-admin-a', 'a', 'alice 的日报')

    const peeked = await env.request('PATCH', `/v1/schedule/${carolTask}`, ADMIN_WS1, { patch: { active: false } })
    assert.equal(peeked.status, 404)
    assert.equal(peeked.body.error.code, 'schedule_not_found')
    assert.equal((await env.request('GET', `/v1/schedule/${carolTask}`, HEADERS.c)).body.status, 'active', 'ws2 的任务没被动')

    // 没有这条任务、空间里没有任务、都是同一个 404 样子
    assert.equal((await env.request('PATCH', '/v1/schedule/schedule-nope', ADMIN_WS1, { patch: { active: false } })).status, 404)
    assert.equal((await env.request('PATCH', `/v1/schedule/${aliceTask}`, { 'x-knowwork-admin-workspace': 'ws-empty' }, { patch: { active: false } })).status, 404)
    assert.equal((await env.request('GET', `/v1/schedule/${aliceTask}`, HEADERS.a)).body.status, 'active')
  } finally {
    await env.stop()
  }
})

test('管理端只能停用：patch 不是恰好 {active:false} 一律 400，任务不动', async () => {
  const env = await startAdminHost([
    { marker: 'a：建 alice 的', steps: [{ tool: 'schedule_create', args: { title: 'alice 的日报', prompt: '写日报', rrule: LATER, target: 'this_session' } }] },
  ])
  try {
    const aliceTask = await env.create('mu-admin-a', 'a', 'alice 的日报')
    const path = `/v1/schedule/${aliceTask}`

    for (const body of [
      { patch: { active: true } },
      { patch: { title: '管理员改名' } },
      { patch: { active: false, title: '顺便改名' } },
      { patch: {} },
      {},
    ]) {
      const refused = await env.request('PATCH', path, ADMIN_WS1, body)
      assert.equal(refused.status, 400, `${JSON.stringify(body)} 不该被接受`)
      assert.equal(refused.body.error.code, 'invalid_request')
      assert.match(refused.body.error.message, /停用/)
    }

    const view = await env.request('GET', path, HEADERS.a)
    assert.equal(view.body.status, 'active', '被拒的请求没动任务')
    assert.equal(view.body.title, 'alice 的日报')
  } finally {
    await env.stop()
  }
})

test('管理端头的值必须合规：空串与超长都 400', async () => {
  const env = await startAdminHost([
    { marker: 'a：建 alice 的', steps: [{ tool: 'schedule_create', args: { title: 'alice 的日报', prompt: '写日报', rrule: LATER, target: 'this_session' } }] },
  ])
  try {
    const aliceTask = await env.create('mu-admin-a', 'a', 'alice 的日报')
    for (const value of ['', 'w'.repeat(129)]) {
      const refused = await env.request('PATCH', `/v1/schedule/${aliceTask}`, { 'x-knowwork-admin-workspace': value }, { patch: { active: false } })
      assert.equal(refused.status, 400, `头值 ${JSON.stringify(value)} 该被拒`)
      assert.equal(refused.body.error.code, 'invalid_request')
      assert.match(refused.body.error.message, /x-knowwork-admin-workspace/)
    }
    assert.equal((await env.request('GET', `/v1/schedule/${aliceTask}`, HEADERS.a)).body.status, 'active')
  } finally {
    await env.stop()
  }
})

test('管理端分支只接 PATCH 停用：建、删、立即运行仍必须带调用者身份', async () => {
  const env = await startAdminHost([
    { marker: 'a：建 alice 的', steps: [{ tool: 'schedule_create', args: { title: 'alice 的日报', prompt: '写日报', rrule: LATER, target: 'this_session' } }] },
  ])
  try {
    const aliceTask = await env.create('mu-admin-a', 'a', 'alice 的日报')
    const body = {
      title: '管理员替别人建',
      prompt: '写点什么',
      timing: { kind: 'rrule', rrule: LATER },
      target: { kind: 'session', sessionId: 'mu-admin-a' },
    }
    const created = await env.request('POST', '/v1/schedule', ADMIN_WS1, body)
    assert.equal(created.status, 400, '管理端不能替别人建任务')
    assert.match(created.body.error.message, /身份/)

    const deleted = await env.request('DELETE', `/v1/schedule/${aliceTask}`, ADMIN_WS1, undefined)
    assert.equal(deleted.status, 400, '管理端不能删任务')
    const run = await env.request('POST', `/v1/schedule/${aliceTask}/run`, ADMIN_WS1, undefined)
    assert.equal(run.status, 400, '管理端不能替别人跑任务')

    // 管理端头也改不了内容：这是「停用」这一条路，别的一概不接
    assert.equal((await env.request('PATCH', `/v1/schedule/${aliceTask}`, ADMIN_WS1, { patch: { prompt: '换成别的' } })).status, 400)
    assert.equal((await env.request('GET', `/v1/schedule/${aliceTask}`, HEADERS.a)).body.prompt, '写日报')
  } finally {
    await env.stop()
  }
})

test('普通个人写侧行为不变：不带管理端头时缺身份仍是 400', async () => {
  const env = await startAdminHost([
    { marker: 'a：建 alice 的', steps: [{ tool: 'schedule_create', args: { title: 'alice 的日报', prompt: '写日报', rrule: LATER, target: 'this_session' } }] },
  ])
  try {
    const aliceTask = await env.create('mu-admin-a', 'a', 'alice 的日报')
    const withoutIdentity = await env.request('PATCH', `/v1/schedule/${aliceTask}`, {}, { patch: { active: false } })
    assert.equal(withoutIdentity.status, 400)
    assert.match(withoutIdentity.body.error.message, /身份/)

    // 别人的个人 PATCH 仍按归属回 404，没被管理端分支带偏
    const others = await env.request('PATCH', `/v1/schedule/${aliceTask}`, HEADERS.b, { patch: { title: 'bob 改名' } })
    assert.equal(others.status, 404)
    assert.equal(others.body.error.code, 'schedule_not_found')

    // 自己的个人 PATCH 照旧可用（这里顺便证明停用与重新启用是同一个官方 edit）
    const mine = await env.request('PATCH', `/v1/schedule/${aliceTask}`, HEADERS.a, { patch: { title: 'alice 自己改名' } })
    assert.equal(mine.status, 200, JSON.stringify(mine.body))
    assert.equal(mine.body.title, 'alice 自己改名')
  } finally {
    await env.stop()
  }
})
