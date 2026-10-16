import type { HarnessModel } from '@lovelace/model-catalog';

export type { HarnessModel };

export const CODING_HARNESSES = [
  { id: 'pi', title: 'Pi', thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'codex', title: 'Codex', thinkingLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'claude', title: 'Claude Code', thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
] as const;

export type CodingHarnessId = (typeof CODING_HARNESSES)[number]['id'];


/** A coding harness whose executable the server detected (`GET /tools`). */
export interface AvailableHarness {
  id: CodingHarnessId;
  title: string;
  thinkingLevels: readonly string[];
  executablePath: string;
  defaultSelected: boolean;
  /** The harness's own model catalog; empty when it could not be listed. Any other name may still be typed. */
  models: HarnessModel[];
}

export function isCodingHarnessId(value: unknown): value is CodingHarnessId {
  return CODING_HARNESSES.some((harness) => harness.id === value);
}

/** Empty/omitted values leave the harness's own defaults unchanged. */
export interface ToolLaunchOptions {
  model?: string;
  thinkingLevel?: string;
}

export type ToolLaunchOptionsById = Partial<Record<CodingHarnessId, ToolLaunchOptions>>;

export function isToolLaunchOptionsById(value: unknown): value is ToolLaunchOptionsById {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([id, options]) => {
    const harness = CODING_HARNESSES.find((entry) => entry.id === id);
    if (!harness || !options || typeof options !== 'object' || Array.isArray(options)) return false;
    const record = options as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'model' && key !== 'thinkingLevel')) return false;
    if (record.model !== undefined && (typeof record.model !== 'string' || record.model.includes('\0'))) return false;
    return record.thinkingLevel === undefined || record.thinkingLevel === '' ||
      (typeof record.thinkingLevel === 'string' && (harness.thinkingLevels as readonly string[]).includes(record.thinkingLevel));
  });
}
