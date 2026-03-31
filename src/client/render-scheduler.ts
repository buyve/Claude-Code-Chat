// Render throttle — leading + trailing edge, 16ms interval (~60fps)
// Adapted from Ink's ink.tsx throttle pattern

const DEFAULT_INTERVAL_MS = 16;

export interface RenderScheduler {
  /** Request a render — coalesced to at most one per interval */
  schedule(): void;
  /** Force immediate execution of any pending render */
  flush(): void;
  /** Cancel any pending render (for teardown) */
  cancel(): void;
}

export function createRenderScheduler(
  renderFn: () => void,
  intervalMs = DEFAULT_INTERVAL_MS,
): RenderScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastExec = 0;
  let pending = false;

  function execute(): void {
    lastExec = performance.now();
    pending = false;
    timer = null;
    renderFn();
  }

  function schedule(): void {
    const now = performance.now();
    const elapsed = now - lastExec;

    if (elapsed >= intervalMs) {
      // Leading edge: execute immediately if enough time has passed
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      execute();
    } else if (!pending) {
      // Trailing edge: schedule execution after remaining interval
      pending = true;
      timer = setTimeout(execute, intervalMs - elapsed);
    }
    // If already pending, do nothing — trailing will fire
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      execute();
    }
  }

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
  }

  return { schedule, flush, cancel };
}
