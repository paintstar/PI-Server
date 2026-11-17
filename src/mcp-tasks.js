/** Register the SDK's experimental Tasks protocol without replacing the ordinary spawn/read/wait workflow. */
export function installTaskTool(server, manager, shape, taskStore) {
  server.experimental.tasks.registerToolTask('run_agent_task', {
    description: 'Start a Pi agent as a standard MCP task. Use only when the client supports task-augmented tool calls. Poll tasks/get until terminal or input_required; read_agent/reply_question handle questions. Cancellation interrupts the agent. Ordinary clients should use spawn_agent and wait_agent.',
    inputSchema: shape, execution: { taskSupport: 'required' }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, {
    createTask: async (values, extra) => {
      const agent = await manager.spawn(values);
      const task = await extra.taskStore.createTask({ ttl: extra.taskRequestedTtl, context: { agentId: agent.id } });
      queueMicrotask(notify);
      return { task, _meta: { 'io.modelcontextprotocol/model-immediate-response': JSON.stringify({ agentId: agent.id, taskId: task.taskId }) } };
    },
    getTask: async (_values, extra) => extra.taskStore.getTask(extra.taskId),
    getTaskResult: async (_values, extra) => extra.taskStore.getTaskResult(extra.taskId),
  });
  let checking = false, dirty = false;
  const progress = new Map();
  const statuses = new Map();
  const notify = async () => {
    if (checking) { dirty = true; return; } checking = true;
    try {
      const states = await taskStore.notificationStates();
      for (const { task, progressToken, sequence } of states) {
        if (progressToken !== undefined && !['completed', 'failed', 'cancelled'].includes(statuses.get(task.taskId)) && sequence > (progress.get(task.taskId) || 0)) {
          progress.set(task.taskId, sequence);
          await server.server.notification({ method: 'notifications/progress', params: { progressToken, progress: sequence, message: task.status } });
        }
        if (statuses.get(task.taskId) === task.status) continue;
        statuses.set(task.taskId, task.status);
        await server.server.notification({ method: 'notifications/tasks/status', params: task });
      }
    } catch (error) { process.stderr.write(`Pi task notification failed: ${error.message}\n`); }
    finally { checking = false; if (dirty) { dirty = false; queueMicrotask(notify); } }
  };
  manager.on('event', notify);
}
