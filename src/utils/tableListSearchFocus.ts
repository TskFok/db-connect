type SelectHandler = () => void;

let handler: SelectHandler | null = null;
let pending = false;

/** 数据表列表挂载后注册，用于选中搜索框里已有的文本。 */
export function registerTableListSearchFocus(next: SelectHandler): () => void {
  handler = next;
  if (pending) {
    pending = false;
    next();
  }
  return () => {
    if (handler === next) handler = null;
  };
}

/**
 * 请求选中数据表列表搜索框。
 * 列表已打开时立即执行；仍在详情页时先记下，等列表挂载后再执行。
 */
export function requestTableListSearchFocus(): void {
  if (handler) {
    handler();
    return;
  }
  pending = true;
}
