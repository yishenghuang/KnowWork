/**
 * 自动化的纯显示规则：时间规则的写法（RRULE 文本）、反解析、中文描述，以及状态与视图的中文名。
 *
 * 规则文本是宿主官方 schedule 服务认的写法，形如
 *
 *   DTSTART;TZID=Asia/Shanghai:20261112T090000
 *   RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0
 *
 * 时间是本地时间（TZID 里的那个时区），不换 UTC：用户填的是「每天九点」，就该在九点跑。
 * 这层不碰网络也不碰状态，页面和表单都从这里取规则（plan-2 §4.3）。
 */
import type { RunStatus } from '../../api/automations';

/** ISO 星期，和 RRULE 的 BYDAY 同序（周一在前）。 */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

export type Weekday = (typeof WEEKDAYS)[number];

const WEEKDAY_TEXT = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

/** 一次任务的触发方式。页面上的表单按这个类型收，再交给 buildRules 变成规则文本。 */
export type Preset =
  /** 一次性：本地时间 'YYYY-MM-DDTHH:mm'。 */
  | { readonly kind: 'once'; readonly at: string }
  | { readonly kind: 'minutes'; readonly every: number }
  | { readonly kind: 'hours'; readonly every: number }
  /** 每天：可以多个时刻，每个时刻一条规则。 */
  | { readonly kind: 'daily'; readonly every: number; readonly times: readonly string[] }
  | { readonly kind: 'workdays'; readonly every: number; readonly time: string }
  | { readonly kind: 'weekly'; readonly every: number; readonly days: readonly Weekday[]; readonly time: string }
  /** 每月某日：day 是 1..31，-1 表示当月最后一天。 */
  | { readonly kind: 'monthly'; readonly every: number; readonly day: number; readonly time: string }
  /** 认不出的规则原样留着，不硬塞进上面任何一种。 */
  | { readonly kind: 'custom'; readonly rrule: string };

/** 'HH:mm' → RRULE 里的 BYHOUR/BYMINUTE。 */
function clock(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(':');
  return { hour: Number(h ?? 0), minute: Number(m ?? 0) };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DDTHH:mm' → 'YYYYMMDDTHHmm00'（DTSTART 的本地时间写法）。 */
function stamp(at: string): string {
  const [datePart = '', timePart = '00:00'] = at.split('T');
  const [y = '2000', mo = '01', d = '01'] = datePart.split('-');
  const { hour, minute } = clock(timePart);
  return `${y}${mo}${d}T${pad2(hour)}${pad2(minute)}00`;
}

/** 现在这一刻在给定时区里的本地写法：每小时、每几分钟这类规则要一个起点。 */
function nowStamp(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
    return `${pick('year')}${pick('month')}${pick('day')}T${pick('hour')}${pick('minute')}${pick('second')}`;
  } catch {
    // 时区名不认：退回本机时间，至少规则还能存下去
    const now = new Date();
    return (
      `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
      `T${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
    );
  }
}

const dtstart = (local: string, timeZone: string) => `DTSTART;TZID=${timeZone}:${local}`;

/**
 * 一个预设 → 若干条规则文本（每天多个时刻就是多条，其余一条；自定义原样一条）。
 * 每条都是「一行 DTSTART，一行 RRULE」。
 */
export function buildRules(preset: Preset, timeZone: string): string[] {
  switch (preset.kind) {
    case 'once':
      return [`${dtstart(stamp(preset.at), timeZone)}\nRRULE:FREQ=DAILY;COUNT=1`];
    case 'minutes':
      return [
        `${dtstart(nowStamp(timeZone), timeZone)}\nRRULE:FREQ=MINUTELY;INTERVAL=${Math.max(1, preset.every)}`,
      ];
    case 'hours':
      return [
        `${dtstart(nowStamp(timeZone), timeZone)}\nRRULE:FREQ=HOURLY;INTERVAL=${Math.max(1, preset.every)}`,
      ];
    case 'daily':
      return preset.times.map((time) => {
        const { hour, minute } = clock(time);
        return (
          `${dtstart(stamp(`2000-01-01T${time}`), timeZone)}\n` +
          `RRULE:FREQ=DAILY;INTERVAL=${Math.max(1, preset.every)};BYHOUR=${hour};BYMINUTE=${minute}`
        );
      });
    case 'workdays': {
      const { hour, minute } = clock(preset.time);
      return [
        `${dtstart(stamp(`2000-01-01T${preset.time}`), timeZone)}\n` +
          `RRULE:FREQ=WEEKLY;INTERVAL=${Math.max(1, preset.every)};BYDAY=${WEEKDAYS.slice(0, 5).join(',')}` +
          `;BYHOUR=${hour};BYMINUTE=${minute}`,
      ];
    }
    case 'weekly': {
      const { hour, minute } = clock(preset.time);
      const days = WEEKDAYS.filter((day) => preset.days.includes(day));
      return [
        `${dtstart(stamp(`2000-01-01T${preset.time}`), timeZone)}\n` +
          `RRULE:FREQ=WEEKLY;INTERVAL=${Math.max(1, preset.every)};BYDAY=${days.join(',')}` +
          `;BYHOUR=${hour};BYMINUTE=${minute}`,
      ];
    }
    case 'monthly': {
      const { hour, minute } = clock(preset.time);
      // 照规格的写法：BYMONTHDAY 同时给「那一天」和「月末」，BYSETPOS 取当月的第一个 —— 该月没有那个日子
      // （比如 31 号遇到 30 天的月份）就落到月末。只写一个日子再加 BYSETPOS 会被官方判成「BYSETPOS 没有作用」而拒收；
      // day = -1（每月最后一天）本身只有一个候选，不写 BYSETPOS。
      const days = preset.day === -1 ? '-1' : `${preset.day},-1`;
      const position = preset.day === -1 ? '' : ';BYSETPOS=1';
      return [
        `${dtstart(stamp(`2000-01-01T${preset.time}`), timeZone)}\n` +
          `RRULE:FREQ=MONTHLY;INTERVAL=${Math.max(1, preset.every)};BYMONTHDAY=${days}${position}` +
          `;BYHOUR=${hour};BYMINUTE=${minute}`,
      ];
    }
    case 'custom':
      return [preset.rrule];
  }
}

interface Parts {
  /** DTSTART 的时区；没写 TZID 时按 UTC。 */
  readonly timeZone: string;
  /** DTSTART 里的本地时间 'YYYYMMDDTHHmmss'（可能没有秒）。 */
  readonly start: string;
  readonly rule: Readonly<Record<string, string>>;
}

/** 拆开「DTSTART... 
 RRULE:...」；不是这个形状就返回 undefined（当自定义处理）。 */
function split(rrule: string): Parts | undefined {
  const lines = rrule
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const startLine = lines.find((line) => line.startsWith('DTSTART'));
  const ruleLine = lines.find((line) => line.startsWith('RRULE:'));
  if (!startLine || !ruleLine) return undefined;
  const tzid = /TZID=([^:]+):/.exec(startLine)?.[1];
  const start = startLine.slice(startLine.lastIndexOf(':') + 1).replace(/Z$/, '');
  const rule: Record<string, string> = {};
  for (const field of ruleLine.slice('RRULE:'.length).split(';')) {
    const [key, value] = field.split('=');
    if (key && value) rule[key] = value;
  }
  return { timeZone: tzid ?? 'UTC', start, rule };
}

const SHORT_DAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** 'YYYYMMDDTHHmmss' → 'YYYY-MM-DDTHH:mm'（本地时间，不做时区换算）。 */
function localAt(start: string): string {
  const date = start.slice(0, 8);
  const hour = start.slice(9, 11) || '00';
  const minute = start.slice(11, 13) || '00';
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${hour}:${minute}`;
}

/** DTSTART 的本地时刻 'HH:mm'：没写 BYHOUR 的规则（每周、每月）从起点取时刻。 */
function startTime(start: string): string {
  return `${start.slice(9, 11) || '00'}:${start.slice(11, 13) || '00'}`;
}

function timeOf(parts: Parts): string {
  const hour = parts.rule.BYHOUR;
  const minute = parts.rule.BYMINUTE;
  if (hour === undefined) return startTime(parts.start);
  return `${pad2(Number(hour))}:${pad2(Number(minute ?? 0))}`;
}

const intervalOf = (parts: Parts): number => Math.max(1, Number(parts.rule.INTERVAL ?? 1) || 1);

/** 规则文本 → 预设；认不出的一律当自定义，页面上原样显示「自定义规则」。 */
export function parseRule(rrule: string): Preset {
  const parts = split(rrule);
  if (!parts) return { kind: 'custom', rrule };
  const { rule } = parts;
  const every = intervalOf(parts);
  const freq = rule.FREQ;

  if (freq === 'MINUTELY' || freq === 'HOURLY') {
    const kind = freq === 'MINUTELY' ? 'minutes' : 'hours';
    // 带 BYDAY、BYMONTHDAY 之类的组合规则不算「每 N 分钟」这种简单预设
    if (rule.BYDAY || rule.BYMONTHDAY) return { kind: 'custom', rrule };
    return { kind, every };
  }
  if (freq === 'DAILY') {
    if (rule.COUNT === '1') {
      const at = localAt(parts.start);
      return { kind: 'once', at };
    }
    if (rule.BYDAY) return { kind: 'custom', rrule };
    return { kind: 'daily', every, times: [timeOf(parts)] };
  }
  if (freq === 'WEEKLY') {
    const days = (rule.BYDAY ?? '')
      .split(',')
      .filter((day): day is Weekday => (SHORT_DAYS as readonly string[]).includes(day));
    if (days.length === 0) return { kind: 'custom', rrule };
    const workdays = days.length === 5 && WEEKDAYS.slice(0, 5).every((day, i) => days[i] === day);
    return workdays
      ? { kind: 'workdays', every, time: timeOf(parts) }
      : { kind: 'weekly', every, days, time: timeOf(parts) };
  }
  if (freq === 'MONTHLY') {
    const day = Number((rule.BYMONTHDAY ?? '').split(',')[0]);
    if (!Number.isInteger(day) || (day !== -1 && (day < 1 || day > 31))) return { kind: 'custom', rrule };
    return { kind: 'monthly', every, day, time: timeOf(parts) };
  }
  return { kind: 'custom', rrule };
}

const weekdayText = (day: Weekday) => WEEKDAY_TEXT[WEEKDAYS.indexOf(day)] ?? day;

/**
 * 规则文本 → 中文一句话，例如「每天 09:00」「每 2 小时」「工作日 09:30」「每月最后一天 09:00」
 * 「一次性 2026-11-12 09:00」；认不出的是「自定义规则」。
 */
export function describeRule(rrule: string): string {
  const preset = parseRule(rrule);
  switch (preset.kind) {
    case 'once':
      return `一次性 ${preset.at.replace('T', ' ')}`;
    case 'minutes':
      return preset.every === 1 ? '每分钟' : `每 ${preset.every} 分钟`;
    case 'hours':
      return preset.every === 1 ? '每小时' : `每 ${preset.every} 小时`;
    case 'daily':
      return preset.every === 1
        ? `每天 ${preset.times.join('、')}`
        : `每 ${preset.every} 天 ${preset.times.join('、')}`;
    case 'workdays':
      return preset.every === 1
        ? `工作日 ${preset.time}`
        : `每 ${preset.every} 周的工作日 ${preset.time}`;
    case 'weekly': {
      const days = preset.days.map(weekdayText).join('、');
      return preset.every === 1 ? `每${days} ${preset.time}` : `每 ${preset.every} 周的${days} ${preset.time}`;
    }
    case 'monthly': {
      const day = preset.day === -1 ? '最后一天' : `${preset.day} 日`;
      return preset.every === 1 ? `每月${day} ${preset.time}` : `每 ${preset.every} 个月的${day} ${preset.time}`;
    }
    case 'custom':
      return '自定义规则';
  }
}

/** 一条任务的时间规则（中文）：页面建的带 rrule；没有就按对话里设的提醒兜底。 */
export function scheduleText(rule: string | null | undefined): string {
  return rule ? describeRule(rule) : '自定义规则';
}

export type AutomationStatus = 'active' | 'paused' | 'ended';

/** 状态的中文说法：和宿主的状态一一对应。 */
export const STATUS_TEXT: Readonly<Record<AutomationStatus, string>> = {
  active: '运行中',
  paused: '已暂停',
  ended: '已结束',
};

/** 最近一次运行的结果说法：跑完/取消/失败来自那一轮汇总，「跳过」是到点时上一轮还没结束、这一次没跑。 */
export const RUN_STATUS_TEXT: Readonly<Record<RunStatus, string>> = {
  completed: '跑完',
  cancelled: '取消',
  failed: '失败',
  skipped: '跳过',
};

export type AutomationOrigin = 'page' | 'chat';

/** 两个视图：页面上建的、对话里设的提醒（判定在业务服务做，这里只认 origin）。 */
export const ORIGIN_TEXT: Readonly<Record<AutomationOrigin, string>> = {
  page: '页面上建的',
  chat: '对话里设的提醒',
};
