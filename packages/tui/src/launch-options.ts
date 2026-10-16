import { visibleWidth } from '@earendil-works/pi-tui';
import { CODING_HARNESSES, type CodingHarnessId } from '@lovelace/core';
import { Dropdown, type DropdownItem, type DropdownTheme, truncate } from '@lovelace/tui-components';
import type { AppState, FocusTarget, LaunchFocus } from './state.js';
import { accent, barBg, bold, muted, reset, selectedBg } from './theme.js';
import { clickable } from './clickable.js';

export const LAUNCH_FIELDS = ['agent', 'thinking', 'model'] as const;
export type LaunchField = (typeof LAUNCH_FIELDS)[number];
const LABELS: Record<LaunchField, string> = { agent: 'Agent', thinking: 'Thinking', model: 'Model' };

/** Select fields shared by Home's dock and the Jira overlay; `prefix` scopes their click links. */
export function selectTheme(prefix: string): DropdownTheme {
  return {
    field: (text, focused) => (focused ? selectedBg + accent + bold : barBg) + text + reset,
    selected: text => selectedBg + accent + text + reset,
    muted: text => muted + text + reset,
    link: (text, action) => clickable(text, { kind: 'modal', data: `${prefix}:${action}` }),
  };
}

/** Home's focus target for a field, and back. */
export const launchFocus = (field: LaunchField): LaunchFocus => `launch-${field}`;
export function launchField(focus: FocusTarget): LaunchField | undefined {
  return focus.startsWith('launch-') ? focus.slice('launch-'.length) as LaunchField : undefined;
}

/** Click targets this row renders; both hosts forward them to `openLink`. */
export function isLaunchOptionsLink(data: string): boolean {
  return data.startsWith('launch:');
}

/**
 * Agent, thinking and model select fields over the TUI-wide launch choice.
 * Each field expands into a filterable list; the model list comes from the
 * harness and also takes a typed name. Empty values keep the harness's own
 * defaults. Home's dock and the Jira overlay share the choice.
 */
export class LaunchOptionsRow {
  private readonly menus: Record<LaunchField, Dropdown>;

  constructor(private readonly state: AppState) {
    this.menus = {
      agent: new Dropdown(selectTheme('launch:agent'), value => this.state.setLaunchAgent(value as CodingHarnessId)),
      thinking: new Dropdown(selectTheme('launch:thinking'), value => this.state.setLaunchOverrides({ thinkingLevel: value || undefined })),
      model: new Dropdown(selectTheme('launch:model'), value => this.state.setLaunchOverrides({ model: value || undefined }), { allowCustom: true }),
    };
  }

  /** The field whose list is expanded, if any. */
  get openField(): LaunchField | undefined {
    return LAUNCH_FIELDS.find(field => this.menus[field].open);
  }

  /** True when `field` used the key; Tab and keys of a closed field stay with the host. */
  handleInput(field: LaunchField, data: string): boolean {
    if (!this.available) return false;
    this.sync();
    return this.menus[field].handleInput(data);
  }

  /** The field a click belongs to, or undefined for someone else's link. */
  openLink(data: string): LaunchField | undefined {
    if (!isLaunchOptionsLink(data)) return undefined;
    const [, field, ...action] = data.split(':') as [string, LaunchField, ...string[]];
    if (!LAUNCH_FIELDS.includes(field) || !this.available) return undefined;
    this.sync();
    for (const other of LAUNCH_FIELDS) if (other !== field) this.menus[other].close();
    this.menus[field].openLink(action.join(':'));
    return field;
  }

  /** The row, then the expanded list of `focused` below its field. Other lists close. */
  render(width: number, focused?: LaunchField): string[] {
    for (const field of LAUNCH_FIELDS) if (field !== focused) this.menus[field].close();
    if (!this.available) return [muted + truncate('No coding harness detected on the server', width) + reset];
    this.sync();
    // Narrow docks drop the labels before squeezing the model name.
    const fields = LAUNCH_FIELDS.reduce((sum, field) => sum + visibleWidth(this.menus[field].label) + 4, 0);
    const labelled = width >= fields + LAUNCH_FIELDS.reduce((sum, field) => sum + LABELS[field].length + 1, 0) + 6;
    let row = '';
    let column = 0;
    for (const field of LAUNCH_FIELDS) {
      const label = (row ? (labelled ? '   ' : '  ') : '') + (labelled ? (focused === field ? accent : muted) + LABELS[field] + reset + ' ' : '');
      // The model gets whatever room the other fields leave.
      const room = field === 'model' ? Math.max(8, width - visibleWidth(row + label)) : 24;
      if (field === focused) column = visibleWidth(row + label);
      row += label + this.menus[field].renderField(room, field === focused, labelled ? undefined : LABELS[field]);
    }
    const list = focused ? this.menus[focused].renderList(Math.min(width, Math.max(28, Math.min(56, width - column)))) : [];
    const indent = ' '.repeat(Math.max(0, Math.min(column, width - Math.max(0, ...list.map(line => visibleWidth(line))))));
    return [truncate(row, width), ...list.map(line => indent + line)];
  }

  /** Null until the server has answered; launches then use its default agent. */
  private get available(): boolean {
    return this.state.tools === null || this.state.tools.length > 0;
  }

  /** Items and values follow the shared choice, which the other host may have changed. */
  private sync(): void {
    const agent = this.state.launchAgent;
    const tool = this.state.tools?.find(entry => entry.id === agent);
    const harness = CODING_HARNESSES.find(entry => entry.id === agent);
    const overrides = agent ? this.state.launchChoice.options[agent] ?? {} : {};
    const fallback = { value: '', label: 'default' };
    const agents: DropdownItem[] = this.state.tools?.map(entry => ({ value: entry.id, label: entry.title }))
      ?? (agent ? [{ value: agent, label: harness?.title ?? agent }] : []);
    this.menus.agent.setItems(agents, agent ?? '');
    this.menus.thinking.setItems([fallback, ...(harness?.thinkingLevels ?? []).map(level => ({ value: level, label: level }))], overrides.thinkingLevel ?? '');
    this.menus.model.setItems([fallback, ...(tool?.models ?? []).map(model => ({ value: model.id, label: model.label ?? model.id, ...(model.label ? { hint: model.id } : {}) }))], overrides.model ?? '');
  }
}
