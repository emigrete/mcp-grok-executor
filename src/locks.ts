export type LockHandle = {
  release: () => void;
  setHolder: (label: string) => void;
};

const locks = new Map<string, string>(); // cwd -> holder label

/** Acquire the per-cwd lock. Returns null if already held. Synchronous on purpose. */
export function tryAcquire(cwd: string, holder: string): LockHandle | null {
  if (locks.has(cwd)) return null;
  locks.set(cwd, holder);
  let released = false;
  return {
    release: () => {
      if (!released) {
        released = true;
        locks.delete(cwd);
      }
    },
    setHolder: (label: string) => {
      if (!released) locks.set(cwd, label);
    },
  };
}

export function currentHolder(cwd: string): string | undefined {
  return locks.get(cwd);
}
