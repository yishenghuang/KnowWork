/**
 * 管理端「自动化审计」的查询：列表与创建者选项。
 *
 * 筛选（创建者、状态）交给服务端：任务上万条时把整表交给前端过滤，翻页与总数都会失真（票 #9 的 AC2）。
 * 所以列表的 queryKey 里带上筛选项——换了筛选就是另一个查询，页面不会拿旧结果凑合。
 *
 * 创建者选项单独查一次不带筛选的列表：下拉框要列出「这个空间里有任务的所有人」，
 * 跟着筛选后的结果走的话，一选张三，选项里就只剩张三了。
 */
import { useQuery } from '@tanstack/react-query';
import { listAdminAutomations, type AutomationStatus } from '../../../api/automations';

export const ADMIN_AUTOMATION_KEY = ['admin', 'automations'] as const;

export interface AdminFilter {
  readonly creator?: string;
  readonly status?: AutomationStatus;
}

const listKey = (filter: AdminFilter) =>
  [...ADMIN_AUTOMATION_KEY, 'list', filter.creator ?? '', filter.status ?? ''] as const;

const creatorsKey = [...ADMIN_AUTOMATION_KEY, 'creators'] as const;

/** 列表：本空间的任务，按筛选项在服务端筛过。 */
export function useAdminAutomations(filter: AdminFilter) {
  return useQuery({
    queryKey: listKey(filter),
    queryFn: () => listAdminAutomations(filter),
  });
}

/** 创建者下拉的选项：只列本空间里真有任务的人，不另外拉一遍成员表。 */
export function useAdminCreatorOptions() {
  return useQuery({
    queryKey: creatorsKey,
    queryFn: () => listAdminAutomations(),
    // 名字读不到时退回用户 id：至少还能看出是谁的，不至于写「未知」
    select: (page) => {
      const seen = new Map<string, string>();
      for (const task of page.items) {
        if (!task.creatorId) continue;
        if (!seen.has(task.creatorId)) seen.set(task.creatorId, task.creatorName ?? task.creatorId);
      }
      return [...seen].map(([value, label]) => ({ value, label }));
    },
  });
}
