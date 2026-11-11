/** 「自动化」页的查询与写动作：我的定时任务列表、一条任务的投递记录，以及四个行内动作。 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  automationHistory,
  deleteAutomation,
  listAutomations,
  pauseAutomation,
  resumeAutomation,
  runAutomation,
} from '../../api/automations';

export const AUTOMATION_KEYS = {
  all: ['me', 'automations'],
  list: ['me', 'automations', 'list'],
  history: (id: string) => ['me', 'automations', 'history', id],
} as const;

/** 我的定时任务：宿主那边已经按调用者筛过，拿到的都是自己的。 */
export const useAutomations = () => useQuery({ queryKey: AUTOMATION_KEYS.list, queryFn: listAutomations });

/** 一条任务的投递记录；没选中任何一条时不发请求。 */
export const useAutomationHistory = (id: string | undefined) =>
  useQuery({
    queryKey: AUTOMATION_KEYS.history(id ?? ''),
    queryFn: () => automationHistory(id!),
    enabled: id !== undefined,
  });

export type AutomationActionKind = 'pause' | 'resume' | 'run' | 'delete';

const ACTIONS: Record<AutomationActionKind, (id: string) => Promise<void>> = {
  pause: pauseAutomation,
  resume: resumeAutomation,
  run: runAutomation,
  delete: deleteAutomation,
};

/** 暂停/恢复/立即运行/删除：成功后让列表重新拉一次，行就跟着变。 */
export function useAutomationAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, kind }: { readonly id: string; readonly kind: AutomationActionKind }) =>
      ACTIONS[kind](id),
    onSuccess: () => client.invalidateQueries({ queryKey: AUTOMATION_KEYS.list }),
  });
}
