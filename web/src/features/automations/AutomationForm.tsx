/**
 * 新建 / 编辑一条定时任务的表单。
 *
 * 「时间规则」按八种预设填，落库前统一由 model.buildRules 变成 rrule：拿到的是规则数组，
 * 每天多个时刻就是几条规则——新建时一次请求全交上去（一次配出 9:00 与 18:30 就是两条任务，
 * 要么一起建出来，要么一条都不留）；编辑改的是列表里那一行，所以编辑只认第一条（多出来的会明确提示另建）。
 * 时区用浏览器的 IANA 名写进 DTSTART;TZID=，不换成 UTC：写 9:00 就是当地 9:00 跑。
 */
import { useMemo, useState } from 'react';
import { Checkbox } from '@openai/apps-sdk-ui/components/Checkbox';
import { Input } from '@openai/apps-sdk-ui/components/Input';
import { RadioGroup } from '@openai/apps-sdk-ui/components/RadioGroup';
import { Select } from '@openai/apps-sdk-ui/components/Select';
import { Textarea } from '@openai/apps-sdk-ui/components/Textarea';
import { useQueryClient } from '@tanstack/react-query';
import {
  createAutomations,
  updateAutomation,
  type Automation,
  type AutomationPatch,
  type AutomationTarget,
} from '../../api/automations';
import type { AutomationDraft } from '../../api/automationDraft';
import { browserTimeZone } from '../../api/conversations';
import { ApiError, readableError } from '../../api/http';
import { Dialog, DialogActions } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { rule, useForm } from '../../ui/form';
import { NumberInput } from '../../ui/NumberInput';
import { toast } from '../../ui/toastStore';
import AssistantBox from './AssistantBox';
import { buildRules, describeRule, MIN_INTERVAL_MINUTES, parseRule, type Preset, type Weekday } from './model';
import { AUTOMATION_KEYS } from './queries';

/** 表单里正在编辑的那份预设：参数先按输入框原样留着，落库前才校验、才规整。 */
type Draft =
  | { readonly kind: 'once'; readonly at: string }
  | { readonly kind: 'minutes'; readonly every: number | null }
  | { readonly kind: 'hours'; readonly every: number | null }
  | { readonly kind: 'daily'; readonly every: number | null; readonly times: string }
  | { readonly kind: 'workdays'; readonly every: number | null; readonly time: string }
  | {
      readonly kind: 'weekly';
      readonly every: number | null;
      readonly days: readonly Weekday[];
      readonly time: string;
    }
  | {
      readonly kind: 'monthly';
      readonly every: number | null;
      readonly day: number | null;
      readonly time: string;
    }
  | { readonly kind: 'custom'; readonly rrule: string };

type PresetKind = Draft['kind'];

/** 执行位置：固定对话（先建一个后台对话）还是每次新建对话。 */
type Place = 'fixed' | 'new_once';

/** 内联错误挂在哪儿：规则的错挂在时间规则上，条数上限之类挂在整张表单上。 */
type Problem = { readonly where: 'rule' | 'save'; readonly message: string };

const PRESETS: readonly { readonly value: PresetKind; readonly label: string }[] = [
  { value: 'once', label: '一次性' },
  { value: 'minutes', label: '每 N 分钟' },
  { value: 'hours', label: '每 N 小时' },
  { value: 'daily', label: '每天' },
  { value: 'workdays', label: '工作日' },
  { value: 'weekly', label: '每周某几天' },
  { value: 'monthly', label: '每月某日' },
  { value: 'custom', label: '自定义' },
];

const DAYS: readonly { readonly value: Weekday; readonly label: string }[] = [
  { value: 'MO', label: '周一' },
  { value: 'TU', label: '周二' },
  { value: 'WE', label: '周三' },
  { value: 'TH', label: '周四' },
  { value: 'FR', label: '周五' },
  { value: 'SA', label: '周六' },
  { value: 'SU', label: '周日' },
];

/** 新建时的默认规则：每天 9:00——最常配的就是这种。 */
const DEFAULT_PRESET: Preset = { kind: 'daily', every: 1, times: ['09:00'] };

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** 表单里的预设 → model 认的那种预设（编辑时按 parseRule 的结果回填）。 */
function draftOf(preset: Preset): Draft {
  switch (preset.kind) {
    case 'once':
      return { kind: 'once', at: preset.at };
    case 'minutes':
      return { kind: 'minutes', every: preset.every };
    case 'hours':
      return { kind: 'hours', every: preset.every };
    case 'daily':
      return { kind: 'daily', every: preset.every, times: preset.times.join(', ') };
    case 'workdays':
      return { kind: 'workdays', every: preset.every, time: preset.time };
    case 'weekly':
      return { kind: 'weekly', every: preset.every, days: [...preset.days], time: preset.time };
    case 'monthly':
      return { kind: 'monthly', every: preset.every, day: preset.day, time: preset.time };
    case 'custom':
      return { kind: 'custom', rrule: preset.rrule };
  }
}

/** 明天早上九点：新建「一次性」时的默认值，省得从空输入框开始。 */
function tomorrowMorning(): string {
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, '0');
  return [String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate())].join('-') + 'T09:00';
}

/** 换预设时那一组参数的初始值。 */
function defaultDraft(kind: PresetKind): Draft {
  switch (kind) {
    case 'once':
      return { kind: 'once', at: tomorrowMorning() };
    case 'minutes':
      return { kind: 'minutes', every: 15 };
    case 'hours':
      return { kind: 'hours', every: 1 };
    case 'daily':
      return { kind: 'daily', every: 1, times: '09:00' };
    case 'workdays':
      return { kind: 'workdays', every: 1, time: '09:00' };
    case 'weekly':
      return { kind: 'weekly', every: 1, days: ['MO'], time: '09:00' };
    case 'monthly':
      return { kind: 'monthly', every: 1, day: 1, time: '09:00' };
    case 'custom':
      return { kind: 'custom', rrule: buildRules(DEFAULT_PRESET, 'Etc/UTC')[0] ?? '' };
  }
}

const whole = (value: number | null): value is number =>
  value !== null && Number.isInteger(value) && value >= 1;

/** 一个时刻：09:00 / 9:00 都认，统一成 HH:mm。 */
function clock(raw: string): string | undefined {
  const found = CLOCK.exec(raw.trim());
  if (!found) return undefined;
  const hour = (found[1] ?? '').padStart(2, '0');
  return hour + ':' + found[2];
}

/** 一串时刻：逗号（中文逗号、顿号、空格也算）隔开，任何一个写错就整串不认。 */
function clocks(raw: string): string[] | undefined {
  const parts = raw.split(/[,，、\s]+/).filter((part) => part !== '');
  if (parts.length === 0) return undefined;
  const out: string[] = [];
  for (const part of parts) {
    const one = clock(part);
    if (one === undefined) return undefined;
    out.push(one);
  }
  return out;
}

/** 表单里的预设 → 真的预设；参数不成立时说清楚哪儿不对。 */
function toPreset(draft: Draft): { readonly preset: Preset } | { readonly message: string } {
  switch (draft.kind) {
    case 'once':
      if (!DATETIME.test(draft.at)) return { message: '选一个具体的日期和时刻' };
      return { preset: { kind: 'once', at: draft.at } };
    case 'minutes':
    case 'hours':
      if (!whole(draft.every)) return { message: '间隔要填 1 以上的整数' };
      return { preset: { kind: draft.kind, every: draft.every } };
    case 'daily': {
      if (!whole(draft.every)) return { message: '间隔要填 1 以上的整数' };
      const times = clocks(draft.times);
      if (times === undefined) return { message: '时刻写成 09:00、18:30 这样，中间用逗号隔开' };
      return { preset: { kind: 'daily', every: draft.every, times } };
    }
    case 'workdays': {
      if (!whole(draft.every)) return { message: '间隔要填 1 以上的整数' };
      const time = clock(draft.time);
      if (time === undefined) return { message: '时刻写成 09:30 这样' };
      return { preset: { kind: 'workdays', every: draft.every, time } };
    }
    case 'weekly': {
      if (!whole(draft.every)) return { message: '间隔要填 1 以上的整数' };
      if (draft.days.length === 0) return { message: '至少选一天' };
      const time = clock(draft.time);
      if (time === undefined) return { message: '时刻写成 09:30 这样' };
      return { preset: { kind: 'weekly', every: draft.every, days: draft.days, time } };
    }
    case 'monthly': {
      if (!whole(draft.every)) return { message: '间隔要填 1 以上的整数' };
      const day = draft.day;
      if (day === null || !Number.isInteger(day) || day === 0 || day < -1 || day > 31) {
        return { message: '填 1 到 31 之间的某天；-1 表示月末' };
      }
      const time = clock(draft.time);
      if (time === undefined) return { message: '时刻写成 09:00 这样' };
      return { preset: { kind: 'monthly', every: draft.every, day, time } };
    }
    case 'custom': {
      const rrule = draft.rrule.trim();
      if (rrule === '') return { message: '把规则文本填上' };
      return { preset: { kind: 'custom', rrule } };
    }
  }
}

/** 业务服务能说清楚的两种 422：间隔太短挂在时间规则上，条数上限挂在整张表单上。 */
function inlineProblem(error: unknown): Problem | undefined {
  if (!(error instanceof ApiError) || error.status !== 422) return undefined;
  if (error.code === 'interval_too_short') return { where: 'rule', message: error.message };
  if (error.code === 'quota_exceeded') return { where: 'save', message: error.message };
  return undefined;
}

export function AutomationForm({
  task,
  onClose,
}: {
  readonly task?: Automation;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const editing = task !== undefined;
  const [draft, setDraft] = useState<Draft>(() =>
    draftOf(task ? parseRule(task.rrule ?? '') : DEFAULT_PRESET),
  );
  // 任务原来投在哪个对话，就先把单选停在那一项；没动过就不改 target
  const [place, setPlace] = useState<Place>(() => (task?.targetSessionId ? 'fixed' : 'new_once'));
  const [placeTouched, setPlaceTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const timeZone = useMemo(() => browserTimeZone() ?? 'Etc/UTC', []);

  const form = useForm(
    { title: task?.title ?? '', prompt: task?.prompt ?? '' },
    {
      title: rule.all(rule.required('给这条任务起个名字'), rule.maxLength(120, '标题最多 120 个字')),
      prompt: rule.all(rule.required('说说到点要我做什么'), rule.maxLength(4000, '要做的事最多 4000 个字')),
    },
  );

  // 选完就能看到一句中文：「每天 09:00」「每天 18:30」——多时刻是几条规则，这里一并说出来
  const preview = useMemo(() => {
    const built = toPreset(draft);
    if ('message' in built) return undefined;
    return buildRules(built.preset, timeZone)
      .map((one) => describeRule(one))
      .join('；');
  }, [draft, timeZone]);

  const ruleProblem = problem?.where === 'rule' ? problem.message : undefined;

  /**
   * 把「一句话生成」的草稿填进表单：只填空、只覆盖模型明确给出的字段（AC2），
   * 时间规则认不出预设就交给 parseRule 落成「自定义」（AC4）。这条路上不建任务（AC3）。
   */
  const applyDraft = (draft: AutomationDraft) => {
    if (draft.title) form.set('title', draft.title);
    if (draft.prompt) form.set('prompt', draft.prompt);
    const timing = draft.timing;
    if (timing) {
      setDraft(draftOf('preset' in timing ? timing.preset : parseRule(timing.rrule)));
      setProblem((current) => (current?.where === 'rule' ? undefined : current));
    }
    if (draft.target) {
      setPlace(draft.target);
      setPlaceTouched(true);
    }
    toast.success('草稿填好了，看一眼再点保存');
  };

  const submit = async () => {
    const values = form.validate();
    if (!values) return;
    const built = toPreset(draft);
    if ('message' in built) {
      setProblem({ where: 'rule', message: built.message });
      return;
    }
    const rules = buildRules(built.preset, timeZone);
    if (rules.length === 0) {
      setProblem({ where: 'rule', message: '这条规则算不出什么时候跑，换一种填法' });
      return;
    }
    if (editing && rules.length > 1) {
      setProblem({ where: 'rule', message: '一次只改这一条任务；要加别的时刻，请另建一条' });
      return;
    }
    setProblem(undefined);
    setSaving(true);
    try {
      const target: AutomationTarget = { kind: place };
      if (task) {
        const patch: AutomationPatch = {
          title: values.title.trim(),
          prompt: values.prompt.trim(),
          rrule: rules[0],
          // 没动执行位置就别改它：投在对话里的任务不该因为改个标题就换地方
          ...(placeTouched ? { target } : {}),
          // 带上列表里看到的那一版；期间别人改过，宿主会判冲突，这里是 409
          ...(task.updatedAt === null ? {} : { expectedUpdatedAt: task.updatedAt }),
        };
        await updateAutomation(task.id, patch);
      } else {
        // 一次提交就是一次请求：每天 9:00 与 18:30 要么一起建出来，要么一条都不留（服务端会回滚）
        await createAutomations({
          title: values.title.trim(),
          prompt: values.prompt.trim(),
          rules,
          target,
        });
      }
      await queryClient.invalidateQueries({ queryKey: AUTOMATION_KEYS.list });
      toast.success(editing ? '改好了' : '任务已建好');
      onClose();
    } catch (error) {
      const inline = inlineProblem(error);
      if (inline) {
        setProblem(inline);
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        // 任务刚被别人改过 / 正在跑：说清楚让人刷新，别静默覆盖
        toast.error(
          error.code === 'schedule_execution_pending'
            ? '这个任务正在运行或排队，等它结束再试'
            : '任务刚被改过，请刷新后再改',
        );
        return;
      }
      toast.error(readableError(error, '保存没有成功，请稍后重试'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={editing ? '编辑任务' : '新建任务'}
      size="md"
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={<DialogActions okText={saving ? '正在保存' : '保存'} loading={saving} onCancel={onClose} />}
    >
      {/* 只在新建时出现：编辑一条已有任务时不该让模型改它的规则 */}
      {editing ? null : <AssistantBox timeZone={timeZone} onDraft={applyDraft} />}
      <Field label="标题" required error={form.errors.title}>
        {(id) => (
          <Input id={id} maxLength={120} placeholder="例如：每天九点提醒我写日报" {...form.text('title')} />
        )}
      </Field>
      <Field label="要做的事" required error={form.errors.prompt} help="到点后，我就按这句话去做。">
        {(id) => (
          <Textarea
            id={id}
            rows={3}
            maxLength={4000}
            placeholder="例如：把今天的进展写下来，发给我"
            {...form.text('prompt')}
          />
        )}
      </Field>

      {/* Field 的节点头带 role="group"：预设下拉就放在这一组里 */}
      <Field
        label="时间规则"
        error={ruleProblem}
        help={preview ? '到点会：' + preview : '按你电脑上的时区算，写 9:00 就是当地 9:00。'}
      >
        <div>
          <Select
            block
            value={draft.kind}
            options={PRESETS.map((item) => ({ value: item.value, label: item.label }))}
            onChange={(option) => setDraft(defaultDraft(option.value as PresetKind))}
          />
          <DraftFields draft={draft} onChange={setDraft} />
        </div>
      </Field>

      <Field
        label="执行位置"
        help={
          place === 'fixed'
            ? '给这条任务建一个后台对话，每次都在那里跑，你能翻回去看。'
            : '每次到点都新开一段对话来跑，各次的记录分开。'
        }
      >
        <RadioGroup<Place>
          aria-label="执行位置"
          direction="row"
          value={place}
          onChange={(next) => {
            setPlace(next);
            setPlaceTouched(true);
          }}
        >
          <RadioGroup.Item value="fixed">固定对话</RadioGroup.Item>
          <RadioGroup.Item value="new_once">每次新建对话</RadioGroup.Item>
        </RadioGroup>
      </Field>

      {problem?.where === 'save' ? (
        <div className="kw-field-note" role="alert">
          {problem.message}
        </div>
      ) : null}
    </Dialog>
  );
}

/** 预设下面那几格参数：选哪种预设就只显示哪种。 */
function DraftFields({
  draft,
  onChange,
}: {
  readonly draft: Draft;
  readonly onChange: (next: Draft) => void;
}) {
  switch (draft.kind) {
    case 'once':
      return (
        <Field label="哪一天和几点">
          {(id) => (
            <Input
              id={id}
              type="datetime-local"
              value={draft.at}
              onChange={(event) => onChange({ ...draft, at: event.target.value })}
            />
          )}
        </Field>
      );
    case 'minutes':
    case 'hours':
      return (
        <Field
          label="间隔"
          help={draft.kind === 'minutes' ? `最少 ${MIN_INTERVAL_MINUTES} 分钟一次。` : '每几小时一次。'}
        >
          {(id) => (
            <NumberInput
              id={id}
              className="kw-input-narrow"
              min={draft.kind === 'minutes' ? MIN_INTERVAL_MINUTES : 1}
              max={999}
              value={draft.every}
              onChange={(every) => onChange({ ...draft, every })}
            />
          )}
        </Field>
      );
    case 'daily':
      return (
        <>
          <Field label="间隔" help="每几天跑一次。">
            {(id) => (
              <NumberInput
                id={id}
                className="kw-input-narrow"
                min={1}
                max={999}
                value={draft.every}
                onChange={(every) => onChange({ ...draft, every })}
              />
            )}
          </Field>
          <Field label="时刻" help="可以填多个，用逗号隔开，例如：09:00, 18:30（每个时刻是一条任务）。">
            {(id) => (
              <Input
                id={id}
                value={draft.times}
                placeholder="09:00, 18:30"
                onChange={(event) => onChange({ ...draft, times: event.target.value })}
              />
            )}
          </Field>
        </>
      );
    case 'workdays':
      return (
        <>
          <Field label="间隔" help="每几周跑一次。">
            {(id) => (
              <NumberInput
                id={id}
                className="kw-input-narrow"
                min={1}
                max={999}
                value={draft.every}
                onChange={(every) => onChange({ ...draft, every })}
              />
            )}
          </Field>
          <Field label="时刻">
            {(id) => (
              <Input
                id={id}
                type="time"
                value={draft.time}
                onChange={(event) => onChange({ ...draft, time: event.target.value })}
              />
            )}
          </Field>
        </>
      );
    case 'weekly':
      return (
        <>
          <Field label="间隔" help="每几周跑一次。">
            {(id) => (
              <NumberInput
                id={id}
                className="kw-input-narrow"
                min={1}
                max={999}
                value={draft.every}
                onChange={(every) => onChange({ ...draft, every })}
              />
            )}
          </Field>
          <Field label="哪几天">
            <div className="kw-check-list">
              {DAYS.map((day) => (
                <Checkbox
                  key={day.value}
                  label={day.label}
                  checked={draft.days.includes(day.value)}
                  onCheckedChange={(next) =>
                    onChange({
                      ...draft,
                      days: next ? [...draft.days, day.value] : draft.days.filter((one) => one !== day.value),
                    })
                  }
                />
              ))}
            </div>
          </Field>
          <Field label="时刻">
            {(id) => (
              <Input
                id={id}
                type="time"
                value={draft.time}
                onChange={(event) => onChange({ ...draft, time: event.target.value })}
              />
            )}
          </Field>
        </>
      );
    case 'monthly':
      return (
        <>
          <Field label="间隔" help="每几个月跑一次。">
            {(id) => (
              <NumberInput
                id={id}
                className="kw-input-narrow"
                min={1}
                max={999}
                value={draft.every}
                onChange={(every) => onChange({ ...draft, every })}
              />
            )}
          </Field>
          <Field label="每月哪一天" help="填 1 到 31；填 -1 表示月末。">
            {(id) => (
              <NumberInput
                id={id}
                className="kw-input-narrow"
                min={-1}
                max={31}
                value={draft.day}
                onChange={(day) => onChange({ ...draft, day })}
              />
            )}
          </Field>
          <Field label="时刻">
            {(id) => (
              <Input
                id={id}
                type="time"
                value={draft.time}
                onChange={(event) => onChange({ ...draft, time: event.target.value })}
              />
            )}
          </Field>
        </>
      );
    case 'custom':
      return (
        <Field label="规则文本" help="认得 RRULE 的直接写，时区照你自己写的那行。">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={draft.rrule}
              onChange={(event) => onChange({ ...draft, rrule: event.target.value })}
            />
          )}
        </Field>
      );
  }
}

export default AutomationForm;
