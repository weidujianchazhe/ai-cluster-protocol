/**
 * Agent Card：能力发现入口（`GET /.well-known/agent-card.json` 与 `GET /a2a/agent-card`）。
 *
 * 只暴露「能不能做、怎么连」，不暴露内部图结构。`metadata` 里的
 * `stateAuthority` / `teamTaskRole` 与插件 `capabilities` 保持同一口径：
 * journal 是权威，TeamTask 是投影。
 */
import type { A2AAgentCard, A2ASkill } from './types.ts';

export const AGENT_CARD_PATH = '/.well-known/agent-card.json';
export const AGENT_CARD_ALIAS = '/a2a/agent-card';

export interface AgentCardOptions {
  url: string;
  name?: string;
  description?: string;
  version?: string;
  skills?: A2ASkill[];
  /** 本部署是否启用流式（本实现暂不支持 → false，不虚报）。 */
  streaming?: boolean;
  /** 是否声明支持 push notification（未实现 → false）。 */
  pushNotifications?: boolean;
}

export const DEFAULT_SKILLS: A2ASkill[] = [
  {
    id: 'l0.task.create',
    name: 'Create control-plane task',
    description: '在接受验收条目的前提下，把一个请求落成工作图节点并派发。',
    tags: ['graph', 'dispatch'],
  },
  {
    id: 'l0.task.status',
    name: 'Read task status',
    description: '按节点 id 读取图状态与 TeamTask 投影（只读）。',
    tags: ['graph', 'read'],
  },
  {
    id: 'l0.task.cancel',
    name: 'Cancel task',
    description: '取消尚未进入验证/终态的节点（落 blocked:canceled:*，对外呈现 canceled）。',
    tags: ['graph', 'control'],
  },
];

export function buildAgentCard(options: AgentCardOptions): A2AAgentCard {
  return {
    name: options.name ?? 'dsh-l0-control',
    description: options.description ?? 'DSH 原生 L0 控制面 · A2A 最小传输（tasks send/get/cancel）',
    version: options.version ?? '0.1.0',
    protocolVersion: '1.0',
    url: options.url,
    capabilities: {
      streaming: options.streaming === true,
      pushNotifications: options.pushNotifications === true,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['application/json'],
    skills: options.skills ?? DEFAULT_SKILLS,
    metadata: {
      stateAuthority: 'plugin-journal',
      teamTaskRole: 'projection',
      /** 幂等键头名，客户端按此发送。 */
      idempotencyHeader: 'Idempotency-Key',
      authScheme: 'Bearer',
    },
  };
}
