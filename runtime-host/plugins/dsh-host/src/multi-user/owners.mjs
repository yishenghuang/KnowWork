/**
 * 多用户适配层的入口：属主服务 `knowworkOwners`。所有属主级插件的适配（定时任务，以后的同类插件）共用它：
 * - 工具执行时设上调用者（caller.mjs）；
 * - 属主账本（ledger.mjs）：属主级资源归哪个空间的哪个人；建资源的那段对话归谁也记一笔——到点激活时宿主上
 *   可能已经没有这段对话（空闲释放、宿主重启），业务服务按空间查对话（行级安全），要靠这一笔知道是哪个空间。
 * 用 owned-service 适配的服务自动依赖它，配置里放在这类插件前面。
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { getSession } from '../state.mjs'
import { trackCallers } from './caller.mjs'
import { createLedger } from './ledger.mjs'

const SESSION = 'session'

export default class KnowWorkOwners extends Service {
  static Config = z.object({
    ledgerPath: z.string().required().description('属主账本文件（DSH 数据目录下）'),
  })

  /** @param {import('@deepseek-ai/cordis').Context} ctx @param {{ ledgerPath: string }} config */
  constructor(ctx, config) {
    super(ctx, 'knowworkOwners')
    this.ledger = createLedger(config.ledgerPath)
    trackCallers(ctx)
  }

  /** @returns {import('./caller.mjs').Owner | undefined} */
  ownerOf(kind, id) {
    return this.ledger.ownerOf(kind, id)
  }

  /**
   * 直接记一笔属主级资源归谁（不经过调用者）。
   * 创建会话的插件用它把「这段会话属谁」写进账本：那段会话还没有对话记录，业务服务回头要靠它知道该找哪个空间。
   * @param {string} kind @param {string} id @param {import('./caller.mjs').Owner} owner
   */
  own(kind, id, owner) {
    this.ledger.record([[kind, id, owner]])
  }

  /** 调用者建了一个属主级资源：资源和发起它的对话都记到调用者名下。 */
  claim(kind, id, caller) {
    // 调用者未必来自某段对话（HTTP 面按身份头调过来时没有 sessionId）：没有就不记那段对话，别写进一个 undefined 键
    const session = caller.sessionId !== undefined && this.ledger.ownerOf(SESSION, caller.sessionId) === undefined
      ? [[SESSION, caller.sessionId, caller.owner]]
      : []
    this.ledger.record([[kind, id, caller.owner], ...session])
  }

  /** 一段对话的属主：宿主上开着就取会话状态里的，否则取账本里记的；都没有是 undefined。 */
  sessionOwner(sessionId) {
    return getSession(sessionId)?.owner ?? this.ledger.ownerOf(SESSION, sessionId)
  }
}

export const name = 'knowwork-owners'
