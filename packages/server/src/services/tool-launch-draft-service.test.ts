import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { LovelaceConfig, ToolLaunchDraftPayload } from '@lovelace/core';
import { openDatabase } from '../database.js';
import { createManualWorkItem } from '../repositories/work-item-repository.js';
import { markToolLaunchDraftLaunched, saveToolLaunchDraft } from './tool-launch-draft-service.js';

test('launch drafts preserve the exact prompt and options until marked launched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-launch-draft-'));
  const config: LovelaceConfig = {
    domainRoot: root,
    lovelaceDir: join(root, '.lovelace'),
    port: 27421,
    logLevel: 'info',
    syncIntervalMs: 300_000,
    defaultAgent: 'pi', tui: { sidebarSide: 'right' },
  };
  const database = openDatabase(config);

  try {
    const workItem = createManualWorkItem(database, { title: 'Draft safety' });
    const prompt = 'Keep this exact prompt.\n\n- including whitespace\n';
    const draft = saveToolLaunchDraft(database, workItem.id, {
      toolIds: ['claude'],
      repoIds: ['github:1'],
      promptId: 'implement',
      prompt,
      toolOptions: { claude: { model: 'opus', thinkingLevel: 'high' } },
    }, randomUUID());

    const saved = JSON.parse(draft.payloadJson!) as ToolLaunchDraftPayload;
    assert.equal(saved?.prompt, prompt);
    assert.deepEqual(saved?.toolOptions, { claude: { model: 'opus', thinkingLevel: 'high' } });
    assert.equal(saved?.status, 'pending');

    markToolLaunchDraftLaunched(database, draft);
    const [current] = database.listWorkItemMeta(workItem.id).filter((meta) => meta.metaType === 'prompt-draft');
    assert.equal(JSON.parse(current!.payloadJson!).status, 'launched');
  } finally {
    database.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
