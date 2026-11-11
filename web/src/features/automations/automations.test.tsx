/**
 * 「自动化」页：两个视图各列自己的任务、读不到时明确说「暂时读不到」、时间规则的中文说法、点开投递记录。
 * 时间规则的中文描述不单独测 model，按 plan-2 的口径从页面上看（行里写的那句话就是用户看到的那句）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '../../test/user';
import { jsonResponse, ME, renderWithApp, routeFetch } from '../../test/render';
import AutomationsPage from './AutomationsPage';
import { buildRules, describeRule, type Preset } from './model';

afterEach(() => vi.unstubAllGlobals());

const B = '/api/workspaces/default';
const TZ = 'Asia/Shanghai';

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
  ...over,
});

function api(items: readonly unknown[], extra: Record<string, unknown> = {}) {
  return routeFetch({
    'GET /api/auth/me': jsonResponse(ME),
    [`GET ${B}/automations`]: jsonResponse({ items, total: items.length, limit: 100, offset: 0 }),
    ...extra,
  });
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

describe('自动化页', () => {
  it('两个视图各列自己名下的任务', async () => {
    api([
      task({ id: 'schedule-page', title: '周报汇总', origin: 'page' }),
      task({ id: 'schedule-chat', title: '该喝水了', origin: 'chat' }),
    ]);
    renderWithApp(<AutomationsPage />, { route: '/automations' });

    // 默认打开「页面上建的」
    expect(await rowOf('周报汇总')).toBeInTheDocument();
    expect(screen.queryByText('该喝水了')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: '对话里设的提醒' }));
    expect(await rowOf('该喝水了')).toBeInTheDocument();
    expect(screen.queryByText('周报汇总')).not.toBeInTheDocument();
  });

  it('行里写着标题、中文时间规则、下次运行时间与状态', async () => {
    api([task({ title: '每日站会提醒' })]);
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    const row = await rowOf('每日站会提醒');
    expect(within(row).getByText('工作日 09:30')).toBeInTheDocument();
    expect(within(row).getByText('运行中')).toBeInTheDocument();
    expect(within(row).getByText('2026-11-12 09:30')).toBeInTheDocument();
  });

  it('八种时间规则各给一句中文（认不出的说「自定义规则」）', async () => {
    const presets: readonly Preset[] = [
      { kind: 'once', at: '2026-11-12T09:00' },
      { kind: 'minutes', every: 15 },
      { kind: 'hours', every: 2 },
      { kind: 'daily', every: 1, times: ['09:00', '18:30'] },
      { kind: 'workdays', every: 1, time: '09:30' },
      { kind: 'weekly', every: 1, days: ['MO', 'WE'], time: '10:00' },
      { kind: 'monthly', every: 1, day: -1, time: '09:00' },
      { kind: 'custom', rrule: 'DTSTART;TZID=Asia/Shanghai:20261112T090000\nRRULE:FREQ=YEARLY' },
    ];
    api(
      presets.map((preset, index) =>
        task({ id: `schedule-${index}`, title: `任务 ${index}`, rrule: buildRules(preset, TZ)[0] }),
      ),
    );
    renderWithApp(<AutomationsPage />, { route: '/automations' });

    // 每天多个时刻是两条规则，行里只显示第一条；这里逐条断言的是描述本身
    expect(await screen.findByText('一次性 2026-11-12 09:00')).toBeInTheDocument();
    expect(screen.getByText('每 15 分钟')).toBeInTheDocument();
    expect(screen.getByText('每 2 小时')).toBeInTheDocument();
    expect(screen.getByText('每天 09:00')).toBeInTheDocument();
    expect(screen.getByText('工作日 09:30')).toBeInTheDocument();
    expect(screen.getByText('每周一、周三 10:00')).toBeInTheDocument();
    expect(screen.getByText('每月最后一天 09:00')).toBeInTheDocument();
    expect(screen.getByText('自定义规则')).toBeInTheDocument();
    // 「每天 09:00 与 18:30」的第二条规则单独一句
    const daily = buildRules({ kind: 'daily', every: 1, times: ['09:00', '18:30'] }, TZ);
    expect(daily[1]).toBeDefined();
    expect(describeRule(daily[1]!)).toBe('每天 18:30');
  });

  it('宿主读不出时说明「暂时读不到」，不当成空列表', async () => {
    routeFetch({
      'GET /api/auth/me': jsonResponse(ME),
      [`GET ${B}/automations`]: jsonResponse(
        { detail: { code: 'schedule_unavailable', message: '暂时读不到定时任务，请稍后重试' } },
        503,
      ),
    });
    renderWithApp(<AutomationsPage />, { route: '/automations' });

    expect(await screen.findByText('暂时读不到任务列表')).toBeInTheDocument();
    expect(screen.getByText('暂时读不到定时任务，请稍后重试')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    // 更要紧的是：不能出现空列表的文案，否则用户会以为任务被删了
    expect(screen.queryByText('还没有定时任务')).not.toBeInTheDocument();
    expect(screen.queryByText('这一栏里还没有任务')).not.toBeInTheDocument();
  });

  it('只列服务端给的那些：别人的任务不出现，也不能拿 id 直接翻出来', async () => {
    // 服务端只返回调用者名下的任务；前端既不打听别人，也不接受「?task=<id>」这种直取
    const fetch = api([task({ id: 'schedule-mine', title: '我的周报' })]);
    renderWithApp(<AutomationsPage />, { route: '/automations?task=schedule-others' });
    await rowOf('我的周报');

    const listCalls = fetch.find('GET', `${B}/automations`);
    expect(listCalls).toHaveLength(1);
    // 不带身份参数：问的是「谁在问」由登录态决定，不由页面挑
    expect(listCalls[0]!.query.toString()).toBe('');
    expect(screen.queryByText('别人的任务')).not.toBeInTheDocument();
    // 页面上没有任何按 id 直取任务的请求（那正是别人任务 id 的入口）
    expect(fetch.calls.some((call) => call.path.includes('schedule-others'))).toBe(false);
  });

  it('点单条能打开它的投递记录：哪一次、什么时间、投到哪个对话', async () => {
    const fetch = api([task({ id: 'schedule-1', title: '每日站会提醒' })], {
      [`GET ${B}/automations/schedule-1/history`]: jsonResponse({
        id: 'schedule-1',
        records: [
          {
            scheduledAt: '2026-11-12T01:30:00+00:00',
            deliveredAt: '2026-11-12T01:30:04+00:00',
            messageId: 'm2',
            targetSessionId: 'c_chat',
            targetTitle: '站会准备',
            prompt: '提醒我准备站会材料',
          },
          {
            scheduledAt: '2026-11-11T01:30:00+00:00',
            deliveredAt: '2026-11-11T01:30:03+00:00',
            messageId: 'm1',
            targetSessionId: 'c_chat',
            targetTitle: '站会准备',
            prompt: '提醒我准备站会材料',
          },
        ],
        nextBefore: null,
        earlierRecordsUnavailable: false,
      }),
    });
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    await userEvent.click(within(await rowOf('每日站会提醒')).getByRole('button', { name: '查看' }));

    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('投递记录')).toBeInTheDocument();
    // 最新的在最上面，按发生顺序数第 2 次
    expect(within(sheet).getByText('第 2 次')).toBeInTheDocument();
    expect(within(sheet).getByText('第 1 次')).toBeInTheDocument();
    expect(within(sheet).getAllByText('2026-11-12 09:30')).toHaveLength(2);
    expect(within(sheet).getAllByText('站会准备')).toHaveLength(2);
    expect(fetch.find('GET', `${B}/automations/schedule-1/history`)).toHaveLength(1);
  });
});
