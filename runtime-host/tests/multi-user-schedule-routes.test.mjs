/**
 * 定时任务的读侧 HTTP 面（http-host 的 /v1/schedule）：业务服务的「自动化」页靠它列任务、看单条、看投递记录。
 * - 要令牌：和宿主其它接口一样先过共享令牌；
 * - 业务服务在请求头里声明这次是谁在问，适配层只放他名下的任务出来；不带身份头是管理端全量读；
 * - 只给一个身份头是请求本身不完整，回 400；别人的任务按 id 取（含投递记录）照官方「找不到」回 404。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHost, collectEvents, isTurnEnd } from './support/harness.mjs'
import { startOpenAiStub } from './support/openai-stub.mjs'
import { startToolsStub } from './support/tools-stub.mjs'

const TOKENS = { a: 'mu-route-a-'.padEnd(40, 'a'), b: 'mu-route-b-'.padEnd(40, 'b') }
const OWNERS = { a: { workspaceId: 'ws1', userId: 'alice' }, b: { workspaceId: 'ws1', userId: 'bob' } }
// 时间按时区写本地时间（适配层只收这种写法，见 schedule.mjs）
const LATER = 'DTSTART;TZID=Asia/Shanghai:20990101T090000\nRRULE:FREQ=DAILY;COUNT=1'
const HEADERS = {
  a: { 'x-knowwork-owner-workspace': OWNERS.a.workspaceId, 'x-knowwork-owner-user': OWNERS.a.userId },
  b: { 'x-knowwork-owner-workspace': OWNERS.b.workspaceId, 'x-knowwork-owner-user': OWNERS.b.userId },
}

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

/** 起真宿主 + 模型桩 + 工具桩，并给一个能带自定义头的 GET。 */
async function startRouteHost(plans) {
  const gateway = await startOpenAiStub({ pick: byMarker(plans) })
  const tools = await startToolsStub({ toolsByToken: { [TOKENS.a]: [], [TOKENS.b]: [] } })
  const host = await startHost({ sequence: ['success'] }, {
    KNOWWORK_MODEL_PROVIDER: 'knowwork-gateway',
    KNOWWORK_MODEL: 'kw-chat',
    KNOWWORK_MODEL_BASE_URL: gateway.baseURL,
    KNOWWORK_MODEL_TOKEN: 'gw-token-schedule-routes-01-aaaa',
    KNOWWORK_TOOLS_BASE_URL: tools.baseUrl,
  })
  const cursors = new Map()
  // harness 的 call 只带令牌与 content-type，读侧要自定义身份头，这里自己发
  const get = async (path, headers = {}) => {
    const res = await fetch(`${host.base}${path}`, { headers: { authorization: `Bearer ${host.token}`, ...headers } })
    return { status: res.status, body: await res.json() }
  }
  /** 让 who 在 sessionId 里问一句话，等这一轮结束（工具结果随模型请求带回来） */
  const ask = async (sessionId, who, text) => {
    assert.equal((await host.call('POST', '/v1/sessions', { sessionId, owner: OWNERS[who], tools: { token: TOKENS[who] } })).status, 201)
    await host.call('POST', `/v1/sessions/${sessionId}/messages`, { text })
    const frames = await collectEvents(host, sessionId, isTurnEnd, { after: cursors.get(sessionId) ?? 0 })
    cursors.set(sessionId, frames.at(-1)?.cursor ?? 0)
  }
  /** 建一个任务，返回宿主给的 id */
  const create = async (sessionId, who, title) => {
    await ask(sessionId, who, `${who}：建 ${title}`)
    const created = JSON.parse(toolResults(gateway).at(-1))
    assert.ok(created.id, `没建成：${JSON.stringify(created)}`)
    return created.id
  }
  return {
    host, gateway, get, create,
    stop: async () => { await host.stop(); await gateway.close(); await tools.close() },
  }
}

test('读侧要令牌；只列出调用者自己的任务，别人的按 id 取与看记录都回 404；不带身份头能列全部；只给一个身份头回 400', async () => {
  const env = await startRouteHost([
    { marker: 'a：建 alice 的', steps: [{ tool: 'schedule_create', args: { title: 'alice 的日报', prompt: '写日报', rrule: LATER, target: 'this_session' } }] },
    { marker: 'b：建 bob 的', steps: [{ tool: 'schedule_create', args: { title: 'bob 的周报', prompt: '写周报', rrule: LATER, target: 'this_session' } }] },
  ])
  const { host, get } = env
  try {
    const aliceTask = await env.create('mu-route-a', 'a', 'alice 的日报')
    const bobTask = await env.create('mu-route-b', 'b', 'bob 的周报')

    // 要令牌：和宿主其它接口一样
    const anonymous = await fetch(`${host.base}/v1/schedule`)
    assert.equal(anonymous.status, 401, '不带令牌读不到任务')
    assert.equal((await anonymous.json()).error.code, 'unauthorized')

    // 普通调用者只见自己
    const mine = await get('/v1/schedule', HEADERS.a)
    assert.equal(mine.status, 200)
    assert.equal(mine.body.total, 1, 'alice 只应看到自己的一个任务')
    assert.equal(mine.body.items[0].id, aliceTask)
    assert.equal(mine.body.items[0].title, 'alice 的日报')

    // 按 id 取别人的：照官方「找不到」
    const foreign = await get(`/v1/schedule/${bobTask}`, HEADERS.a)
    assert.equal(foreign.status, 404, '别人的任务按 id 取不到')
    assert.equal(foreign.body.error.code, 'schedule_not_found')

    // 投递记录也要归属校验：连记录都不该问得出来
    const foreignHistory = await get(`/v1/schedule/${bobTask}/history`, HEADERS.a)
    assert.equal(foreignHistory.status, 404, '别人的任务看投递记录也回找不到')
    assert.equal(foreignHistory.body.error.code, 'schedule_not_found')
    assert.equal(foreignHistory.body.records, undefined, '别人的任务不该漏出任何记录')

    // 自己的任务：单条与记录（刚建、还没投递过，记录为空但形状完整）
    const own = await get(`/v1/schedule/${aliceTask}`, HEADERS.a)
    assert.equal(own.status, 200)
    assert.equal(own.body.id, aliceTask)
    assert.equal(own.body.kind, 'rrule')
    const history = await get(`/v1/schedule/${aliceTask}/history`, HEADERS.a)
    assert.equal(history.status, 200)
    assert.equal(history.body.id, aliceTask)
    assert.deepEqual(history.body.records, [], '刚建的任务还没有投递记录')

    // 不带身份头 = 管理端全量读
    const all = await get('/v1/schedule')
    assert.equal(all.status, 200)
    assert.equal(all.body.total, 2, '管理端看得到全部任务')
    assert.deepEqual(all.body.items.map(item => item.id).sort(), [aliceTask, bobTask].sort())

    // 只给一个身份头：请求本身不完整
    const partial = await get('/v1/schedule', { 'x-knowwork-owner-user': OWNERS.a.userId })
    assert.equal(partial.status, 400)
    assert.equal(partial.body.error.code, 'invalid_request')
    assert.equal(partial.body.error.message, '调用者身份不完整')

    // 身份头的值也不能超长（和会话 id 一样的上限）
    const tooLong = await get('/v1/schedule', { ...HEADERS.a, 'x-knowwork-owner-workspace': 'w'.repeat(129) })
    assert.equal(tooLong.status, 400, '超长的身份头当成不合规')

    // 不认识的路径照旧 404，不会被当成任务的动作
    const unknown = await get(`/v1/schedule/${aliceTask}/deliveries`, HEADERS.a)
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error.code, 'not_found')
  } finally {
    await env.stop()
  }
})
