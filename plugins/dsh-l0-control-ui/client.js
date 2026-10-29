window.__ModuleLoader__.load({
  id: '@local/dsh-l0-control-ui',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'l0-control-ui';
    const PANEL_ID = 'l0-control';
    const SNAPSHOT_URL = 'http://127.0.0.1:47831/ui/snapshot';
  const ACCESS_URL = 'http://127.0.0.1:47831/ui/access';

    const ZH = {
      nav: 'AI集群工作协议',
      title: 'AI集群工作协议',
      subtitle: '许愿式集群工作 · 子 Agent 递归分支 · 高吞吐 / 高 token 消耗',
      costWarning: '⚠ 高 token 消耗：每个子 Agent 都是独立上下文，递归/并行会成倍放大成本；启用前请设预算并限制并发/深度。',
      badge: '原生插件',
      refresh: '刷新',
      checkUpdate: '检查更新',
      close: '关闭',
      loading: '加载中…',
      offline: 'UI 侧车未连接；请确认控制面插件已启用，或让 Agent 调 graph_status。',
      members: '团队成员',
      subagents: '子 Agent（递归）',
      activeSubagents: '活跃子 Agent',
      tasks: '共同任务',
      ready: '就绪节点',
      events: '黑板事件',
      tabTeam: '团队',
      tabTasks: '共同任务',
      tabBoard: '黑板',
      tabWorkspace: '工作区',
      workSpaces: '工作区',
      tabProject: '项目管理',
      projectTitle: '项目管理',
      projectHint: '管理区协议的具体项目：任务卡、INDEX、STATE、reports；下方目录可复制。',
      workspaceNoInstance: '该工作区尚未挂载独立控制面实例；统计按当前实例显示为 0。',
      managementTitle: '管理区协议',
      managementHint: '任务卡/INDEX/STATE 只读投影',
      noCards: '未发现管理区任务卡',
      teamTitle: '智能体团队',
      teamHint: '来自 agentTeams 团队板；先调一次 team_status 才能填充。',
      tasksTitle: '共同任务',
      tasksHint: '来自 TeamTask 投影，权威仍是插件 journal。',
      boardTitle: '共享黑板',
      boardHint: '最近 40 条 journal 事件；只读。',
      workspaceTitle: '工作区管理',
      workspaceHint: '工程目录与管理区；路径可复制。',
      copyPath: '复制路径',
      copied: '已复制',
      noMembers: '暂无成员数据',
      noTasks: '暂无任务',
      noEvents: '暂无事件',
      role: '角色',
      status: '状态',
      owner: '负责人',
      subject: '任务',
      path: '路径',
      entries: '目录内容',
      journal: 'journal',
      source: '事实源',
      sourceValue: '插件 journal（TeamTask 是投影）',
      pluginSwitch: '插件开关',
      pluginOn: '已启用',
      pluginOff: '已停用',
      pluginSwitchHint: '只控制智能体协调 / 集群协作；工作区管理在「项目管理」页单独设置。',
      enablePlugin: '启用插件',
      disablePlugin: '关闭插件',
      managementSwitch: '工作区管理',
      mgmtOff: '关闭',
      mgmtAuto: '自动',
      mgmtOn: '开启',
      mgmtSwitchHint: '工作区管理：关闭 / 自动（由 AI 决定）/ 开启。',
      managementOffHint: '工作区管理未启用；不会创建或展示管理区。',
      managementAutoHint: '自动：由 AI 决定是否创建管理区。',
      footer: '数据每 10 秒刷新；实时图状态仍以 graph_status 为准。',
      plugins: '插件管理',
    };

    const EN = {
      nav: 'AI Cluster Protocol',
      title: 'AI Cluster Protocol',
      subtitle: 'Wish-driven cluster work · recursive subagents · high throughput / high token cost',
      costWarning: '⚠ High token cost: every subagent carries its own context; recursive/parallel fan-out multiplies spend. Set a budget and limit concurrency/depth before enabling.',
      badge: 'Native plugin',
      refresh: 'Refresh',
      checkUpdate: 'Check updates',
      close: 'Close',
      loading: 'Loading…',
      offline: 'UI sidecar is not connected. Check the control plugin is enabled, or ask the Agent to call graph_status.',
      members: 'Members',
      subagents: 'Subagents (recursive)',
      activeSubagents: 'Active subagents',
      tasks: 'Shared tasks',
      ready: 'Ready nodes',
      events: 'Board events',
      tabTeam: 'Team',
      tabTasks: 'Tasks',
      tabBoard: 'Board',
      tabWorkspace: 'Workspaces',
      workSpaces: 'Workspaces',
      tabProject: 'Projects',
      projectTitle: 'Project management',
      projectHint: 'Management-area projects: task cards, INDEX, STATE, reports; directories below are copyable.',
      workspaceNoInstance: 'This workspace has no independent control-plane instance; stats show 0 for the current instance.',
      managementTitle: 'Management protocol',
      managementHint: 'Read-only projection of task cards / INDEX / STATE',
      noCards: 'No management task cards found',
      teamTitle: 'Agent team',
      teamHint: 'From the agentTeams board; call team_status once to populate.',
      tasksTitle: 'Shared tasks',
      tasksHint: 'TeamTask projection; the plugin journal remains authoritative.',
      boardTitle: 'Shared board',
      boardHint: 'Last 40 journal events; read-only.',
      workspaceTitle: 'Workspace management',
      workspaceHint: 'Code and management directories; paths are copyable.',
      copyPath: 'Copy path',
      copied: 'Copied',
      noMembers: 'No member data',
      noTasks: 'No tasks',
      noEvents: 'No events',
      role: 'Role',
      status: 'Status',
      owner: 'Owner',
      subject: 'Task',
      path: 'Path',
      entries: 'Entries',
      journal: 'journal',
      source: 'Authority',
      sourceValue: 'Plugin journal (TeamTask is projection)',
      pluginSwitch: 'Plugin switch',
      pluginOn: 'Enabled',
      pluginOff: 'Disabled',
      pluginSwitchHint: 'Controls coordination only; workspace management is set separately on the Projects tab.',
      enablePlugin: 'Enable plugin',
      disablePlugin: 'Disable plugin',
      managementSwitch: 'Workspace management',
      mgmtOff: 'Off',
      mgmtAuto: 'Auto',
      mgmtOn: 'On',
      mgmtSwitchHint: 'Workspace management: off / auto (AI decides) / on.',
      managementOffHint: 'Workspace management is off; no management area is created or shown.',
      managementAutoHint: 'Auto: the AI decides whether to create a management area.',
      footer: 'Refreshes every 10s; graph_status remains the live source.',
      plugins: 'Plugins',
    };

    const page = {
      minHeight: '100%',
      boxSizing: 'border-box',
      padding: '24px 30px 44px',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      overflow: 'auto',
    };
    const wrap = { maxWidth: 1080, margin: '0 auto' };
    const card = {
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 14,
      padding: '16px 18px',
      marginBottom: 14,
    };
    const muted = { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.6 };
    const title = { margin: 0, fontSize: 24, lineHeight: 1.2 };
    const sectionTitle = { fontSize: 14, fontWeight: 600, margin: '0 0 10px' };
    const statGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginTop: 16 };
    const stat = { background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, padding: '12px 14px' };
    const statValue = { fontSize: 22, fontWeight: 650, lineHeight: 1.1 };
    const badge = {
      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: 1,
      padding: '6px 10px', borderRadius: 999, color: 'var(--dsw-alias-brand-primary)',
      border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
    };
    const button = {
      appearance: 'none', cursor: 'pointer', borderRadius: 9, padding: '7px 11px', fontSize: 13,
      color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)', font: 'inherit', outline: 'none', boxShadow: 'none',
    };
    const selectedButton = {
      border: '2px solid var(--dsw-alias-label-primary)',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-2)',
      fontWeight: 600,
    };
    const tabRow = { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l1)', marginBottom: 16, flexWrap: 'wrap' };
    const tabStyle = (active) => ({
      appearance: 'none', cursor: 'pointer', border: 0, background: 'transparent', font: 'inherit',
      padding: '9px 12px', fontSize: 13, color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
      borderBottom: active ? '2px solid var(--dsw-alias-brand-primary)' : '2px solid transparent',
      marginBottom: -1,
    });
    const row = {
      display: 'grid', gridTemplateColumns: 'minmax(120px, 1.2fr) minmax(80px, .7fr) minmax(80px, .7fr)',
      gap: 10, padding: '9px 0', borderTop: '1px solid var(--dsw-alias-border-l1)', fontSize: 13, alignItems: 'center',
    };
    const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, overflowWrap: 'anywhere' };
    const pill = { display: 'inline-block', padding: '2px 7px', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2)', fontSize: 11 };

    function Icon({ size = 18, active }) {
      const color = active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)';
      const s = Math.max(14, Math.min(28, Number(size) || 18));
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 6.5, cy: 7, r: 2.1, stroke: color, strokeWidth: 1.7 }),
        h('circle', { cx: 17.5, cy: 7, r: 2.1, stroke: color, strokeWidth: 1.7 }),
        h('circle', { cx: 12, cy: 17, r: 2.1, stroke: color, strokeWidth: 1.7 }),
        h('path', { d: 'M8.6 7h6.8M7.4 8.8l3.5 6M16.6 8.8l-3.5 6', stroke: color, strokeWidth: 1.7, strokeLinecap: 'round' }));
    }

    function Stat({ label, value }) {
      return h('div', { style: stat }, h('div', { style: statValue }, String(value)), h('div', { style: muted }, label));
    }

    function Empty({ text }) {
      return h('div', { style: { ...muted, padding: '14px 0' } }, text);
    }

    function fmt(value) {
      if (value === null || value === undefined || value === '') return '—';
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }

    function samePath(a, b) {
      if (!a || !b) return false;
      const norm = (v) => String(v).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      return norm(a) === norm(b);
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: String(error?.message || error) };
      }
      componentDidCatch(error, info) {
        try {
          console.error('[l0-control-ui] panel crashed', error, info);
        } catch {}
      }
      render() {
        if (this.state.error) {
          return h('div', { style: { ...page, color: 'var(--dsw-alias-state-error-primary)' } },
            h('h1', { style: title }, 'AI集群工作协议'),
            h('div', { style: { ...muted, marginTop: 12 } }, '面板渲染失败：'),
            h('pre', { style: { ...mono, whiteSpace: 'pre-wrap', marginTop: 8 } }, this.state.error));
        }
        return this.props.children;
      }
    }

    function Panel({ ctx, useWorkspaces, useSessions, session, sessionId: ownSessionId }) {
      const t = (key) => ZH[key] || EN[key] || key;
      const useWs = useWorkspaces || (() => []);
      const useSs = useSessions || (() => []);
      const sidebarWorkspaces = useWs((snapshot) => (snapshot && Array.isArray(snapshot.items) ? snapshot.items : []));
      const archivedSessionIds = useWs((snapshot) => (snapshot && Array.isArray(snapshot.archivedSessionIds) ? snapshot.archivedSessionIds : [])) || [];
      const archivedSet = new Set(archivedSessionIds);
      const rawSessions = useSs((snapshot) => {
        if (!snapshot) return [];
        if (Array.isArray(snapshot.items)) return snapshot.items;
        if (snapshot.byId) return Object.values(snapshot.byId);
        return [];
      }) || [];
      const sessionById = new Map();
      for (const s of rawSessions) {
        const id = s.sessionId || s.id;
        if (id) sessionById.set(id, { ...s, id });
      }
      const isArchivedOrSubagent = (s) => Boolean(s) && (
        archivedSet.has(s.id)
        || s.origin === 'subagent'
        || Boolean(s.parentSessionId)
        || s.blank === true
      );
      const liveSessionId = ownSessionId || session?.id || null;
      const [tab, setTab] = React.useState('team');
      const [sidebarId, setSidebarId] = React.useState(null);
      const [projectId, setProjectId] = React.useState('code');
      const [pickedSession, setPickedSession] = React.useState(null);
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [copiedPath, setCopiedPath] = React.useState(null);

      const workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
      const workspaceCandidate = workspaces.find((w) => w.id === projectId) || workspaces[0] || null;
      const activeSidebar = sidebarWorkspaces.find((w) => (w.id && w.id === sidebarId) || (w.path && samePath(w.path, sidebarId)))
        || sidebarWorkspaces.find((w) => samePath(w.path, data?.workspaceRoot))
        || sidebarWorkspaces[0] || null;
      const projectOnCurrent = !activeSidebar?.path || !data?.workspaceRoot || samePath(activeSidebar.path, data.workspaceRoot);
      const workspace = projectOnCurrent ? workspaceCandidate : null;
      const allowedSessionIds = new Set(Array.isArray(activeSidebar?.sessionIds) ? activeSidebar.sessionIds : []);
      // 直接以工作区的 sessionIds 为准（与侧边栏一致），再减去归档/子会话/空会话。
      const workspaceSessions = [...allowedSessionIds]
        .map((id) => sessionById.get(id))
        .filter((s) => s && !isArchivedOrSubagent(s));
      const snapshotSessionIds = new Set((Array.isArray(data?.sessions) ? data.sessions : [])
        .map((s) => s?.sessionId || s?.id)
        .filter(Boolean));
      const selectedSessionId = (pickedSession && !isArchivedOrSubagent({ id: pickedSession }) && (allowedSessionIds.size === 0 || allowedSessionIds.has(pickedSession)) ? pickedSession : null)
        || (liveSessionId && !isArchivedOrSubagent({ id: liveSessionId }) && (allowedSessionIds.size === 0 || allowedSessionIds.has(liveSessionId)) ? liveSessionId : null)
        || (data?.suggestedSessionId && !isArchivedOrSubagent({ id: data.suggestedSessionId }) && (allowedSessionIds.size === 0 || allowedSessionIds.has(data.suggestedSessionId)) ? data.suggestedSessionId : null)
        || [...allowedSessionIds].find((id) => snapshotSessionIds.has(id) && !isArchivedOrSubagent({ id }))
        || workspaceSessions[0]?.id || null;
      const activeSessionId = selectedSessionId;
      const teamSource = data?.team?.source || 'none';
      const sessionAttached = teamSource === 'live' || teamSource === 'snapshot';
      const sessionLabel = (s) => (s?.title || s?.id || '').toString().slice(0, 18);
      const counts = data?.graph?.counts || null;
      // 双轴：coordination（协作，决定工具/统计）+ management（工作区管理 off/auto/on）
      const coordinationEnabled = data?.access?.coordination === true || data?.access?.enabled === true;
      const managementMode = ['off', 'auto', 'on'].includes(data?.access?.management) ? data.access.management : 'off';
      // 子 Agent 快照来源：live=实时，snapshot=上次持久化，none=没有任何数据（显示 —）
      const descendantsSource = data?.descendants?.source || 'none';
      // 新建项目用的目标工作区：优先侧栏选中的真实 path
      const boardWorkspacePath = (activeSidebar && activeSidebar.path) || data?.workspaceRoot || null;
      const showData = coordinationEnabled && sessionAttached;
      const setAccess = async (patch) => {
        const target = activeSessionId || liveSessionId || data?.sessionId || null;
        if (!target) {
          setError(t('needSession'));
          return;
        }
        try {
          await fetch(ACCESS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: target, ...patch, by: 'ui' }),
          });
          await load();
        } catch (e) {
          setError(String(e?.message || e));
        }
      };
      const toggleAccess = (next) => setAccess({ coordination: next });
      const setManagement = (mode) => setAccess({ management: mode });
      // 新建项目表单（用当前选中工作区）
      const [newName, setNewName] = React.useState('');
      const [newWish, setNewWish] = React.useState('');
      const [projectResult, setProjectResult] = React.useState(null);
      const createProject = async (dryRun) => {
        try {
          const res = await fetch(`${ACCESS_URL.replace('/ui/access', '')}/ui/project-init`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: activeSessionId || liveSessionId || data?.sessionId || null,
              workspaceRoot: boardWorkspacePath,
              projectName: newName || 'project',
              wish: newWish || undefined,
              dryRun,
            }),
          });
          const json = await res.json();
          setProjectResult(json);
          if (!dryRun && json?.ok) await load();
        } catch (e) {
          setProjectResult({ ok: false, error: String(e?.message || e) });
        }
      };
      const [updateNotice, setUpdateNotice] = React.useState(null);
      const checkUpdate = async () => {
        try {
          const res = await fetch(`${SNAPSHOT_URL.replace('/ui/snapshot', '')}/ui/update-check`, { headers: { accept: 'application/json' } });
          const json = await res.json();
          setUpdateNotice(json ?? { ok: false, error: 'update-check-empty' });
        } catch (e) {
          setUpdateNotice({ ok: false, error: 'update-check-failed', message: String(e?.message || e) });
        }
      };

      const load = React.useCallback(async () => {
        try {
          setLoading(true);
          const target = selectedSessionId || liveSessionId || null;
          const params = new URLSearchParams();
          if (target) params.set('sessionId', target);
          if (boardWorkspacePath) params.set('workspaceRoot', boardWorkspacePath);
          const url = params.toString() ? `${SNAPSHOT_URL}?${params.toString()}` : SNAPSHOT_URL;
          const res = await fetch(url, { headers: { accept: 'application/json' } });
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          const json = await res.json();
          if (!json || json.ok !== true) throw new Error(json?.error || 'snapshot failed');
          setData(json);
          setError(null);
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setLoading(false);
        }
      }, [selectedSessionId, liveSessionId, boardWorkspacePath]);

      React.useEffect(() => {
        load();
        const timer = setInterval(load, 10000);
        return () => clearInterval(timer);
      }, [load]);

      const team = data?.team && data.team.ok ? data.team : null;
      const members = Array.isArray(team?.members) ? team.members : [];
      const tasks = Array.isArray(team?.tasks) ? team.tasks : [];
      const ready = Array.isArray(data?.graph?.ready) ? data.graph.ready : [];
      const events = Array.isArray(data?.blackboard) ? data.blackboard : [];

      const copy = async (text, key) => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(String(text));
            setCopiedPath(key);
            setTimeout(() => setCopiedPath(null), 1400);
          }
        } catch {
          setCopiedPath(null);
        }
      };

      const tabs = [
        ['team', t('tabTeam')],
        ['tasks', t('tabTasks')],
        ['board', t('tabBoard')],
        ['workspace', t('tabProject')],
      ];

      return h('div', { style: page }, h('div', { style: wrap },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 18, marginBottom: 16 } },
          h('div', null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' } },
              h(Icon, { size: 26, active: true }),
              h('h1', { style: title }, t('title')),
              h('span', { style: badge }, t('badge'))),
            h('div', { style: muted }, t('subtitle')),
            h('div', { style: { ...muted, color: 'var(--dsw-alias-state-warn-primary)', marginTop: 4 } }, t('costWarning'))),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { type: 'button', style: button, onClick: () => { setLoading(true); load(); } }, t('refresh')),
            h('button', { type: 'button', style: button, onClick: checkUpdate }, t('checkUpdate')),
            h('button', { type: 'button', style: button, onClick: () => ctx.layout.selectPanel('plugins') }, t('plugins')))),

        error ? h('div', { style: { ...card, borderColor: 'var(--dsw-alias-state-warn-primary)' } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, t('offline')),
          h('div', { style: mono }, error)) : null,

        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'nowrap', overflowX: 'auto', alignItems: 'center', margin: '0 0 12px', paddingBottom: 2 } },
          h('span', { style: { ...muted, whiteSpace: 'nowrap' } }, t('workSpaces')),
          (sidebarWorkspaces.length ? sidebarWorkspaces : workspaces).map((w) => {
            const id = w.id || w.path || w.title;
            const active = (activeSidebar?.id && activeSidebar.id === id)
              || (activeSidebar?.path && samePath(activeSidebar.path, id))
              || (!sidebarWorkspaces.length && workspace?.id === w.id);
            return h('button', {
              key: id, type: 'button',
              style: { ...button, whiteSpace: 'nowrap', ...(active ? selectedButton : {}) },
              onClick: () => setSidebarId(id),
            }, fmt(w.title || w.name || w.label || id));
          })),

        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'nowrap', overflowX: 'auto', alignItems: 'center', margin: '0 0 8px 18px', padding: '0 0 2px 10px', borderLeft: '2px solid var(--dsw-alias-border-l1)' } },
          h('span', { style: { ...muted, whiteSpace: 'nowrap' } }, t('sessions')),
          workspaceSessions.length === 0
            ? h('span', { style: { ...muted, whiteSpace: 'nowrap' } }, t('noSessions'))
            : workspaceSessions.map((s) => h('button', {
              key: s.id,
              type: 'button',
              title: s.title || s.id,
              style: { ...button, whiteSpace: 'nowrap', ...(activeSessionId === s.id ? selectedButton : {}) },
              onClick: () => setPickedSession(s.id),
            }, sessionLabel(s)))),

        h('div', { style: statGrid },
          h(Stat, { label: t('members'), value: loading ? '…' : (showData ? members.length : '—') }),
          h(Stat, { label: t('subagents'), value: loading ? '…' : (showData && descendantsSource !== 'none' ? (data?.descendants?.count ?? 0) : '—') }),
          h(Stat, { label: t('activeSubagents'), value: loading ? '…' : (showData && descendantsSource !== 'none' ? (data?.descendants?.active ?? 0) : '—') }),
          h(Stat, { label: t('tasks'), value: loading ? '…' : (showData ? tasks.length : '—') }),
          h(Stat, { label: t('ready'), value: loading ? '…' : (showData ? ready.length : '—') }),
          h(Stat, { label: t('events'), value: loading ? '…' : (showData ? (data?.journal?.events ?? events.length) : '—') })),
        coordinationEnabled && !sessionAttached ? h('div', { style: { ...muted, marginTop: -4, marginBottom: 8 } }, t('noSessionSnapshot')) : null,

        // 两块分开：左边事实源，右边插件开关（只控制协作）
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(240px, .9fr)', gap: 12, marginTop: 12 } },
          h('div', { style: { ...card, margin: 0, padding: '8px 12px' } },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 } },
              h('span', { style: { ...sectionTitle, margin: 0 } }, t('source')),
              h('span', { style: { ...muted, ...mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('sourceValue'))),
            counts ? h('div', { style: { ...muted, ...mono, marginTop: 4 } }, `${counts.nodes ?? 0} nodes · ${counts.done ?? 0} done`) : null),

          h('div', { style: { ...card, margin: 0, padding: '8px 12px' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 } },
              h('div', null,
                h('div', { style: { ...sectionTitle, margin: 0 } }, t('pluginSwitch')),
                h('div', { style: { ...muted, marginTop: 3 } }, `${t('pluginSwitch')}: ${coordinationEnabled ? t('pluginOn') : t('pluginOff')}`)),
              h('button', {
                type: 'button',
                style: { ...button, ...(coordinationEnabled ? selectedButton : {}) },
                onClick: () => toggleAccess(!coordinationEnabled),
              }, coordinationEnabled ? t('disablePlugin') : t('enablePlugin'))),
            h('div', { style: { ...muted, marginTop: 4 } }, t('pluginSwitchHint')))),

        h('div', { style: tabRow }, tabs.map(([id, label]) =>
          h('button', { key: id, type: 'button', style: tabStyle(tab === id), onClick: () => setTab(id) }, label))),

        tab === 'team' ? h('div', { style: card },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12 } },
            h('h2', { style: sectionTitle }, t('teamTitle')),
            h('span', { style: muted }, team ? `${team.memberCount ?? members.length}` : '—')),
          h('div', { style: muted }, t('teamHint')),
          h('div', { style: { ...muted, marginTop: 4 } }, `来源 ${teamSource}${data?.team?.capturedAt ? ` · ${data.team.capturedAt}` : ''}${data?.team?.sessionId ? ` · session ${String(data.team.sessionId).slice(0, 12)}` : ''}`),
          !coordinationEnabled ? h(Empty, { text: '—' }) : null,
          coordinationEnabled && !sessionAttached ? h(Empty, { text: t('noSessionSnapshot') }) : null,
          !showData ? null : members.length === 0 ? h(Empty, { text: t('noMembers') }) : members.map((m) =>
            h('div', { key: m.id || m.name, style: { ...row, gridTemplateColumns: 'minmax(140px, 1.4fr) minmax(80px, .7fr) minmax(80px, .7fr)' } },
              h('div', null, h('div', { style: { fontWeight: 550 } }, fmt(m.name || m.id)), h('div', { style: { ...mono, ...muted } }, fmt(m.id || ''))),
              h('div', null, h('span', { style: pill }, fmt(m.role))),
              h('div', null, h('span', { style: pill }, fmt(m.status)))))) : null,

        tab === 'tasks' ? h('div', { style: card },
          h('h2', { style: sectionTitle }, t('tasksTitle')),
          h('div', { style: muted }, t('tasksHint')),
          !coordinationEnabled ? h(Empty, { text: '—' }) : !sessionAttached ? h(Empty, { text: t('noSessionSnapshot') }) : tasks.length === 0 ? h(Empty, { text: t('noTasks') }) : tasks.map((task) =>
            h('div', { key: task.id, style: { ...row, gridTemplateColumns: 'minmax(180px, 1.6fr) minmax(90px, .6fr) minmax(110px, .7fr)' } },
              h('div', null, h('div', { style: { fontWeight: 550 } }, fmt(task.subject || task.id)), h('div', { style: { ...mono, ...muted } }, fmt(task.id))),
              h('div', null, h('span', { style: pill }, fmt(task.status))),
              h('div', { style: muted }, fmt(task.ownerName))))) : null,

        tab === 'board' ? h('div', { style: card },
          h('h2', { style: sectionTitle }, t('boardTitle')),
          h('div', { style: muted }, t('boardHint')),
          !coordinationEnabled ? h(Empty, { text: '—' }) : !sessionAttached ? h(Empty, { text: t('noSessionSnapshot') }) : events.length === 0 ? h(Empty, { text: t('noEvents') }) : events.map((event, index) =>
            h('div', { key: `${event.at || ''}-${index}`, style: { ...row, gridTemplateColumns: 'minmax(140px, 1.2fr) minmax(120px, 1fr) minmax(160px, 1.5fr)' } },
              h('div', { style: mono }, fmt(event.kind)),
              h('div', { style: { ...mono, ...muted } }, fmt(event.at)),
              h('div', { style: muted }, fmt(event.text || event.nodeId || event.actor))))) : null,

        tab === 'workspace' ? h('div', { style: card },
          h('h2', { style: sectionTitle }, t('projectTitle')),
          h('div', { style: muted }, t('projectHint')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '10px 0' } },
            h('span', { style: muted }, t('managementSwitch')),
            ['off', 'auto', 'on'].map((mode) => h('button', {
              key: mode, type: 'button',
              style: { ...button, ...(managementMode === mode ? selectedButton : {}) },
              onClick: () => setManagement(mode),
            }, mode === 'off' ? t('mgmtOff') : mode === 'auto' ? t('mgmtAuto') : t('mgmtOn')))),
          // 第二个轴：工作区管理 off → 不展示管理区内容
          managementMode === 'off'
            ? h('div', null,
              h(Empty, { text: t('managementOffHint') }),
              h('div', { style: { marginTop: 8 } },
                h('button', { type: 'button', style: selectedButton, onClick: () => setManagement('auto') }, t('mgmtAuto'))))
            : managementMode === 'auto'
              ? h('div', { style: { ...muted, marginTop: 4 } }, t('managementAutoHint'))
              : null,
          // 新建项目：用当前选中工作区（activeSidebar.path）作为 workspaceRoot
          h('div', { style: { ...sectionTitle, marginTop: 16 } }, t('newProject')),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '8px 0' } },
            h('input', {
              type: 'text',
              placeholder: t('projectNamePlaceholder'),
              value: newName,
              disabled: managementMode === 'off',
              onChange: (event) => setNewName(event.target.value),
              style: { flex: '1 1 180px', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'inherit' },
            }),
            h('input', {
              type: 'text',
              placeholder: t('wishPlaceholder'),
              value: newWish,
              disabled: managementMode === 'off',
              onChange: (event) => setNewWish(event.target.value),
              style: { flex: '2 1 260px', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'inherit' },
            }),
            h('button', { type: 'button', style: button, disabled: managementMode === 'off' || !boardWorkspacePath, onClick: () => createProject(true) }, t('preview')),
            h('button', { type: 'button', style: selectedButton, disabled: managementMode === 'off' || !boardWorkspacePath, onClick: () => createProject(false) }, t('create'))),
          h('div', { style: { ...muted, ...mono, overflowWrap: 'anywhere' } },
            `${t('targetWorkspace')} ${boardWorkspacePath || '—'}`),
          managementMode === 'off' ? h('div', { style: { ...muted, marginTop: 4 } }, t('managementOffHint')) : null,
          projectResult
            ? h('div', { style: { ...card, marginTop: 10, padding: '8px 12px' } },
              h('div', { style: muted }, `${projectResult.dryRun ? t('previewOnly') : t('created')} · ${projectResult.ok ? 'ok' : projectResult.error || 'fail'} · ${t('actions')} ${(projectResult.actions || []).length}${(projectResult.conflicts || []).length ? ` · ${t('conflicts')} ${projectResult.conflicts.join(',')}` : ''}`),
              h('div', { style: { ...muted, ...mono, marginTop: 4, overflowWrap: 'anywhere' } }, fmt(projectResult.project?.root)),
              h('div', { style: { ...muted, ...mono, overflowWrap: 'anywhere' } }, fmt(projectResult.project?.managementDir)))
            : null,
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' } },
            (projectOnCurrent ? workspaces : []).map((w) => h('button', {
              key: w.id, type: 'button',
              style: { ...button, ...(workspace?.id === w.id ? selectedButton : {}) },
              onClick: () => setProjectId(w.id),
            }, w.label))),
          workspace ? h('div', null,
            h('div', { style: { display: 'grid', gridTemplateColumns: '120px 1fr auto', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
              h('div', { style: muted }, t('path')),
              h('div', { style: mono }, fmt(workspace.path)),
              h('button', { type: 'button', style: button, onClick: () => copy(workspace.path, workspace.id) }, copiedPath === workspace.id ? t('copied') : t('copyPath'))),
            h('div', { style: { ...muted, marginTop: 10 } }, t('entries')),
            (workspace.entries || []).map((entry) =>
              h('div', { key: entry.name, style: { ...row, gridTemplateColumns: '1fr 80px' } },
                h('div', { style: mono }, fmt(entry.name)),
                h('div', { style: muted }, entry.type === 'dir' ? 'dir' : 'file'))),
            h('div', { style: { ...sectionTitle, marginTop: 16 } }, t('managementTitle')),
            h('div', { style: muted }, `${t('managementHint')}${data?.management?.revision ? ` · STATE revision ${fmt(data.management.revision)}` : ''}`),
            (data?.management?.cards || []).length === 0
              ? h(Empty, { text: t('noCards') })
              : (data.management.cards || []).map((card) =>
                h('div', { key: card.name, style: { ...row, gridTemplateColumns: 'minmax(180px, 1.5fr) minmax(80px, .6fr) minmax(200px, 1.3fr)' } },
                  h('div', null, h('div', { style: { fontWeight: 550 } }, fmt(card.name)), h('div', { style: { ...mono, ...muted } }, fmt(card.taskId))),
                  h('div', null, h('span', { style: pill }, fmt(card.status))),
                  h('div', { style: muted }, fmt(card.next))))
          ) : h(Empty, { text: t('workspaceNoInstance') })) : null,

        updateNotice ? h('div', {
          style: {
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 50,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          },
        }, h('div', { style: { ...card, maxWidth: 460, width: '100%', margin: 0, boxShadow: '0 18px 60px rgba(0,0,0,.3)' } },
          h('h2', { style: { ...sectionTitle, marginBottom: 8 } }, updateNotice?.available ? t('updateAvailable') : t('checkUpdate')),
          updateNotice?.available
            ? h('div', { style: { ...muted, marginBottom: 6 } },
              `${t('currentVersion')} ${fmt(updateNotice.currentVersion)} → ${t('latestVersion')} ${fmt(updateNotice.latestVersion)}`)
            : null,
          h('div', { style: { ...muted, marginBottom: 6 } },
            fmt(updateNotice?.message || updateNotice?.error || (updateNotice?.ok ? t('upToDate') : '—'))),
          h('div', { style: { ...muted, ...mono, marginBottom: 14, overflowWrap: 'anywhere' } },
            updateNotice?.repo ? `${updateNotice.repo}@${updateNotice.ref}` : ''),
          updateNotice?.available
            ? h('div', { style: { ...muted, marginBottom: 14 } }, t('updateApplyLater'))
            : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
            updateNotice?.available
              ? h('button', { type: 'button', style: button, onClick: () => setUpdateNotice(null) }, t('laterUpdate'))
              : null,
            h('button', { type: 'button', style: button, onClick: () => setUpdateNotice(null) }, t('close'))))) : null,

        h('div', { style: { ...muted, marginTop: 4 } }, t('footer'))));
    }

    // 首次对话入口：只在"当前 session 未启用"时出现的轻量按钮
    function EnableEntry(props) {
      const sessionId = props?.sessionId || props?.session?.id || null;
      const [enabled, setEnabled] = React.useState(null);
      React.useEffect(() => {
        if (!sessionId) return;
        let alive = true;
        fetch(`${ACCESS_URL}?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((json) => { if (alive) setEnabled(json?.enabled === true); })
          .catch(() => { if (alive) setEnabled(true); });
        return () => { alive = false; };
      }, [sessionId]);
      if (!sessionId || enabled !== false) return null;
      const enable = async () => {
        try {
          await fetch(ACCESS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, coordination: true, by: 'composer' }),
          });
          setEnabled(true);
        } catch {
          setEnabled(false);
        }
      };
      return h('button', {
        type: 'button',
        title: '启用 AI集群工作协议（本对话）',
        style: { ...button, whiteSpace: 'nowrap', fontSize: 12, padding: '2px 8px' },
        onClick: enable,
      }, '🎛 启用 AI集群工作协议');
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 40,
          label: () => 'AI集群工作协议',
        }, Icon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID,
        }, (props) => h(Boundary, null, h(Panel, { ...props, ctx }))));
      },
    };
  },
});
