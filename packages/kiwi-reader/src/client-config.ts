import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonObject = Record<string, unknown>;

export interface StdioServerEntry {
  type: 'stdio';
  command: string;
  args: string[];
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readConfig = async (path: string): Promise<JsonObject> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isObject(parsed)) throw new Error('the root value is not an object');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Could not read MCP config ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
};

const writeConfig = async (path: string, config: JsonObject): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
};

const sameEntry = (value: unknown, command: string, proxyPath: string): boolean => {
  if (!isObject(value) || value.command !== command || !Array.isArray(value.args)) return false;
  return value.args.length === 1 && value.args[0] === proxyPath;
};

const serverMap = (config: JsonObject): JsonObject => {
  const current = config.mcpServers;
  if (current === undefined) {
    const created = {};
    config.mcpServers = created;
    return created;
  }
  if (!isObject(current)) throw new Error('mcpServers must be a JSON object');
  return current;
};

export const installStdioServer = async (
  path: string,
  name: string,
  entry: StdioServerEntry,
  previous?: { command: string; proxyPath: string },
): Promise<void> => {
  const config = await readConfig(path);
  const servers = serverMap(config);
  assertOwnedEntry(path, name, servers[name], entry, previous);
  servers[name] = entry;
  await writeConfig(path, config);
};

const assertOwnedEntry = (
  path: string,
  name: string,
  current: unknown,
  entry: StdioServerEntry,
  previous?: { command: string; proxyPath: string },
): void => {
  const owned =
    current === undefined ||
    sameEntry(current, entry.command, entry.args[0] ?? '') ||
    (previous !== undefined && sameEntry(current, previous.command, previous.proxyPath));
  if (!owned) {
    throw new Error(
      `MCP server "${name}" already exists in ${path} and is not owned by this installation.`,
    );
  }
};

export const checkStdioServerInstall = async (
  path: string,
  name: string,
  entry: StdioServerEntry,
  previous?: { command: string; proxyPath: string },
): Promise<void> => {
  const config = await readConfig(path);
  const servers = serverMap(config);
  assertOwnedEntry(path, name, servers[name], entry, previous);
};

export const removeStdioServer = async (
  path: string,
  name: string,
  expected: { command: string; proxyPath: string },
): Promise<'missing' | 'removed' | 'changed'> => {
  const config = await readConfig(path);
  if (!isObject(config.mcpServers)) return 'missing';
  const current = config.mcpServers[name];
  if (current === undefined) return 'missing';
  if (!sameEntry(current, expected.command, expected.proxyPath)) return 'changed';
  delete config.mcpServers[name];
  await writeConfig(path, config);
  return 'removed';
};

const main = async (): Promise<void> => {
  const [mode, path, name, command, proxyPath, previousCommand, previousProxyPath] =
    process.argv.slice(2);
  if ((mode === 'check' || mode === 'install') && path && name && command && proxyPath) {
    const operation = mode === 'check' ? checkStdioServerInstall : installStdioServer;
    await operation(
      path,
      name,
      { type: 'stdio', command, args: [proxyPath] },
      previousCommand && previousProxyPath
        ? { command: previousCommand, proxyPath: previousProxyPath }
        : undefined,
    );
    return;
  }
  if (mode === 'remove' && path && name && command && proxyPath) {
    process.stdout.write(`${await removeStdioServer(path, name, { command, proxyPath })}\n`);
    return;
  }
  throw new Error(
    'Usage: client-config.mjs <check|install|remove> <config> <name> <node> <proxy> [previous-node previous-proxy]',
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
