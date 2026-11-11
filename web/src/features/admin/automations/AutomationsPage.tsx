/**
 * 管理端的「自动化审计」：看本空间全部定时任务，并停用其中任意一条。
 *
 * 任务都归创建者个人，普通用户在「自动化」页只看得到自己的；这里走的是另一条读口（/automations/admin），
 * 宿主不带调用者身份读全量，业务服务按任务属主筛出本空间、再逐条补创建者、origin 与 lastRun。
 * 普通用户请求同一份数据拿到的是 403，不是别人的任务——页面把 403 与读失败一样说成「暂时读不到」，
 * 不会渲染成空列表让人以为任务没了（plan-2 §4.5）。
 *
 * 管理端只有两件事：看、停用。不替别人新建，也不改任务内容（AC5）：改内容仍由创建者自己在自动化页里做，
 * 停用之后创建者也能在自己那边恢复。所以这一页没有任何新建/编辑入口，只有状态为「运行中」的行才有「停用」。
 */
import { useMemo, useState } from 'react';
import { Button } from '@openai/apps-sdk-ui/components/Button';
import { Warning } from '@openai/apps-sdk-ui/components/Icon';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  disableAdminAutomation,
  listAdminAutomations,
  type AdminAutomation,
  type LastRun as LastRunInfo,
} from '../../../api/automations';
import { readableError } from '../../../api/http';
import { confirm } from '../../../ui/confirmStore';
import { Empty } from '../../../ui/Empty';
import { FilterSelect } from '../../../ui/FilterSelect';
import { Skeleton } from '../../../ui/Skeleton';
import { Table, type Column } from '../../../ui/Table';
import { formatDateTime } from '../../../utils/format';
import { RUN_STATUS_TEXT, scheduleText, STATUS_TEXT } from '../../automations/model';
import { AdminPage, Toolbar } from '../AdminPage';
import { useAction } from '../useAction';

const KEYS = { list: ['admin', 'automations'] } as const;

type StatusFilter = 'active' | 'paused' | 'ended';

const STATUS_OPTIONS: readonly { readonly value: StatusFilter; readonly label: string }[] = [
  { value: 'active', label: STATUS_TEXT.active },
  { value: 'paused', label: STATUS_TEXT.paused },
  { value: 'ended', label: STATUS_TEXT.ended },
];

/** 最近一次跑成没跑成：跑完/取消/失败 + 那一刻，链到那一次的对话；跳过的没有对话，只有一句说明。 */
function LastRun({ run }: { readonly run: LastRunInfo | null }) {
  if (!run) return <span className="kw-secondary">还没有跑过</span>;
  const text = (
    <>
      {RUN_STATUS_TEXT[run.status]} · <span className="kw-num">{formatDateTime(run.at)}</span>
    </>
  );
  if (!run.conversationId) return <span title={run.note ?? undefined}>{text}</span>;
  return <Link to={`/chat/${encodeURIComponent(run.conversationId)}`}>{text}</Link>;
}

const COLUMNS: readonly Column<AdminAutomation>[] = [
  { key: 'title', title: '标题', width: 220, ellipsis: true, render: (task) => task.title },
  {
    key: 'creator',
    title: '创建者',
    width: 160,
    ellipsis: true,
    // 名字读不到时退回用户 id：至少还能看出是谁的，不至于写「未知」
    render: (task) => task.creatorName ?? task.creatorId ?? '—',
  },
  { key: 'rule', title: '时间规则', width: 180, ellipsis: true, render: (task) => scheduleText(task.rrule) },
  {
    key: 'next',
    title: '下次运行',
    width: 150,
    render: (task) => <span className="kw-num">{formatDateTime(task.scheduledAt)}</span>,
  },
  { key: 'lastRun', title: '最近一次', width: 210, render: (task) => <LastRun run={task.lastRun} /> },
  { key: 'status', title: '状态', width: 120, render: (task) => STATUS_TEXT[task.status] },
];

export default function AutomationsPage() {
  const [creator, setCreator] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<StatusFilter | undefined>(undefined);
  const automations = useQuery({ queryKey: KEYS.list, queryFn: listAdminAutomations });
  const disable = useAction((id: string) => disableAdminAutomation(id), {
    invalidate: [KEYS.list],
    success: '已停用，到点不会再触发',
    failure: '停用没有成功，请稍后重试',
  });

  const all = useMemo(() => automations.data?.items ?? [], [automations.data]);

  // 创建者选项跟着列表走：只列本空间里真有任务的人，不另外拉一遍成员表
  const creatorOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const task of all) {
      if (!task.creatorId) continue;
      if (!seen.has(task.creatorId)) seen.set(task.creatorId, task.creatorName ?? task.creatorId);
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [all]);

  // 选中的创建者已经不在列表里了（任务被删光）就当「全部」：不然筛选看起来永远空着
  const activeCreator =
    creator !== undefined && creatorOptions.some((option) => option.value === creator) ? creator : undefined;

  const rows = all.filter(
    (task) =>
      (activeCreator === undefined || task.creatorId === activeCreator) &&
      (status === undefined || task.status === status),
  );

  const askDisable = async (task: AdminAutomation) => {
    const ok = await confirm({
      title: '停用这条定时任务？',
      description: '停用后到点不再触发；创建者仍可以在自己的自动化页里恢复它。',
      okText: '停用',
      danger: true,
    });
    if (!ok) return;
    await disable.run(task.id);
  };

  const columns: readonly Column<AdminAutomation>[] = [
    ...COLUMNS,
    {
      key: 'actions',
      title: '操作',
      width: 100,
      // 已暂停与已结束的没有可停的：没有按钮，而不是给一个点了没反应的按钮
      render: (task) =>
        task.status === 'active' ? (
          <Button
            color="secondary"
            variant="ghost"
            size="sm"
            loading={disable.pending}
            onClick={() => void askDisable(task)}
          >
            停用
          </Button>
        ) : null,
    },
  ];

  if (automations.isError) {
    // 读失败：明确说「暂时读不到」，绝不当成空列表——那会让人以为任务都没了
    return (
      <AdminPage title="自动化审计" description="看本空间所有人的定时任务，停用其中不该再跑的。">
        <Empty
          area
          icon={<Warning />}
          title="暂时读不到任务列表"
          description={readableError(automations.error, '服务暂时不可用，请稍后重试')}
          action={
            <Button color="primary" onClick={() => void automations.refetch()}>
              重试
            </Button>
          }
        />
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title="自动化审计"
      description="本空间所有人建的定时任务：谁建的、什么时候跑、最近一次跑成什么样、现在还跑不跑。看到不该再跑的可以停用，到点就不再触发。"
    >
      <Toolbar
        left={
          <>
            <FilterSelect
              label="创建者"
              clearable
              width={160}
              options={creatorOptions}
              value={activeCreator}
              onChange={setCreator}
            />
            <FilterSelect
              label="状态"
              clearable
              width={120}
              options={STATUS_OPTIONS}
              value={status}
              onChange={setStatus}
            />
          </>
        }
      />
      {automations.isPending ? (
        <Skeleton rows={6} />
      ) : (
        <Table<AdminAutomation>
          rowKey={(task) => task.id}
          columns={columns}
          rows={rows}
          minWidth={1120}
          loading={automations.isFetching}
          pageSize={false}
          empty={all.length === 0 ? '这个空间还没有定时任务' : '没有符合条件的任务'}
          aria-label="本空间的定时任务"
        />
      )}
    </AdminPage>
  );
}
