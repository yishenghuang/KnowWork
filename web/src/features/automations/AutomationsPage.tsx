/**
 * 「自动化」页（从侧栏主菜单进来，和「对话」「技能」并列）：列出我的定时任务。
 *
 * 两个视图分开放：页面上建的、对话里设的提醒。判定在业务服务做（entry.origin），这里只按它分栏，不按 target 自己猜。
 * 任务都存在宿主的官方 schedule 服务里，业务服务只转一手并按调用者筛过——别人的任务不会出现在这里，
 * 拿别人任务的 id 直接问也只会得到「没有这个定时任务」。
 *
 * 宿主暂时不可用时是「暂时读不到」，不是「没有任务」：读失败和读到空必须分得开，
 * 否则用户会以为自己的定时任务被删了（plan-2 §4.5）。
 *
 * 新建与编辑共用 AutomationForm：新建给空表单，编辑按 parseRule 把那条规则回填成同一预设，
 * 提交时带上列表里看到的 updatedAt——期间别人改过就 409，提示刷新而不是把别人的改动盖掉。
 */
import { useState } from 'react';
import { Button } from '@openai/apps-sdk-ui/components/Button';
import { Warning } from '@openai/apps-sdk-ui/components/Icon';
import { useSearchParams } from 'react-router';
import type { Automation, DeliveryRecord } from '../../api/automations';
import { readableError } from '../../api/http';
import { Empty } from '../../ui/Empty';
import { Sheet } from '../../ui/Sheet';
import { Skeleton } from '../../ui/Skeleton';
import { Table, type Column } from '../../ui/Table';
import { Tabs } from '../../ui/Tabs';
import { formatDateTime } from '../../utils/format';
import { AdminPage, Toolbar } from '../admin/AdminPage';
import AutomationForm from './AutomationForm';
import { scheduleText, STATUS_TEXT } from './model';
import { useAutomationHistory, useAutomations } from './queries';

/** 一条任务在表格里的一行：标题、中文时间规则、下次运行时间、状态。 */
const COLUMNS: readonly Column<Automation>[] = [
  { key: 'title', title: '标题', width: 220, ellipsis: true, render: (task) => task.title },
  { key: 'rule', title: '时间规则', width: 180, ellipsis: true, render: (task) => scheduleText(task.rrule) },
  {
    key: 'next',
    title: '下次运行',
    width: 150,
    render: (task) => <span className="kw-num">{formatDateTime(task.scheduledAt)}</span>,
  },
  { key: 'status', title: '状态', width: 80, render: (task) => STATUS_TEXT[task.status] },
];

/** 一次投递：哪一次、什么时间投的、投到了哪个对话。 */
type RecordRow = DeliveryRecord & { readonly turn: number };

const RECORD_COLUMNS: readonly Column<RecordRow>[] = [
  { key: 'turn', title: '哪一次', width: 80, render: (row) => '第 ' + row.turn + ' 次' },
  {
    key: 'at',
    title: '投递时间',
    width: 150,
    render: (row) => <span className="kw-num">{formatDateTime(row.deliveredAt)}</span>,
  },
  {
    key: 'scheduled',
    title: '计划时间',
    width: 150,
    render: (row) => <span className="kw-num">{formatDateTime(row.scheduledAt)}</span>,
  },
  {
    key: 'target',
    title: '投到哪个对话',
    ellipsis: true,
    // 优先对话名；会话删了没名字，退回会话 id，总比空着强
    render: (row) => row.targetTitle ?? row.targetSessionId ?? '—',
  },
];

/** 表单开着的时候编辑哪一条：'new' 是新建，一条任务就是改它。 */
type Editing = Automation | 'new';

export default function AutomationsPage() {
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const openCreate = () => setEditing('new');
  const items = [
    {
      key: 'page',
      label: '页面上建的',
      children: <AutomationList origin="page" onEdit={setEditing} />,
    },
    {
      key: 'chat',
      label: '对话里设的提醒',
      children: <AutomationList origin="chat" onEdit={setEditing} />,
    },
  ];
  const value = items.find((item) => item.key === params.get('tab'))?.key ?? 'page';
  return (
    <AdminPage
      title="自动化"
      description="到点就替你做的任务。页面上建的、在对话里让我设成提醒的，分两栏放；点一行能看它投递过几次、投到了哪里。"
    >
      <Toolbar
        right={
          <Button color="primary" onClick={openCreate}>
            新建任务
          </Button>
        }
      />
      <Tabs items={items} value={value} onChange={(tab) => setParams({ tab }, { replace: true })} />
      {/* key：换一条任务要重新挂载，useForm 的初值只在挂载时读一次 */}
      {editing ? (
        <AutomationForm
          key={editing === 'new' ? 'new' : editing.id}
          task={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </AdminPage>
  );
}

function AutomationList({
  origin,
  onEdit,
}: {
  readonly origin: Automation['origin'];
  readonly onEdit: (task: Automation) => void;
}) {
  const automations = useAutomations();
  const [opened, setOpened] = useState<Automation | undefined>(undefined);

  // 读失败：明确说「暂时读不到」，绝不当成空列表——那会让人以为任务被删了
  if (automations.isError) {
    return (
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
    );
  }
  if (automations.isPending) return <Skeleton rows={6} />;

  const all = automations.data?.items ?? [];
  const rows = all.filter((task) => task.origin === origin);
  const columns: readonly Column<Automation>[] = [
    ...COLUMNS,
    {
      key: 'edit',
      title: '编辑',
      width: 80,
      render: (task) => (
        <Button
          color="secondary"
          variant="ghost"
          size="sm"
          onClick={(event) => {
            // 行本身也能点开投递记录，按钮不要再冒泡触发一次
            event.stopPropagation();
            onEdit(task);
          }}
        >
          编辑
        </Button>
      ),
    },
    {
      key: 'history',
      title: '投递记录',
      width: 90,
      render: (task) => (
        <Button
          color="secondary"
          variant="ghost"
          size="sm"
          onClick={(event) => {
            // 行本身也能点开，按钮不要再冒泡触发一次
            event.stopPropagation();
            setOpened(task);
          }}
        >
          查看
        </Button>
      ),
    },
  ];

  return (
    <>
      <Table<Automation>
        rowKey={(task) => task.id}
        columns={columns}
        rows={rows}
        minWidth={860}
        loading={automations.isFetching}
        onRowClick={setOpened}
        empty={all.length === 0 ? '还没有定时任务' : '这一栏里还没有任务'}
        aria-label="定时任务"
      />
      {opened ? <HistorySheet task={opened} onClose={() => setOpened(undefined)} /> : null}
    </>
  );
}

/** 一条任务的投递记录，最新的在最上面。 */
function HistorySheet({ task, onClose }: { readonly task: Automation; readonly onClose: () => void }) {
  const history = useAutomationHistory(task.id);
  const records = history.data?.records ?? [];
  // 记录是新的在前，序号按发生顺序数：最早那一次算第 1 次
  const rows = records.map((record, index) => ({ ...record, turn: records.length - index }));
  return (
    <Sheet title="投递记录" onClose={onClose} width={720}>
      {history.isPending ? (
        <Skeleton rows={4} />
      ) : history.isError ? (
        <Empty
          icon={<Warning />}
          title="暂时读不到投递记录"
          description={readableError(history.error, '服务暂时不可用，请稍后重试')}
          action={
            <Button color="primary" onClick={() => void history.refetch()}>
              重试
            </Button>
          }
        />
      ) : (
        <Table<RecordRow>
          rowKey={(row) => row.messageId}
          columns={RECORD_COLUMNS}
          rows={rows}
          pageSize={false}
          minWidth={620}
          empty="这条任务还没有投递过"
          aria-label="投递记录"
        />
      )}
    </Sheet>
  );
}
