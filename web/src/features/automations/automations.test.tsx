/**
 * 「自动化」页：两个视图各列自己的任务、读不到时明确说「暂时读不到」、时间规则的中文说法、点开投递记录，
 * 以及「最近一次跑成没跑成」——结果由业务服务补在 lastRun 上，跑过的那一行链到那一次的对话，
 * 「跳过」没有对话，只有一句说明。时间规则的中文描述不单独测 model，按 plan-2 的口径从页面上看（行里写的那句话
 * 就是用户看到的那句）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '../../test/user';
import { jsonResponse, ME, renderWithApp, routeFetch } from '../../test/render';
import { useConfirmState } from '../../ui/confirmStore';
import { useToasts } from '../../ui/toastStore';
import AutomationsPage from './AutomationsPage';
import { buildRules, describeRule, type Preset } from './model';

afterEach(() => {
  vi.unstubAllGlobals();
  useToasts.getState().clear();
  useConfirmState.setState({ pending: null });
});

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

/** 四个动作的假响应：没登记的请求会 404，所以每个用例都得把要点的那个动作登记上。 */
const actions = (extra: Record<string, unknown> = {}) => ({
  [`POST ${B}/automations/*/pause`]: jsonResponse({ id: 'schedule-1' }),
  [`POST ${B}/automations/*/resume`]: jsonResponse({ id: 'schedule-1' }),
  [`POST ${B}/automations/*/run`]: jsonResponse({ id: 'schedule-1' }),
  [`DELETE ${B}/automations/*`]: jsonResponse({ id: 'schedule-1', deleted: true }),
  ...extra,
});

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

  it('最近一次跑成没跑成：跑完 · 时间，点得到那一次的对话', async () => {
    api([
      task({
        title: '每日站会提醒',
        lastRun: {
          status: 'completed',
          at: '2026-11-12T01:30:00+00:00',
          conversationId: 'c_new',
          title: '自动化',
          note: null,
        },
      }),
    ]);
    renderWithApp(<AutomationsPage />, { route: '/automations' });

    const row = await rowOf('每日站会提醒');
    expect(row).toHaveTextContent('跑完 · 2026-11-12 09:30');
    // 「每次新建对话」的任务每一轮都在新对话里：这一下要落到那一次新开的对话
    expect(within(row).getByRole('link')).toHaveAttribute('href', '/chat/c_new');
  });

  it('跳过的那一次没有对话可去：写着原因，不做成链接', async () => {
    api([
      task({
        title: '每日站会提醒',
        lastRun: {
          status: 'skipped',
          at: '2026-11-12T01:30:00+00:00',
          conversationId: null,
          title: null,
          note: '到点时上一轮还没结束，这一次跳过了',
        },
      }),
    ]);
    renderWithApp(<AutomationsPage />, { route: '/automations' });

    const row = await rowOf('每日站会提醒');
    expect(row).toHaveTextContent('跳过 · 2026-11-12 09:30');
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
    // 没有对话可去时，用 title 把「为什么跳过」挂上，鼠标停一下就看得到
    expect(within(row).getByTitle('到点时上一轮还没结束，这一次跳过了')).toBeInTheDocument();
  });

  it('还没跑过的任务说「还没有跑过」，不装作失败', async () => {
    api([task({ title: '每日站会提醒', lastRun: null })]);
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    expect(await rowOf('每日站会提醒')).toHaveTextContent('还没有跑过');
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

  it('投递记录里每一次都写着结果，跳过的那次排在最新、没有投递时间', async () => {
    // 业务服务在看最近一页时把「跳过」补成一条合成记录（skipped + note，没有 deliveredAt）
    const fetch = api([task({ id: 'schedule-1', title: '每日站会提醒' })], {
      [`GET ${B}/automations/schedule-1/history`]: jsonResponse({
        id: 'schedule-1',
        records: [
          {
            scheduledAt: '2026-11-12T01:30:00+00:00',
            deliveredAt: null,
            messageId: 'skipped:2026-11-12T01:30:00Z',
            targetSessionId: null,
            targetTitle: null,
            prompt: '提醒我准备站会材料',
            status: 'skipped',
            skipped: true,
            note: '到点时上一轮还没结束，这一次跳过了',
          },
          {
            scheduledAt: '2026-11-11T01:30:00+00:00',
            deliveredAt: '2026-11-11T01:30:03+00:00',
            messageId: 'm1',
            targetSessionId: 'c_chat',
            targetTitle: '站会准备',
            prompt: '提醒我准备站会材料',
            status: 'failed',
            skipped: false,
            note: null,
          },
        ],
        nextBefore: null,
        earlierRecordsUnavailable: false,
      }),
    });
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    await userEvent.click(within(await rowOf('每日站会提醒')).getByRole('button', { name: '查看' }));

    const sheet = await screen.findByRole('dialog');
    const skipped = (await within(sheet).findByText('第 2 次')).closest('tr') as HTMLElement;
    expect(within(skipped).getAllByText('跳过')).toHaveLength(1);
    // 合成的那条没有投递时间：写 — 而不是留白
    expect(within(skipped).getAllByText('—').length).toBeGreaterThan(0);
    const ran = within(sheet).getByText('第 1 次').closest('tr') as HTMLElement;
    expect(within(ran).getByText('失败')).toBeInTheDocument();
    expect(fetch.find('GET', `${B}/automations/schedule-1/history`)).toHaveLength(1);
  });

  it('点「暂停」发 POST .../pause，成功后提示已暂停', async () => {
    const fetch = api([task()], actions());
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    const row = await rowOf('每日站会提醒');
    await userEvent.click(within(row).getByRole('button', { name: '暂停' }));

    expect(fetch.find('POST', `${B}/automations/schedule-1/pause`)).toHaveLength(1);
    expect(await screen.findByText('已暂停')).toBeInTheDocument();
  });

  it('已暂停的任务显示「恢复」，点它发 POST .../resume', async () => {
    const fetch = api([task({ status: 'paused' })], actions());
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    const row = await rowOf('每日站会提醒');
    expect(within(row).queryByRole('button', { name: '暂停' })).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: '恢复' }));

    expect(fetch.find('POST', `${B}/automations/schedule-1/resume`)).toHaveLength(1);
    expect(await screen.findByText('已恢复')).toBeInTheDocument();
  });

  it('自动暂停的任务显著标「已自动暂停」与原因，点「恢复」发 POST .../resume', async () => {
    const reason = '连续 3 次运行失败，已自动暂停';
    const fetch = api(
      [task({ status: 'paused', autoPaused: { reason, at: '2026-11-11T10:00:00+00:00' } })],
      actions(),
    );
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    const row = await rowOf('每日站会提醒');
    expect(within(row).getByText('已自动暂停')).toBeInTheDocument();
    expect(within(row).getByText(reason)).toBeInTheDocument();
    expect(within(row).queryByText('已暂停')).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: '恢复' }));

    expect(fetch.find('POST', `${B}/automations/schedule-1/resume`)).toHaveLength(1);
    expect(await screen.findByText('已恢复')).toBeInTheDocument();
  });

  it('普通暂停（没有 autoPaused）只显示「已暂停」，不误报自动暂停', async () => {
    api([task({ status: 'paused', autoPaused: null })], actions());
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    const row = await rowOf('每日站会提醒');
    expect(within(row).getByText('已暂停')).toBeInTheDocument();
    expect(within(row).queryByText('已自动暂停')).not.toBeInTheDocument();
  });

  it('运行中的任务即使后端给了 autoPaused 也不显示自动暂停', async () => {
    const reason = '连续 3 次运行失败，已自动暂停';
    api([task({ status: 'active', autoPaused: { reason, at: null } })], actions());
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    const row = await rowOf('每日站会提醒');
    expect(within(row).getByText('运行中')).toBeInTheDocument();
    expect(within(row).queryByText('已自动暂停')).not.toBeInTheDocument();
    expect(within(row).queryByText(reason)).not.toBeInTheDocument();
  });

  it('正在执行或排队的任务：「立即运行」不可点，并说明原因', async () => {
    api([task({ executionActive: true })], actions());
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    const row = await rowOf('每日站会提醒');
    const run = within(row).getByRole('button', { name: '立即运行' });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', '这个任务正在运行或排队，等它结束再试');
  });

  it('点「立即运行」发 POST .../run，成功后提示已立即运行', async () => {
    const fetch = api([task()], actions());
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    const row = await rowOf('每日站会提醒');
    await userEvent.click(within(row).getByRole('button', { name: '立即运行' }));

    expect(fetch.find('POST', `${B}/automations/schedule-1/run`)).toHaveLength(1);
    expect(await screen.findByText('已立即运行')).toBeInTheDocument();
  });

  it('点「删除」先确认，确认后发 DELETE 并重新拉列表', async () => {
    const fetch = api([task()], actions());
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    const row = await rowOf('每日站会提醒');
    await userEvent.click(within(row).getByRole('button', { name: '删除' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('删除这条定时任务？')).toBeInTheDocument();
    expect(
      within(dialog).getByText('删掉后不再触发，但已经跑过的对话和消息还留着，可以照常打开。'),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    expect(fetch.find('DELETE', `${B}/automations/schedule-1`)).toHaveLength(1);
    expect(await screen.findByText('已删除')).toBeInTheDocument();
    // 成功后让列表失效重拉：刷新过的列表里已经没有这条
    expect(fetch.find('GET', `${B}/automations`).length).toBeGreaterThan(1);
  });

  it('删除确认框点「取消」不发 DELETE', async () => {
    const fetch = api([task()], actions());
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    const row = await rowOf('每日站会提醒');
    await userEvent.click(within(row).getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(fetch.find('DELETE', `${B}/automations/schedule-1`)).toHaveLength(0);
  });

  it('宿主回 409 正在运行/排队时，toast 原样显示服务端的话', async () => {
    const fetch = api(
      [task()],
      actions({
        [`POST ${B}/automations/*/run`]: jsonResponse(
          {
            detail: {
              code: 'schedule_execution_pending',
              message: '这个任务正在运行或排队，等它结束再试',
            },
          },
          409,
        ),
      }),
    );
    renderWithApp(<AutomationsPage />, { route: '/automations' });
    const row = await rowOf('每日站会提醒');
    await userEvent.click(within(row).getByRole('button', { name: '立即运行' }));

    expect(fetch.find('POST', `${B}/automations/schedule-1/run`)).toHaveLength(1);
    expect(await screen.findByRole('alert')).toHaveTextContent('这个任务正在运行或排队，等它结束再试');
  });
});
