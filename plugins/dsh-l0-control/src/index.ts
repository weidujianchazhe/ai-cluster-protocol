/**
 * dsh-l0-control —— DSH 原生 L0 控制面插件的入口。
 *
 * 注册：`l0control` 服务（ctx.provide）+ 工具（tools）。
 * 权威边界：插件 journal 是权威，TeamTask 是投影，DSH Session log 是执行证据。
 *
 * M4 接线（本轮新增）：
 *   1. 授权：每次工具调用前置 `authorize`（S lane），允许/拒绝都写 `auth` 审计行；
 *   2. 观测：工具用 `instrumentTool` 埋点，`graph_status.observability` 由 O lane 派生；
 *   3. A2A：`tokenSecret` 非空时起 A2A server（P lane router/server + 本插件 port 适配）。
 */
import { Config, ConfigSource, ConfigSourceFile, normalizeConfig } from './config.js';
import { CAPABILITIES, roleOfInstance } from './capabilities.js';
import { L0ControlService } from './service.js';
import { buildTools } from './tools.js';
import { authorizeWithAudit, isSecurityError, httpStatusFor } from './security/index.js';
import { createObservability, instrumentTool } from './observability/index.js';
import { buildAgentCard, createA2ARouter, startA2AServer } from './a2a/index.js';
import { createA2ATaskPort } from './wiring/a2a-port.js';
import { startUiServer } from './ui-server.js';
import { ServicePool } from './workspaces/index.js';
import path from 'node:path';

export const name = 'dsh-l0-control';
export const inject = ['tools'];

export { Config, CAPABILITIES };

/** 工具名 → 授权动作（未登记的动作在 security 侧默认拒绝）。 */
const ACTION_BY_TOOL: Record<string, string> = {
  wish_submit: 'wish.create',
  graph_status: 'graph.read',
  graph_export: 'export',
  task_next: 'task.next',
  task_claim: 'task.claim',
  evidence_submit: 'evidence.add',
  pass_gate: 'gate.pass',
  verify_done: 'verify_done',
  decision_record: 'decide',
  team_status: 'status.read',
  agent_spawn: 'team.spawn',
  agent_message: 'team.message',
  board_task_create: 'task.submit',
  board_task_update: 'task.submit',
  project_init: 'project.init',
};

function actorOf(exec: any, args: any, tenant: string) {
  const candidate = [args?.instanceId, args?.producer_instance, args?.producerInstance, args?.auditor_instance, args?.auditorInstance]
    .find((value) => typeof value === 'string' && roleOfInstance(value));
  if (candidate) return { id: String(candidate), kind: 'agent', tenant, roles: [roleOfInstance(candidate) as string] };
  const agentId = exec?.agent?.id;
  if (agentId) return { id: String(agentId), kind: 'agent', tenant, roles: ['HUMAN'] };
  // 宿主/插件内部调用（无活 Agent）
  return { id: 'plugin', kind: 'plugin', tenant, roles: ['PLUGIN', 'HUMAN'] };
}

export function apply(ctx: any, rawConfig: unknown = {}) {
  const config = normalizeConfig(rawConfig);
  const service = new L0ControlService(ctx, config, { configSource: ConfigSource, configSourceFile: ConfigSourceFile });
  ctx.provide('l0control', service);

  const tenant = String(config.tenant ?? 'default');
  const obs = createObservability({ tenant });
  service.attachObservability?.(obs);

  // 多工作区：每工作区一份实例（独立 stateDir/journal/lock），主实例先被池认领
  const pool = new ServicePool({
    ctx,
    config,
    meta: { configSource: ConfigSource, configSourceFile: ConfigSourceFile },
    createService: (c: any, cfg: any, m: any) => {
      const instance = new L0ControlService(c, cfg, m);
      instance.attachObservability?.(obs);
      return instance;
    },
    primaryRoot: service.workspaceRoot,
    primaryStateDir: config.stateDir,
  });
  pool.adopt(service);

  // 每实例的同名工具（懒建 + 缓存），执行时按会话工作目录路由
  const instanceTools = new Map<string, Map<string, any>>();
  const toolsFor = (workspaceRoot: string) => {
    const root = path.resolve(workspaceRoot);
    const cached = instanceTools.get(root);
    if (cached) return cached;
    const instance = pool.get(root);
    const map = new Map<string, any>(buildTools(instance).map((tool: any) => [tool.name, tool]));
    instanceTools.set(root, map);
    return map;
  };

  const baseTools = buildTools(service);
  const tools = baseTools.map((tool) =>
    instrumentTool(
      {
        ...tool,
        async execute(args: any, exec: any) {
          const action = ACTION_BY_TOOL[tool.name] ?? 'graph.read';
          // 1) 解析会话工作目录 → 选实例（取不到回退主工作区）
          const workspaceRoot = pool.resolveWorkspaceRoot(exec?.agent);
          const instance = pool.get(workspaceRoot);
          // 2) 按对话启用：默认 disabled，未启用的 session 一律 not-enabled
          const sessionId = String(exec?.agent?.id ?? '');
          if (!instance.isSessionEnabled(sessionId)) {
            instance.appendJournal('access_denied', { sessionId: sessionId || null, tool: tool.name, action });
            return {
              ok: false,
              error: 'not-enabled',
              sessionId: sessionId || null,
              tool: tool.name,
              workspaceRoot,
              hint: '在「AI集群工作协议」面板里启用本对话，或在对话输入框左侧点「启用 AI集群工作协议」',
            };
          }
          const actor = actorOf(exec, args, tenant);
          const { decision, row } = authorizeWithAudit(actor, action, {
            tenant,
            governance: action === 'verify_done' || action === 'decide' || action === 'reassign',
            requireAuditIndependence: action === 'verify_done',
            producerInstance: args?.producer_instance ?? args?.producerInstance,
            auditorInstance: actor.id,
          });
          instance.appendJournal('auth', { ...row, tool: tool.name, action, workspaceRoot });
          if (!decision) {
            return {
              ok: false,
              code: row.code,
              status: httpStatusFor(row.code),
              message: row.message,
              action,
              tool: tool.name,
              workspaceRoot,
              actor: row.actor ?? actor.id,
            };
          }
          try {
            // 3) 路由到该实例的同名工具
            const routed = toolsFor(workspaceRoot).get(tool.name) ?? tool;
            return await routed.execute(args, exec ?? {});
          } catch (error) {
            if (isSecurityError(error)) {
              const code = (error as { code?: string }).code ?? 'security-error';
              return { ok: false, code, status: httpStatusFor(code), message: (error as Error).message };
            }
            throw error;
          }
        },
      },
      obs,
    ),
  );

  for (const tool of tools) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: tool.output,
      async execute(args: any, exec: any) {
        return tool.execute(args, exec ?? {});
      },
    });
  }

  // A2A：tokenSecret 非空才起服务（空 = 关闭）
  let a2aHandle: { url: string; port: number; close(): Promise<void> } | null = null;
  const secret = String(config.tokenSecret ?? '');
  if (secret) {
    const port = createA2ATaskPort({
      getCore: () => service.core(),
      emit: (kind: string, payload: Record<string, unknown>) => service.appendJournal(kind, payload),
    });
    const card = buildAgentCard({ name: 'dsh-l0-control', url: `http://${config.a2aHost}` });
    const router = createA2ARouter({ port, card, auth: { tokens: [secret] } });
    startA2AServer({ router, host: config.a2aHost, port: Number(config.a2aPort ?? 0) })
      .then((handle: any) => {
        a2aHandle = handle;
        service.appendJournal('a2a_started', { url: handle.url, port: handle.port });
      })
      .catch((error: unknown) => {
        service.appendJournal('a2a_failed', { error: String((error as Error)?.message ?? error) });
      });
  }

  // 只读 UI 侧车：给 @local/dsh-l0-control-ui 面板提供快照（默认 47831）
  let uiHandle: { url: string; port: number; close(): Promise<void> } | null = null;
  startUiServer({
    host: config.uiHost,
    port: Number(config.uiPort ?? 47831),
    getSnapshot: (sessionId?: string, workspaceRoot?: string) =>
      pool.get(workspaceRoot ?? service.workspaceRoot).uiSnapshot({ sessionId }),
    getWorkspaces: () => pool.list(),
    getAccess: (sessionId?: string, workspaceRoot?: string) =>
      pool.get(workspaceRoot ?? service.workspaceRoot).accessFor(sessionId),
    setAccess: (input: { sessionId: string; enabled?: boolean; coordination?: boolean; management?: string; by?: string; workspaceRoot?: string }) =>
      pool.get(input?.workspaceRoot ?? service.workspaceRoot).setSessionAccess(
        input?.sessionId,
        {
          ...(typeof input?.coordination === 'boolean' ? { coordination: input.coordination } : {}),
          ...(input?.management === undefined ? {} : { management: input.management }),
          ...(typeof input?.enabled === 'boolean' && input?.coordination === undefined ? { coordination: input.enabled } : {}),
        },
        input?.by ?? 'ui',
      ),
    getUpdateInfo: () => service.checkUpdate(),
    projectInit: (input: { workspaceRoot?: string; projectName?: string; wish?: string; dryRun?: boolean; sessionId?: string }) =>
      service.projectInit(
        {
          workspaceRoot: input?.workspaceRoot,
          projectName: input?.projectName,
          wish: input?.wish,
          dryRun: input?.dryRun !== false,
        },
        input?.sessionId ?? null,
      ),
  })
    .then((handle: any) => {
      uiHandle = handle;
      service.appendJournal('ui_started', { url: handle.url, port: handle.port });
    })
    .catch((error: unknown) => {
      service.appendJournal('ui_failed', { error: String((error as Error)?.message ?? error) });
    });

  ctx.effect(() => () => {
    // 卸载/disable 时必须释放持久层锁（否则下一世代 open 会 STATE_LOCKED）。
    service.appendJournal('plugin_disposed', { tools: tools.map((tool) => tool.name) });
    const closing = Promise.all([
      a2aHandle ? a2aHandle.close().catch(() => undefined) : Promise.resolve(undefined),
      uiHandle ? uiHandle.close().catch(() => undefined) : Promise.resolve(undefined),
    ]);
    return closing
      .then(() => service.dispose())
      .then((result) => {
        service.appendJournal('plugin_dispose_result', result);
      });
  });

  service.appendJournal('plugin_applied', {
    tools: tools.map((tool) => tool.name),
    tenant,
    a2a: secret ? { enabled: true, host: config.a2aHost, port: config.a2aPort } : { enabled: false },
    configSource: ConfigSource,
  });

  return { service, tools: tools.map((tool) => tool.name) };
}
