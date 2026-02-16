import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from './api-client.js';
import type { Synv2Config } from './config.js';

function text(data: unknown): { content: { type: "text"; text: string }[] } {
  const s = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text: s }] };
}

export function registerTools(server: McpServer, config: Synv2Config) {
  const api = new ApiClient(config);

  server.tool(
    'list_projects',
    'List all synv2 projects and their status',
    {},
    async () => {
      const result = await api.listProjects();
      return text(result);
    }
  );

  server.tool(
    'get_project_status',
    'Get detailed status of a project including task progress, pending questions, and metrics',
    { project: z.string().describe('Project name') },
    async ({ project }) => {
      const result = await api.getProject(project);
      return text(result);
    }
  );

  server.tool(
    'send_message',
    'Send a message to a project\'s agent. Fire-and-forget — does not wait for response (turns take minutes). Use get_project_status or get_agent_memory to check results later.',
    {
      project: z.string().describe('Project name'),
      message: z.string().describe('Message to send to the agent'),
    },
    async ({ project, message }) => {
      const result = await api.sendMessage(project, message);
      return text(result);
    }
  );

  server.tool(
    'create_task',
    'Create or replace a task for a project. The task defines what the autonomous agent should work on.',
    {
      project: z.string().describe('Project name'),
      name: z.string().describe('Task name'),
      description: z.string().optional().describe('Task description'),
      type: z.enum(['measurable', 'subjective']).optional().describe('Task type (default: subjective)'),
      goal_description: z.string().optional().describe('Goal description'),
      goal_verify_command: z.string().optional().describe('Shell command to verify goal completion'),
      goal_target_value: z.number().optional().describe('Target numeric value for measurable tasks'),
      goal_direction: z.enum(['below', 'above']).optional().describe('Whether target should be above or below goal_target_value'),
      max_idle_turns: z.number().optional().describe('Max turns with no progress before stopping (default: 20)'),
      max_turns: z.number().optional().describe('Max total turns'),
      system_prompt_prepend: z.string().optional().describe('Text to prepend to agent system prompt'),
      system_prompt_append: z.string().optional().describe('Text to append to agent system prompt'),
    },
    async ({ project, name, description, type, goal_description, goal_verify_command, goal_target_value, goal_direction, max_idle_turns, max_turns, system_prompt_prepend, system_prompt_append }) => {
      const taskDef: Record<string, unknown> = { name };
      if (description) taskDef.description = description;
      if (type) taskDef.type = type;

      const goal: Record<string, unknown> = {};
      if (goal_description) goal.description = goal_description;
      if (goal_verify_command) goal.verify_command = goal_verify_command;
      if (goal_target_value !== undefined) goal.target_value = goal_target_value;
      if (goal_direction) goal.direction = goal_direction;
      if (Object.keys(goal).length > 0) taskDef.goal = goal;

      const limits: Record<string, unknown> = {};
      if (max_idle_turns !== undefined) limits.max_idle_turns = max_idle_turns;
      if (max_turns !== undefined) limits.max_turns = max_turns;
      if (Object.keys(limits).length > 0) taskDef.limits = limits;

      const context: Record<string, unknown> = {};
      if (system_prompt_prepend) context.system_prompt_prepend = system_prompt_prepend;
      if (system_prompt_append) context.system_prompt_append = system_prompt_append;
      if (Object.keys(context).length > 0) taskDef.context = context;

      const result = await api.createTask(project, taskDef);
      return text(result);
    }
  );

  server.tool(
    'stop_task',
    'Stop the running task for a project',
    { project: z.string().describe('Project name') },
    async ({ project }) => {
      const result = await api.stopTask(project);
      return text(result);
    }
  );

  server.tool(
    'resume_task',
    'Resume a stopped task for a project',
    { project: z.string().describe('Project name') },
    async ({ project }) => {
      const result = await api.resumeTask(project);
      return text(result);
    }
  );

  server.tool(
    'respond_to_question',
    'Answer a question from the agent. Questions may be blocking (agent paused waiting) or non-blocking (informational).',
    {
      project: z.string().describe('Project name'),
      question_id: z.string().describe('ID of the question to answer'),
      answer: z.string().describe('Your answer to the question'),
    },
    async ({ project, question_id, answer }) => {
      const result = await api.respondToQuestion(project, question_id, answer);
      return text(result);
    }
  );

  server.tool(
    'set_operator_directive',
    'Set a persistent operator directive for a project. Directives are injected into every supervisor prompt and the agent is told they are mandatory.',
    {
      project: z.string().describe('Project name'),
      instruction: z.string().describe('The directive instruction (e.g. "keep MAX_PARALLEL=40, do not change it")'),
      id: z.string().optional().describe('Directive ID (auto-generated if omitted)'),
    },
    async ({ project, instruction, id }) => {
      const result = await api.setDirective(project, instruction, id);
      return text(result);
    }
  );

  server.tool(
    'list_operator_directives',
    'List all operator directives for a project.',
    { project: z.string().describe('Project name') },
    async ({ project }) => {
      const result = await api.listDirectives(project);
      return text(result);
    }
  );

  server.tool(
    'remove_operator_directive',
    'Remove an operator directive by ID.',
    {
      project: z.string().describe('Project name'),
      directive_id: z.string().describe('ID of the directive to remove'),
    },
    async ({ project, directive_id }) => {
      const result = await api.deleteDirective(project, directive_id);
      return text(result);
    }
  );

  server.tool(
    'control_supervisor',
    'Control the supervisor process for a project. Actions: pause (stop autonomous prompts), resume (restart prompting), stop (kill supervisor), restart (kill and let entrypoint restart it).',
    {
      project: z.string().describe('Project name'),
      action: z.enum(['pause', 'resume', 'stop', 'restart']).describe('Control action'),
    },
    async ({ project, action }) => {
      const result = await api.controlSupervisor(project, action);
      return text(result);
    }
  );

  server.tool(
    'get_container_processes',
    'Get running processes, memory usage, disk usage, and tmux sessions for a project container.',
    { project: z.string().describe('Project name') },
    async ({ project }) => {
      const result = await api.getProcesses(project);
      return text(result);
    }
  );

  server.tool(
    'exec_in_container',
    'Execute a command inside a project\'s container. Returns stdout. Use for debugging, inspecting processes, or running one-off commands.',
    {
      project: z.string().describe('Project name'),
      cmd: z.array(z.string()).describe('Command and arguments (e.g. ["ps", "aux"])'),
    },
    async ({ project, cmd }) => {
      const result = await api.exec(project, cmd);
      return text(result);
    }
  );

  server.tool(
    'get_agent_memory',
    'Read the agent\'s memory files (SHORT_TERM_MEMORY.md, LONG_TERM_MEMORY.md, plan.md). These persist across context compactions and show what the agent knows/is planning.',
    { project: z.string().describe('Project name') },
    async ({ project }) => {
      const result = await api.getMemory(project);
      return text(result);
    }
  );

  server.tool(
    'get_agent_logs',
    'Get recent supervisor logs for a project. Shows autonomous agent activity, turns, errors, and state transitions.',
    {
      project: z.string().describe('Project name'),
      lines: z.number().optional().describe('Number of log lines to return (default: 100)'),
    },
    async ({ project, lines }) => {
      const result = await api.getLogs(project, lines);
      return text(result);
    }
  );
}
