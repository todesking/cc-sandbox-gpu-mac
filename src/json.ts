export type JsonObject = { [key: string]: unknown };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getObject(value: unknown, key: string): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  const child = value[key];
  return isObject(child) ? child : undefined;
}

export function getStrings(value: unknown, key: string): string[] {
  if (!isObject(value)) return [];
  const child = value[key];
  if (!Array.isArray(child)) return [];
  return child.filter((item): item is string => typeof item === 'string');
}

export function getBoolean(value: unknown, key: string): boolean | undefined {
  if (!isObject(value)) return undefined;
  const child = value[key];
  return typeof child === 'boolean' ? child : undefined;
}

export function getNumber(value: unknown, key: string): number | undefined {
  if (!isObject(value)) return undefined;
  const child = value[key];
  return typeof child === 'number' ? child : undefined;
}

export function getObjects(value: unknown, key: string): JsonObject[] {
  if (!isObject(value)) return [];
  const child = value[key];
  if (!Array.isArray(child)) return [];
  return child.filter(isObject);
}
