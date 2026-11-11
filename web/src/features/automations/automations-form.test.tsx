/**
 * 「自动化」表单：八种时间规则各自存成什么、多时刻拆成几条、冲突与超限的提示、编辑时的回显。
 * 时区取浏览器时区（jsdom 里就是本机时区），所以断言按同一个时区算，不写死 Asia/Shanghai。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent, { pickOption } from '../../test/user';
import { jsonResponse, ME, renderWithApp, routeFetch } from '../../test/render';
import { browserTimeZone } from '../../api/conversations';
import AutomationsPage from './AutomationsPage';
import { buildRules, parseRule } from './model';

afterEach(() => vi.unstubAllGlobals());

const B = '/api/workspaces/default';
const TZ = browserTimeZone() ?? 'Etc/UTC';

/** 宿主返回的一条任务（业务服务透传 entry，另加 origin）。 */
const task = (over: Record<string, unknown> = {}) => ({
  id: 'schedule-1',
  kind: 'rrule',
  title: '每日站会提醒',
  prompt: '提醒我准备站会材料',
  rrule: buildRules({ kind: 'workdays', every: 1, time: '09:30' }, TZ)[0],
  scheduledAt: '2026-11-12T01:30:00+00:00',
  status: 'active',
  origin: 'page',
  target: { kind: 'session', sessionId: 'c_page' },
  createdAt: '2026-11-01T00:00:00+00:00',
  updatedAt: '2026-11-01T00:00:00+00:00',
  ...over,
});

/** 保存成功后业务服务只回这四样。 */
const saved = (id = 'schedule-new') =>
  jsonResponse(
    {
      id,
      scheduledAt: '2026-11-13T01:00:00+00:00',
      origin: 'page',
      updatedAt: '2026-11-02T00:00:00+00:00',
    },
    201,
  );

function setup(items: readonly unknown[] = [], extra: Record<string, unknown> = {}) {
  const fetch = routeFetch({
    'GET /api/auth/me': jsonResponse(ME),
    [`GET ${B}/automations`]: jsonResponse({ items, total: items.length, limit: 100, offset: 0 }),
    ...extra,
  });
  renderWithApp(<AutomationsPage />, { route: '/automations' });
  return fetch;
}

async function openCreate(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole('button', { name: '新建任务' }));
  return screen.findByRole('dialog');
}

async function openEdit(title: string): Promise<HTMLElement> {
  const cell = await screen.findByText(title);
  const row = cell.closest('tr') as HTMLElement;
  await userEvent.click(within(row).getByRole('button', { name: '编辑' }));
  return screen.findByRole('dialog');
}

function fill(form: HTMLElement, title = '每天九点写日报', prompt = '把今天的进展写下来') {
  fireEvent.change(within(form).getByLabelText(/标题/), { target: { value: title } });
  fireEvent.change(within(form).getByLabelText(/要做的事/), { target: { value: prompt } });
}

async function save(form: HTMLElement) {
  await userEvent.click(within(form).getByRole('button', { name: '保存' }));
}

/** 取 rrule 的第二行（RRULE 那一行）：DTSTART 里可能带「现在」，那一段不参与断言。 */
const ruleLine = (body: unknown) => {
  const rrule = (body as { rrule: string }).rrule;
  return rrule.split('\n').at(-1);
};

interface PresetCase {
  readonly label: string;
  readonly option: string;
  readonly apply?: (form: HTMLElement) => void;
  readonly rrule: string;
}

/** 八种预设各一遍：选预设、按需填参数，期望落在 POST body 的 RRULE 行上。 */
const CASES: readonly PresetCase[] = [
  {
    label: '一次性',
    option: '一次性',
    apply: (form) =>
      fireEvent.change(within(form).getByLabelText('哪一天和几点'), {
        target: { value: '2027-03-04T09:00' },
      }),
    rrule: 'RRULE:FREQ=DAILY;COUNT=1',
  },
  { label: '每 N 分钟', option: '每 N 分钟', rrule: 'RRULE:FREQ=MINUTELY;INTERVAL=15' },
  { label: '每 N 小时', option: '每 N 小时', rrule: 'RRULE:FREQ=HOURLY;INTERVAL=1' },
  {
    label: '每天',
    option: '每天',
    rrule: 'RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0',
  },
  {
    label: '工作日',
    option: '工作日',
    rrule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
  },
  {
    label: '每周某几天',
    option: '每周某几天',
    apply: (form) => {
      // 默认只勾了周一，再勾一个周三
      const box = within(form).getByRole('checkbox', { name: '周三' });
      fireEvent.click(box);
    },
    rrule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=0',
  },
  {
    label: '每月某日',
    option: '每月某日',
    apply: (form) => fireEvent.change(within(form).getByLabelText('每月哪一天'), { target: { value: '5' } }),
    rrule: 'RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=5,-1;BYSETPOS=1;BYHOUR=9;BYMINUTE=0',
  },
  {
    label: '自定义',
    option: '自定义',
    apply: (form) =>
      fireEvent.change(within(form).getByLabelText('规则文本'), {
        target: { value: 'DTSTART;TZID=Asia/Shanghai:20261112T090000\nRRULE:FREQ=YEARLY' },
      }),
    rrule: 'RRULE:FREQ=YEARLY',
  },
];

describe('新建任务', () => {
  it('保存后立刻出现在列表里，默认每次新建对话', async () => {
    const items: Record<string, unknown>[] = [];
    const fetch = routeFetch({
      'GET /api/auth/me': jsonResponse(ME),
      [`GET ${B}/automations`]: () => jsonResponse({ items, total: items.length, limit: 100, offset: 0 }),
      [`POST ${B}/automations`]: (call) => {
        const body = call.body as { title: string; prompt: string; rrule: string };
        items.push(
          task({
            id: 'schedule-new',
            title: body.title,
            prompt: body.prompt,
            rrule: body.rrule,
            target: { kind: 'new_once' },
            targetSessionId: null,
          }),
        );
        return saved() as Response;
      },
    });
    renderWithApp(<AutomationsPage />, { route: '/automations' });

    const form = await openCreate();
    fill(form, '每天九点写日报');
    await save(form);

    // 保存完直接能在列表里看到，弹窗关掉
    expect(await screen.findByText('每天九点写日报')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const posts = fetch.find('POST', `${B}/automations`);
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body as { target: unknown; title: string };
    expect(body.title).toBe('每天九点写日报');
    expect(body.target).toEqual({ kind: 'new_once' });
  });

  it('选「固定对话」时把执行位置一起存下去', async () => {
    const fetch = setup([], { [`POST ${B}/automations`]: saved() });
    const form = await openCreate();
    fill(form);
    await userEvent.click(within(form).getByRole('radio', { name: '固定对话' }));
    await save(form);

    const posts = await waitFor(() => {
      const found = fetch.find('POST', `${B}/automations`);
      expect(found).toHaveLength(1);
      return found;
    });
    expect((posts[0]!.body as { target: unknown }).target).toEqual({ kind: 'fixed' });
  });

  it('「每天 09:00, 18:30」一次保存建出两条任务', async () => {
    const fetch = setup([], { [`POST ${B}/automations`]: saved() });
    const form = await openCreate();
    fill(form);
    fireEvent.change(within(form).getByLabelText('时刻'), {
      target: { value: '09:00, 18:30' },
    });
    await save(form);

    const posts = await waitFor(() => {
      const found = fetch.find('POST', `${B}/automations`);
      expect(found).toHaveLength(2);
      return found;
    });
    expect(posts.map((call) => ruleLine(call.body))).toEqual([
      'RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0',
      'RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=18;BYMINUTE=30',
    ]);
  });

  for (const one of CASES) {
    it(`「${one.label}」存成 ${one.rrule}`, async () => {
      const fetch = setup([], { [`POST ${B}/automations`]: saved() });
      const form = await openCreate();
      fill(form);
      await pickOption(form, '时间规则', one.option);
      one.apply?.(form);
      await save(form);

      const posts = await waitFor(() => {
        const found = fetch.find('POST', `${B}/automations`);
        expect(found).toHaveLength(1);
        return found;
      });
      expect(ruleLine(posts[0]!.body)).toBe(one.rrule);
      const rrule = (posts[0]!.body as { rrule: string }).rrule;
      // 时区照浏览器那一个写进 DTSTART；自定义那条以用户自己写的为准
      if (one.option !== '自定义') expect(rrule.startsWith(`DTSTART;TZID=${TZ}:`)).toBe(true);
    });
  }

  it('别人刚改过时提示刷新，不静默覆盖', async () => {
    setup([], {
      [`POST ${B}/automations`]: jsonResponse(
        { detail: { code: 'schedule_conflict', message: '任务刚被改过，请刷新后再改' } },
        409,
      ),
    });
    const form = await openCreate();
    fill(form);
    await save(form);

    expect(await screen.findByText('任务刚被改过，请刷新后再改')).toBeInTheDocument();
    // 没保存成功就别关窗，否则用户以为改上了
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('间隔少于 5 分钟时在时间规则上说明原因', async () => {
    setup([], {
      [`POST ${B}/automations`]: jsonResponse(
        { detail: { code: 'interval_too_short', message: '间隔不能小于 5 分钟' } },
        422,
      ),
    });
    const form = await openCreate();
    fill(form);
    await save(form);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('间隔不能小于 5 分钟');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('条数到上限时把原因说在表单上', async () => {
    setup([], {
      [`POST ${B}/automations`]: jsonResponse(
        {
          detail: {
            code: 'quota_exceeded',
            message: '每个人最多 20 条定时任务，先删掉不用的再建',
          },
        },
        422,
      ),
    });
    const form = await openCreate();
    fill(form);
    await save(form);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('每个人最多 20 条定时任务，先删掉不用的再建');
  });
});

describe('编辑任务', () => {
  it('按原规则回显同一预设，保存时带上列表里那一版的时间戳', async () => {
    const original = buildRules({ kind: 'workdays', every: 1, time: '09:30' }, TZ)[0]!;
    const fetch = setup([task({ rrule: original })], {
      [`PATCH ${B}/automations/schedule-1`]: jsonResponse({
        id: 'schedule-1',
        scheduledAt: '2026-11-12T01:30:00+00:00',
        origin: 'page',
        updatedAt: '2026-11-02T00:00:00+00:00',
      }),
    });

    const form = await openEdit('每日站会提醒');
    expect(within(form).getByText('编辑任务')).toBeInTheDocument();
    // 回显：预设停在「工作日」，时刻还是原来那个
    expect(
      within(within(form).getByRole('group', { name: '时间规则' })).getByRole('button'),
    ).toHaveTextContent('工作日');
    expect(within(form).getByLabelText('时刻')).toHaveValue('09:30');

    await save(form);
    const patches = await waitFor(() => {
      const found = fetch.find('PATCH', `${B}/automations/schedule-1`);
      expect(found).toHaveLength(1);
      return found;
    });
    const body = patches[0]!.body as {
      rrule: string;
      expectedUpdatedAt?: string;
      target?: unknown;
    };
    expect(body.rrule).toBe(original);
    expect(parseRule(body.rrule).kind).toBe('workdays');
    expect(body.expectedUpdatedAt).toBe('2026-11-01T00:00:00+00:00');
    // 没动执行位置就别改它
    expect(body.target).toBeUndefined();
  });

  it('改了执行位置就带上新位置', async () => {
    const fetch = setup([task()], {
      [`PATCH ${B}/automations/schedule-1`]: jsonResponse({
        id: 'schedule-1',
        scheduledAt: '2026-11-12T01:30:00+00:00',
        origin: 'page',
        updatedAt: '2026-11-02T00:00:00+00:00',
      }),
    });

    const form = await openEdit('每日站会提醒');
    await userEvent.click(within(form).getByRole('radio', { name: '每次新建对话' }));
    await save(form);

    const patches = await waitFor(() => {
      const found = fetch.find('PATCH', `${B}/automations/schedule-1`);
      expect(found).toHaveLength(1);
      return found;
    });
    expect((patches[0]!.body as { target: unknown }).target).toEqual({ kind: 'new_once' });
  });
});
