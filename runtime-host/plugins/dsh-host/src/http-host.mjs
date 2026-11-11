/**
 * KnowWork 宿主的 HTTP 协议驱动。
 *
 * 形态照官方 `@deepseek-ai/dsh-sdk-jsonrpc-server`：插件拿到 `ctx.agents`，把外部请求映射成
 * `agents.create / resume`、`agent.followup / steer / cancel`，并转发 `session/event`。
 * 同官方一样：同一会话「已打开或正在打开」时拒绝再开；等整棵插件树就绪后才对外服务；
 * 关闭时先拒新请求、等正在打开的会话、排空子 Agent，再释放。
 * 区别只在传输：官方是 stdio JSON-RPC，这里是带令牌的 HTTP，事件流为 NDJSON。
 * 空闲会话定时释放（见 idle-sessions.mjs），业务服务下次发消息走恢复流程。
 *
 * 业务服务是唯一调用方；宿主只监听内网地址，缺令牌或令牌太短直接拒绝启动。
 */

import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { createHash, timingSafeEqual } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AnswerError, checkAnswer, parseAnswer } from './question-answers.mjs'
import { attachmentBlocks, attachmentsOf } from './attachment-handles.mjs'
import { sessionRoot } from './sandbox-client.mjs'
import { EPOCH, createSession, dropSession, framesAfter, getSession, oldestCursor, publish, publishLive } from './state.mjs'
import { createIdleTracker, idleMsOf, releasable, sweepMsOf } from './idle-sessions.mjs'
import { bundledCandidates } from './bundled-skills.mjs'
import { catalogOf } from './knowledge-catalog.mjs'
import { mentionBlocks, mentionsOf } from './mentions.mjs'
import { receiveTurnContext, turnContextOf } from './turn-context.mjs'
import { BUILT_IN_MODES, MODE_PATTERN, answerModeSpecOf } from './answer-mode.mjs'
import { runAs, sameOwner } from './multi-user/caller.mjs'
import { ownerOfToken } from './multi-user/preset-token.mjs'
import { deploymentTimeZone, userSource } from './message-source.mjs'

// DSH 版本号随 /health 一起报给业务服务，系统信息页显示（所有 @deepseek-ai 包锁在同一版本）
const DSH_VERSION = createRequire(import.meta.url)('@deepseek-ai/dsh/package.json').version

export const name = 'knowwork-http-host'
export const inject = ['agents']

const HEARTBEAT_MS = 2000
const CANCEL_SETTLE_MS = 5000
const MAX_BODY_BYTES = 1024 * 1024
const MAX_SUBSCRIBERS_PER_SESSION = 8
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/
// 定时任务 id 是官方给的 schedule-<uuid>，取值范围和会话 id 一样
const SCHEDULE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/
// 业务服务在请求头里声明这次是谁在问（宿主用共享令牌认证，二者都是内网可信面）
const OWNER_WORKSPACE_HEADER = 'x-knowwork-owner-workspace'
const OWNER_USER_HEADER = 'x-knowwork-owner-user'
// 管理端停用任务时声明「停的是哪个空间的任务」：管理员只能停本空间的，替别人建与改内容都不在管理端
const ADMIN_WORKSPACE_HEADER = 'x-knowwork-admin-workspace'
const CREDENTIAL_ACTIONS = new Set(['tool-credential', 'skill-credential'])
// 官方远程方法（remoteCreate / remoteEdit / remoteList …）把输入校验错误包成这个 code 的 RemoteError，
// 原来的 ScheduleInputError.code 在 details.code 里
const REMOTE_INPUT_INVALID = 'schedule/input-invalid'

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const digest = value => createHash('sha256').update(value).digest()

function tokenMatches(expectedDigest, header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  return timingSafeEqual(digest(header.slice(7)), expectedDigest)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', '请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体不是合法 JSON')
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'invalid_request', `缺少字段 ${field}`)
  }
  return value
}

function sessionIdOf(raw) {
  let id
  try {
    id = decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'invalid_request', '路径参数编码错误')
  }
  if (!SESSION_ID_PATTERN.test(id)) throw new HttpError(400, 'invalid_request', 'sessionId 只允许字母、数字和 _.:-，最长 128')
  return id
}

function scheduleIdOf(raw) {
  const id = segmentOf(raw)
  if (!SCHEDULE_ID_PATTERN.test(id)) throw new HttpError(400, 'invalid_request', 'scheduleId 只允许字母、数字和 _.:-，最长 128')
  return id
}

/** 回答校验不通过统一成 400 invalid_answer，原因写进 message（业务服务只记日志，不给用户看）。 */
function validated(check) {
  try {
    return check()
  } catch (error) {
    if (error instanceof AnswerError) throw new HttpError(400, 'invalid_answer', error.message)
    throw error
  }
}

function segmentOf(raw) {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'invalid_request', '路径参数编码错误')
  }
}

/**
 * 业务服务在请求头里声明的调用者：两个头都在 = 某个人的「我的任务」，两个都不在 = 管理端全量读，只给一个是不完整的。
 * @returns {import('./multi-user/caller.mjs').Owner | undefined}
 */
function callerOwnerOf(headers) {
  const field = (header) => {
    const value = headers[header]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
      throw new HttpError(400, 'invalid_request', `${header} 必须是 1 到 128 个字符的字符串`)
    }
    return value
  }
  const workspaceId = field(OWNER_WORKSPACE_HEADER)
  const userId = field(OWNER_USER_HEADER)
  if (workspaceId === undefined && userId === undefined) return undefined
  if (workspaceId === undefined || userId === undefined) throw new HttpError(400, 'invalid_request', '调用者身份不完整')
  return { workspaceId, userId }
}

function policyOf(raw) {
  if (raw === undefined) return {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new HttpError(400, 'invalid_request', 'policy 必须是对象')
  const policy = {}
  if (raw.deny !== undefined) {
    if (!Array.isArray(raw.deny) || raw.deny.some(n => typeof n !== 'string')) throw new HttpError(400, 'invalid_request', 'policy.deny 必须是字符串数组')
    policy.deny = [...raw.deny]
  }
  if (raw.gate !== undefined) {
    const { requiredTool, maxNudges } = raw.gate ?? {}
    if (requiredTool !== undefined) requireString(requiredTool, 'policy.gate.requiredTool')
    if (maxNudges !== undefined && !(Number.isInteger(maxNudges) && maxNudges >= 0 && maxNudges <= 5)) {
      throw new HttpError(400, 'invalid_request', 'policy.gate.maxNudges 必须是 0 到 5 的整数')
    }
    policy.gate = { ...(requiredTool === undefined ? {} : { requiredTool }), ...(maxNudges === undefined ? {} : { maxNudges }) }
  }
  return policy
}

/** 回调令牌：工具桥（受众 tools）与技能提供方（受众 skills）各一个，业务服务签发。宿主只转交，不解读。 */
function accessOf(raw, field) {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new HttpError(400, 'invalid_request', `${field} 必须是对象`)
  return { token: toolTokenOf(raw.token, `${field}.token`) }
}

/** 这段对话的属主（空间、人），业务服务给的；宿主只拿它记录、比对属主级资源的归属，不据此判权限。 */
function ownerOf(raw) {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new HttpError(400, 'invalid_request', 'owner 必须是对象')
  const pick = field => {
    const value = raw[field]
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
      throw new HttpError(400, 'invalid_request', `owner.${field} 必须是 1 到 128 个字符的字符串`)
    }
    return value
  }
  return { workspaceId: pick('workspaceId'), userId: pick('userId') }
}

function toolTokenOf(value, field) {
  requireString(value, field)
  if (value.length < 32 || value.length > 4096) throw new HttpError(400, 'invalid_request', `${field} 长度不合法`)
  return value
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ host?: string, port?: number, token?: string, provider?: string, model?: string, modelTokenRef?: string,
 *   idleMinutes?: number }} [config]
 */
export function apply(ctx, config) {
  config ??= {}
  const log = ctx.logger
  const token = config.token ?? process.env.KNOWWORK_HOST_TOKEN
  if (typeof token !== 'string' || token.length < 32) {
    throw new Error('knowwork-http-host: 需要至少 32 个字符的宿主令牌（KNOWWORK_HOST_TOKEN）')
  }
  const tokenDigest = digest(token)
  const host = config.host ?? '127.0.0.1'
  const port = config.port ?? Number(process.env.KNOWWORK_HOST_PORT ?? 0)
  const agentOptions = {
    provider: config.provider ?? process.env.KNOWWORK_MODEL_PROVIDER ?? 'knowwork-gateway',
    model: config.model ?? process.env.KNOWWORK_MODEL ?? 'default',
  }
  const modelTokenRef = config.modelTokenRef ?? process.env.KNOWWORK_MODEL_TOKEN_REF ?? 'KNOWWORK_MODEL_TOKEN'
  // 消息没带用户时区时用它（见 message-source.mjs）
  const fallbackTimeZone = deploymentTimeZone()

  /** @type {Map<string, import('@deepseek-ai/dsh-agent').AgentHandle>} */
  const handles = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const opening = new Map()
  const closing = new Set()
  let shuttingDown = false
  const idleMs = idleMsOf(config.idleMinutes ?? process.env.KNOWWORK_HOST_SESSION_IDLE_MINUTES)
  const idle = createIdleTracker(idleMs)

  ctx.on('session/event', (session, event) => {
    publish(String(session.id), 'session/event', event)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = String(agent.session.id)
    if (handles.has(sessionId)) idle.touch(sessionId)  // 一轮跑完（变成空闲）从这一刻起算
    publish(sessionId, 'agent/status', { status })
  })
  // 逐字输出：官方 dsh-agent-loop 的 agent/assistant-stream（官方会话接口 dsh-api-session-controller、
  // 命令行运行 dsh-headless 都订阅它出字）。转正文片段，和模型开始写某个工具调用时的工具名，作为临时帧推给当前订阅方；
  // 这一步的正式消息照常落成会话事件，业务服务拿它整段替换。子 Agent 的会话不是宿主打开的，查不到就丢。
  const announced = new Map() // 每次输出里已经报过名字的工具调用（attemptId → 序号）：参数片段很多，名字只报一次
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const data = liveFrame(frame, announced)
    if (data !== undefined) publishLive(String(agent.session.id), 'assistant/stream', data)
  }, { global: true })

  function liveAgent(sessionId) {
    const handle = handles.get(sessionId)
    if (closing.has(sessionId) || handle === undefined || ctx.agents.get(handle.agent.id) !== handle.agent) {
      throw new HttpError(404, 'session_not_found', `会话不存在或已释放：${sessionId}`)
    }
    return handle.agent
  }

  async function openSession(body) {
    if (shuttingDown) throw new HttpError(503, 'shutting_down', '宿主正在关闭')
    const sessionId = sessionIdOf(requireString(body.sessionId, 'sessionId'))
    const resume = body.resume === true
    if (resume && body.policy === undefined) {
      throw new HttpError(400, 'policy_required', '恢复会话必须重新给出 policy，宿主不保存策略')
    }
    if (handles.has(sessionId) || opening.has(sessionId) || closing.has(sessionId) || getSession(sessionId) !== undefined) {
      throw new HttpError(409, 'session_busy', `会话已打开、正在打开或正在释放：${sessionId}`)
    }
    const policy = policyOf(body.policy)
    const toolAccess = accessOf(body.tools, 'tools')
    const skillAccess = accessOf(body.skills, 'skills')
    const owner = ownerOf(body.owner)
    const state = createSession(sessionId, policy)
    state.toolAccess = toolAccess
    state.skillAccess = skillAccess
    state.owner = owner
    const id = brandString(sessionId)
    const task = resume
      ? ctx.agents.resume({ resumeSessionId: id, agentOptions })
      : ctx.agents.create({ sessionId: id, meta: { cwd: sessionRoot(sessionId) }, agentOptions })
    opening.set(sessionId, task)
    try {
      const handle = await task
      handles.set(sessionId, handle)
      state.agent = handle.agent
      idle.touch(sessionId)
      return { sessionId, status: handle.agent.status, epoch: EPOCH }
    } catch (error) {
      dropSession(state)
      log.warn('open session %s failed: %s', sessionId, error instanceof Error ? error.stack : String(error))
      throw new HttpError(400, 'session_open_failed', '会话打开失败，详情见宿主日志')
    } finally {
      opening.delete(sessionId)
    }
  }

  function sendMessage(sessionId, body) {
    const agent = liveAgent(sessionId)
    const text = requireString(body.text, 'text')
    const mode = body.mode ?? 'followup'
    if (mode !== 'followup' && mode !== 'steer') throw new HttpError(400, 'invalid_request', 'mode 只能是 followup 或 steer')
    const language = body.language
    if (language !== undefined && language !== 'zh' && language !== 'en') {
      throw new HttpError(400, 'invalid_request', 'language 只能是 zh 或 en')
    }
    const answerMode = body.answerMode ?? 'agent'
    if (typeof answerMode !== 'string' || !MODE_PATTERN.test(answerMode)) {
      throw new HttpError(400, 'invalid_request', 'answerMode 格式不对')
    }
    // 扩展登记的回答方式随消息带上放行的官方工具与指令（answer-mode）；内置的两种宿主自己认得
    let answerModeSpec
    if (!BUILT_IN_MODES.has(answerMode)) {
      try {
        answerModeSpec = answerModeSpecOf(body.answerModeSpec)
      } catch (error) {
        throw new HttpError(400, 'invalid_request', error.message)
      }
    }
    let files
    let knowledge
    let mentions
    let context
    try {
      files = attachmentsOf(body.attachments)
      knowledge = catalogOf(body.knowledge)
      mentions = mentionsOf(body.mentions)
      context = turnContextOf(body.context)
    } catch (error) {
      throw new HttpError(400, 'invalid_request', error.message)
    }
    const state = getSession(sessionId)
    if (state !== undefined && language !== undefined) state.language = language
    if (state !== undefined && knowledge !== undefined) state.knowledgeCatalog = knowledge
    const content = [{ type: 'text', text }, ...attachmentBlocks(files), ...mentionBlocks(mentions)]
    const source = userSource(body.timeZone, fallbackTimeZone)
    if (state !== undefined) state.timeZone = source.clientTimeZone
    const message = createUserMessage({ content, source })
    // 回答方式等这条消息进入步骤时才生效（answer-mode）：排队到下一轮的消息不改正在跑的这一轮
    state?.answerModes.set(String(message.id), { mode: answerMode, spec: answerModeSpec })
    receiveTurnContext(state, message.id, context)
    if (mode === 'steer') agent.steer(message)
    else agent.followup(message)
    return { messageId: message.id, mode }
  }

  async function cancel(sessionId) {
    const agent = liveAgent(sessionId)
    agent.cancel({ kind: 'user' })
    let timer
    const settled = await Promise.race([
      agent.whenIdle().then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), CANCEL_SETTLE_MS) }),
    ])
    clearTimeout(timer)
    return { settled, status: agent.status }
  }

  async function dispose(sessionId) {
    if (closing.has(sessionId)) throw new HttpError(409, 'session_busy', `会话正在释放：${sessionId}`)
    const handle = handles.get(sessionId)
    if (handle === undefined) throw new HttpError(404, 'session_not_found', `会话不存在：${sessionId}`)
    closing.add(sessionId)
    const state = getSession(sessionId)
    try {
      // 先结算待决审批、结束事件流，再释放 agent；否则释放会等一个最长 30 分钟的审批。
      if (state !== undefined) dropSession(state)
      handles.delete(sessionId)
      idle.forget(sessionId)
      await handle.dispose()
      return { disposed: true }
    } finally {
      closing.delete(sessionId)
    }
  }

  function streamEvents(sessionId, url, req, res) {
    const state = getSession(sessionId)
    if (state === undefined || closing.has(sessionId)) throw new HttpError(404, 'session_not_found', `会话不存在：${sessionId}`)
    const epoch = url.searchParams.get('epoch')
    if (epoch !== null && epoch !== EPOCH) throw new HttpError(410, 'epoch_mismatch', '宿主已重启，游标失效，请从头读取')
    if (state.subscribers.size >= MAX_SUBSCRIBERS_PER_SESSION) throw new HttpError(429, 'too_many_subscribers', '订阅过多')
    const afterRaw = Number(url.searchParams.get('after') ?? 0)
    const after = Number.isSafeInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0

    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
    const line = frame => res.write(`${JSON.stringify(frame)}\n`)
    const oldest = oldestCursor(state)
    if (after > 0 && oldest !== undefined && after < oldest - 1) {
      line({ epoch: EPOCH, cursor: oldest - 1, kind: 'gap', time: Date.now(), data: { after, oldest } })
    }
    for (const frame of framesAfter(state, after)) line(frame)

    let ended = false
    // 一帧可能比 socket 的写缓冲还大：res.write 返回 false 只表示这一帧还在排队，不代表订阅方已经断开。
    // 拿它当断开处理会在「请求头」这类大帧之后把事件流整个掐掉，所以只在连接真的没了时才结束。
    const alive = () => !res.writableEnded && !res.destroyed
    const subscriber = {
      write: frame => {
        if (ended) return true
        if (!alive()) {
          subscriber.end()
          return false
        }
        line(frame)
        return true
      },
      end: () => {
        if (ended) return
        ended = true
        clearInterval(heartbeat)
        state.subscribers.delete(subscriber)
        if (alive()) res.end()
      },
    }
    const heartbeat = setInterval(() => { if (alive()) res.write('\n'); else subscriber.end() }, HEARTBEAT_MS)
    state.subscribers.add(subscriber)
    req.on('close', () => subscriber.end())
  }

  /** 模型网关短期令牌轮换：写入官方凭据服务，下一次模型请求即使用新值。 */
  async function rotateModelCredential(body) {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw new HttpError(503, 'credentials_unavailable', '宿主没有挂载凭据服务')
    const value = requireString(body.token, 'token')
    if (value.length < 16 || value.length > 4096) throw new HttpError(400, 'invalid_request', 'token 长度不合法')
    await credentials.set(credentialRef(modelTokenRef), value)
    return { rotated: true }
  }

  /**
   * 回调令牌续期：只对已带令牌打开的会话生效，下一次工具调用或技能加载即使用新值。
   * @param {'toolAccess' | 'skillAccess'} slot
   */
  function rotateAccess(sessionId, body, slot) {
    const state = getSession(sessionId)
    if (state === undefined || closing.has(sessionId)) throw new HttpError(404, 'session_not_found', `会话不存在：${sessionId}`)
    if (state[slot] === undefined) {
      throw slot === 'toolAccess'
        ? new HttpError(409, 'tools_not_enabled', '该会话打开时没有启用工具桥')
        : new HttpError(409, 'skills_not_enabled', '该会话打开时没有启用技能')
    }
    state[slot] = { token: toolTokenOf(body.token, 'token') }
    return { rotated: true }
  }

  function listApprovals(sessionId) {
    const state = getSession(sessionId)
    if (state === undefined) throw new HttpError(404, 'session_not_found', `会话不存在：${sessionId}`)
    return [...state.approvals.values()].map(({ id, sessionId: from, toolName, callId, reason }) => ({ id, sessionId: from, toolName, callId, reason }))
  }

  function decide(sessionId, approvalId, body) {
    const pending = getSession(sessionId)?.approvals.get(approvalId)
    if (pending === undefined) throw new HttpError(404, 'approval_not_found', `审批不存在或已结束：${approvalId}`)
    const outcome = body.outcome
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      throw new HttpError(400, 'invalid_request', 'outcome 只能是 allowed-once 或 rejected')
    }
    pending.resolve(outcome)
    return { approvalId, outcome }
  }

  /** 官方 userQuestions 投影里本会话还能回答、但已不在前台等待的问题（等待到期、或宿主重启前没答完）。 */
  function continuedQuestions(agent) {
    const view = ctx.get('sessionProjections')?.stateOf(agent.session, 'userQuestions')
    return (view?.questions.active ?? []).filter(question => question.state === 'continued')
  }

  /** 待答问题：前台等待中的（open）在前，已转入 continued 的在后。会话没在运行时只看得到前者。 */
  function listQuestions(sessionId) {
    const state = getSession(sessionId)
    if (state === undefined) throw new HttpError(404, 'session_not_found', `会话不存在：${sessionId}`)
    const open = [...state.questions.values()].map(({ id, sessionId: from, questions, timed }) => ({ id, sessionId: from, questions, timed, state: 'open' }))
    const handle = handles.get(sessionId)
    const continued = handle === undefined ? [] : continuedQuestions(handle.agent)
      .filter(question => !state.questions.has(String(question.callId)))
      .map(question => ({ id: String(question.callId), sessionId, questions: question.questions, timed: true, state: 'continued' }))
    return [...open, ...continued]
  }

  /**
   * 提交回答。前台等待中的问题直接交回；已转入 continued 的经官方 `userQuestions.answer` 以
   * user-question-reply 消息送回 agent（空闲时会开新一轮）。
   */
  function answerQuestion(sessionId, questionId, body) {
    const answer = validated(() => parseAnswer(body))
    const pending = getSession(sessionId)?.questions.get(questionId)
    if (pending !== undefined) {
      validated(() => checkAnswer(pending.questions, answer))
      pending.answer(answer)
      return { questionId, state: 'answered' }
    }
    const agent = liveAgent(sessionId)
    const service = ctx.get('userQuestions')
    const question = continuedQuestions(agent).find(item => String(item.callId) === questionId)
    if (service === undefined || question === undefined) {
      throw new HttpError(404, 'question_not_found', `问题不存在或已结束：${questionId}`)
    }
    validated(() => checkAnswer(question.questions, answer))
    let accepted
    try {
      accepted = service.answer(agent, question.callId, answer)
    } catch (error) {
      if (error?.code === 'REPLY_QUEUED') throw new HttpError(409, 'reply_queued', '这个问题的回答已在排队，等 Agent 接收')
      if (error?.code === 'BAD_ANSWER') throw new HttpError(400, 'invalid_answer', '每个问题都要有一条回答')
      throw error
    }
    if (!accepted) throw new HttpError(404, 'question_not_found', `问题不存在或已结束：${questionId}`)
    return { questionId, state: 'queued' }
  }

  /**
   * 宿主自带的技能：业务服务的「技能」页、@ 菜单与「公共与自带」页要列出来，业务服务自己不知道有哪些。
   * 自带技能按会话注册（bundled-skills），这里给的是全部，停用与同名由业务服务按空间算。
   */
  function bundledSkills() {
    return {
      skills: bundledCandidates().map(skill => ({
        name: skill.name,
        description: skill.description,
        userInvocable: skill.invocation.userInvocable,
      })),
    }
  }

  /**
   * 定时任务读侧：业务服务的「自动化」页要列「我的任务」、看单条、看投递记录，而任务存在宿主里的官方
   * schedule 服务，业务服务摸不到。这里只把三个读方法转出去（归属过滤在适配层 schedule.mjs 里，照调用者算）：
   * - 带调用者身份头的请求用 runAs 包住，官方服务的 list/guard 就只看这个人的；
   * - 不带身份头的是管理端全量读。
   * 增删改与立即运行留给之后（见 plan-2 的写侧路由）。
   */
  function scheduleService() {
    const service = ctx.get('schedule')
    if (service === undefined) throw new HttpError(503, 'schedule_unavailable', '宿主没有挂载定时任务服务')
    return service
  }

  /**
   * 本空间的定时任务条数：业务服务建任务前要先算这个空间已经有几条（上限 100），但不需要看到任何任务内容。
   * 因此这个分支只认空间头——不认用户头，也不按人过滤：数的是一个空间的总数。返回值里只有 total。
   */
  async function countSchedules(headers) {
    const workspaceId = headers[OWNER_WORKSPACE_HEADER]
    if (typeof workspaceId !== 'string' || workspaceId.length === 0 || workspaceId.length > 128) {
      throw new HttpError(400, 'invalid_request', `${OWNER_WORKSPACE_HEADER} 必须是 1 到 128 个字符的字符串`)
    }
    const owners = ctx.get('knowworkOwners')
    if (owners === undefined) throw new HttpError(503, 'schedule_unavailable', '宿主没有挂载属主账本')
    const all = await scheduleService().catalog()
    const total = all.filter(entry => owners.ownerOf('schedule', entry.id)?.workspaceId === workspaceId).length
    return { total }
  }

  /** 官方「找不到」的样子（{id, code:'schedule_not_found'}）在这里就是 404；归属不对时适配层也回这个。 */
  function found(result) {
    if (result?.code === 'schedule_not_found') throw new HttpError(404, 'schedule_not_found', '没有这个定时任务')
    return result
  }

  /** 有调用者身份就按他跑（适配层据此过滤）——没有就是管理端全量读。 */
  async function asCaller(owner, fn) {
    try {
      return await (owner === undefined ? fn() : runAs({ owner }, fn))
    } catch (error) {
      // 官方的输入校验（limit、offset、rrule、target 不合规）是请求本身不合规，不是宿主出错。
      // 直接调的方法抛 ScheduleInputError，远程方法把它包成 code 为 schedule/input-invalid 的 RemoteError
      if (error instanceof Error && (error.name === 'ScheduleInputError' || error.code === REMOTE_INPUT_INVALID)) {
        throw new HttpError(400, 'invalid_request', error.message)
      }
      throw error
    }
  }

  /**
   * 全量读（没有调用者身份，也就是管理端在审计整个宿主）时每条任务要带上归属：业务服务只认空间，
   * 拿不到归属就没法只列本空间的任务。归属问属主账本，取不到就记 null（账本里没有的任务不编造属主）。
   * 带身份头的个人列表不加这个字段：适配层已经只回他自己的，多一个 owner 反而把内部账本泄漏给页面。
   */
  async function listSchedules(owner, url) {
    const query = url.searchParams
    const limit = query.get('limit')
    const offset = query.get('offset')
    const active = query.get('active')
    const page = await asCaller(owner, () => scheduleService().remoteList({
      ...(limit === null ? {} : { limit: Number(limit) }),
      ...(offset === null ? {} : { offset: Number(offset) }),
      ...(active === null ? {} : { active: active === 'true' }),
    }))
    if (owner !== undefined) return page
    const owners = ctx.get('knowworkOwners')
    if (owners === undefined) throw new HttpError(503, 'schedule_unavailable', '宿主没有挂载属主账本')
    return { ...page, items: page.items.map(entry => ({ ...entry, owner: owners.ownerOf('schedule', entry.id) ?? null })) }
  }

  function viewSchedule(owner, id) {
    return asCaller(owner, () => scheduleService().view({ id })).then(found)
  }

  /** 先判归属再看投递记录：别人的任务连记录条数都不该问得出来。 */
  async function scheduleHistory(owner, id, url) {
    await viewSchedule(owner, id)
    const limit = Number(url.searchParams.get('limit') ?? 20)
    const before = url.searchParams.get('before')
    return asCaller(owner, () => scheduleService().history({ id, limit, ...(before === null ? {} : { before }) }))
      .then(found)
  }

  /**
   * 定时任务写侧：建、改、删、立即运行。四个都直接转官方的远程方法，归属仍是适配层的事（runAs 之后
   * create/edit/run 都先过 guard），这里只把官方的结果码翻成 HTTP：
   * - schedule_not_found → 404（不是调用者的任务，适配层也回这个）；
   * - schedule_conflict → 409（带 expectedUpdatedAt 时任务刚被别人改过）；
   * - schedule_execution_pending → 409（这个任务正在运行或排队）。
   * 写侧必须带调用者身份：没身份就建得出无处归属的任务，所以缺了直接 400。
   */
  function writerOf(req) {
    const owner = callerOwnerOf(req.headers)
    if (owner === undefined) throw new HttpError(400, 'invalid_request', '写定时任务要在请求头里带上调用者身份')
    return owner
  }

  /**
   * 页面建「每次新建对话」的任务时带的是业务服务铸的属主令牌：建之前先校验，令牌不对、或令牌里的属主不是这次调用者，
   * 当场拒绝——不能把一条到点必然建不出对话的半成品任务留在调度器里。
   * @param {any} body 请求体
   * @param {import('./multi-user/caller.mjs').Owner} caller 这次调用者
   */
  function verifiedTarget(body, caller) {
    const target = body?.target
    if (target === undefined || target === null || typeof target !== 'object') return
    if (target.kind !== 'new' && target.kind !== 'new_once') return
    const preset = target.create?.agentPreset
    if (typeof preset !== 'string' || preset.length === 0) {
      throw new HttpError(400, 'invalid_request', '每次新建对话的定时任务必须带属主令牌（target.create.agentPreset）')
    }
    const owner = ownerOfToken(preset, token)
    if (owner === undefined) throw new HttpError(400, 'invalid_request', '定时任务的属主令牌不对，拒绝建这条任务')
    if (!sameOwner(owner, caller)) throw new HttpError(400, 'invalid_request', '定时任务的属主令牌不是这个人的，拒绝建这条任务')
  }

  function settled(result) {
    if (result?.code === 'schedule_conflict') throw new HttpError(409, 'schedule_conflict', '任务刚被改过，请刷新后再改')
    if (result?.code === 'schedule_execution_pending') throw new HttpError(409, 'schedule_execution_pending', '这个任务正在运行或排队，等它结束再试')
    return found(result)
  }

  /**
   * 「预留了会话 id」的任务（new_once）在官方 create 时就定下了那段对话的 id，到点先按这个 id 找宿主上有没有活会话，
   * 没有才走建会话。建会话得靠业务服务（后台对话、只读配置都在业务服务那边），所以这里建任务时就把对话建出来：
   * 到点直接投递，不会留一条到点才发现建不出对话的半成品任务。建不出来就把刚建的任务删掉再报错。
   */
  async function materialize(created, body, owner) {
    if (created?.target?.kind !== 'new_once') return
    const sessionId = created.target.sessionId
    const controller = ctx.get('sessionController')
    if (typeof sessionId !== 'string' || controller === undefined) return
    try {
      await controller.create({ sessionId, agentPreset: body.target.create.agentPreset })
    } catch (error) {
      log.error('schedule %s could not materialize Session %s: %s', created.id, sessionId, String(error))
      await asCaller(owner, () => scheduleService().remoteEdit({ id: created.id, action: 'delete' })).catch(() => {})
      throw new HttpError(400, 'invalid_request', '业务服务没有建出这次自动化的对话，任务没有留下，请稍后再建')
    }
  }

  /**
   * 请求体原样交给官方：title、prompt、timing、target 的校验都在官方 create 里，不合规抛 ScheduleInputError。
   * 只多了属主令牌这一道：官方不认识它，是 KnowWork 自己往 target.create.agentPreset 里放的。
   */
  async function createSchedule(owner, body) {
    verifiedTarget(body, owner)
    const created = await asCaller(owner, () => scheduleService().remoteCreate(body)).then(settled)
    await materialize(created, body, owner)
    return created
  }

  function editSchedule(owner, id, body, action) {
    const patch = body.patch
    if (action === 'update' && (patch === undefined || typeof patch !== 'object' || patch === null || Array.isArray(patch))) {
      throw new HttpError(400, 'invalid_request', '缺少字段 patch')
    }
    // 改投递目标时同样要过属主令牌：换成「每次新建对话」却没带对令牌，改完到点也建不出对话
    if (action === 'update') verifiedTarget({ target: patch.target }, owner)
    const request = {
      id,
      action,
      ...(action === 'update' ? { patch } : {}),
      ...(body.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: body.expectedUpdatedAt }),
    }
    return asCaller(owner, () => scheduleService().remoteEdit(request)).then(settled)
  }

  function runSchedule(owner, id) {
    return asCaller(owner, () => scheduleService().run({ id })).then(settled)
  }

  /**
   * 管理端停用：业务服务确认过调用者是空间管理员之后，带着 x-knowwork-admin-workspace 来停一条任务。
   * 这里不按调用者跑（管理端没有「某个人」的身份），所以适配层不会替我们校验归属——空间必须在这里自己判：
   * 任务属主不是这个空间的，一律当「没有这个任务」，不能凭管理员身份停到别人空间去。
   * 管理端只做停用一件事：patch 必须恰好是 {active:false}，其余字段（标题、内容、目标、重新启用）都不接受。
   */
  async function disableScheduleForAdmin(headers, id, body) {
    const workspaceId = headers[ADMIN_WORKSPACE_HEADER]
    if (typeof workspaceId !== 'string' || workspaceId.length === 0 || workspaceId.length > 128) {
      throw new HttpError(400, 'invalid_request', `${ADMIN_WORKSPACE_HEADER} 必须是 1 到 128 个字符的字符串`)
    }
    const patch = body?.patch
    const keys = patch === undefined || patch === null || typeof patch !== 'object' || Array.isArray(patch) ? [] : Object.keys(patch)
    if (patch?.active !== false || keys.length !== 1) {
      throw new HttpError(400, 'invalid_request', '管理端只能停用任务（请求体必须是 {"patch":{"active":false}}）')
    }
    const owners = ctx.get('knowworkOwners')
    if (owners === undefined) throw new HttpError(503, 'schedule_unavailable', '宿主没有挂载属主账本')
    if (owners.ownerOf('schedule', id)?.workspaceId !== workspaceId) throw new HttpError(404, 'schedule_not_found', '没有这个定时任务')
    return scheduleService().remoteEdit({ id, action: 'update', patch: { active: false } }).then(settled)
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://host')
    const path = url.pathname
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: !shuttingDown, epoch: EPOCH, dsh: DSH_VERSION })
    if (!tokenMatches(tokenDigest, req.headers.authorization)) throw new HttpError(401, 'unauthorized', '令牌无效')

    if (req.method === 'POST' && path === '/v1/sessions') return send(res, 201, await openSession(await readJson(req)))
    if (req.method === 'PUT' && path === '/v1/model-credential') return send(res, 200, await rotateModelCredential(await readJson(req)))
    if (req.method === 'GET' && path === '/v1/skills/bundled') return send(res, 200, bundledSkills())

    // 只数条数：只认空间头，不认用户头，也不回任何任务内容
    if (req.method === 'GET' && path === '/v1/schedule' && url.searchParams.get('countOnly') === 'true') {
      return send(res, 200, await countSchedules(req.headers))
    }

    // 定时任务读侧：GET /v1/schedule、GET /v1/schedule/{id}、GET /v1/schedule/{id}/history
    if (req.method === 'GET' && (path === '/v1/schedule' || path.startsWith('/v1/schedule/'))) {
      const owner = callerOwnerOf(req.headers)
      if (path === '/v1/schedule') return send(res, 200, await listSchedules(owner, url))
      const [rawId, action, extra] = path.slice('/v1/schedule/'.length).split('/')
      if (rawId === undefined || rawId === '') throw new HttpError(404, 'not_found', '路径不存在')
      const scheduleId = scheduleIdOf(rawId)
      if (action === undefined) return send(res, 200, await viewSchedule(owner, scheduleId))
      if (action === 'history' && extra === undefined) return send(res, 200, await scheduleHistory(owner, scheduleId, url))
      throw new HttpError(404, 'not_found', '路径不存在')
    }

    // 管理端停用：只认一个「停哪个空间的任务」的头，不带也不看调用者身份头（管理端代表空间，不代表某个人）。
    // 必须排在写侧 writerOf 之前：管理端请求没有调用者身份，走普通写侧会被当成缺身份 400。
    if (req.method === 'PATCH' && req.headers[ADMIN_WORKSPACE_HEADER] !== undefined
      && path.startsWith('/v1/schedule/')) {
      const [rawId, action, extra] = path.slice('/v1/schedule/'.length).split('/')
      if (rawId === undefined || rawId === '' || action !== undefined || extra !== undefined) {
        throw new HttpError(404, 'not_found', '路径不存在')
      }
      return send(res, 200, await disableScheduleForAdmin(req.headers, scheduleIdOf(rawId), await readJson(req)))
    }

    // 定时任务写侧：POST /v1/schedule、PATCH /v1/schedule/{id}、DELETE /v1/schedule/{id}、POST /v1/schedule/{id}/run
    if (req.method !== 'GET' && (path === '/v1/schedule' || path.startsWith('/v1/schedule/'))) {
      const owner = writerOf(req)
      if (path === '/v1/schedule') {
        if (req.method !== 'POST') throw new HttpError(404, 'not_found', '路径不存在')
        return send(res, 201, await createSchedule(owner, await readJson(req)))
      }
      const [rawId, action, extra] = path.slice('/v1/schedule/'.length).split('/')
      if (rawId === undefined || rawId === '' || extra !== undefined) throw new HttpError(404, 'not_found', '路径不存在')
      const scheduleId = scheduleIdOf(rawId)
      if (action === undefined && req.method === 'PATCH') return send(res, 200, await editSchedule(owner, scheduleId, await readJson(req), 'update'))
      // 删除只需要 id 与（可选的）expectedUpdatedAt，不用 patch
      if (action === undefined && req.method === 'DELETE') return send(res, 200, await editSchedule(owner, scheduleId, await readJson(req), 'delete'))
      if (action === 'run' && req.method === 'POST') return send(res, 202, await runSchedule(owner, scheduleId))
      throw new HttpError(404, 'not_found', '路径不存在')
    }

    const match = /^\/v1\/sessions\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(path)
    if (match === null) throw new HttpError(404, 'not_found', '路径不存在')
    const sessionId = sessionIdOf(match[1])
    const action = match[2]
    const sub = match[3]
    // 业务服务定期续签令牌、查状态不算活动：否则会话永远不空闲
    if (handles.has(sessionId) && !CREDENTIAL_ACTIONS.has(action) && !(req.method === 'GET' && action === undefined)) {
      idle.touch(sessionId)
    }

    if (req.method === 'DELETE' && action === undefined) return send(res, 200, await dispose(sessionId))
    if (req.method === 'GET' && action === undefined) return send(res, 200, { sessionId, status: liveAgent(sessionId).status })
    if (req.method === 'POST' && action === 'messages') return send(res, 202, sendMessage(sessionId, await readJson(req)))
    if (req.method === 'POST' && action === 'cancel') return send(res, 200, await cancel(sessionId))
    if (req.method === 'PUT' && action === 'tool-credential') return send(res, 200, rotateAccess(sessionId, await readJson(req), 'toolAccess'))
    if (req.method === 'PUT' && action === 'skill-credential') return send(res, 200, rotateAccess(sessionId, await readJson(req), 'skillAccess'))
    if (req.method === 'GET' && action === 'events') return streamEvents(sessionId, url, req, res)
    if (req.method === 'GET' && action === 'approvals' && sub === undefined) return send(res, 200, listApprovals(sessionId))
    if (req.method === 'POST' && action === 'approvals' && sub !== undefined) {
      return send(res, 200, decide(sessionId, segmentOf(sub), await readJson(req)))
    }
    if (req.method === 'GET' && action === 'questions' && sub === undefined) return send(res, 200, listQuestions(sessionId))
    if (req.method === 'POST' && action === 'questions' && sub !== undefined) {
      return send(res, 200, answerQuestion(sessionId, segmentOf(sub), await readJson(req)))
    }
    throw new HttpError(404, 'not_found', '路径不存在')
  }

  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      if (!(error instanceof HttpError)) log.error('request %s %s failed: %s', req.method, req.url, error instanceof Error ? error.stack : String(error))
      const status = error instanceof HttpError ? error.status : 500
      const code = error instanceof HttpError ? error.code : 'internal'
      const message = error instanceof HttpError ? error.message : '宿主内部错误'
      if (!res.headersSent) send(res, status, { error: { code, message } })
      else res.end()
    })
  })
  server.on('error', error => {
    log.error('http server error: %s', error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })

  /** 释放空闲会话：一次一个，出错只记日志（下一轮再试）。 */
  async function sweepIdle() {
    if (shuttingDown) return
    const jobs = ctx.get('jobs')
    for (const [sessionId, handle] of [...handles]) {
      if (opening.has(sessionId) || closing.has(sessionId) || !idle.due(sessionId)) continue
      if (!releasable(handle.agent, getSession(sessionId), jobs)) continue
      try {
        await dispose(sessionId)
        log.info('session %s idle for %d min; released (reopens on the next message)', sessionId, Math.round(idleMs / 60_000))
      } catch (error) {
        log.warn('release idle session %s failed: %s', sessionId, error instanceof Error ? error.message : String(error))
      }
    }
  }

  ctx.effect(() => {
    if (idleMs === 0) return () => {}
    let sweeping = false
    const timer = setInterval(() => {
      if (sweeping) return
      sweeping = true
      sweepIdle().finally(() => { sweeping = false })
    }, sweepMsOf(idleMs))
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'knowwork.http-host.idle-sweep')

  ctx.effect(() => {
    // 照官方就绪边界：整棵插件树（会话策略、技能门、审批应答者等监听）挂好之后才对外服务。
    const ready = (async () => {
      await ctx.get('loader')?.await()
      if (shuttingDown) return
      await new Promise(resolve => server.listen(port, host, resolve))
      const address = server.address()
      const bound = typeof address === 'object' && address ? address.port : port
      process.stdout.write(`${JSON.stringify({ knowworkHostReady: true, host, port: bound, epoch: EPOCH })}\n`)
    })().catch(error => {
      log.error('host failed to start: %s', error instanceof Error ? error.stack : String(error))
      process.exitCode = 1
    })

    return async () => {
      // 照官方关闭顺序：拒新请求 → 等正在打开的会话 → 排空子 Agent → 释放 → 清状态。
      shuttingDown = true
      await ready
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(() => resolve(undefined)))
      await Promise.allSettled([...opening.values()])
      const live = [...handles.entries()]
      handles.clear()
      await Promise.allSettled([ctx.get('subagents')?.drainDescendants(live.map(([, h]) => h.agent))])
      for (const [sessionId] of live) {
        const state = getSession(sessionId)
        if (state !== undefined) dropSession(state)
      }
      await Promise.allSettled(live.map(([, handle]) => handle.dispose()))
    }
  }, 'knowwork.http-host')
}

/**
 * 官方逐字帧 → 转给业务服务的样子：开始（带轮次、步）、正文片段、开始写某个工具调用（只报一次工具名）、结束。
 * 思考与工具参数的片段不转：模型把整个文件写进 write 的参数时要好十几秒，这期间页面只能写「思考中」、点开什么都没有，
 * 看着像卡住了；报一次工具名，页面就能写「正在写文件」。参数本身不转（量大，半截的参数也没法给人看）。
 * @param {{ type: string, attemptId?: string, turn?: number, step?: number,
 *   chunk?: { type: string, text?: string, index?: number, name?: string } }} frame
 * @param {Map<string, Set<number>>} announced
 */
export function liveFrame(frame, announced) {
  if (frame.type === 'start') return { type: 'start', attemptId: frame.attemptId, turn: frame.turn, step: frame.step }
  if (frame.type === 'end') {
    announced.delete(frame.attemptId)
    return { type: 'end', attemptId: frame.attemptId }
  }
  const chunk = frame.type === 'chunk' ? frame.chunk : undefined
  if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
    return { type: 'text', attemptId: frame.attemptId, text: chunk.text }
  }
  if (chunk?.type === 'tool-call-delta' && typeof chunk.name === 'string' && chunk.name) {
    const seen = announced.get(frame.attemptId) ?? new Set()
    if (seen.has(chunk.index)) return undefined
    announced.set(frame.attemptId, seen.add(chunk.index))
    return { type: 'tool', attemptId: frame.attemptId, name: chunk.name }
  }
  return undefined
}
