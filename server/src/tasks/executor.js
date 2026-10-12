import { AppError, normalizeError } from '../utils/errors.js';
import { createId } from '../utils/ids.js';
import { isTerminal } from './stateMachine.js';

/**
 * Task executor: the orchestration between planner, policy and device.
 *
 * Rules enforced here:
 *  - one active UI automation task per device (a device lock, not a queue)
 *  - hard action budget, hard wall-clock budget and per-action timeout
 *  - bounded retries, no blind re-planning
 *  - cancellation honoured between every step
 *  - a disconnected device fails the task instead of leaving it dangling
 */

const RETRIABLE_ACTION_ERRORS = new Set(['ACTION_TIMEOUT', 'TARGET_NOT_FOUND', 'INTERNAL_ERROR']);

export class TaskExecutor {
  constructor({ store, config, registry, gateway, planner, tasks, logger, publish = () => {} }) {
    this.store = store;
    this.config = config;
    this.registry = registry;
    this.gateway = gateway;
    this.planner = planner;
    this.tasks = tasks;
    this.logger = logger;
    this.publish = publish;

    this.deviceLocks = new Map(); // deviceId -> taskId
    this.cancelled = new Set();
    this.approvalWaiters = new Map(); // taskId -> {resolve, timer}
  }

  /** Start a task. Never throws: failures are recorded on the task itself. */
  async run(task) {
    try {
      await this.#runInternal(task);
    } catch (error) {
      const appError = normalizeError(error);
      this.logger.error('task.executor_error', {
        taskId: task.id,
        errorCode: appError.code,
        error: appError.message,
      });
      await this.#finishWithError(task, appError);
    } finally {
      if (this.deviceLocks.get(task.deviceId) === task.id) this.deviceLocks.delete(task.deviceId);
      const waiter = this.approvalWaiters.get(task.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.approvalWaiters.delete(task.id);
      }
      this.cancelled.delete(task.id);
    }
  }

  async #runInternal(task) {
    if (!this.gateway.isOnline(task.deviceId)) {
      throw new AppError('DEVICE_OFFLINE');
    }
    if (this.deviceLocks.has(task.deviceId)) {
      throw new AppError('DEVICE_BUSY', {
        message: 'The device is already running another task. Wait for it to finish or cancel it.',
      });
    }
    this.deviceLocks.set(task.deviceId, task.id);

    const device = await this.registry.requireControllable(task.ownerId, task.deviceId);
    if (!this.gateway.isAccessibilityEnabled(task.deviceId) && !device.accessibilityEnabled) {
      throw new AppError('ACCESSIBILITY_NOT_ENABLED');
    }

    await this.tasks.updateStatus(task.id, 'planning');

    let screenContext = null;
    let executedTotal = 0;

    for (let round = 1; round <= this.config.tasks.maxPlanningIterations; round += 1) {
      this.#assertNotCancelled(task.id);
      this.#assertNotExpired(task);

      const remainingActions = this.config.tasks.maxActionsPerTask - executedTotal;
      if (remainingActions <= 0) {
        throw new AppError('TASK_LIMIT_EXCEEDED', {
          message: `The task used its full action budget (${this.config.tasks.maxActionsPerTask} actions).`,
        });
      }

      let plan;
      try {
        plan = await this.planner.createPlan({
          instruction: task.instruction,
          taskId: task.id,
          device,
          screen: screenContext,
          maxActions: remainingActions,
          planningRound: round,
        });
      } catch (error) {
        throw normalizeError(error, 'INVALID_AI_PLAN');
      }

      await this.tasks.patch(task.id, {
        planSummary: plan.taskSummary,
        actionCount: executedTotal + plan.actions.length,
        requiresApproval: plan.requiresApproval,
      });

      if (plan.requiresApproval || plan.needsClarification) {
        const reasons = plan.needsClarification
          ? [plan.clarificationQuestion ?? 'The planner needs more information.']
          : plan.approvalReasons.length
            ? plan.approvalReasons
            : ['This task touches a sensitive action.'];

        await this.tasks.updateStatus(task.id, 'awaiting_approval', {
          approvalState: plan.needsClarification ? 'clarification' : 'pending',
          result: { summary: reasons.join(' ') },
          expiresAt: new Date(Date.now() + this.config.tasks.approvalTimeoutSeconds * 1000).toISOString(),
        });
        this.gateway.sendApprovalRequired({ deviceId: task.deviceId, taskId: task.id, reasons });
        this.publish('task.awaiting_approval', { task, reasons });

        const approved = await this.#waitForApproval(task.id);
        if (!approved) {
          throw new AppError('TASK_CANCELLED', { message: 'The task was cancelled while awaiting approval.' });
        }
      }

      // A re-planning round re-enters the loop while the task is already running.
      await this.#ensureStatus(task.id, 'running');
      this.gateway.sendTaskDispatch({
        deviceId: task.deviceId,
        taskId: task.id,
        instruction: task.instruction,
        actionCount: plan.actions.length,
        expiresAt: task.expiresAt,
      });

      const outcome = await this.#executeActions(task, plan, executedTotal);
      executedTotal = outcome.executedTotal;
      screenContext = outcome.screenContext ?? screenContext;

      if (outcome.state === 'cancelled') {
        throw new AppError('TASK_CANCELLED');
      }
      if (outcome.state === 'offline') {
        throw new AppError('DEVICE_OFFLINE');
      }
      if (outcome.state === 'failed') {
        throw new AppError(outcome.errorCode ?? 'INTERNAL_ERROR', { message: outcome.message });
      }
      if (outcome.state === 'needs_context' && round < this.config.tasks.maxPlanningIterations) {
        // A read_visible_ui action produced new screen context: re-plan with it.
        continue;
      }

      await this.tasks.updateStatus(task.id, 'completed', {
        completedActions: executedTotal,
        result: {
          summary: plan.taskSummary,
          actions: outcome.reports,
        },
      });
      this.gateway.sendTaskCompleted({
        deviceId: task.deviceId,
        taskId: task.id,
        status: 'completed',
        summary: plan.taskSummary,
      });
      this.publish('task.completed', { taskId: task.id, deviceId: task.deviceId, summary: plan.taskSummary });
      return;
    }

    throw new AppError('TASK_LIMIT_EXCEEDED', {
      message: `The task reached the maximum number of planning rounds (${this.config.tasks.maxPlanningIterations}).`,
    });
  }

  /** Execute one plan's actions sequentially. */
  async #executeActions(task, plan, executedTotal) {
    const reports = [];
    let screenContext = null;
    let count = executedTotal;

    for (const action of plan.actions) {
      this.#assertNotCancelled(task.id);
      this.#assertNotExpired(task);

      if (!this.gateway.isOnline(task.deviceId)) {
        return { state: 'offline', reports, executedTotal: count };
      }

      const result = await this.#executeSingleAction(task, action, count + 1);
      count = result.executedTotal;
      reports.push(result.report);

      if (result.state === 'cancelled') return { state: 'cancelled', reports, executedTotal: count };
      if (result.state === 'offline') return { state: 'offline', reports, executedTotal: count };
      if (result.state === 'failed') {
        return {
          state: 'failed',
          reports,
          executedTotal: count,
          errorCode: result.errorCode,
          message: result.message,
        };
      }

      if (result.screenContext) screenContext = result.screenContext;
    }

    return { state: screenContext ? 'needs_context' : 'done', reports, executedTotal: count, screenContext };
  }

  async #executeSingleAction(task, action, sequence) {
    let attempt = 0;
    let lastError = null;

    while (attempt <= this.config.tasks.maxActionRetries) {
      const actionId = createId('action');
      const startedAt = new Date().toISOString();
      const timeoutMs = this.#actionTimeoutMs(task);

      await this.store.upsertAction({
        id: actionId,
        taskId: task.id,
        sequence,
        type: action.type,
        status: 'running',
        createdAt: startedAt,
        startedAt,
        retryCount: attempt,
        payload: action,
      });
      await this.tasks.patch(task.id, { currentActionId: actionId });

      try {
        const outcome = await this.gateway.executeAction({
          deviceId: task.deviceId,
          taskId: task.id,
          actionId,
          sequence,
          action,
          timeoutMs,
        });

        if (outcome.status === 'succeeded') {
          const finishedAt = new Date().toISOString();
          await this.store.upsertAction({
            id: actionId,
            taskId: task.id,
            sequence,
            type: action.type,
            status: 'succeeded',
            createdAt: startedAt,
            startedAt,
            finishedAt,
            retryCount: attempt,
            result: outcome.result ?? null,
            payload: action,
          });
          await this.tasks.patch(task.id, { completedActions: sequence });
          this.publish('task.progress', {
            taskId: task.id,
            sequence,
            type: action.type,
            status: 'succeeded',
          });

          return {
            state: 'done',
            executedTotal: sequence,
            report: { sequence, type: action.type, status: 'succeeded', summary: outcome.result?.summary ?? null },
            screenContext: action.type === 'read_visible_ui' ? outcome.result ?? null : null,
          };
        }

        lastError = new AppError(outcome.errorCode ?? 'INTERNAL_ERROR', { message: outcome.message ?? 'The device reported a failure.' });
      } catch (error) {
        lastError = normalizeError(error);
        if (lastError.code === 'TASK_CANCELLED') {
          return { state: 'cancelled', executedTotal: sequence - 1, report: { sequence, type: action.type, status: 'cancelled' } };
        }
      }

      const failedAt = new Date().toISOString();
      await this.store.upsertAction({
        id: actionId,
        taskId: task.id,
        sequence,
        type: action.type,
        status: 'failed',
        createdAt: startedAt,
        startedAt,
        finishedAt: failedAt,
        retryCount: attempt,
        errorCode: lastError.code,
        payload: action,
      });

      const retriable = RETRIABLE_ACTION_ERRORS.has(lastError.code) && !['TARGET_AMBIGUOUS', 'ACTION_NOT_ALLOWED'].includes(lastError.code);
      if (!retriable || attempt === this.config.tasks.maxActionRetries) break;
      attempt += 1;
      this.logger.warn('task.action_retry', {
        taskId: task.id,
        sequence,
        type: action.type,
        attempt,
        errorCode: lastError.code,
      });
      if (!this.gateway.isOnline(task.deviceId)) {
        return { state: 'offline', executedTotal: sequence - 1, report: { sequence, type: action.type, status: 'failed' } };
      }
    }

    return {
      state: 'failed',
      executedTotal: sequence - 1,
      errorCode: lastError.code,
      message: lastError.message,
      report: { sequence, type: action.type, status: 'failed', error: lastError.code },
    };
  }

  /** Transition only when the stored status differs (re-planning re-enters states). */
  async #ensureStatus(taskId, to) {
    const current = await this.store.getTask(taskId);
    if (current?.status === to) return current;
    return this.tasks.updateStatus(taskId, to);
  }

  #actionTimeoutMs(task) {
    const remaining = Date.parse(task.expiresAt) - Date.now();
    return Math.max(1000, Math.min(this.config.tasks.maxActionTimeoutMs, remaining));
  }

  #assertNotCancelled(taskId) {
    if (this.cancelled.has(taskId)) {
      throw new AppError('TASK_CANCELLED');
    }
  }

  #assertNotExpired(task) {
    if (task.expiresAt && Date.parse(task.expiresAt) < Date.now()) {
      throw new AppError('TASK_EXPIRED');
    }
  }

  #waitForApproval(taskId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvalWaiters.delete(taskId);
        resolve(false);
      }, this.config.tasks.approvalTimeoutSeconds * 1000);
      // Never keep the process alive just because a task is parked.
      timer.unref?.();
      this.approvalWaiters.set(taskId, { resolve, timer });
    });
  }

  /**
   * Release the OS resources an in-flight task owns.
   *
   * Only called while the process is shutting down: parked tasks are left
   * untouched on purpose so their records stay unfinished and the next boot
   * reconciles them instead of replaying an action whose state is unknown.
   */
  shutdown() {
    for (const [taskId, waiter] of [...this.approvalWaiters.entries()]) {
      clearTimeout(waiter.timer);
      this.approvalWaiters.delete(taskId);
    }
    this.deviceLocks.clear();
    this.cancelled.clear();
  }

  /** Called by the task service when the owner approves a waiting task. */
  async handleApproval(taskId) {
    const waiter = this.approvalWaiters.get(taskId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.approvalWaiters.delete(taskId);
    waiter.resolve(true);
    return true;
  }

  /** Called when a task is cancelled/expired/denied from anywhere. */
  async handleExternalCancellation(taskId, reason = 'user_cancelled') {
    this.cancelled.add(taskId);
    const waiter = this.approvalWaiters.get(taskId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.approvalWaiters.delete(taskId);
      waiter.resolve(false);
    }
    this.gateway.failPendingForTask(taskId, 'TASK_CANCELLED');

    const task = await this.store.getTask(taskId);
    if (task) {
      this.gateway.sendCancel({
        deviceId: task.deviceId,
        taskId,
        reason: reason === 'approval_denied' || reason === 'policy_denied' ? 'user_cancelled' : reason,
      });
    }
  }

  async #finishWithError(task, error) {
    try {
      const current = await this.store.getTask(task.id);
      if (!current || isTerminal(current.status)) return current;
      await this.tasks.updateStatus(task.id, 'failed', {
        errorCode: error.code,
        result: { summary: error.message },
      });
      this.gateway.sendTaskCompleted({
        deviceId: task.deviceId,
        taskId: task.id,
        status: 'failed',
        summary: error.message,
        errorCode: error.code,
      });
      this.publish('task.failed', { taskId: task.id, deviceId: task.deviceId, errorCode: error.code, message: error.message });
    } catch (secondary) {
      this.logger.error('task.finish_failed', { taskId: task.id, error: secondary.message });
    }
  }

  /** Devices that vanished: fail their running tasks instead of hanging. */
  async handleDeviceOffline(deviceId) {
    const unfinished = await this.store.listUnfinishedTasks();
    for (const task of unfinished) {
      if (task.deviceId !== deviceId) continue;
      if (task.status === 'running') {
        this.cancelled.add(task.id);
        this.gateway.failPendingForTask(task.id, 'DEVICE_OFFLINE');
      }
    }
  }
}
