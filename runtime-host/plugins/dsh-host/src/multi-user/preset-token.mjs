/**
 * 自动化任务的属主令牌（agent preset 令牌）。
 *
 * 官方建会话的 createSpecSchema 只收 cwd 与 agentPreset 两样，没有属主字段：任务到点要新建对话时，宿主只知道
 * 「这个任务带了一串 agentPreset」。所以属主（哪个空间哪个人）就编进这串令牌里，随任务一起存：
 * `kwauto1.<base64url(JSON {"w": workspaceId, "u": userId})>.<base64url(hmac_sha256(host_token, 前两段))>`
 *
 * 令牌由业务服务铸造（server/.../automations/tokens.py，同一个算法），宿主只验证：用 KNOWWORK_HOST_TOKEN 重算
 * 签名比对。令牌不对就拒绝建会话——不能凭一串来路不明的字符串把会话开给某个人。
 * 每个任务一个令牌（即使同一个人建几百条也一样），随任务持久化，宿主重启后照样能用。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

const PREFIX = 'kwauto1'
const BASE64URL = /^[A-Za-z0-9_-]+$/

/** 会话 id 的取值范围（官方 SESSION_ID_PATTERN；宿主 HTTP 面同一份）。 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

function digestOf(hostToken, signed) {
  return createHmac('sha256', hostToken).update(signed).digest()
}

/** 解开一段 base64url；不是合法 base64url 或不是对象就返回 undefined。 */
function ownerOf(segment) {
  if (typeof segment !== 'string' || !BASE64URL.test(segment)) return undefined
  let payload
  try {
    payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof payload !== 'object' || payload === null) return undefined
  const { w, u } = payload
  if (typeof w !== 'string' || typeof u !== 'string' || w.length === 0 || u.length === 0) return undefined
  return { workspaceId: w, userId: u }
}

/**
 * 校验令牌并把属主编解码出来。
 * @param {unknown} token
 * @param {string | undefined} hostToken 宿主令牌（KNOWWORK_HOST_TOKEN）
 * @returns {{ workspaceId: string, userId: string } | undefined} 校验不过一律 undefined
 */
export function ownerOfToken(token, hostToken) {
  if (typeof token !== 'string' || typeof hostToken !== 'string' || hostToken.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX) return undefined
  const signed = `${parts[0]}.${parts[1]}`
  const expected = digestOf(hostToken, signed)
  const given = Buffer.from(parts[2], 'base64url')
  // 长度不同时 timingSafeEqual 会抛错；先判长度
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined
  return ownerOf(parts[1])
}

/** 铸一枚令牌（业务服务侧用同一算法；宿主侧自己只在测试与本地调式时用得到）。 */
export function mintToken(owner, hostToken) {
  const payload = Buffer.from(JSON.stringify({ w: owner.workspaceId, u: owner.userId }), 'utf8').toString('base64url')
  const signed = `${PREFIX}.${payload}`
  return `${signed}.${digestOf(hostToken, signed).toString('base64url')}`
}
