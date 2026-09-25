import { resolveSettings } from '@anthropic-ai/claude-agent-sdk/core';
import { RefuseError } from './errors.ts';
import { isObject, type JsonObject } from './json.ts';
import type { Tier, TierSettings } from './rules.ts';

function toJson(value: unknown): JsonObject {
  const copy: unknown = JSON.parse(JSON.stringify(value ?? {}));
  if (!isObject(copy)) throw new RefuseError('settings are not an object');
  return copy;
}

function tierOf(source: string): Tier {
  switch (source) {
    case 'managed':
    case 'user':
    case 'project':
    case 'local':
      return source;
    default:
      throw new RefuseError(`unsupported settings source: ${source}`);
  }
}

/**
 * Read the settings cascade the way Claude Code does. The caller must have set
 * HOME from the user database and removed CLAUDE_CONFIG_DIR beforehand.
 */
export async function loadSettings(projectRoot: string): Promise<{ tiers: TierSettings[]; effective: JsonObject }> {
  const resolved = await resolveSettings({ cwd: projectRoot });
  const tiers = resolved.sources.map(s => ({
    tier: tierOf(s.source),
    path: s.path,
    settings: toJson(s.settings),
  }));
  return { tiers, effective: toJson(resolved.effective) };
}
