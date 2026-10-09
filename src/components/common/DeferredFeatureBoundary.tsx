import {
  Component,
  Suspense,
  lazy,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react";
import { Button, Modal, Space, Spin } from "antd";

type BoundaryProps = {
  children: ReactNode;
  onClose: () => void;
  onFailure?: () => void;
  modal?: boolean;
};

function FeatureFallback({
  failed = false,
  onClose,
  modal = false,
}: Omit<BoundaryProps, "children"> & { failed?: boolean }) {
  const content = (
    <Space direction="vertical" role={failed ? "alert" : "status"}>
      {failed ? (
        "功能加载失败，请关闭后重新打开。"
      ) : (
        <>
          <Spin />
          正在加载…
        </>
      )}
      <Button onClick={onClose}>关闭</Button>
    </Space>
  );
  return modal ? (
    <Modal
      open
      title={failed ? "加载失败" : "加载中"}
      onCancel={onClose}
      footer={null}
    >
      {content}
    </Modal>
  ) : (
    content
  );
}

/** 将可选界面的加载与渲染错误限制在功能区域。 */
export class DeferredFeatureBoundary extends Component<
  BoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFailure?.();
  }

  render() {
    const { children, onClose, modal } = this.props;
    if (this.state.failed)
      return <FeatureFallback failed onClose={onClose} modal={modal} />;
    return (
      <Suspense fallback={<FeatureFallback onClose={onClose} modal={modal} />}>
        {children}
      </Suspense>
    );
  }
}

type Attempt<P extends object> = {
  Feature: LazyExoticComponent<ComponentType<P>>;
  loaded: boolean;
  failed: boolean;
};

/** 健康实例关闭时保留；加载或渲染失败的尝试关闭时丢弃，重开重新加载。 */
export function DeferredFeature<P extends object>({
  active,
  loader,
  children,
  onClose,
  modal,
}: {
  active: boolean;
  loader: () => Promise<{ default: ComponentType<P> }>;
  children: (Feature: LazyExoticComponent<ComponentType<P>>) => ReactNode;
  onClose: () => void;
  modal?: boolean;
}) {
  const [attempt, setAttempt] = useState<Attempt<P> | null>(null);
  if (active && !attempt) {
    const next: Attempt<P> = {
      loaded: false,
      failed: false,
      Feature: lazy(async () => {
        const module = await loader();
        next.loaded = true;
        return module;
      }),
    };
    setAttempt(next);
    return null;
  }
  if (!active && attempt && (!attempt.loaded || attempt.failed)) {
    setAttempt(null);
    return null;
  }
  if (!attempt) return null;
  return (
    <DeferredFeatureBoundary
      onClose={onClose}
      onFailure={() => setAttempt({ ...attempt, failed: true })}
      modal={modal}
    >
      {children(attempt.Feature)}
    </DeferredFeatureBoundary>
  );
}
