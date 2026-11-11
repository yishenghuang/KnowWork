/**
 * 「用一句话生成」草稿的接口与解析（server/src/knowwork_server/automations/draft.py）。
 *
 * 单独一层是因为它跟任务本身不是一回事：草稿只在新建表单里走一趟，**不建任务**，
 * 回来的东西还要过表单的校验与用户的手。任务的增删改查仍在 `./automations`。
 *
 * 服务端给的字段一律容错：解析不出来就当没给，绝不让整张表单消失（票 #10 的第三条验收）。
 */
import type { Preset, Weekday } from '../features/automations/model';
import { request } from './http';
import { isRecord, text } from './parse';
import { workspacePath } from './workspace';

/** 草稿里的时间规则：能落进预设就给预设对象，落不进就是 RRULE 行原文（前端 parseRule 认不出就当「自定义」）。 */
export type AutomationDraftTiming = { readonly preset: Preset } | { readonly rrule: string };

/** 「一句话生成」回来的草稿：没给出的字段是 null，表单保持原样。生成草稿不会建任务。 */
export interface AutomationDraft {
  readonly title: string | null;
  readonly prompt: string | null;
  readonly timing: AutomationDraftTiming | null;
  readonly target: 'fixed' | 'new_once' | null;
  /** 给用户看的一句中文补充（例如「没完全听懂，只填了能确定的部分」）。 */
  readonly note: string | null;
}

const EMPTY_DRAFT: AutomationDraft = { title: null, prompt: null, timing: null, target: null, note: null };

const DRAFT_KINDS = ['once', 'minutes', 'hours', 'daily', 'workdays', 'weekly', 'monthly'] as const;

/** 与 model.ts 的 WEEKDAYS 同序；这里只用来校验，不从那边 import 值，免得接口层依赖 feature 层。 */
const DAYS: readonly string[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** 正整数；其余（含小数、字符串）都不要。 */
function whole(value: unknown, min = 1): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : undefined;
}

/** 'HH:mm'（24 小时制）。 */
function clock(value: unknown): string | undefined {
  const time = text(value);
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return undefined;
  const [hour = '', minute = ''] = time.split(':');
  return Number(hour) <= 23 && Number(minute) <= 59 ? time : undefined;
}

/**
 * 草稿里的预设：逐字段校验，任一项对不上就整条丢掉（服务端已经校验过一遍，这里是防着版本不一致）。
 * 校验不过的那一条不再退回 rrule——服务端会先替我们决定该走哪条路。
 */
function parseDraftPreset(value: unknown): Preset | undefined {
  if (!isRecord(value)) return undefined;
  const kind = DRAFT_KINDS.find((k) => k === value.kind);
  if (!kind) return undefined;
  if (kind === 'once') {
    const at = text(value.at);
    return at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at) ? { kind, at } : undefined;
  }
  const every = whole(value.every);
  if (every === undefined) return undefined;
  if (kind === 'minutes' || kind === 'hours') return { kind, every };
  if (kind === 'daily') {
    const times = Array.isArray(value.times) ? value.times.map(clock) : [];
    if (times.length === 0 || times.some((time) => time === undefined)) return undefined;
    return { kind, every, times: times.filter((time) => time !== undefined) };
  }
  const time = clock(value.time);
  if (!time) return undefined;
  if (kind === 'workdays') return { kind, every, time };
  if (kind === 'weekly') {
    const days = (Array.isArray(value.days) ? value.days : [])
      .map((day) => (typeof day === 'string' ? day.toUpperCase() : ''))
      .filter((day): day is Weekday => DAYS.includes(day));
    return days.length > 0 ? { kind, every, days, time } : undefined;
  }
  const day = whole(value.day, -1);
  if (day === undefined || day === 0 || day > 31) return undefined;
  return { kind: 'monthly', every, day, time };
}

function parseDraftTiming(value: unknown): AutomationDraftTiming | null {
  if (!isRecord(value)) return null;
  const preset = parseDraftPreset(value.preset);
  if (preset) return { preset };
  const rrule = text(value.rrule);
  // 服务端只透出以 FREQ= 开头的原文；别的当没给
  return rrule && rrule.startsWith('FREQ=') ? { rrule } : null;
}

function parseDraft(value: unknown): AutomationDraft {
  if (!isRecord(value)) return EMPTY_DRAFT;
  const target = value.target === 'fixed' || value.target === 'new_once' ? value.target : null;
  return {
    title: text(value.title) ?? null,
    prompt: text(value.prompt) ?? null,
    timing: parseDraftTiming(value.timing),
    target,
    note: text(value.note) ?? null,
  };
}

/**
 * 一句话 → 表单草稿：业务服务调一次模型，把标题、提示词、时间规则、执行位置翻出来。
 * **这条路上不建任务**：用户改完点「保存」才真的建（AC3）。解析不出来就当全空，绝不让整张表单消失。
 */
export async function draftAutomation(text: string, timeZone: string): Promise<AutomationDraft> {
  const body = await request<unknown>(workspacePath('/automations/draft'), {
    method: 'POST',
    body: { text, timeZone },
  });
  return parseDraft(body);
}
