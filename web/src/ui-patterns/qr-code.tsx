import { Component, lazy, Suspense, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
const QRCode = lazy(() =>
  import("qrcode.react").then((m) => ({ default: m.QRCodeSVG })),
);
class QRBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      // The QR surface stays white in both themes for scanning contrast.
      <p
        role="alert"
        className="flex size-[180px] items-center text-center text-sm text-neutral-600"
      >
        二维码暂时无法加载，请复制订阅链接。
      </p>
    ) : (
      this.props.children
    );
  }
}
export function SubscriptionQRCode({ value }: { value: string }) {
  return (
    <QRBoundary key={value}>
      <Suspense
        fallback={
          <div
            role="status"
            aria-label="正在加载二维码"
            aria-busy="true"
            className="size-[180px]"
          >
            <Skeleton className="size-full" />
          </div>
        }
      >
        <QRCode value={value} size={180} color="#224e43" />
      </Suspense>
    </QRBoundary>
  );
}
