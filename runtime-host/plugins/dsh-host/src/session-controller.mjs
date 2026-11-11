/**
 * 会话创建能力：让宿主上的定时任务到点能新建一段对话。
 *
 * 官方 ScheduleService 建会话只认两件事：调 ctx.get('sessionController').create({sessionId, agentPreset?}) 建出会话，
 * 再走 schedule/resolve-agent 拿活 Agent。它自己只问「有没有这个服务」，所以这里把服务装上，同时决定「这段会话
 * 归谁」——官方那份 createSpec 只有 cwd 与 agentPreset，没有属主字段，属主只能编进 agentPreset 令牌：业务服务
 * 铸造（附带创建者的空间与人），宿主用 KNOWWORK_HOST_TOKEN 重算签名校验（multi-user/preset-token.mjs）。
 *
 * 建会话的顺序：先让业务服务按指定 id 建出后台对话（它同时把只读运行配置绑上、把归属写进库里），业务服务认下
 * 这段会话之后，才把属主记进宿主自己的账本。令牌不对、或业务服务说这个人不是这个空间的成员，就到此为止：
 * 一段会话都不建，一个属主都不记——不留半成品。
 */

import { getSession } from './state.mjs'
import { SESSION_ID_PATTERN, ownerOfToken } from './multi-user/preset-token.mjs'

export const name = 'knowwork-session-controller'

export const inject = ['agents']

const DEFAULT_BASE_URL = 'http://127.0.0.1:8001/internal/host/v1'
const TIMEOUT_MS = 30_000
// 对外固定的拒绝文案：令牌不对时不解释哪里不对
const DENIED = '定时任务的属主令牌不对，拒绝创建会话'

/** 业务服务的内部接口基地址：与激活用同一份配置（KNOWWORK_ACTIVATION_BASE_URL）。 */
function baseUrlOf(config) {
  const configured = config?.baseUrl ?? process.env.KNOWWORK_ACTIVATION_BASE_URL ?? DEFAULT_BASE_URL
  return String(configured).replace(/\/+$/, '')
}

/** 业务服务拒绝时的说法：优先用它给的 detail，取不到就用状态码。不往外带内部细节。 */
async function refusalOf(response) {
  let reason = ''
  try {
    const body = await response.json()
    const detail = body?.detail ?? body?.error?.message
    reason = typeof detail === 'string' ? detail : ''
  } catch {
    reason = ''
  }
  return reason === '' ? String(response.status) : `${response.status}：${reason.slice(0, 200)}`
}

async function post(url, token, body) {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.name : String(error)
    throw new Error(`业务服务没有连上（${reason}）：${url}`)
  }
}

export function apply(ctx, config) {
  const baseUrl = baseUrlOf(config)
  const tokenOf = () => config?.token ?? process.env.KNOWWORK_HOST_TOKEN
  const owners = () => ctx.get('knowworkOwners')

  /** 宿主上这段会话真的开着时给出它的活 Agent。 */
  function live(sessionId) {
    const agent = getSession(sessionId)?.agent
    return agent !== undefined && ctx.agents.get(agent.id) === agent ? agent : undefined
  }

  /**
   * 到点要新建一段对话：先请业务服务按这个 id 建后台对话并绑只读运行配置，再把属主记进账本。
   * @param {{ sessionId: string, cwd?: string, agentPreset?: string }} request 官方 createAgent 给的请求
   * @returns {Promise<{ sessionId: string }>}
   */
  async function create(request) {
    const hostToken = tokenOf()
    const owner = ownerOfToken(request?.agentPreset, hostToken)
    if (owner === undefined) throw new Error(DENIED)
    const sessionId = String(request?.sessionId ?? '')
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`会话 id 不合法，拒绝创建会话：${sessionId}`)
    const response = await post(`${baseUrl}/automation-conversations`, hostToken, {
      sessionId,
      owner: { workspaceId: owner.workspaceId, userId: owner.userId },
    })
    if (!response.ok) throw new Error(`业务服务没有建出自动化对话 ${sessionId}（${await refusalOf(response)}）`)
    owners()?.own('session', sessionId, owner)
    return { sessionId }
  }

  /**
   * 到点要用的活 Agent：宿主上有就用；没有（空闲释放、宿主重启过）就按账本里的属主请业务服务重开。
   * 官方把 { error } 当异常抛给投递方，投递据 code 决定是「这段会话还没建过」还是别的失败。
   * @param {string} sessionId
   */
  async function resolveAgent(sessionId) {
    const id = String(sessionId)
    const agent = live(id)
    if (agent !== undefined) return { agent }
    const hostToken = tokenOf()
    if (hostToken === undefined) return { error: { code: 'session/not-found', message: `会话 ${id} 没有打开：宿主令牌没有配置` } }
    const owner = owners()?.sessionOwner(id)
    if (owner === undefined) return { error: { code: 'session/not-found', message: `会话 ${id} 没有打开` } }
    const response = await post(`${baseUrl}/activations`, hostToken, { kind: 'schedule', sessionId: id, owner })
    if (!response.ok) {
      return { error: { code: 'session/not-found', message: `会话 ${id} 没有打开（${await refusalOf(response)}）` } }
    }
    const opened = live(id)
    if (opened === undefined) return { error: { code: 'session/not-found', message: `会话 ${id} 没有打开` } }
    return { agent: opened }
  }

  ctx.provide('sessionController', { create, resolveAgent })
}
