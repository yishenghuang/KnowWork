/**
 * 「一句话生成草稿」：把一句话发出去、草稿填进表单、模型没给的部分保持原样。
 * 两条最容易写错的验收在这里盯着：生成草稿不建任务（AC3），时间规则认不出预设时落成「自定义」而不是拒绝（AC4）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '../../test/user';
import { jsonResponse, ME, renderWithApp, routeFetch } from '../../test/render';
import { browserTimeZone } from '../../api/conversations';
import AutomationsPage from './AutomationsPage';

afterEach(() => vi.unstubAllGlobals());

const B = '/api/workspaces/default';
const TZ = browserTimeZone() ?? 'Etc/UTC';
const DRAFT = `${B}/automations/draft`;
const CREATE = `${B}/automations`;

/** 草稿接口的返回：没提到的字段就是 null。 */
const draft = (over: Record<string, unknown> = {}) =>
  jsonResponse({ title: null, prompt: null, timing: null, target: null, note: null, ...over });

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

function setup(extra: Record<string, unknown> = {}) {
  const fetch = routeFetch({
    'GET /api/auth/me': jsonResponse(ME),
    [`GET ${B}/automations`]: jsonResponse({ items: [], total: 0, limit: 100, offset: 0 }),
    ...extra,
  });
  renderWithApp(<AutomationsPage />, { route: '/automations' });
  return fetch;
}

async function openCreate(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole('button', { name: '新建任务' }));
  return screen.findByRole('dialog');
}

/** 写一句话，点「生成草稿」。 */
async function ask(form: HTMLElement, said = '每天早上九点提醒我把日报交了') {
  fireEvent.change(within(form).getByLabelText('用一句话生成'), { target: { value: said } });
  await userEvent.click(within(form).getByRole('button', { name: '生成草稿' }));
}

const titleOf = (form: HTMLElement) => (within(form).getByLabelText(/标题/) as HTMLInputElement).value;
const promptOf = (form: HTMLElement) =>
  (within(form).getByLabelText(/要做的事/) as HTMLTextAreaElement).value;
/** 时间规则那一组里显示的预设名。 */
const presetOf = (form: HTMLElement) =>
  within(within(form).getByRole('group', { name: '时间规则' })).getByRole('button');
/** 执行位置那一组单选：组件库渲染出来是 role="radio" 的按钮，选中看 aria-checked。 */
const picked = (form: HTMLElement, name: string) =>
  within(form).getByRole('radio', { name }).getAttribute('aria-checked');

describe('用一句话生成草稿', () => {
  it('把这句话连同浏览器时区发给业务服务，这条路上不建任务', async () => {
    const fetch = setup({
      [`POST ${DRAFT}`]: draft({
        title: '交日报',
        prompt: '提醒我把今天的日报交了',
        timing: { preset: { kind: 'daily', every: 1, times: ['09:00'] } },
        target: 'new_once',
      }),
    });
    const form = await openCreate();
    await ask(form);

    const calls = await waitFor(() => {
      const found = fetch.find('POST', DRAFT);
      expect(found).toHaveLength(1);
      return found;
    });
    expect(calls[0]!.body).toEqual({ text: '每天早上九点提醒我把日报交了', timeZone: TZ });
    // AC3：生成草稿只是填表单，没有任何一条新建任务的请求
    expect(fetch.find('POST', CREATE)).toHaveLength(0);
    // 表单还开着，等用户确认
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('草稿把标题、要做的事、时间规则、执行位置一起填好', async () => {
    setup({
      [`POST ${DRAFT}`]: draft({
        title: '交日报',
        prompt: '提醒我把今天的日报交了',
        timing: { preset: { kind: 'daily', every: 1, times: ['09:00'] } },
        target: 'fixed',
      }),
    });
    const form = await openCreate();
    await ask(form);

    await waitFor(() => expect(titleOf(form)).toBe('交日报'));
    expect(promptOf(form)).toBe('提醒我把今天的日报交了');
    expect(presetOf(form)).toHaveTextContent('每天');
    expect(screen.getByText(/到点会：每天 09:00/)).toBeInTheDocument();
    expect(picked(form, '固定对话')).toBe('true');
    expect(await screen.findByText('草稿填好了，看一眼再点保存')).toBeInTheDocument();
  });

  it('点「保存」之后才真的建出一条任务', async () => {
    const fetch = setup({
      [`POST ${DRAFT}`]: draft({
        title: '交日报',
        prompt: '提醒我把今天的日报交了',
        timing: { preset: { kind: 'daily', every: 1, times: ['09:00'] } },
        target: 'new_once',
      }),
      [`POST ${CREATE}`]: saved(),
    });
    const form = await openCreate();
    await ask(form);
    await waitFor(() => expect(titleOf(form)).toBe('交日报'));
    expect(fetch.find('POST', CREATE)).toHaveLength(0);

    // AC3：只有用户点保存，任务才被创建
    await userEvent.click(within(form).getByRole('button', { name: '保存' }));
    const posts = await waitFor(() => {
      const found = fetch.find('POST', CREATE);
      expect(found).toHaveLength(1);
      return found;
    });
    const body = posts[0]!.body as { title: string; rrule: string; target: unknown };
    expect(body.title).toBe('交日报');
    expect(body.rrule.split('\n').at(-1)).toBe('RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0');
    expect(body.target).toEqual({ kind: 'new_once' });
  });

  it('时间规则落在预设之外时回退成「自定义」，保存时把那行原文原样发出去', async () => {
    const rrule = 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1';
    const fetch = setup({
      [`POST ${DRAFT}`]: draft({ title: '年检', timing: { rrule } }),
      [`POST ${CREATE}`]: saved(),
    });
    const form = await openCreate();
    await ask(form);

    await waitFor(() => expect(presetOf(form)).toHaveTextContent('自定义'));
    expect(within(form).getByLabelText('规则文本')).toHaveValue(rrule);

    // 模型没给提示词，保存得自己补一条
    fireEvent.change(within(form).getByLabelText(/要做的事/), { target: { value: '提醒我去做年检' } });
    await userEvent.click(within(form).getByRole('button', { name: '保存' }));
    const posts = await waitFor(() => {
      const found = fetch.find('POST', CREATE);
      expect(found).toHaveLength(1);
      return found;
    });
    // 自定义那一条以用户写的为准，原样发出去
    expect((posts[0]!.body as { rrule: string }).rrule.split('\n').at(-1)).toBe(rrule);
  });

  it('草稿只给了标题时，其余字段保持原样', async () => {
    setup({ [`POST ${DRAFT}`]: draft({ title: '交日报' }) });
    const form = await openCreate();
    await ask(form);

    await waitFor(() => expect(titleOf(form)).toBe('交日报'));
    // AC2：没提到的字段不动——提示词还是空的，时间规则还是默认的「每天 09:00」
    expect(promptOf(form)).toBe('');
    expect(presetOf(form)).toHaveTextContent('每天');
    expect(screen.getByText(/到点会：每天 09:00/)).toBeInTheDocument();
    expect(picked(form, '每次新建对话')).toBe('true');
  });

  it('模型用不了时只提示一句，表单里已经填的内容不变', async () => {
    setup({
      [`POST ${DRAFT}`]: jsonResponse(
        { detail: { code: 'draft_unavailable', message: '模型暂时用不了，先自己填一下表单' } },
        503,
      ),
    });
    const form = await openCreate();
    fireEvent.change(within(form).getByLabelText(/标题/), { target: { value: '自己写的标题' } });
    await ask(form);

    expect(await screen.findByText('模型暂时用不了，先自己填一下表单')).toBeInTheDocument();
    expect(titleOf(form)).toBe('自己写的标题');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('模型没听懂时把服务端那句补充显示出来', async () => {
    setup({ [`POST ${DRAFT}`]: draft({ note: '没听懂这句话，把它写得更具体些，或者直接填表单' }) });
    const form = await openCreate();
    await ask(form);

    expect(await screen.findByText('没听懂这句话，把它写得更具体些，或者直接填表单')).toBeInTheDocument();
  });
});
