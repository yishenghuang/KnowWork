/**
 * 自动化接口（server/src/knowwork_server/automations/api.py）：我的定时任务列表、单条、投递记录。
 *
 * 任务本身存在宿主的官方 schedule 服务里，业务服务只转一手并按调用者筛过，所以这里拿到的都是「我的」；
 * `origin` 是业务服务补的派生字段：这条是「页面上建的」（page）还是「对话里设的提醒」（chat），前端只读它，
 * 不按 target 自己猜（plan-2 §4.4）。
 *
 * `lastRun` 与投递记录的 `status` 也是业务服务补的：结果不在宿主里，读的是那一轮对话的「每轮汇总」；
 * 「跳过」在宿主里根本没有记录（到点时上一轮还在跑），是业务侧按「还在跑 + 已经过点」推出来的。
 * 这几条字段老版本服务端没有，解析一律容错——缺就是没有，显示成「还没有跑过」，不能让整条任务消失。
 */
import { request, seg } from './http';
import { bool, isRecord, listOf, str, text } from './parse';
import { workspacePath } from './workspace';

/** 任务状态：宿主里未激活的也归到「已结束」。 */
export type AutomationStatus = 'active' | 'paused' | 'ended';

/** 这条任务是从哪来的：页面上建的，还是对话里设的提醒。 */
export type AutomationOrigin = 'page' | 'chat';

/** 最近一次跑成没跑成：跑完、取消、失败，以及到点时上一轮还在跑而跳过的那一次。 */
export type RunStatus = 'completed' | 'cancelled' | 'failed' | 'skipped';

/** 这条任务最近一次运行：哪一轮、什么时候、落在哪个对话（跳过没有对话）。 */
export interface LastRun {
  readonly status: RunStatus;
  readonly at: string;
  readonly conversationId: string | null;
  readonly title: string | null;
  /** 为什么跳过之类的一句说明；只有跳过着一次有。 */
  readonly note: string | null;
}

/** 一次投递的回执：按计划该在哪一刻跑、实际什么时候投出去、投到了哪个对话。 */
export interface DeliveryRecord {
  readonly scheduledAt: string | null;
  readonly deliveredAt: string | null;
  readonly messageId: string;
  readonly targetSessionId: string | null;
  /** 投递目标那个对话的名字（业务服务补的）；会话删了就为空，界面上退回显示 id。 */
  readonly targetTitle: string | null;
  readonly prompt: string;
  /** 那一次跑成没跑成（该次投递之后那个对话里最近一轮的状态）；读不到时为 null。 */
  readonly status: RunStatus | null;
  /** 这一次宿主里没有投递记录，是业务服务按「到点时上一轮还没结束」补出来的那一条。 */
  readonly skipped: boolean;
  readonly note: string | null;
}

/** 连续 3 次运行失败被自动暂停的原因与时间；读侧只对已暂停的任务给，老服务端没有这个字段。 */
export type AutoPaused = { reason: string; at: string | null };

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
  /** 最近一次跑成没跑成；还没跑过、或读不到时为 null。 */
  readonly lastRun: LastRun | null;
  /** 被连续失败自动暂停时带原因；普通暂停或读不到时为 null。 */
  readonly autoPaused: AutoPaused | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** 宿主说这一轮正在跑或排队（runSchedule 后立即为 true）：「立即运行」按钮这时不能点。 */
  readonly executionActive: boolean;
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

const RUN_STATUSES: readonly RunStatus[] = ['completed', 'cancelled', 'failed', 'skipped'];

const base = (path = '') => workspacePath(`/automations${path}`);

function parseDelivery(value: unknown): DeliveryRecord | undefined {
  if (!isRecord(value)) return undefined;
  const messageId = text(value.messageId);
  // 没有 messageId 的记录分不清是哪一次，直接丢掉比显示半条好；合成的那条「跳过」有 "skipped:..." 的 id
  if (!messageId) return undefined;
  return {
    scheduledAt: text(value.scheduledAt) ?? null,
    deliveredAt: text(value.deliveredAt) ?? null,
    messageId,
    targetSessionId: text(value.targetSessionId) ?? null,
    targetTitle: text(value.targetTitle) ?? null,
    prompt: str(value.prompt) ?? '',
    status: RUN_STATUSES.find((s) => s === value.status) ?? null,
    skipped: bool(value.skipped),
    note: text(value.note) ?? null,
  };
}

/** 最近一次运行：认不出状态就当失败（宁可显示得难看重试，也别当成功），时间不是字符串就整条当没有。 */
function parseLastRun(value: unknown): LastRun | null {
  if (!isRecord(value)) return null;
  const at = text(value.at);
  if (!at) return null;
  return {
    status: RUN_STATUSES.find((s) => s === value.status) ?? 'failed',
    at,
    conversationId: text(value.conversationId) ?? null,
    title: text(value.title) ?? null,
    note: text(value.note) ?? null,
  };
}

/** 自动暂停原因：认得出 reason 字符串才收，时间缺了就是 null；老服务端没这字段整条当没有。 */
function parseAutoPaused(value: unknown): AutoPaused | null {
  if (!isRecord(value)) return null;
  const reason = str(value.reason);
  if (reason === undefined) return null;
  const at = str(value.at);
  return { reason, at: at ?? null };
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
    lastRun: parseLastRun(value.lastRun),
    autoPaused: parseAutoPaused(value.autoPaused),
    createdAt: text(value.createdAt) ?? null,
    updatedAt: text(value.updatedAt) ?? null,
    executionActive: value.executionActive === true,
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

/** 暂停：到点不再触发。走业务服务的薄路由，宿主的官方写侧把 active 关掉。 */
export async function pauseAutomation(id: string): Promise<void> {
  await request<unknown>(base(`/${seg(id)}/pause`), { method: 'POST' });
}

/** 恢复：宿主按 patch.active=true 重算下一次运行时间，原来的规则不动。 */
export async function resumeAutomation(id: string): Promise<void> {
  await request<unknown>(base(`/${seg(id)}/resume`), { method: 'POST' });
}

/** 立即运行一次：宿主立刻发起一轮、原来的下次运行时间不变；正在跑/排队时回 409。 */
export async function runAutomation(id: string): Promise<void> {
  await request<unknown>(base(`/${seg(id)}/run`), { method: 'POST' });
}

/** 删除：宿主侧不再触发；它跑过的对话与消息不在这里，删不掉。 */
export async function deleteAutomation(id: string): Promise<void> {
  await request<unknown>(base(`/${seg(id)}`), { method: 'DELETE' });
}

/** 管理端看到的一条任务：在「我的任务」那些字段之外，多一个创建者（宿主属主账本里的 userId + 资料里的姓名）。 */
export interface AdminAutomation extends Automation {
  /** 创建者的显示名；账号注销或资料服务读不到时为 null，界面上退回用户 id。 */
  readonly creatorName: string | null;
  /** 创建者的用户 id；按创建者筛选用它，同名的人也不会被并成一条。 */
  readonly creatorId: string | null;
}

function parseAdminAutomation(value: unknown): AdminAutomation | undefined {
  const task = parseAutomation(value);
  if (!task) return undefined;
  if (!isRecord(value)) return { ...task, creatorName: null, creatorId: null };
  // 属主是宿主给全量读补上的；老宿主没有这字段就当不知道是谁建的，别把整条任务丢掉
  const owner = isRecord(value.owner) ? value.owner : undefined;
  return {
    ...task,
    creatorName: text(value.creatorName) ?? null,
    creatorId: owner ? (text(owner.userId) ?? null) : null,
  };
}

export interface AdminAutomationPage {
  readonly items: readonly AdminAutomation[];
  readonly total: number;
}

/** 管理端：本空间全部定时任务（含已暂停与已结束的）。只有空间所有者/管理员拿得到，普通用户是 403。 */
export async function listAdminAutomations(): Promise<AdminAutomationPage> {
  const body = await request<unknown>(base('/admin'));
  if (!isRecord(body)) return { items: [], total: 0 };
  const items = listOf(body.items, parseAdminAutomation);
  return { items, total: typeof body.total === 'number' ? body.total : items.length };
}

/** 管理端停用一条任务：到点不再触发。宿主只接受「停用」这一种改动，改内容仍由创建者自己做。 */
export async function disableAdminAutomation(id: string): Promise<void> {
  await request<unknown>(base(`/admin/${seg(id)}/disable`), { method: 'POST' });
}

