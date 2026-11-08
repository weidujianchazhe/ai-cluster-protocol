/**
 * 端口：传输层与控制面的唯一接缝（主窗口 M4 接线）。
 *
 * 设计约束：
 *  - 只 3 个方法，全部返回**扁平 NodeRow**，不返回 core 的类实例/闭包
 *    （否则会踩「工具/HTTP 输出必须 lossless JSON」的坑）；
 *  - 端口自己负责 S/T 两层的鉴权与租户校验；传输层只传 `actor`；
 *  - 端口抛 `PortError` → 由 router 映射成 HTTP 状态码；非 PortError 一律 500，
 *    **不把内部堆栈透给外部**。
 */
import type { A2AActor, A2ACancelOutcome, A2ACreateTaskInput, A2ACreateTaskResult, A2ANodeRow } from './types.ts';

export interface A2ATaskPort {
  /** 建任务：落图节点（+ 可选 TeamTask 投影），返回节点行。 */
  createTask(input: A2ACreateTaskInput): Promise<A2ACreateTaskResult>;
  /** 读任务：只读派生视图；不存在返回 null。 */
  getTask(taskId: string, actor: A2AActor): Promise<A2ANodeRow | null>;
  /** 取消：可取消 → blocked(canceled:*)，不可取消 → not-cancelable。 */
  cancelTask(taskId: string, reason: string | undefined, actor: A2AActor): Promise<A2ACancelOutcome>;
}

export class PortError extends Error {
  code: string;
  status: number;
  details: unknown;

  constructor(code: string, message: string, status = 502, details: unknown = undefined) {
    super(message);
    this.name = 'PortError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** 端口不可用/依赖缺失时用，便于 router 判 503 而不是 500。 */
export function portUnavailable(detail: unknown = undefined): PortError {
  return new PortError('port-unavailable', '控制面端口不可用（未接线或依赖缺失）', 503, detail);
}

export function isPortError(value: unknown): value is PortError {
  return value instanceof PortError
    || (typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string'
      && typeof (value as { status?: unknown }).status === 'number');
}
