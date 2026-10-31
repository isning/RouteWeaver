import { useQuery } from "@tanstack/react-query";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ActionButton } from "@/ui-patterns/actions";
import { Notice } from "@/ui-patterns/notice";
import { CodePreview, Section } from "./components";
import { list } from "./api";

interface PendingCounter {
  receiptId: string;
  reason: string;
  createdAt: string;
  batch: {
    digest: string;
    samples: {
      sampleId: string;
      subjectId: string;
      cumulativeBytes: string;
      observedAt: string;
    }[];
  };
}

/** Read-only status for legacy batches awaiting authenticated node replay. */
export function AccountingRecovery({ instanceId }: { instanceId: string }) {
  const query = useQuery({
    queryKey: ["accounting-pending", instanceId],
    queryFn: () =>
      list<PendingCounter>(`/agent/instances/${instanceId}/accounting-pending`),
    refetchInterval: (state) => (state.state.data?.length ? 10_000 : false),
  });
  const failedRead =
    query.isError ||
    (query.isFetching && query.errorUpdatedAt > query.dataUpdatedAt);
  if (!failedRead && !query.data?.length) return null;
  return (
    <Section title="流量统计">
      {failedRead ? (
        <Notice tone="warning" title="流量统计状态暂不可用">
          <p>暂时无法读取统计状态，请稍后重试。</p>
          <ActionButton
            className="mt-3"
            variant="outline"
            pending={query.isFetching}
            keepFocusableWhilePending
            onClick={() => void query.refetch({ cancelRefetch: false })}
          >
            重新读取
          </ActionButton>
        </Notice>
      ) : (
        <div className="space-y-3">
          <Notice tone="info" title="等待节点恢复上报">
            收到有效上报后会自动继续统计，无法确定归属的历史流量不会补扣。
          </Notice>
          <Accordion type="single" collapsible>
            <AccordionItem value="details">
              <AccordionTrigger>技术详情</AccordionTrigger>
              <AccordionContent>
                <CodePreview content={JSON.stringify(query.data, null, 2)} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      )}
    </Section>
  );
}
