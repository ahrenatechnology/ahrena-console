// Payloads sintéticos de cada hook, no formato que o Claude Code manda no stdin.

const common = {
  session_id: 'sess-hooks-1',
  transcript_path: '/home/dev/.claude/projects/-repo-app/sess-hooks-1.jsonl',
  cwd: '/repo/app',
  permission_mode: 'default',
};

export const HOOK_PAYLOADS = {
  SessionStart: { ...common, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' },
  UserPromptSubmit: { ...common, hook_event_name: 'UserPromptSubmit', prompt: 'Rode os testes\n e corrija o que falhar' },
  PreToolUse: {
    ...common,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test', description: 'Roda os testes' },
    tool_use_id: 'toolu_01',
  },
  PostToolUse: {
    ...common,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: 'ok', stderr: '', interrupted: false },
    tool_use_id: 'toolu_01',
  },
  Notification: {
    ...common,
    hook_event_name: 'Notification',
    message: 'Claude needs your permission to use Bash',
    notification_type: 'permission_prompt',
  },
  SubagentStop: {
    ...common,
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    agent_id: 'agent-7',
    agent_type: 'Explore',
    agent_transcript_path: '/home/dev/.claude/projects/-repo-app/sess-hooks-1/subagents/agent-7.jsonl',
  },
  Stop: { ...common, hook_event_name: 'Stop', stop_hook_active: false },
  SessionEnd: { ...common, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
} as const;

export type HookName = keyof typeof HOOK_PAYLOADS;
export const HOOK_NAMES = Object.keys(HOOK_PAYLOADS) as HookName[];
