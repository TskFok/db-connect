interface GlobalLoadingBarProps {
  loading: boolean;
}

/**
 * 全局顶部加载条
 * 当任何全局操作正在进行时显示一条彩色动画条
 */
export function GlobalLoadingBar({ loading }: GlobalLoadingBarProps) {
  if (!loading) return null;

  return (
    <div className="global-loading-bar">
      <div className="global-loading-bar-inner" />
    </div>
  );
}
