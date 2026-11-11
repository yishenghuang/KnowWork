/**
 * 管理端的「自动化审计」：本空间全部任务（谁建的、什么规则、现在还跑不跑、最近一次跑成什么样），
 * 按创建者与状态筛选，以及停用——停用是本页唯一的写动作，已暂停的行没有这个按钮。
 * 读失败必须说「暂时读不到」而不是渲染空列表：管理员会以为大家的任务都没了。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { pickOption } from '../../../test/user';
import { jsonResponse, ME, renderWithApp, routeFetch } from '../../../test/render';
import { useConfirmState } from '../../../ui/confirmStore';
import { useToasts } from '../../../ui/toastStore';
import { buildRules } from '../../automations/model';
import AutomationsPage from './AutomationsPage';

afterEach(() => {
  vi.unstubAllGlobals();
  useToasts.getState().clear();
  useConfirmState.setState({ pending: null });
});

const B = '/api/workspaces/default';
const TZ = 'Asia/Shanghai';

/** 业务服务给的一条：宿主 entry + 补的 owner、creatorName、origin、lastRun。 */
const task = (over: Record<string, unknown> = {}) => ({
  id: 'schedule-1',
  kind: 'rrule',
  title: '每日站会提醒',
  prompt: '提醒我准备站会材料',
  rrule: buildRules({ kind: 'workdays', every: 1, time: '09:30' }, TZ)[0],
  scheduledAt: '2026-11-12T01:30:00+00:00',
  status: 'active',
  origin: 'page',
  owner: { workspaceId: 'default', userId: 'u1' },
  creatorName: '张三',
  lastRun: {
    status: 'completed',
    at: '2026-11-11T01:30:00+00:00',
    conversationId: 'c_chat',
    title: '自动化',
    note: null,
  },
  target: { kind: 'session', sessionId: 'c_chat' },
  ...over,
});

function api(items: readonly unknown[], extra: Record<string, unknown> = {}) {
  return routeFetch({
    'GET /api/auth/me': jsonResponse(ME),
    [`GET ${B}/automations/admin`]: jsonResponse({ items, total: items.length }),
    ...extra,
  });
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

describe('管理端自动化审计', () => {
  it('列出本空间全部任务：创建者、时间规则、状态、最近一次', async () => {
    api([
      task({ id: 'schedule-a', title: '每日站会提醒' }),
      task({
        id: 'schedule-b',
        title: '周报汇总',
        status: 'paused',
        owner: { workspaceId: 'default', userId: 'u2' },
        creatorName: '李四',
        rrule: buildRules({ kind: 'weekly', every: 1, days: ['MO'], time: '10:00' }, TZ)[0],
        lastRun: null,
      }),
    ]);
    renderWithApp(<AutomationsPage />, { route: '/admin/automations' });

    const first = await rowOf('每日站会提醒');
    expect(within(first).getByText('张三')).toBeInTheDocument();
    expect(within(first).getByText('工作日 09:30')).toBeInTheDocument();
    expect(within(first).getByText('运行中')).toBeInTheDocument();
    expect(first).toHaveTextContent('跑完 · 2026-11-11 09:30');
    expect(within(first).getByRole('link')).toHaveAttribute('href', '/chat/c_chat');

    const second = await rowOf('周报汇总');
    expect(within(second).getByText('李四')).toBeInTheDocument();
    expect(within(second).getByText('每周一 10:00')).toBeInTheDocument();
    expect(within(second).getByText('已暂停')).toBeInTheDocument();
    expect(second).toHaveTextContent('还没有跑过');
  });

  it('创建者姓名读不到时退回用户 id，不写「未知」', async () => {
    api([task({ creatorName: null, owner: { workspaceId: 'default', userId: 'u9' } })]);
    renderWithApp(<AutomationsPage />, { route: '/admin/automations' });
    expect(within(await rowOf('每日站会提醒')).getByText('u9')).toBeInTheDocument();
  });

  it('按创建者筛选，只留这个人建的', async () => {
    api([
      task({ id: 'schedule-a', title: '每日站会提醒' }),
      task({
        id: 'schedule-b',
        title: '周报汇总',
        owner: { workspaceId: 'default', userId: 'u2' },
        creatorName: '李四',
      }),
    ]);
    renderWithApp(<AutomationsPage />, { route: '/admin/automations' });
    await rowOf('周报汇总');

    await pickOption(document.body, '创建者', '张三');
    await waitFor(() => expect(screen.queryByText('周报汇总')).not.toBeInTheDocument());
    expect(screen.getByText('每日站会提醒')).toBeInTheDocument();
  });

  it('按状态筛选，只留这一种状态', async () => {
    api([
      task({ id: 'schedule-a', title: '每日站会提醒' }),
      task({ id: 'schedule-b', title: '周报汇总', status: 'paused' }),
    ]);
    renderWithApp(<AutomationsPage />, { route: '/admin/automations' });
    await rowOf('每日站会提醒');

    await pickOption(document.body, '状态', '已暂停');
    await waitFor(() => expect(screen.queryByText('每日站会提醒')).not.toBeInTheDocument());
    expect(screen.getByText('周报汇总')).toBeInTheDocument();
  });

  it('停用：先确认，确认后发 POST .../disable 并重新拉列表', async () => {
    let paused = false;
    const fetch = routeFetch({
      'GET /api/auth/me': jsonResponse(ME),
      [`GET ${B}/automations/admin`]: () =>
        jsonResponse({ items: [task({ status: paused ? 'paused' : 'active' })], total: 1 }),
      [`POST ${B}/automations/admin/schedule-1/disable`]: () => {
        paused = true;
        return jsonResponse({ id: 'schedule-1', status: 'paused' });
      },
    });
    renderWithApp(<AutomationsPage />, { route: '/admin/automations' });
    const row = await rowOf('每日站会提醒');
    await userEvent.click(within(row).getByRole('button', { name: '停用' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('停用这条定时任务？')).toBeInTheDocument();
    expect(
      within(dialog).getByText('停用后到点不再触发；创建者仍可以在自己的自动化页里恢复它。'),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '停用' }));

    expect(fetch.find('POST', `${B}/automations/admin/schedule-1/disable`)).toHaveLength(1);
    expect(await screen.findByText('已停用，到点不会再触发')).toBeInTheDocument();
    // 成功后列表失效重拉：刷新过的列表里这条已经变成「已暂停」
    await waitFor(() => expect(fetch.find('GET', `${B}/automations/admin`).length).toBeGreaterThan(1));
    expect(await screen.findByText('已暂停')).toBeInTheDocument();
  });

  it('确认框点「取消」不发停用请求', async () => {
    const fetch = api([task()]);
    renderWithApp(<AutomationsPage />, { route: '/admin/automations' });
    const row = await rowOf('每日站会提醒');
    await userEvent.click(within(row).getByRole('button', { name: '停用' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(fetch.find('POST', `${B}/automations/admin/schedule-1/disable`)).toHaveLength(0);
  });

  it('已暂停与已结束的任务没有「停用」按钮', async () => {
    api([
      task({ id: 'schedule-a', title: '每日站会提醒', status: 'paused' }),
      task({ id: 'schedule-b', title: '周报汇总', status: 'ended' }),
    ]);
    renderWithApp(<AutomationsPage />, { route: '/admin/automations' });
    expect(within(await rowOf('每日站会提醒')).queryByRole('button', { name: '停用' })).toBeNull();
    expect(within(await rowOf('周报汇总')).queryByRole('button', { name: '停用' })).toBeNull();
  });

  it('停用失败时把服务端的话原样提示出来', async () => {
    api([task()], {
      [`POST ${B}/automations/admin/schedule-1/disable`]: jsonResponse(
        { detail: { code: 'schedule_conflict', message: '任务刚被改过，请刷新后再改' } },
        409,
      ),
    });
    renderWithApp(<AutomationsPage />, { route: '/admin/automations' });
    const row = await rowOf('每日站会提醒');
    await userEvent.click(within(row).getByRole('button', { name: '停用' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '停用' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('任务刚被改过，请刷新后再改');
  });

  it('读不出来时说「暂时读不到」，不当成空列表', async () => {
    routeFetch({
      'GET /api/auth/me': jsonResponse(ME),
      [`GET ${B}/automations/admin`]: jsonResponse(
        { detail: { code: 'schedule_unavailable', message: '暂时读不到定时任务，请稍后重试' } },
        503,
      ),
    });
    renderWithApp(<AutomationsPage />, { route: '/admin/automations' });

    expect(await screen.findByText('暂时读不到任务列表')).toBeInTheDocument();
    expect(screen.getByText('暂时读不到定时任务，请稍后重试')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.queryByText('这个空间还没有定时任务')).not.toBeInTheDocument();
  });

  it('普通用户被拒（403）时也只说读不到，不显示别人的任务', async () => {
    routeFetch({
      'GET /api/auth/me': jsonResponse(ME),
      [`GET ${B}/automations/admin`]: jsonResponse(
        { detail: '只有空间的所有者或管理员可以查看本空间的定时任务' },
        403,
      ),
    });
    renderWithApp(<AutomationsPage />, { route: '/admin/automations' });

    expect(await screen.findByText('暂时读不到任务列表')).toBeInTheDocument();
    expect(screen.getByText('只有空间的所有者或管理员可以查看本空间的定时任务')).toBeInTheDocument();
  });

  it('空间里还没有任务时说「还没有」，不是一片空白', async () => {
    api([]);
    renderWithApp(<AutomationsPage />, { route: '/admin/automations' });
    expect(await screen.findByText('这个空间还没有定时任务')).toBeInTheDocument();
  });
});
