/**
 * 宿主具备创建任务与会话的能力（票 #4）。
 * - 写侧 HTTP 面（建 / 改 / 删 / 立即运行）必须带调用者身份，缺了 400：没身份就建得出无处归属的任务；
 * - 「固定对话」与「每次新建对话」两类任务都建得出来，归属记在创建人名下——别人列不出、按 id 查不到；
 * - 「每次新建对话」必须带业务服务铸的属主令牌：裸的、坏的、别人的令牌都当场拒绝，且不留半成品任务；
 * - 到点：固定对话的任务请业务服务激活后投进那段对话；新建对话的任务先请业务服务按预留的会话 id 建出后台对话，
 *   再在新对话里跑完一轮——那段对话没执行过任何工具，属主来自创建时记下的账本；
 * - 宿主重启后任务与归属都还在（任务存在宿主数据目录，属主存在账本里）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { startHost, collectEvents, isTurnEnd } from './support/harness.mjs'
import { startOpenAiStub } from './support/openai-stub.mjs'
import { startToolsStub } from './support/tools-stub.mjs'
import { mintToken } from '../plugins/dsh-host/src/multi-user/preset-token.mjs'

const TOKENS = { a: 'mu-create-a-'.padEnd(40, 'a'), b: 'mu-create-b-'.padEnd(40, 'b') }
const OWNERS = { a: { workspaceId: 'ws1', userId: 'alice' }, b: { workspaceId: 'ws1', userId: 'bob' } }
const HEADERS = {
  a: { 'x-knowwork-owner-workspace': OWNERS.a.workspaceId, 'x-knowwork-owner-user': OWNERS.a.userId },
  b: { 'x-knowwork-owner-workspace': OWNERS.b.workspaceId, 'x-knowwork-owner-user': OWNERS.b.userId },
}
const WHO = { alice: 'a', bob: 'b' }
// 时间按时区写本地时间（适配层只收这种写法，见 schedule.mjs）
const LATER = 'DTSTART;TZID=Asia/Shanghai:20990101T090000\nRRULE:FREQ=DAILY;COUNT=1'
const AUTOMATION = '/internal/host/v1/automation-conversations'
const ACTIVATION = '/internal/host/v1/activations'

/** 一次性：几秒后到点（精确到秒；用 Etc/UTC，本地时间就是 UTC 的钟点） */
function soon(seconds) {
  const at = new Date(Date.now() + seconds * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')
  return `DTSTART;TZID=Etc/UTC:${at}\nRRULE:FREQ=DAILY;COUNT=1`
}

/** 到点投进来的提醒；建/改任务时宿主也会往对话里投一条 [SCHEDULE CHANGE] 通知，同属 schedule 来源，不要认错。 */
const isReminder = frame => frame.kind === 'session/event' && frame.data?.type === 'user/message' &&
  frame.data.data?.source?.kind === 'schedule' && JSON.stringify(frame.data.data.content ?? []).includes('[SCHEDULE REMINDER')

/** 轮询到 check 有结果为止（到点投递、会话建立都是异步的）。 */
async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = check()
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`等不到${what}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** 等宿主上真的出现这段对话：新建对话的任务，业务服务到点才建它。 */
async function waitForSession(host, sessionId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await host.call('GET', `/v1/sessions/${sessionId}`)
    if (response.status === 200) return
    if (Date.now() > deadline) throw new Error(`等不到会话 ${sessionId}：${JSON.stringify(response.body)}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** 按提问编排模型：找最后一条带某个标记的用户消息（用户的提问或到点的提醒），步骤按它之后已有的工具结果数往下走。 */
function byConversation(plans) {
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

const openSession = (host, sessionId, who) =>
  host.call('POST', '/v1/sessions', { sessionId, owner: OWNERS[who], tools: { token: TOKENS[who] } })

/** 业务服务的做法：核对属主后在宿主上把这段对话装好打开（已经开着就当没事）。 */
async function openAs(host, body) {
  if (host === undefined) return false
  const who = WHO[body.owner?.userId]
  if (who === undefined || body.owner?.workspaceId !== 'ws1') return false
  const response = await openSession(host, body.sessionId, who)
  return response.status === 201 || response.status === 409
}

/** 业务服务的两个内部接口（建自动化对话、激活对话）打在一个桩上：宿主只配了一个地址。 */
async function startBusinessStub(handle) {
  const requests = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}')
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body })
    const ok = await handle({ path: req.url, body })
    const status = ok ? (req.url === AUTOMATION ? 201 : 200) : 403
    const payload = ok ? (req.url === AUTOMATION ? { id: body.sessionId } : { ok: true }) : { detail: '这个人不是这个空间的成员' }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${server.address().port}/internal/host/v1`, requests,
    close: () => new Promise(resolve => server.close(resolve)) }
}

async function startCreateHost(plans, { home } = {}) {
  const gateway = await startOpenAiStub({ pick: byConversation(plans) })
  const tools = await startToolsStub({ toolsByToken: { [TOKENS.a]: [], [TOKENS.b]: [] } })
  // 激活与建对话都要能回头调宿主（像业务服务那样打开对话），宿主起来后才有
  const holder = { host: undefined }
  const business = await startBusinessStub(({ body }) => openAs(holder.host, body))
  const host = await startHost({ sequence: ['success'] }, {
    KNOWWORK_MODEL_PROVIDER: 'knowwork-gateway',
    KNOWWORK_MODEL: 'kw-chat',
    KNOWWORK_MODEL_BASE_URL: gateway.baseURL,
    KNOWWORK_MODEL_TOKEN: 'gw-token-schedule-create-01',
    KNOWWORK_TOOLS_BASE_URL: tools.baseUrl,
    KNOWWORK_ACTIVATION_BASE_URL: business.baseUrl,
  }, home === undefined ? {} : { home })
  holder.host = host
  // harness 的 call 只带宿主管家令牌；调用者身份要自己往请求头里放
  const request = async (method, path, identity, body) => {
    const res = await fetch(`${host.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json', ...identity },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  return { host, gateway, tools, business, request,
    stop: async ({ keepHome = false } = {}) => {
      await host.stop({ keepHome })
      await gateway.close()
      await tools.close()
      await business.close()
    } }
}

const task = (preset, { target, rrule = LATER, title = '周报', prompt = '写周报' } = {}) => ({
  title, prompt, timing: { kind: 'rrule', rrule },
  target: target ?? { kind: 'new', create: preset === undefined ? {} : { agentPreset: preset } },
})

test('写侧路由必须带调用者身份：缺了 400，只给一个头也算身份不完整', async () => {
  const env = await startCreateHost([])
  try {
    const body = task(undefined, { target: { kind: 'session', sessionId: 'mu-a' } })
    const anonymous = await env.request('POST', '/v1/schedule', {}, body)
    assert.equal(anonymous.status, 400, '没身份就建得出无处归属的任务')
    assert.equal(anonymous.body.error.code, 'invalid_request')
    assert.match(anonymous.body.error.message, /身份/)

    const half = await env.request('POST', '/v1/schedule', { 'x-knowwork-owner-workspace': 'ws1' }, body)
    assert.equal(half.status, 400)
    assert.match(half.body.error.message, /身份不完整/)

    assert.equal((await env.request('PATCH', '/v1/schedule/schedule-x', {}, { patch: { title: '改名' } })).status, 400)
    assert.equal((await env.request('DELETE', '/v1/schedule/schedule-x', {}, undefined)).status, 400)
    assert.equal((await env.request('POST', '/v1/schedule/schedule-x/run', {}, undefined)).status, 400)
  } finally {
    await env.stop()
  }
})

test('固定对话与每次新建对话两类任务都建得出来，归属记在创建人名下', async () => {
  const env = await startCreateHost([])
  try {
    assert.equal((await openSession(env.host, 'mu-a', 'a')).status, 201)
    const reminder = await env.request('POST', '/v1/schedule', HEADERS.a,
      task(undefined, { target: { kind: 'session', sessionId: 'mu-a' } }))
    assert.equal(reminder.status, 201, JSON.stringify(reminder.body))
    assert.equal(reminder.body.target.kind, 'session')
    assert.equal(reminder.body.target.sessionId, 'mu-a')

    const preset = mintToken(OWNERS.a, env.host.token)
    const fresh = await env.request('POST', '/v1/schedule', HEADERS.a, task(preset))
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body))
    assert.equal(fresh.body.target.kind, 'new')
    assert.equal(fresh.body.target.create.agentPreset, preset, '属主令牌随任务存下来')

    const mine = await env.request('GET', '/v1/schedule', HEADERS.a)
    assert.equal(mine.status, 200)
    assert.equal(mine.body.total, 2)

    const theirs = await env.request('GET', '/v1/schedule', HEADERS.b)
    assert.equal(theirs.body.total, 0, '别人的任务不该列出来')
    const peek = await env.request('GET', `/v1/schedule/${reminder.body.id}`, HEADERS.b)
    assert.equal(peek.status, 404, '按 id 查别人的任务也查不到')
    assert.equal(peek.body.error.code, 'schedule_not_found')
  } finally {
    await env.stop()
  }
})

test('每次新建对话必须带本人属主令牌：裸的、坏的、别人的都当场拒绝，不留半成品', async () => {
  const env = await startCreateHost([])
  try {
    const bare = await env.request('POST', '/v1/schedule', HEADERS.a, task(undefined))
    assert.equal(bare.status, 400, '裸的每次新建对话没有属主，到点也建不出对话')
    assert.match(bare.body.error.message, /属主令牌/)

    const broken = await env.request('POST', '/v1/schedule', HEADERS.a, task('kwauto1.bm90LWpzb24.bm90LWEtc2ln'))
    assert.equal(broken.status, 400)
    assert.match(broken.body.error.message, /令牌不对/)

    const stolen = await env.request('POST', '/v1/schedule', HEADERS.a, task(mintToken(OWNERS.b, env.host.token)))
    assert.equal(stolen.status, 400)
    assert.match(stolen.body.error.message, /不是这个人的/)

    const mine = await env.request('GET', '/v1/schedule', HEADERS.a)
    assert.equal(mine.body.total, 0, '被拒的任务不该留在调度器里')
    assert.equal((await env.request('GET', '/v1/schedule', HEADERS.b)).body.total, 0)
  } finally {
    await env.stop()
  }
})

test('固定对话的任务到点：请业务服务激活（宿主令牌、说清属主）后投进那段对话，并跑完一轮', async () => {
  const env = await startCreateHost([{ marker: '写日报', steps: [{ text: '日报写好了' }] }])
  try {
    assert.equal((await openSession(env.host, 'mu-a', 'a')).status, 201)
    const created = await env.request('POST', '/v1/schedule', HEADERS.a,
      task(undefined, { target: { kind: 'session', sessionId: 'mu-a' }, rrule: soon(3), title: '日报', prompt: '写日报' }))
    assert.equal(created.status, 201, JSON.stringify(created.body))

    const frames = await collectEvents(env.host, 'mu-a', isReminder, { timeoutMs: 30_000 })
    assert.match(frames.at(-1).data.data.content[0].text, /写日报/)
    const asked = env.business.requests.find(entry => entry.path === ACTIVATION)
    assert.equal(asked.authorization, `Bearer ${env.host.token}`)
    assert.deepEqual(asked.body, { kind: 'schedule', sessionId: 'mu-a', owner: OWNERS.a })

    // 提醒投进去后这段对话跑完一轮（模型桩按「写日报」应答）
    await collectEvents(env.host, 'mu-a', isTurnEnd, { timeoutMs: 30_000 })
  } finally {
    await env.stop()
  }
})

test('每次新建对话的任务到点：业务服务按预留的会话 id 建出后台对话，新对话里跑完一轮', async () => {
  const env = await startCreateHost([{ marker: '整理周报', steps: [{ text: '周报整理好了' }] }])
  try {
    const created = await env.request('POST', '/v1/schedule', HEADERS.a,
      task(mintToken(OWNERS.a, env.host.token), { rrule: soon(2), prompt: '整理周报' }))
    assert.equal(created.status, 201, JSON.stringify(created.body))

    const made = await waitFor(() => env.business.requests.find(entry => entry.path === AUTOMATION), 30_000, '业务服务建对话')
    assert.equal(made.authorization, `Bearer ${env.host.token}`)
    assert.match(made.body.sessionId, /^session-[0-9a-f-]{36}$/, '会话 id 由宿主生成')
    assert.deepEqual(made.body.owner, OWNERS.a, '建哪段对话、归谁，一起告诉业务服务')

    const sessionId = made.body.sessionId
    await waitForSession(env.host, sessionId)
    const frames = await collectEvents(env.host, sessionId, isReminder, { timeoutMs: 30_000 })
    assert.match(frames.at(-1).data.data.content[0].text, /整理周报/)
    // 这段对话没执行过任何工具，属主来自创建时记下的账本；提醒投进去后跑完一轮
    await collectEvents(env.host, sessionId, isTurnEnd, { timeoutMs: 30_000 })
  } finally {
    await env.stop()
  }
})

test('预留会话 id 的任务建的时候就建好对话；对话被回收后到点按账本属主请业务服务重开再投递', async () => {
  const env = await startCreateHost([{ marker: '整理周报', steps: [{ text: '周报整理好了' }] }])
  try {
    const preset = mintToken(OWNERS.a, env.host.token)
    const created = await env.request('POST', '/v1/schedule', HEADERS.a,
      task(preset, { rrule: soon(3), prompt: '整理周报', target: { kind: 'new_once', create: { agentPreset: preset } } }))
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.target.kind, 'new_once')
    const sessionId = created.body.target.sessionId
    assert.match(sessionId, /^session-/, '建任务时就预留了会话 id')

    // 建任务时就把这段对话建了出来：不留到点才发现建不出对话的半成品任务
    const made = env.business.requests.find(entry => entry.path === AUTOMATION)
    assert.deepEqual(made.body, { sessionId, owner: OWNERS.a })
    await waitForSession(env.host, sessionId)

    // 对话被回收（空闲释放、宿主重启后没再打开）：到点按账本里的属主请业务服务重开
    assert.equal((await env.host.call('DELETE', `/v1/sessions/${sessionId}`)).status, 200)
    const asked = await waitFor(() => env.business.requests.find(entry => entry.path === ACTIVATION), 40_000, '业务服务重开对话')
    assert.equal(asked.authorization, `Bearer ${env.host.token}`)
    assert.deepEqual(asked.body, { kind: 'schedule', sessionId, owner: OWNERS.a })

    const frames = await collectEvents(env.host, sessionId, isReminder, { timeoutMs: 30_000 })
    assert.match(frames.at(-1).data.data.content[0].text, /整理周报/)
    await collectEvents(env.host, sessionId, isTurnEnd, { timeoutMs: 30_000 })
  } finally {
    await env.stop()
  }
})

test('宿主重启后任务与归属都还在', async () => {
  const first = await startCreateHost([])
  let home
  let created
  try {
    created = await first.request('POST', '/v1/schedule', HEADERS.a, task(mintToken(OWNERS.a, first.host.token)))
    assert.equal(created.status, 201, JSON.stringify(created.body))
    home = first.host.home
  } finally {
    await first.stop({ keepHome: true })
  }

  const again = await startCreateHost([], { home })
  try {
    const mine = await again.request('GET', '/v1/schedule', HEADERS.a)
    assert.equal(mine.body.total, 1, '重启后任务还在')
    assert.equal(mine.body.items[0].id, created.body.id)
    assert.equal(mine.body.items[0].target.create.agentPreset, created.body.target.create.agentPreset, '属主令牌随任务存下来')
    assert.equal((await again.request('GET', '/v1/schedule', HEADERS.b)).body.total, 0, '归属也还在')
  } finally {
    await again.stop()
  }
})
