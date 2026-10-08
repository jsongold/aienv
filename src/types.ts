// Shared types for the aienv CLI. Erasable TypeScript only (Node type stripping).

export const APPS = ['claude', 'codex', 'opencode'] as const;
export type App = (typeof APPS)[number];

export function isApp(value: string): value is App {
  return (APPS as readonly string[]).includes(value);
}

/** Everything a module needs from the process; built once in cli.ts. */
export type Ctx = {
  /** $AIENV_HOME (not resolved). */
  home: string;
  /** $AIENV_HOME/.store */
  storeDir: string;
  /** $AIENV_HOME/bindings */
  bindingsPath: string;
  /** The user's $HOME. */
  userHome: string;
  /** Snapshot of process.env. */
  env: Record<string, string | undefined>;
  /** Logical working directory ($PWD semantics, falls back to process.cwd()). */
  cwd: string;
};

export type Account = {
  id: string;
  app: App;
  /** '-' when the agent reports no organisation. */
  org: string;
  /** 'unknown' when it could not be determined. */
  email: string;
  /** Absolute path: $AIENV_HOME/.store/<id> */
  store: string;
};

export type Identity = { org: string; email: string };

/** What the bindings file says for one app and directory. */
export type Resolution = {
  /** Bound account id, '' when nothing is bound. */
  id: string;
  /** The binding's dir column ('*' for global), '' when none. */
  dir: string;
  /** A binding exists but its store directory is missing. */
  dangling: boolean;
};

export class AienvError extends Error {
  exitCode: number;
  /** Also print usage to stderr (exit code 2 convention). */
  showUsage: boolean;

  constructor(message: string, exitCode = 1, showUsage = false) {
    super(message);
    this.name = 'AienvError';
    this.exitCode = exitCode;
    this.showUsage = showUsage;
  }
}

export function usageError(message: string): AienvError {
  return new AienvError(message, 2, true);
}
