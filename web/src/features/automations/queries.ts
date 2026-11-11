/** 「自动化」页的查询：我的定时任务列表、一条任务的投递记录。 */
import { useQuery } from '@tanstack/react-query';
import { automationHistory, listAutomations } from '../../api/automations';

export const AUTOMATION_KEYS = {
  all: ['me', 'automations'],
  list: ['me', 'automations', 'list'],
  history: (id: string) => ['me', 'automations', 'history', id],
} as const;

/** 我的定时任务：宿主那边已经按调用者筛过，拿到的都是自己的。 */
export const useAutomations = () =>
  useQuery({ queryKey: AUTOMATION_KEYS.list, queryFn: listAutomations });

/** 一条任务的投递记录；没选中任何一条时不发请求。 */
export const useAutomationHistory = (id: string | undefined) =>
  useQuery({
    queryKey: AUTOMATION_KEYS.history(id ?? ''),
    queryFn: () => automationHistory(id!),
    enabled: id !== undefined,
  });
