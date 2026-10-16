/**
 * Herdr is Lovelace's only terminal host. The server talks to the running
 * Herdr session through its CLI; clients never touch Herdr directly.
 */
export interface HerdrConfig {
  /** Herdr CLI; detected on the server's search path when omitted. */
  executable?: string;
  /** API socket of a non-default Herdr session; the default session when omitted. */
  socketPath?: string;
}

/** Herdr pane that hosts (or hosted) a session's agent. */
export interface HerdrPaneRef {
  workspaceId: string;
  paneId: string;
}
