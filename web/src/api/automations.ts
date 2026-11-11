/**
 * 自动化接口（server/src/knowwork_server/automations/api.py）：我的定时任务列表、单条、投递记录。
 *
 * 任务本身存在宿主的官方 schedule 服务里，业务服务只转一手并按调用者筛过，所以这里拿到的都是「我的」；
 * `origin` 是业务服务补的派生字段：这条是「页面上建的」（page）还是「对话里设的提醒」（chat），前端只读它，
 * 不按 target 自己猜（plan-2 §4.4）。
 */
import { request, seg } from './http';
import { bool, isRecord, listOf, str, text } from './parse';
import { workspacePath } from './workspace';

/** 任务状态：宿主里未激活的也归到「已结束」。 */
export type AutomationStatus = 'active' | 'paused' | 'ended';

/** 这条任务是从哪来的：页面上建的，还是对话里设的提醒。 */
export type AutomationOrigin = 'page' | 'chat';

/** 一次投递的回执：按计划该在哪一刻跑、实际什么时候投出去、投到了哪个对话。 */
export interface DeliveryRecord {
  readonly scheduledAt: string | null;
  readonly deliveredAt: string | null;
  readonly messageId: string;
  readonly targetSessionId: string | null;
  /** 投递目标那个对话的名字（业务服务补的）；会话删了就为空，界面上退回显示 id。 */
  readonly targetTitle: string | null;
  readonly prompt: string;
}

export interface Automation {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  /** 宿主记录的种类：rrule（页面建的规则）以及 after / at / every / daily / weekly / cron。 */
  readonly kind: string;
  /** 时间规则原文（只有 rrule 记录有）；中文描述由 features/automations/model.ts 算。 */
  readonly rrule: string | null;
  readonly scheduledAt: string | null;
  readonly status: AutomationStatus;
  readonly origin: AutomationOrigin;
  readonly targetSessionId: string | null;
  readonly lastDelivery: DeliveryRecord | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface AutomationPage {
  readonly items: readonly Automation[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface AutomationHistory {
  readonly records: readonly DeliveryRecord[];
  /** 往后翻的游标（上一条记录的 messageId）；没有更多时是 null。 */
  readonly nextBefore: string | null;
  /** 更早的记录已经被清理，翻不到底。 */
  readonly earlierRecordsUnavailable: boolean;
}

/** 任务跑在哪儿：固定对话（页面替你建一个后台对话）、每次新建对话，或指定某段对话。 */
export interface AutomationTarget {
  readonly kind: 'fixed' | 'new_once' | 'session';
  /** 只有 kind 为 session 时用得上。 */
  readonly sessionId?: string;
}

/** 新建一条任务要填的东西。 */
export interface AutomationInput {
  readonly title: string;
  readonly prompt: string;
  readonly rrule: string;
  readonly target: AutomationTarget;
}

/** 改一条任务：只带要改的字段；带 expectedUpdatedAt 时服务端会拦住别人先改过的情形。 */
export interface AutomationPatch {
  readonly title?: string;
  readonly prompt?: string;
  readonly rrule?: string;
  readonly target?: AutomationTarget;
  readonly active?: boolean;
  readonly expectedUpdatedAt?: string;
}

const STATUSES: readonly AutomationStatus[] = ['active', 'paused', 'ended'];

const base = (path = '') => workspacePath(`/automations${path}`);

function parseDelivery(value: unknown): DeliveryRecord | undefined {
  if (!isRecord(value)) return undefined;
  const messageId = text(value.messageId);
  // 没有 messageId 的记录分不清是哪一次，直接丢掉比显示半条好
  if (!messageId) return undefined;
  return {
    scheduledAt: text(value.scheduledAt) ?? null,
    deliveredAt: text(value.deliveredAt) ?? null,
    messageId,
    targetSessionId: text(value.targetSessionId) ?? null,
    targetTitle: text(value.targetTitle) ?? null,
    prompt: str(value.prompt) ?? '',
  };
}

export function parseAutomation(value: unknown): Automation | undefined {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  if (!id) return undefined;
  const target = isRecord(value.target) ? value.target : undefined;
  return {
    id,
    title: str(value.title) ?? id,
    prompt: str(value.prompt) ?? '',
    kind: str(value.kind) ?? 'rrule',
    rrule: text(value.rrule) ?? null,
    scheduledAt: text(value.scheduledAt) ?? null,
    status: STATUSES.find((s) => s === value.status) ?? 'ended',
    origin: value.origin === 'page' ? 'page' : 'chat',
    targetSessionId: target ? (text(target.sessionId) ?? null) : null,
    lastDelivery: parseDelivery(value.lastDelivery) ?? null,
    createdAt: text(value.createdAt) ?? null,
    updatedAt: text(value.updatedAt) ?? null,
  };
}

function required(value: unknown): Automation {
  const automation = parseAutomation(value);
  if (!automation) throw new Error('定时任务数据格式不对');
  return automation;
}

/** 保存成功后业务服务只回这几样（宿主的完整记录由列表接口再读一遍），所以不复用 parseAutomation 编造其余字段。 */
export interface SavedAutomation {
  readonly id: string;
  readonly scheduledAt: string | null;
  readonly origin: AutomationOrigin;
  readonly updatedAt: string | null;
}

function parseSaved(value: unknown): SavedAutomation {
  if (!isRecord(value)) throw new Error('定时任务数据格式不对');
  const id = text(value.id);
  if (!id) throw new Error('定时任务数据格式不对');
  return {
    id,
    scheduledAt: text(value.scheduledAt) ?? null,
    origin: value.origin === 'page' ? 'page' : 'chat',
    updatedAt: text(value.updatedAt) ?? null,
  };
}

/** 我的定时任务。宿主那边已经按调用者筛过，这里拿到的都是自己的。 */
export async function listAutomations(): Promise<AutomationPage> {
  const body = await request<unknown>(base());
  if (!isRecord(body)) return { items: [], total: 0, limit: 100, offset: 0 };
  const items = listOf(body.items, parseAutomation);
  return {
    items,
    total: typeof body.total === 'number' ? body.total : items.length,
    limit: typeof body.limit === 'number' ? body.limit : items.length,
    offset: typeof body.offset === 'number' ? body.offset : 0,
  };
}

/** 新建一条任务。时间规则原文由 features/automations/model.ts 按预设算好传进来。 */
export async function createAutomation(input: AutomationInput): Promise<SavedAutomation> {
  const body = await request<unknown>(base(), { method: 'POST', body: input });
  return parseSaved(body);
}

/** 改一条任务；要防别人刚改过就带上 expectedUpdatedAt。 */
export async function updateAutomation(id: string, patch: AutomationPatch): Promise<SavedAutomation> {
  const body = await request<unknown>(base(`/${seg(id)}`), { method: 'PATCH', body: patch });
  return parseSaved(body);
}

export async function getAutomation(id: string): Promise<Automation> {
  return required(await request<unknown>(base(`/${seg(id)}`)));
}

/** 一条任务的投递记录，最新的在前。 */
export async function automationHistory(
  id: string,
  options: { readonly limit?: number; readonly before?: string } = {},
): Promise<AutomationHistory> {
  const body = await request<unknown>(base(`/${seg(id)}/history`), {
    query: { limit: options.limit, before: options.before },
  });
  if (!isRecord(body)) return { records: [], nextBefore: null, earlierRecordsUnavailable: false };
  return {
    records: listOf(body.records, parseDelivery),
    nextBefore: text(body.nextBefore) ?? null,
    earlierRecordsUnavailable: bool(body.earlierRecordsUnavailable),
  };
}
