import type { LovelaceClient } from '@lovelace/client';
import { isLaunchInProgress } from '@lovelace/core';
import type { AppState } from './state.js';
import { RefreshPoller } from './poller.js';
import { errorMessage, isOffline } from './errors.js';

/**
 * Keeps the dashboard and the open page's details fresh: faster while a
 * launch is in progress, and keeping last-known data on read failures.
 */
export class AppRefresh {
  private readonly dashboard: RefreshPoller;
  private readonly details: RefreshPoller;
  private detailLoadToken = 0;

  constructor(private readonly state: AppState, private readonly client: LovelaceClient, private readonly signal: AbortSignal) {
    this.dashboard = new RefreshPoller(signal => this.fetchDashboard(signal),
      () => state.activeWorkItems.some(item => item.launchState && isLaunchInProgress(item.launchState)) ? 2000 : 7000);
    this.details = new RefreshPoller(signal => this.fetchDetails(signal),
      () => state.route.kind === 'work' && state.route.details?.launches.some(launch => isLaunchInProgress(launch.state)) ? 1000 : 7000);
  }

  start(): void {
    this.dashboard.start();
    this.details.start();
    void this.loadTools();
  }

  stop(): void {
    this.dashboard.stop();
    this.details.stop();
  }

  refreshDashboard(): void {
    this.dashboard.refresh();
  }

  /** Reloads the open page; replies for a page left meanwhile are dropped. */
  refreshDetails(): void {
    this.detailLoadToken++;
    this.details.refresh();
  }

  /** Harness detection is cheap and rarely changes: once per TUI, and again with each Jira setup. */
  private async loadTools(): Promise<void> {
    try {
      const tools = await this.client.tools.list.query(undefined, { signal: this.signal });
      if (!this.signal.aborted) this.state.setTools(tools);
    } catch (error) {
      // Launches still fall back to the server's default agent.
      if (!this.signal.aborted && !isOffline(error)) this.state.setError(errorMessage(error, 'Loading coding harnesses failed'));
    }
  }

  private async fetchDashboard(signal: AbortSignal): Promise<void> {
    try {
      const data = await this.client.dashboard.get.query(undefined, { signal });
      if (signal.aborted || this.signal.aborted) return;
      this.state.applyDashboardResponse(data);
    } catch (error) {
      if (signal.aborted) return;
      // Keep sidebar/last known view; surface the message in the help bar.
      if (isOffline(error)) this.state.setOffline();
      else this.state.setError(errorMessage(error, 'Dashboard refresh failed'));
    }
  }

  private async fetchDetails(signal: AbortSignal): Promise<void> {
    const token = this.detailLoadToken;
    const route = this.state.route;
    const current = () => !signal.aborted && token === this.detailLoadToken;
    try {
      if (route.kind === 'work') {
        const details = await this.client.workItems.get.query({ id: route.id }, { signal });
        if (current()) this.state.setWorkItemData(details);
      } else if (route.kind === 'jira') {
        const issues = await this.client.tracker.issues.query(undefined, { signal });
        const issue = issues.find(issue => issue.id === route.issue.id);
        if (current() && issue) this.state.setJiraDetails(issue);
      }
    } catch (error) {
      if (!current()) return;
      if (isOffline(error)) this.state.setOffline();
      else this.state.setError(errorMessage(error, route.kind === 'jira' ? 'Jira fetch failed' : 'Work item fetch failed'));
    }
  }
}
