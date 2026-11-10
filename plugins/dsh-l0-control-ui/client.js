window.__ModuleLoader__.load({
  id: '@local/dsh-l0-control-ui',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'l0-control-ui';
    const PANEL_ID = 'l0-control';
    // ── 面板服务地址解析 ─────────────────────────────────────────────────────
    // 面板服务端口是**可配置的**（cfg.uiPort，默认 47831）。写死会在改端口后整套请求
    // 落到 `Failed to fetch`，且错误看起来像"没启动"，排查方向被完全带偏。
    // 策略：注入值/上次成功的值 → 默认端口 → 候选探测；成功后记进 localStorage。
    const DEFAULT_SIDECAR_PORT = 47831;
    const BASE_STORAGE_KEY = 'l0-control-ui.base';
    const baseCandidates = () => {
      const list = [];
      try {
        const injected = (window.__DSH_L0_CONTROL_UI__ && window.__DSH_L0_CONTROL_UI__.baseUrl) || null;
        const saved = window.localStorage ? window.localStorage.getItem(BASE_STORAGE_KEY) : null;
        const def = window.__DSH_L0_CONTROL_UI__ && window.__DSH_L0_CONTROL_UI__.port;
        if (injected) list.push(String(injected));
        if (saved) list.push(String(saved));
        const basePort = Number(def) || DEFAULT_SIDECAR_PORT;
        // 服务端在端口被占时会依次试 +1…+7，甚至交给系统分配；
        // 面板必须把同一批候选都探一遍，否则「换个端口起来」等于没起。
        for (let i = 0; i < 8; i += 1) list.push(`http://127.0.0.1:${basePort + i}`);
      } catch {
        list.push(`http://127.0.0.1:${DEFAULT_SIDECAR_PORT}`);
      }
      return [...new Set(list.map((b) => String(b).replace(/\/$/, '')))];
    };

    let resolvedBase = null;
    let resolving = null;

    /** 最近一次探测的失败明细（给用户看的"试过什么"）。 */
    let probeLog = [];

    /**
     * 探测哪个 base 上是我们的面板服务（用 /ui/health，极便宜，不构造快照）。
     * 判定放宽为「200 + ok:true」：服务名只作加分项——早前版本的健康端点没有
     * `service` 字段，硬校验会让面板永远连不上。
     */
    const resolveBase = async () => {
      if (resolvedBase) return resolvedBase;
      if (resolving) return resolving;
      resolving = (async () => {
        probeLog = [];
        for (const base of baseCandidates()) {
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 4000);
            const res = await fetch(`${base}/ui/health`, {
              signal: ctrl.signal,
              headers: { accept: 'application/json' },
            });
            clearTimeout(timer);
            if (!res.ok) {
              probeLog.push(`${base} → HTTP ${res.status}`);
              continue;
            }
            const json = await res.json().catch(() => null);
            if (json && json.ok === true) {
              resolvedBase = base;
              probeLog.push(`${base} → OK`);
              try { window.localStorage && window.localStorage.setItem(BASE_STORAGE_KEY, base); } catch {}
              return base;
            }
            probeLog.push(`${base} → 非本插件响应`);
          } catch (error) {
            const msg = String((error && error.message) || error);
            probeLog.push(`${base} → ${msg.includes('abort') ? '超时' : msg}`);
          }
        }
        const err = new Error('面板服务不可达');
        err.probeLog = probeLog.slice();
        throw err;
      })();
      try {
        return await resolving;
      } finally {
        resolving = null;
      }
    };

    /**
     * 带超时的请求：服务卡住时不能让面板无限转圈。
     * 超时/中断必须换成能定位的文字——原样抛 AbortError 时，界面上只会显示
     * `signal is aborted without reason`，既看不出是哪个地址、也看不出等了多久。
     */
    const request = async (base, path, init = {}, timeoutMs = 8000) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const started = Date.now();
      try {
        return await fetch(`${base}${path}`, { ...init, signal: ctrl.signal });
      } catch (error) {
        const elapsed = Date.now() - started;
        const name = String((error && error.name) || '');
        if (name === 'AbortError') {
          const err = new Error(`请求超时：${base}${path}（${elapsed}ms 未响应，超时阈值 ${timeoutMs}ms）`);
          err.timeout = true;
          err.url = `${base}${path}`;
          throw err;
        }
        const err = new Error(`请求失败：${base}${path}（${String((error && error.message) || error)}）`);
        err.url = `${base}${path}`;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    };

    /** 统一 GET JSON：自动解析 base、超时、并把失败原因说清楚。 */
    const getJson = async (path, timeoutMs) => {
      const base = await resolveBase();
      let res;
      try {
        res = await request(base, path, { headers: { accept: 'application/json' } }, timeoutMs);
      } catch (error) {
        // 缓存可能指向一个已经死掉的地址：清掉，下一轮自动重新探测
        resolvedBase = null;
        try { window.localStorage && window.localStorage.removeItem(BASE_STORAGE_KEY); } catch {}
        throw error;
      }
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error((json && (json.error || json.message)) || `HTTP ${res.status}`);
        err.status = res.status;
        err.payload = json;
        throw err;
      }
      return json;
    };

    /** 统一 POST JSON。 */
    const postJson = async (path, body, timeoutMs = 15000) => {
      const base = await resolveBase();
      let res;
      try {
        res = await request(base, path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body || {}),
        }, timeoutMs);
      } catch (error) {
        resolvedBase = null;
        try { window.localStorage && window.localStorage.removeItem(BASE_STORAGE_KEY); } catch {}
        throw error;
      }
      const json = await res.json().catch(() => null);
      if (!res.ok && (!json || json.ok !== false)) {
        const err = new Error((json && (json.error || json.message)) || `HTTP ${res.status}`);
        err.status = res.status;
        err.payload = json;
        throw err;
      }
      return json;
    };

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
      offline: '面板服务未连接：已在回环地址上探测服务端口但没找到。请确认控制面插件（dsh-l0-control）已启用；若改过 uiPort，请把面板地址指到该端口。',
      members: '团队成员',
      agentsEmpty: 'No sub-agents spawned yet. Spawn via agent_spawn or dispatch and they will appear here.',
      teamNotCollected: 'Team board not collected yet. Click "Refresh team" to have this window\'s agent read it once.',
      tabAgents: '智能体',
      clusterLabel: '工作区集群',
      agentsTitle: '智能体花名册',
      agentsHint: '从插件 journal 折叠而来：谁被派出来、领了哪个节点、交没交证据、最后活跃时间；不依赖 team_status。',
      agentsTotal: '智能体总数',
      agentsRunning: '运行中',
      agentsIdle: '空闲',
      agentsWithLease: '持有节点',
      agentsEmpty: '还没有派出过子 Agent；用 agent_spawn 或 dispatch 派活后会出现在这里。',
      agentsRole: '职务',
      agentsInstance: '实例',
      agentsActivity: '状态',
      agentsNode: '当前节点',
      agentsEvidence: '证据',
      agentsLastSeen: '最后活跃',
      graphNodes: '图节点',
      graphDone: '已完成',
      teamNotCollected: '团队板尚未采集：点「刷新团队统计」让本窗口的 Agent 读一次。',
      switchTarget: '作用对象',
      enableAlsoCluster: '启用时会一并启用到本工作区（工作区集群），不需要再单独点一次。',
      accessOn: '本对话：已启用',
      accessOff: '本对话：未启用',
      subagents: '递归子 Agent 总数',
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
      activeTitle: '活跃子 Agent',
      activeHint: '只显示当前 activity=running 的递归子 Agent；DSH 列表里的绿点是“可继续”，不等于运行中。',
      activeEmpty: '当前没有运行中的子 Agent（历史子 Agent 仍保留在递归统计中）。',
      readyHint: '图谱为空（0 nodes）：就绪节点=依赖已完成、可被 task_claim 的节点；先 graph_plan 预览、graph_commit 落图（wish_submit 只记录意图，不建图）。',
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
      clusterEnabled: '工作区集群：已启用',
      clusterDisabled: '工作区集群：未启用',
      enableCluster: '启用工作区集群',
      refreshTeam: '刷新团队统计',
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
      offline: 'UI sidecar not found on loopback: the panel probed the sidecar port and got nothing. Make sure dsh-l0-control is enabled; if uiPort was changed, point the panel at that port.',
      members: 'Members',
      tabAgents: 'Agents',
      clusterLabel: 'Workspace cluster',
      agentsTitle: 'Agent roster',
      agentsHint: 'Folded from the plugin journal: who was spawned, which node they hold, evidence count and last seen. Independent of team_status.',
      agentsTotal: 'Agents',
      agentsRunning: 'Running',
      agentsIdle: 'Idle',
      agentsWithLease: 'Holding nodes',
      agentsEmpty: 'No sub-agents spawned yet. Spawn one with agent_spawn or dispatch and it will show up here.',
      agentsRole: 'Role',
      agentsInstance: 'Instance',
      agentsActivity: 'Activity',
      agentsNode: 'Current node',
      agentsEvidence: 'Evidence',
      agentsLastSeen: 'Last seen',
      graphNodes: 'Nodes',
      graphDone: 'Done',
      teamNotCollected: 'Team board not collected yet. Click Refresh team to let this window agent read it once.',
      switchTarget: 'Target',
      enableAlsoCluster: 'Enabling also turns it on for this workspace, so no separate cluster button is needed.',
      accessOn: 'This conversation: enabled',
      accessOff: 'This conversation: disabled',
      subagents: 'Recursive subagent total',
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
      activeTitle: 'Active subagents',
      activeHint: 'Only recursive subagents with activity=running; a green dot in the DSH list means resumable, not running.',
      activeEmpty: 'No subagent is running right now (historical subagents remain in the recursive count).',
      readyHint: 'Graph is empty (0 nodes): ready nodes are dependency-satisfied and claimable by task_claim; preview with graph_plan then graph_commit (wish_submit only records intent, it does not build a graph).',
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
      clusterEnabled: 'Workspace cluster: enabled',
      clusterDisabled: 'Workspace cluster: disabled',
      enableCluster: 'Enable workspace cluster',
      refreshTeam: 'Refresh team stats',
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

    function Stat({ label, value, tone }) {
      const valueStyle = tone === 'on'
        ? { ...statValue, color: 'var(--dsw-alias-brand-primary)' }
        : statValue;
      return h('div', { style: stat }, h('div', { style: valueStyle }, String(value)), h('div', { style: muted }, label));
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
      const [tab, setTab] = React.useState('agents');
      const [sidebarId, setSidebarId] = React.useState(null);
      const [projectId, setProjectId] = React.useState('code');
      const [pickedSession, setPickedSession] = React.useState(null);
      const [data, setData] = React.useState(null);
      // 黑板增量 cursor（journal 行数）：初始 null → 首次取最近 40
      const cursorRef = React.useRef(null);
      const failStreakRef = React.useRef(0);
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
      const clusterEnabled = data?.cluster?.enabled === true;
      const managementMode = ['off', 'auto', 'on'].includes(data?.access?.management) ? data.access.management : 'off';
      // 子 Agent 快照来源：live=实时，snapshot=上次持久化，none=没有任何数据（显示 —）
      const descendantsSource = data?.descendants?.source || 'none';
      // 新建项目用的目标工作区：优先侧栏选中的真实 path
      const boardWorkspacePath = (activeSidebar && activeSidebar.path) || data?.workspaceRoot || null;
      // 关键修复：原来 `showData = coordinationEnabled && sessionAttached`，而 sessionAttached
      // 要求 team_status 被**活 Agent 手动调过**——没人调，整个面板就只剩「—」，看起来像摆设。
      // 现在：拿到快照就展示（图计数、agent 花名册、黑板都来自 journal，与 team_status 无关）；
      // team 数据缺了只是那一块显示"未采集"，不再拖垮整页。
      const showData = Boolean(data && data.ok === true);
      const setAccess = async (patch) => {
        const target = activeSessionId || liveSessionId || data?.sessionId || null;
        if (!target) {
          setError(t('needSession'));
          return;
        }
        try {
          const detail = await postJson('/ui/access', {
            sessionId: target,
            workspaceRoot: boardWorkspacePath,
            ...patch,
            by: 'ui',
          });
          if (detail && detail.ok === false) throw new Error(detail.error || 'access-failed');
          await load();
        } catch (e) {
          setError(String(e?.message || e));
        }
      };
      /**
       * 一个开关搞定两件事：本对话启用 + 工作区集群启用。
       * 原来「启用插件」和「启用工作区集群」是两个按钮，语义重叠、还容易只点一个；
       * 现在启用时顺带把工作区集群打开（幂等），关闭只关本对话。
       */
      const toggleAccess = async (next) => {
        if (next && !clusterEnabled) {
          try {
            await postJson('/ui/cluster-enable', {
              workspaceRoot: boardWorkspacePath,
              sessionId: activeSessionId || liveSessionId || data?.sessionId || null,
            });
          } catch {
            // 集群开关失败不阻断本对话启用；下面 setAccess 会给出真实状态
          }
        }
        await setAccess({ coordination: next });
      };
      const setManagement = (mode) => setAccess({ management: mode });
      // 新建项目表单（用当前选中工作区）
      const refreshTeam = async () => {
        const target = activeSessionId || liveSessionId || data?.sessionId || null;
        if (!target || !boardWorkspacePath) {
          setError(t('needSession'));
          return;
        }
        try {
          const res = await postJson('/ui/team-refresh', {
            workspaceRoot: boardWorkspacePath,
            sessionId: target,
          });
          const detail = await res.json().catch(() => ({}));
          if (!res.ok || detail?.ok === false) throw new Error(detail?.error || `${res.status} ${res.statusText}`);
          await load();
        } catch (e) {
          setError(String(e?.message || e));
        }
      };
      const [newName, setNewName] = React.useState('');
      const [newWish, setNewWish] = React.useState('');
      const [projectResult, setProjectResult] = React.useState(null);
      const createProject = async (dryRun) => {
        try {
          const json = await postJson('/ui/project-init', {
            sessionId: activeSessionId || liveSessionId || data?.sessionId || null,
            workspaceRoot: boardWorkspacePath,
            projectName: newName || 'project',
            wish: newWish || undefined,
            dryRun,
          }, 30000);
          setProjectResult(json);
          if (!dryRun && json?.ok) await load();
        } catch (e) {
          setProjectResult({ ok: false, error: String(e?.message || e) });
        }
      };
      const [updateNotice, setUpdateNotice] = React.useState(null);
      const checkUpdate = async () => {
        try {
          const json = await getJson('/ui/update-check', 20000);
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
          if (cursorRef.current !== null) params.set('sinceSeq', String(cursorRef.current));
          const qs = params.toString();
          const json = await getJson(qs ? `/ui/snapshot?${qs}` : '/ui/snapshot');
          if (!json || json.ok !== true) throw new Error(json?.error || 'snapshot failed');
          // 黑板增量合并：initial/fallback 直接替换；incremental 只把新行接到前面
          const incoming = Array.isArray(json.blackboard) ? json.blackboard : [];
          const mode = json.blackboardMode || (cursorRef.current === null ? 'initial' : 'incremental');
          setData((prev) => {
            if (!prev || mode !== 'incremental') return json;
            const seen = new Set();
            const merged = [];
            for (const row of [...incoming, ...(prev.blackboard || [])]) {
              const key = `${row?.at || ''}|${row?.kind || ''}|${row?.nodeId || ''}|${row?.text || ''}`;
              if (seen.has(key)) continue;
              seen.add(key);
              merged.push(row);
              if (merged.length >= 40) break;
            }
            return { ...json, blackboard: merged };
          });
          if (typeof json.blackboardCursor === 'number') cursorRef.current = json.blackboardCursor;
          failStreakRef.current = 0;
          setError(null);
        } catch (e) {
          // 保留 Error 对象：横幅要读 e.probeLog（每个候选地址的结果）。
          // 之前写成 setError(String(e))，属性被拍平，于是只能说"不可达"，等于把诊断信息丢了。
          failStreakRef.current += 1;
          // 插件重载/服务重启会造成 1–2 次瞬时失败（在途请求被 abort）。
          // 连续失败 2 次以上才提示，避免每次热更新面板都弹一条吓人的红条。
          if (failStreakRef.current >= 2) {
            setError(e instanceof Error ? e : Object.assign(new Error(String(e?.message || e)), { probeLog: e?.probeLog }));
          }
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
      const roster = data?.agents && data.agents.ok ? data.agents : null;
      const rosterItems = Array.isArray(roster?.items) ? roster.items : [];
      const members = Array.isArray(team?.members) ? team.members : [];
      const tasks = Array.isArray(team?.tasks) ? team.tasks : [];
      const ready = Array.isArray(data?.graph?.ready) ? data.graph.ready : [];
      const events = Array.isArray(data?.blackboard) ? data.blackboard : [];
      const descendantItems = Array.isArray(data?.descendants?.items) ? data.descendants.items : [];
      const activeDescendants = descendantItems.filter((item) => item?.activity === 'running');
      const graphNodes = Number(data?.graph?.counts?.nodes ?? 0);
      const graphEmpty = !data?.graph || graphNodes === 0;

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
        ['agents', t('tabAgents')],
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

        error ? h('div', { style: { ...card, marginBottom: 12, borderColor: 'var(--dsw-alias-state-warn-primary)' } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, t('offline')),
          h('div', { style: mono }, String(error?.message || error)),
          error && error.url ? h('div', { style: { ...mono, ...muted, marginTop: 4 } }, `地址：${error.url}`) : null,
          Array.isArray(error && error.probeLog) && error.probeLog.length
            ? h('div', { style: { ...mono, ...muted, marginTop: 6, whiteSpace: 'pre-wrap' } },
              `探测明细：\n${error.probeLog.join('\n')}`)
            : null,
          h('div', { style: { ...muted, marginTop: 6 } },
            '排查：① 确认 dsh-l0-control 插件为启用；② 若改过 uiPort，把它告诉面板；③ 端口 47831 是否被别的程序占用。')) : null,

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
          h(Stat, { label: t('agentsTotal'), value: loading ? '…' : String(roster?.total ?? 0) }),
          h(Stat, { label: t('agentsRunning'), value: loading ? '…' : String(roster?.running ?? 0), tone: (roster?.running ?? 0) > 0 ? 'on' : null }),
          h(Stat, { label: t('agentsIdle'), value: loading ? '…' : String(roster?.idle ?? 0) }),
          h(Stat, { label: t('agentsWithLease'), value: loading ? '…' : String(roster?.withLease ?? 0) }),
          h(Stat, { label: t('graphNodes'), value: loading ? '…' : String(counts?.nodes ?? 0) }),
          h(Stat, { label: t('graphDone'), value: loading ? '…' : String(counts?.done ?? 0) })),
        h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 2, marginBottom: 6 } },
          h('span', { style: muted }, `${t('subagents')}: ${descendantsSource === 'none' ? '—' : (data?.descendants?.count ?? 0)}`),
          h('span', { style: muted }, `${t('activeSubagents')}: ${descendantsSource === 'none' ? '—' : (data?.descendants?.active ?? 0)}`),
          h('span', { style: muted }, `${t('members')}: ${team ? (team.memberCount ?? members.length) : '—'}`),
          h('span', { style: muted }, `${t('ready')}: ${graphEmpty ? '—' : ready.length}`),
          h('span', { style: muted }, `${t('events')}: ${data?.journal?.events ?? events.length}`)),
        showData && graphEmpty ? h('div', { style: { ...muted, marginTop: -4, marginBottom: 8 } }, t('readyHint')) : null,
        coordinationEnabled && !sessionAttached ? h('div', { style: { ...muted, marginTop: -4, marginBottom: 8 } }, t('noSessionSnapshot')) : null,

        // 两块分开：左边事实源，右边插件开关（只控制协作）
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(260px, .9fr)', gap: 12, marginTop: 12, alignItems: 'start' } },
          // 左：事实与计数（紧凑，不留大片空白）
          h('div', { style: { ...card, margin: 0, padding: '10px 12px', alignSelf: 'start' } },
            h('div', { style: { ...sectionTitle, margin: 0 } }, t('source')),
            h('div', { style: { ...muted, marginTop: 2 } }, t('sourceValue')),
            h('div', { style: { ...mono, ...muted, marginTop: 6 } },
              `${t('graphNodes')} ${counts?.nodes ?? 0} · ${t('graphDone')} ${counts?.done ?? 0} · ${t('ready')} ${graphEmpty ? 0 : ready.length}`),
            h('div', { style: { ...mono, ...muted, marginTop: 2 } },
              `${t('events')} ${data?.journal?.events ?? 0} · ${t('subagents')} ${descendantsSource === 'none' ? '—' : (data?.descendants?.count ?? 0)}`),
            h('div', { style: { ...mono, ...muted, marginTop: 2, overflowWrap: 'anywhere' } }, String(data?.stateDir || '')),
            h('div', { style: { ...muted, marginTop: 6 } }, clusterEnabled ? t('clusterEnabled') : t('clusterDisabled'))),

          // 右：控制区——**一个开关**（启用/关闭）+ 管理三态，避免两个"启用"让人分不清
          h('div', { style: { ...card, margin: 0, padding: '10px 12px', alignSelf: 'start' } },
            h('div', { style: { ...muted, ...mono, marginBottom: 6 } },
              `${t('switchTarget')}: ${activeSessionId ? sessionLabel(sessionById.get(activeSessionId)) : '—'}`),
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 } },
              h('div', null,
                h('div', { style: { ...sectionTitle, margin: 0 } }, t('pluginSwitch')),
                h('div', { style: { ...muted, marginTop: 3 } }, coordinationEnabled ? t('accessOn') : t('accessOff'))),
              h('button', {
                type: 'button',
                style: { ...button, ...(coordinationEnabled ? selectedButton : {}) },
                onClick: () => toggleAccess(!coordinationEnabled),
              }, coordinationEnabled ? t('disablePlugin') : t('enablePlugin'))),
            clusterEnabled ? null : h('div', { style: { ...muted, marginTop: 4 } }, t('enableAlsoCluster')))),

        h('div', { style: tabRow }, tabs.map(([id, label]) =>
          h('button', { key: id, type: 'button', style: tabStyle(tab === id), onClick: () => setTab(id) }, label))),

        tab === 'agents' ? h('div', { style: card },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' } },
            h('h2', { style: sectionTitle }, t('agentsTitle')),
            h('span', { style: muted }, loading ? '…' : `${roster?.total ?? 0}`)),
          h('div', { style: muted }, t('agentsHint')),
          roster && roster.byRole && Object.keys(roster.byRole).length
            ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 } },
              Object.entries(roster.byRole).map(([role, n]) => h('span', { key: role, style: pill }, `${role} × ${n}`)))
            : null,
          rosterItems.length === 0
            ? h(Empty, { text: t('agentsEmpty') })
            : rosterItems.map((item) => h('div', {
              key: item.instanceId,
              style: { ...row, gridTemplateColumns: 'minmax(150px, 1.4fr) minmax(90px, .7fr) minmax(90px, .6fr) minmax(120px, 1fr)' },
            },
              h('div', null,
                h('div', { style: { fontWeight: 550 } }, fmt(item.label || item.instanceId)),
                h('div', { style: { ...mono, ...muted } }, fmt(item.instanceId))),
              h('div', null, h('span', { style: pill }, fmt(item.role))),
              h('div', null, h('span', {
                style: item.activity === 'running' ? { ...pill, color: 'var(--dsw-alias-brand-primary)' } : pill,
              }, fmt(item.activity))),
              h('div', null,
                h('div', { style: mono }, fmt(item.currentNode)),
                h('div', { style: { ...mono, ...muted, fontSize: 11 } },
                  `${t('agentsEvidence')} ${item.evidenceCount ?? 0} · ${t('agentsLastSeen')} ${fmt(String(item.lastSeen || '').slice(11, 19))}`))))) : null,

        tab === 'team' ? h('div', { style: card },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12 } },
            h('h2', { style: sectionTitle }, t('teamTitle')),
            h('span', { style: muted }, team ? `${team.memberCount ?? members.length}` : '—')),
          h('div', { style: muted }, t('teamHint')),
          h('button', { type: 'button', style: { ...button, marginTop: 6, fontSize: 12, padding: '2px 8px' }, onClick: refreshTeam }, t('refreshTeam')),
          h('div', { style: { ...muted, marginTop: 4 } }, `来源 ${teamSource}${data?.team?.capturedAt ? ` · ${data.team.capturedAt}` : ''}${data?.team?.sessionId ? ` · session ${String(data.team.sessionId).slice(0, 12)}` : ''}`),
          coordinationEnabled ? null : h('div', { style: { ...muted, marginTop: 6 } }, t('accessOff')),
          team ? null : h('div', { style: { ...muted, marginTop: 6 } }, t('teamNotCollected')),
          !showData ? null : members.length === 0 ? h(Empty, { text: t('noMembers') }) : members.map((m) =>
            h('div', { key: m.id || m.name, style: { ...row, gridTemplateColumns: 'minmax(140px, 1.4fr) minmax(80px, .7fr) minmax(80px, .7fr)' } },
              h('div', null, h('div', { style: { fontWeight: 550 } }, fmt(m.name || m.id)), h('div', { style: { ...mono, ...muted } }, fmt(m.id || ''))),
              h('div', null, h('span', { style: pill }, fmt(m.role))),
              h('div', null, h('span', { style: pill }, fmt(m.status)))))) : null,
          !showData ? null : h('div', { style: { marginTop: 16, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 12 } },
            h('h3', { style: { ...sectionTitle, fontSize: 14, margin: 0 } }, t('activeTitle')),
            h('div', { style: { ...muted, margin: '4px 0 8px' } }, t('activeHint')),
            activeDescendants.length === 0
              ? h('div', { style: muted }, t('activeEmpty'))
              : activeDescendants.map((item, index) => h('div', { key: item.id || index, style: { ...row, gridTemplateColumns: 'minmax(180px, 1.5fr) minmax(70px, .5fr) minmax(90px, .7fr)' } },
                h('div', null, h('div', { style: { fontWeight: 550 } }, fmt(item.label || item.id)), h('div', { style: { ...mono, ...muted } }, fmt(item.id || ''))),
                h('div', null, h('span', { style: pill }, `depth ${fmt(item.depth)}`)),
                h('div', null, h('span', { style: pill }, fmt(item.activity)))))),

        tab === 'tasks' ? h('div', { style: card },
          h('h2', { style: sectionTitle }, t('tasksTitle')),
          h('div', { style: muted }, t('tasksHint')),
          coordinationEnabled ? null : h('div', { style: { ...muted, marginTop: 4 } }, t('accessOff')),
          tasks.length === 0 ? h(Empty, { text: team ? t('noTasks') : t('teamNotCollected') }) : tasks.map((task) =>
            h('div', { key: task.id, style: { ...row, gridTemplateColumns: 'minmax(180px, 1.6fr) minmax(90px, .6fr) minmax(110px, .7fr)' } },
              h('div', null, h('div', { style: { fontWeight: 550 } }, fmt(task.subject || task.id)), h('div', { style: { ...mono, ...muted } }, fmt(task.id))),
              h('div', null, h('span', { style: pill }, fmt(task.status))),
              h('div', { style: muted }, fmt(task.ownerName))))) : null,

        tab === 'board' ? h('div', { style: card },
          h('h2', { style: sectionTitle }, t('boardTitle')),
          h('div', { style: muted }, t('boardHint')),
          // 摘要行：总数 / 已显示 / 旧事件数 / 最近失败（不拉全量历史）
          data?.blackboardSummary
            ? h('div', { style: { ...muted, ...mono, marginTop: 4 } },
              `${t('bbTotal')} ${data.blackboardSummary.total} · ${t('bbShown')} ${data.blackboardSummary.shown} · ${t('bbOlder')} ${data.blackboardSummary.older}`
              + `${data.blackboardMode ? ` · ${data.blackboardMode}` : ''}`
              + `${(data.blackboardSummary.failedDecisions || []).length ? ` · ${t('bbFailed')} ${data.blackboardSummary.failedDecisions.length}` : ''}`)
            : null,
          events.length === 0 ? h(Empty, { text: t('noEvents') }) : events.map((event, index) =>
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
        getJson(`/ui/access?sessionId=${encodeURIComponent(sessionId)}`)
          .then((res) => res.json())
          .then((json) => { if (alive) setEnabled(json?.enabled === true); })
          .catch(() => { if (alive) setEnabled(true); });
        return () => { alive = false; };
      }, [sessionId]);
      if (!sessionId || enabled !== false) return null;
      const enable = async () => {
        try {
          await postJson('/ui/access', { sessionId, coordination: true, by: 'composer' });
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
