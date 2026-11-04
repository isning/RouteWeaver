import { useQueryClient } from "@tanstack/react-query";
import { APIError } from "./api";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { Notice } from "./ui-patterns/notice";
import { ActionButton } from "./ui-patterns/actions";

export function profileDraftChanged(error: unknown) {
  return (
    error instanceof APIError &&
    error.status === 409 &&
    (error.details as { code?: string } | undefined)?.code ===
      "PROFILE_DRAFT_CHANGED"
  );
}

/** Never refresh an editor's token without replacing its retained input. */
export function ProfileDraftConflict({
  profileID,
  onClose,
}: {
  profileID: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const { confirm } = useDiscardConfirmation(profileID);
  return (
    <Notice
      tone="warning"
      title="配置或引用内容已变化。当前输入已保留，不能覆盖新版本。"
      action={
        <ActionButton
          variant="outline"
          onClick={() =>
            confirm(
              {
                title: "放弃当前修改并返回？",
                description:
                  "这会放弃当前未保存的输入，保留最新草稿与已发布的订阅。",
                confirmLabel: "放弃修改并返回",
                cancelLabel: "保留当前输入",
              },
              (stillCurrent) => {
                if (!stillCurrent()) return;
                // Close the confirmed form immediately. Waiting for the catalog
                // would expose editable input that a later response could discard.
                void client.invalidateQueries({ queryKey: ["profiles"] });
                onClose();
              },
            )
          }
        >
          放弃修改并返回
        </ActionButton>
      }
    >
      已发布的订阅保留原版本。重新打开编辑时会读取最新草稿。
    </Notice>
  );
}
