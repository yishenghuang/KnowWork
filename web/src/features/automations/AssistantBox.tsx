/**
 * 「用一句话生成」：在新建表单最前面让用户写一句大白话，业务服务调一次模型把它翻成草稿。
 *
 * 这里只负责把话送出去、把草稿交回来——**不建任务**，也不替用户按保存：填进去的东西用户随时能改，
 * 真正落库仍然只在点「保存」那一下（票 #10 的第三条验收）。生成过一次之后输入框留着，
 * 改一句话可以再生成一次、覆盖上一次的草稿。
 */
import { useState } from 'react';
import { Button } from '@openai/apps-sdk-ui/components/Button';
import { Textarea } from '@openai/apps-sdk-ui/components/Textarea';
import { draftAutomation, type AutomationDraft } from '../../api/automations';
import { readableError } from '../../api/http';
import { Field } from '../../ui/Field';
import { toast } from '../../ui/toastStore';

export function AssistantBox({
  timeZone,
  onDraft,
}: {
  /** 浏览器所在的 IANA 时区：模型据此把「明天下午三点」算成一个具体时刻。 */
  readonly timeZone: string;
  readonly onDraft: (draft: AutomationDraft) => void;
}) {
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  // 服务端给的一句中文补充，例如「没完全听懂，只填了能确定的部分」
  const [note, setNote] = useState<string | null>(null);

  const generate = async () => {
    const text = said.trim();
    if (text === '') return;
    setBusy(true);
    setNote(null);
    try {
      const draft = await draftAutomation(text, timeZone);
      setNote(draft.note);
      onDraft(draft);
    } catch (error) {
      // 生成失败只是没帮上忙：已经填上的东西一个字都不动
      toast.error(readableError(error, '没能生成草稿，先自己填吧'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field label="用一句话生成" help="我来把它翻成下面的表单，你再改改、确认了才保存。">
      {(id) => (
        <div>
          <Textarea
            id={id}
            rows={2}
            maxLength={1000}
            placeholder="例如：每天早上九点提醒我把日报交了"
            value={said}
            readOnly={busy}
            onChange={(event) => setSaid(event.target.value)}
          />
          <div style={{ marginTop: 8 }}>
            {/* 表单里按钮默认是 submit：不写 type 就会顺手把任务建出来 */}
            <Button
              type="button"
              color="secondary"
              variant="outline"
              loading={busy}
              onClick={() => void generate()}
            >
              生成草稿
            </Button>
          </div>
          {note ? <div className="kw-field-note">{note}</div> : null}
        </div>
      )}
    </Field>
  );
}

export default AssistantBox;
