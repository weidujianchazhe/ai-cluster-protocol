/**
 * N5 · UX 契约的可执行检查（U1 prompt 注入 / U3 命令白名单）
 *
 * 这里放**唯一实现**：`run.mjs` 直接 import，N2 的入口实现按同一约束对齐。
 * 原则：
 *   - prompt 注入只放**指针与摘要**，不贴全文（预算是给推理的，不是给 UI 的）；
 *   - 命令只做"读/发起"，**没有任何命令能直接改节点状态**（状态只能经证据事务）。
 */

// ── U1：prompt 注入契约 ────────────────────────────────────────────
export const PROMPT_SECTION_MAX_CHARS = 200;
export const PROMPT_SECTION_MAX_LINES = 2;

/**
 * 生成"任务指针"段（N2 的 systemPrompt.section 实现应产出等价内容）。
 * 只允许：node / role / stage / evidence_required / budget 五类指针。
 */
export function buildPromptSection({ nodeId, role, stage, evidenceRequired = [], budgetTokens = 0 } = {}) {
  const evidence = evidenceRequired.length ? evidenceRequired.join(',') : '-';
  const budget = budgetTokens > 0 ? `${budgetTokens}t` : '-';
  return `任务指针 node=${nodeId} role=${role} stage=${stage} 证据=${evidence} 预算=${budget}`;
}

/** 校验一段注入文本是否满足"只放指针"契约 */
export function validatePromptSection(text, expect = {}) {
  const issues = [];
  const value = String(text ?? '');
  if (!value.trim()) issues.push('空文本');
  if (value.length > PROMPT_SECTION_MAX_CHARS) issues.push(`超长 ${value.length}>${PROMPT_SECTION_MAX_CHARS}`);
  const lines = value.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length > PROMPT_SECTION_MAX_LINES) issues.push(`行数 ${lines.length}>${PROMPT_SECTION_MAX_LINES}`);

  // 指针必须齐全
  for (const [key, needle] of [
    ['nodeId', expect.nodeId],
    ['role', expect.role],
    ['stage', expect.stage],
  ]) {
    if (needle && !value.includes(String(needle))) issues.push(`缺指针 ${key}=${needle}`);
  }
  for (const kind of expect.evidenceRequired ?? []) {
    if (!value.includes(String(kind))) issues.push(`缺证据类型 ${kind}`);
  }

  // 反例守卫：出现"全文搬运"的迹象即判失败
  const BODY_MARKERS = ['BEGIN', '-----', 'diff --git', 'PRD 正文', '```'];
  for (const marker of BODY_MARKERS) {
    if (value.includes(marker)) issues.push(`出现正文标记 ${marker}`);
  }
  if (value.length > 0 && Math.max(...lines.map((l) => l.length)) > 160) issues.push('单行过长（疑似贴正文）');

  return { ok: issues.length === 0, issues };
}

// ── U3：命令白名单契约 ────────────────────────────────────────────
/** 允许的命令 → 目标工具（只允许读/发起类）。工具名随 N6 改名同步：
 *  `export → graph_export`、`decide → decision_record`；`team_status` 未改名。 */
export const ALLOWED_COMMANDS = Object.freeze({
  '/wish': 'wish_submit',
  '/status': 'graph_status',
  '/next': 'task_next',
  '/decide': 'decision_record',
  '/export': 'graph_export',
  '/team': 'team_status',
});

/** 明确禁止的命令形态（会绕过证据事务） */
export const FORBIDDEN_COMMAND_PATTERNS = Object.freeze([
  /^\/done$/i,
  /^\/set[-_]?status/i,
  /^\/force/i,
  /^\/skip[-_]?evidence/i,
  /^\/accept/i,
]);

/** 任何会直接改状态的工具名都不得出现在工具面里（状态只能经证据事务） */
export const FORBIDDEN_TOOL_PATTERNS = Object.freeze([
  /set[-_]?status/i,
  /force[-_]?done/i,
  /skip[-_]?evidence/i,
]);

export function validateCommand(command) {
  const cmd = String(command ?? '').trim();
  const forbidden = FORBIDDEN_COMMAND_PATTERNS.some((re) => re.test(cmd));
  if (forbidden) return { allowed: false, reason: 'forbidden-pattern', mapsTo: null };
  const target = ALLOWED_COMMANDS[cmd];
  if (!target) return { allowed: false, reason: 'not-in-allowlist', mapsTo: null };
  return { allowed: true, reason: 'ok', mapsTo: target };
}

export function validateToolSurface(toolNames = []) {
  const issues = [];
  for (const name of toolNames) {
    if (FORBIDDEN_TOOL_PATTERNS.some((re) => re.test(name))) issues.push(`出现可直改状态的工具：${name}`);
  }
  // 命令目标必须都在工具面里
  for (const [cmd, target] of Object.entries(ALLOWED_COMMANDS)) {
    if (toolNames.length && !toolNames.includes(target)) issues.push(`命令 ${cmd} 的目标工具不在工具面：${target}`);
  }
  return {
    ok: issues.length === 0,
    issues,
    allowlist: Object.entries(ALLOWED_COMMANDS).map(([cmd, tool]) => `${cmd}→${tool}`),
  };
}
