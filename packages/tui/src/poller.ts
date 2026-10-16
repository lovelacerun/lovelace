/** One refresh cycle at a time, including explicit retries and all detail requests. */
export class RefreshPoller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private running = false;
  private again = false;
  private generation = 0;
  constructor(private readonly task: (signal: AbortSignal) => Promise<void>, private readonly intervalMs: number | (() => number) = 7000) {}
  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation++;
    this.refresh();
  }
  refresh(): void {
    if (!this.running) return;
    clearTimeout(this.timer);
    if (this.controller) { this.again = true; return; }
    void this.cycle(this.generation);
  }
  stop(): void {
    this.running = false;
    this.again = false;
    this.generation++;
    clearTimeout(this.timer);
    this.controller?.abort();
  }
  private async cycle(generation: number): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    try { await this.task(controller.signal); }
    catch { /* Task reports actionable errors; cancellation is silent. */ }
    finally {
      if (this.controller === controller) this.controller = undefined;
      if (generation !== this.generation) {
        if (this.running) this.refresh();
      } else if (this.running) {
        if (this.again) { this.again = false; this.refresh(); }
        else this.timer = setTimeout(() => this.refresh(), typeof this.intervalMs === 'function' ? this.intervalMs() : this.intervalMs);
      }
    }
  }
}
