import { loadConfig } from '@lovelace/core';
import { createLovelaceClient, type LovelaceClient } from '@lovelace/client';

export function client(): LovelaceClient {
  return createLovelaceClient(`http://127.0.0.1:${loadConfig().port}`);
}
