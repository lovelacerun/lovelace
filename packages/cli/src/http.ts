import { loadConfig } from '@lovelace/core';
import { LovelaceClient } from '@lovelace/client';

export function client(): LovelaceClient {
  return new LovelaceClient(`http://127.0.0.1:${loadConfig().port}`);
}

/** Provider and SDK operations always go through the local server. */
export async function request(path: string, init?: RequestInit): Promise<unknown> {
  return client().requestJson(path, init);
}
