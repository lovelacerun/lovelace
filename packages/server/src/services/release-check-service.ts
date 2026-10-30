import type { Attachment, ReleaseChecks } from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import type { ReleaseCheckPlugin } from '../plugins/release-checks.js';
import { describeActivityError } from './activity-bus.js';

/** Asks the plugin about every merged change request on active work items until it reports them complete. */
export async function refreshReleaseChecks(
  database: DatabaseState,
  plugin: ReleaseCheckPlugin,
  logger: { warn: (obj: unknown, msg: string) => void },
  workItemId?: string,
) {
  const result = { attempted: 0, updated: 0, failed: 0 };
  const workItems = database.listWorkItems('active').filter(item => !workItemId || item.id === workItemId);
  for (const workItem of workItems) {
    for (const attachment of database.listAttachmentsOfType('pull-request', workItem.id)) {
      const { payload } = attachment;
      if (payload.status !== 'merged' || payload.releaseChecks?.complete) continue;
      result.attempted += 1;
      const checkedAt = new Date().toISOString();
      let releaseChecks: ReleaseChecks;
      try {
        releaseChecks = { ...await plugin.check(payload), checkedAt, error: null };
        result.updated += 1;
      } catch (error) {
        result.failed += 1;
        logger.warn({ err: error, workItemId: workItem.id, externalId: attachment.externalId }, 'Release check failed');
        releaseChecks = { complete: false, checks: [], ...payload.releaseChecks, checkedAt, error: describeActivityError(error) };
      }
      save(database, attachment, releaseChecks);
    }
  }
  return result;
}

function save(database: DatabaseState, attachment: Attachment<'pull-request'>, releaseChecks: ReleaseChecks): void {
  // Re-read so a concurrent change request refresh is not overwritten.
  const current = database.getAttachment('pull-request', attachment.id);
  if (current) database.updateAttachment('pull-request', current.id, { ...current.payload, releaseChecks });
}
