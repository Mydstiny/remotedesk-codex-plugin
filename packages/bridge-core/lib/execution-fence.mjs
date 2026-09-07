import { requireThat } from './errors.mjs';

// Upstream model-idle is not evidence that local tool callbacks or Docker
// cleanup have finished. Keep this barrier outside the native engine lifecycle.
export class ExecutionFence {
  constructor(executor) {
    this.executor = executor;
    this.pending = new Map();
    this.blocked = new Set();
  }
  run(id, project, action) {
    requireThat(!this.blocked.has(id), 'WORKSPACE_CLEANUP_UNCONFIRMED');
    const calls = this.pending.get(id) ?? new Set();
    this.pending.set(id, calls);
    const call = Promise.resolve()
      .then(action)
      .catch((error) => {
        if (['DOCKER_CLEANUP_UNCONFIRMED', 'CONTAINER_OWNER_MISMATCH'].includes(error.code))
          this.blocked.add(id);
        throw error;
      })
      .finally(() => {
        calls.delete(call);
        if (!calls.size && this.pending.get(id) === calls) this.pending.delete(id);
      });
    calls.add(call);
    return call;
  }
  assertIdle(id, project) {
    requireThat(!this.pending.get(id)?.size, 'WORKSPACE_EXECUTION_PENDING');
    requireThat(!this.blocked.has(id), 'WORKSPACE_CLEANUP_UNCONFIRMED');
    this.executor.assertQuiescent?.(project, id);
  }
  async wait(id, project) {
    while (this.pending.get(id)?.size) await Promise.allSettled([...this.pending.get(id)]);
    this.assertIdle(id, project);
  }
  async drain() {
    while (this.pending.size)
      await Promise.allSettled([...this.pending.values()].flatMap((calls) => [...calls]));
  }
}
