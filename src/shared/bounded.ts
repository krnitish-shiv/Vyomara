export class OperationStoppedError extends Error {
  readonly reason: 'timeout' | 'cancelled';

  constructor(reason: 'timeout' | 'cancelled') {
    super(reason === 'timeout' ? 'Operation timed out.' : 'Operation cancelled.');
    this.name = 'OperationStoppedError';
    this.reason = reason;
  }
}

export function runBounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outerSignal: AbortSignal,
): Promise<T> {
  if (outerSignal.aborted) {
    return Promise.reject(new OperationStoppedError('cancelled'));
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  let onAbort: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new OperationStoppedError('timeout'));
    }, timeoutMs);
    onAbort = () => {
      controller.abort();
      reject(new OperationStoppedError('cancelled'));
    };
    outerSignal.addEventListener('abort', onAbort, { once: true });
  });

  return Promise.race([
    Promise.resolve().then(() => operation(controller.signal)),
    stopped,
  ]).finally(() => {
    clearTimeout(timeout);
    outerSignal.removeEventListener('abort', onAbort);
  });
}
