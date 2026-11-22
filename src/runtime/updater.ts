import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AntigravityPluginUpdateReason } from '../shared/contracts.js';
import { AntigravityAcpError, redactSensitiveText } from '../shared/errors.js';
import {
  ANTIGRAVITY_CLI_MANIFEST_BASE,
  antigravityCliTarget,
  compareSemver,
  parseAntigravityCliRelease,
  tryParseSemver,
} from './release.js';

export const DEFAULT_PLUGIN_PACKAGE_NAME = 'dsh-antigravity-acp';
export const DEFAULT_PLUGIN_REPO_OWNER = 'qq1299235059';
export const DEFAULT_PLUGIN_REPO_NAME = 'dsh-antigravity-acp';
export const DEFAULT_PLUGIN_BRANCH = 'main';
export const DEFAULT_PLUGIN_GITHUB_API_BASE = 'https://api.github.com';
export const DEFAULT_PLUGIN_RAW_BASE = 'https://raw.githubusercontent.com';

const DEFAULT_CHECK_TIMEOUT_MS = 15_000;
const DEFAULT_CLI_MANIFEST_TIMEOUT_MS = 8_000;
const HEX_40_RE = /^[0-9a-fA-F]{40}$/;
const SAFE_REPO_PART_RE = /^[A-Za-z0-9._-]+$/;

const DEFAULT_PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** Structural subset of `@deepseek-ai/dsh-plugin-manager`'s `ChangeResult`. */
export interface PluginManagerChangeResultLike {
  readonly changed?: boolean;
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled';
  readonly restartReason?: string;
  readonly stage?: string;
  readonly target?: string;
  readonly version?: string;
  readonly bundle?: string;
  readonly warnings?: readonly string[];
  readonly error?: {
    readonly code?: string;
    readonly diagnostic?: string;
  };
  readonly packageResult?: {
    readonly exitCode?: number;
    readonly output?: string;
  };
}

/** Structural subset of DSH's `ctx.get('pluginManager')` service used for self-updates. */
export interface PluginManagerLike {
  listBundles?(): Promise<
    readonly {
      readonly name: string;
      readonly version?: string;
      readonly source?: string;
      readonly installed?: boolean;
      readonly enabled?: boolean;
    }[]
  >;
  installBundle?(
    spec: string,
    options?: {
      readonly enabled?: boolean;
      readonly saveExact?: boolean;
      readonly requestId?: string;
      readonly approvedBuilds?: readonly string[];
      readonly registry?: string | null;
    },
  ): Promise<PluginManagerChangeResultLike>;
  cancelInstall?(requestId: string): Promise<{
    readonly status: 'cancelled' | 'too-late' | 'not-running';
  }>;
}

/** Metadata about the locally installed plugin bundle. */
export interface InstalledPluginInfo {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly currentCommit?: string;
  readonly installedSpec?: string;
  readonly owner: string;
  readonly repo: string;
  readonly repoUrl: string;
  readonly branch: string;
  readonly dshProfileDir?: string;
  readonly canAutoUpdate: boolean;
}

/** Options accepted by {@link checkPluginUpdate}. */
export interface CheckPluginUpdateOptions {
  readonly packageRootDir?: string;
  readonly dshProfileDir?: string;
  readonly pluginManager?: PluginManagerLike;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly githubApiBase?: string;
  readonly rawGithubBase?: string;
  readonly branch?: string;
  readonly timeoutMs?: number;
  readonly cliInstalledVersion?: string;
  readonly cliManifestBaseUrl?: string;
  readonly checkCliManifest?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly musl?: boolean;
}

/** Structured outcome from checking GitHub (and optionally Antigravity CLI manifest) for updates. */
export interface PluginUpdateCheckResult {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly currentCommit?: string;
  readonly installedSpec?: string;
  readonly owner: string;
  readonly repo: string;
  readonly repoUrl: string;
  readonly branch: string;
  readonly latestVersion?: string;
  readonly latestCommit?: string;
  readonly latestMessage?: string;
  readonly latestDate?: string;
  readonly commitUrl?: string;
  readonly installSpec: string;
  readonly updateAvailable: boolean;
  readonly reason: AntigravityPluginUpdateReason;
  readonly canAutoUpdate: boolean;
  readonly cliLatestVersion?: string;
  readonly cliUpdateAvailable?: boolean;
  readonly checkedAt: string;
}

/** Options accepted by {@link applyPluginUpdate}. */
export interface ApplyPluginUpdateOptions {
  readonly installSpec: string;
  readonly requestId?: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly pluginManager?: PluginManagerLike;
}

/** Structured outcome from applying a plugin update via DSH's plugin manager. */
export interface PluginUpdateApplyResult {
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly installSpec: string;
  readonly installedVersion?: string;
  readonly restartRequired: boolean;
  readonly restartReason?: string;
  readonly warnings?: readonly string[];
  readonly message: string;
  readonly error?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeUpdaterError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message || error.name || 'Unknown error'
      : typeof error === 'string'
        ? error
        : String(error ?? 'Unknown error');
  return redactSensitiveText(raw).trim() || 'Unknown error';
}

/**
 * Parse a `package.json` repository URL into GitHub `{ owner, repo, repoUrl }`,
 * falling back cleanly to the canonical `qq1299235059/dsh-antigravity-acp` repo.
 */
export function parseGitHubRepoUrl(url?: string): {
  readonly owner: string;
  readonly repo: string;
  readonly repoUrl: string;
} {
  const fallback = {
    owner: DEFAULT_PLUGIN_REPO_OWNER,
    repo: DEFAULT_PLUGIN_REPO_NAME,
    repoUrl: `https://github.com/${DEFAULT_PLUGIN_REPO_OWNER}/${DEFAULT_PLUGIN_REPO_NAME}`,
  };
  if (typeof url !== 'string' || url.trim() === '') {
    return fallback;
  }
  const trimmed = url.trim().replace(/#.*$/s, '');

  let owner: string | undefined;
  let repo: string | undefined;

  const shorthandMatch = /^github:([^/\s]+)\/([^/\s]+)$/i.exec(trimmed);
  if (shorthandMatch) {
    owner = shorthandMatch[1];
    repo = shorthandMatch[2];
  } else {
    const scpMatch = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(trimmed);
    if (scpMatch) {
      owner = scpMatch[1];
      repo = scpMatch[2];
    } else {
      const normalized = trimmed.replace(/^git\+/i, '').replace(/^ssh:\/\//i, 'https://');
      try {
        const parsed = new URL(normalized);
        if (parsed.hostname.toLowerCase() === 'github.com') {
          const segments = parsed.pathname.split('/').filter(Boolean);
          if (segments.length >= 2) {
            owner = segments[0];
            repo = segments[1];
          }
        }
      } catch {
        return fallback;
      }
    }
  }

  if (!owner || !repo) {
    return fallback;
  }
  const cleanRepo = repo.replace(/\.git$/i, '');
  if (
    !SAFE_REPO_PART_RE.test(owner) ||
    !SAFE_REPO_PART_RE.test(cleanRepo) ||
    owner === '.' ||
    owner === '..' ||
    cleanRepo === '.' ||
    cleanRepo === '..'
  ) {
    return fallback;
  }

  return {
    owner,
    repo: cleanRepo,
    repoUrl: `https://github.com/${owner}/${cleanRepo}`,
  };
}

function unquoteYamlKey(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Extract the resolved 40-character git commit SHA for `packageName` from a pnpm v9 lockfile.
 */
export function extractInstalledCommitFromLockfile(
  lockfileText: string,
  packageName: string,
): string | undefined {
  if (typeof lockfileText !== 'string' || !lockfileText || !packageName) {
    return undefined;
  }

  const lines = lockfileText.replace(/\r\n/g, '\n').split('\n');
  let inPackageBlock = false;
  let packageBlockIndent = -1;

  for (const line of lines) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      continue;
    }
    const indent = line.search(/\S/);
    const trimmed = line.trim();

    if (inPackageBlock) {
      if (indent <= packageBlockIndent) {
        inPackageBlock = false;
      } else {
        const versionMatch =
          /^version:\s*['"]?.*?(?:\/tar\.gz\/|#|\b)([0-9a-fA-F]{40})(?:[^0-9a-fA-F]|$)/.exec(
            trimmed,
          );
        if (versionMatch?.[1]) {
          return versionMatch[1].toLowerCase();
        }
        const commitMatch = /^commit:\s*['"]?([0-9a-fA-F]{40})['"]?(?:\s|$)/.exec(trimmed);
        if (commitMatch?.[1]) {
          return commitMatch[1].toLowerCase();
        }
        continue;
      }
    }

    if (trimmed.endsWith(':') && !trimmed.startsWith('-')) {
      const key = unquoteYamlKey(trimmed.slice(0, -1));
      if (key === packageName) {
        inPackageBlock = true;
        packageBlockIndent = indent;
        continue;
      }
    }

    // Also match top-level `packages:` key lines like
    // `dsh-antigravity-acp@https://codeload.github.com/owner/repo/tar.gz/<40-hex>:`
    const pkgKeyMatch = new RegExp(
      `^['"]?${escapeRegExp(packageName)}@.*?(?:/tar\\.gz/|#)([0-9a-fA-F]{40})`,
    ).exec(trimmed);
    if (pkgKeyMatch?.[1]) {
      return pkgKeyMatch[1].toLowerCase();
    }
  }

  return undefined;
}

/**
 * Infer the enclosing DSH profile directory when this plugin is installed inside `<profile>/node_modules/<pkg>`.
 */
export function inferDshProfileDir(
  packageRootDir: string,
  packageName = DEFAULT_PLUGIN_PACKAGE_NAME,
): string | undefined {
  const parentDir = path.dirname(packageRootDir);
  if (path.basename(parentDir) !== 'node_modules') {
    return undefined;
  }
  const candidate = path.resolve(parentDir, '..');
  try {
    if (fs.existsSync(path.join(candidate, 'pnpm-lock.yaml'))) {
      return candidate;
    }
    const manifestPath = path.join(candidate, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        dsh?: { profile?: unknown };
        dependencies?: Record<string, unknown>;
      };
      if (
        parsed.dsh?.profile !== undefined ||
        typeof parsed.dependencies?.[packageName] === 'string'
      ) {
        return candidate;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

interface ParsedPackageManifest {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly owner: string;
  readonly repo: string;
  readonly repoUrl: string;
}

function parsePackageManifestObject(raw: unknown): ParsedPackageManifest {
  const record =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const packageName =
    typeof record['name'] === 'string' && record['name'].trim()
      ? record['name'].trim()
      : DEFAULT_PLUGIN_PACKAGE_NAME;
  const currentVersion =
    typeof record['version'] === 'string' && record['version'].trim()
      ? record['version'].trim()
      : '0.0.0';
  const repository = record['repository'];
  const repoUrlRaw =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' && repository !== null && !Array.isArray(repository)
        ? typeof (repository as Record<string, unknown>)['url'] === 'string'
          ? ((repository as Record<string, unknown>)['url'] as string)
          : undefined
        : undefined;
  const repoInfo = parseGitHubRepoUrl(repoUrlRaw);
  return {
    packageName,
    currentVersion,
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    repoUrl: repoInfo.repoUrl,
  };
}

/**
 * Synchronously read the installed plugin package manifest without touching network or profile lockfiles.
 */
export function readInstalledPluginManifestSync(
  packageRootDir = DEFAULT_PACKAGE_ROOT,
): ParsedPackageManifest {
  try {
    const raw = fs.readFileSync(path.join(packageRootDir, 'package.json'), 'utf8');
    return parsePackageManifestObject(JSON.parse(raw));
  } catch {
    return parsePackageManifestObject({});
  }
}

async function readGitCheckoutCommit(packageRootDir: string): Promise<string | undefined> {
  const dotGitPath = path.join(packageRootDir, '.git');
  let gitDir: string;
  try {
    const stat = await fsPromises.stat(dotGitPath);
    if (stat.isDirectory()) {
      gitDir = dotGitPath;
    } else if (stat.isFile()) {
      const content = await fsPromises.readFile(dotGitPath, 'utf8');
      const match = /^gitdir:\s*(.+)$/im.exec(content.trim());
      if (!match?.[1]) {
        return undefined;
      }
      gitDir = path.resolve(packageRootDir, match[1].trim());
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }

  let head: string;
  try {
    head = (await fsPromises.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
  } catch {
    return undefined;
  }

  if (HEX_40_RE.test(head)) {
    return head.toLowerCase();
  }
  const refMatch = /^ref:\s*(.+)$/i.exec(head);
  if (!refMatch?.[1]) {
    return undefined;
  }
  const refPath = refMatch[1].trim();
  if (refPath.includes('..') || path.isAbsolute(refPath)) {
    return undefined;
  }
  const resolvedRefFile = path.resolve(gitDir, refPath);
  const relative = path.relative(gitDir, resolvedRefFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }

  try {
    const sha = (await fsPromises.readFile(resolvedRefFile, 'utf8')).trim();
    if (HEX_40_RE.test(sha)) {
      return sha.toLowerCase();
    }
  } catch {
    // Fall through to packed-refs
  }

  try {
    const packed = await fsPromises.readFile(path.join(gitDir, 'packed-refs'), 'utf8');
    for (const line of packed.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) {
        continue;
      }
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2 && parts[1] === refPath && parts[0] && HEX_40_RE.test(parts[0])) {
        return parts[0].toLowerCase();
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function extractCommitFragment(spec: string | undefined): {
  readonly full?: string;
  readonly short?: string;
} {
  if (!spec) {
    return {};
  }
  const fullMatch = /#([0-9a-fA-F]{40})(?:$|[&?])/.exec(spec);
  if (fullMatch?.[1]) {
    return { full: fullMatch[1].toLowerCase() };
  }
  const shortMatch = /#([0-9a-fA-F]{7,39})$/.exec(spec);
  if (shortMatch?.[1]) {
    return { short: shortMatch[1].toLowerCase() };
  }
  return {};
}

/**
 * Inspect local `package.json`, enclosing DSH profile manifest/`pnpm-lock.yaml`, and optional `pluginManager`
 * to resolve installed plugin version, commit SHA, install spec, and auto-update availability.
 */
export async function readInstalledPluginInfo(options: {
  readonly packageRootDir?: string;
  readonly dshProfileDir?: string;
  readonly pluginManager?: PluginManagerLike;
  readonly branch?: string;
} = {}): Promise<InstalledPluginInfo> {
  const packageRootDir = options.packageRootDir ?? DEFAULT_PACKAGE_ROOT;
  let manifest: ParsedPackageManifest;
  try {
    const raw = await fsPromises.readFile(path.join(packageRootDir, 'package.json'), 'utf8');
    manifest = parsePackageManifestObject(JSON.parse(raw));
  } catch {
    manifest = parsePackageManifestObject({});
  }

  const branch = options.branch?.trim() || DEFAULT_PLUGIN_BRANCH;
  const dshProfileDir =
    options.dshProfileDir ?? inferDshProfileDir(packageRootDir, manifest.packageName);

  let installedSpec: string | undefined;
  if (dshProfileDir) {
    try {
      const profilePkg = JSON.parse(
        await fsPromises.readFile(path.join(dshProfileDir, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, unknown> };
      const spec = profilePkg.dependencies?.[manifest.packageName];
      if (typeof spec === 'string' && spec.trim()) {
        installedSpec = spec.trim();
      }
    } catch {
      // Optional
    }
  }

  if (!installedSpec && typeof options.pluginManager?.listBundles === 'function') {
    try {
      const bundles = await options.pluginManager.listBundles();
      const own = bundles.find((item) => item.name === manifest.packageName);
      if (own && typeof own.source === 'string' && own.source.trim()) {
        installedSpec = own.source.trim();
      }
    } catch {
      // Optional
    }
  }

  const fragment = extractCommitFragment(installedSpec);
  let currentCommit = fragment.full;

  if (!currentCommit && dshProfileDir) {
    try {
      const lockText = await fsPromises.readFile(
        path.join(dshProfileDir, 'pnpm-lock.yaml'),
        'utf8',
      );
      currentCommit = extractInstalledCommitFromLockfile(lockText, manifest.packageName);
    } catch {
      // Optional
    }
  }

  if (!currentCommit && fragment.short) {
    currentCommit = fragment.short;
  }

  if (!currentCommit) {
    currentCommit = await readGitCheckoutCommit(packageRootDir);
  }

  return {
    packageName: manifest.packageName,
    currentVersion: manifest.currentVersion,
    ...(currentCommit !== undefined ? { currentCommit } : {}),
    ...(installedSpec !== undefined ? { installedSpec } : {}),
    owner: manifest.owner,
    repo: manifest.repo,
    repoUrl: manifest.repoUrl,
    branch,
    ...(dshProfileDir !== undefined ? { dshProfileDir } : {}),
    canAutoUpdate: typeof options.pluginManager?.installBundle === 'function',
  };
}

/**
 * Validate that an installation spec strictly points to this plugin's GitHub repository
 * with an optional clean commit SHA, branch `main`, or SemVer tag ref.
 */
export function validatePluginUpdateSpec(
  spec: string,
  owner = DEFAULT_PLUGIN_REPO_OWNER,
  repo = DEFAULT_PLUGIN_REPO_NAME,
): string {
  if (typeof spec !== 'string') {
    throw new AntigravityAcpError('Plugin update spec must be a string', 'INVALID_REQUEST');
  }
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new AntigravityAcpError('Plugin update spec must not be empty', 'INVALID_REQUEST');
  }
  if (/[\s@?\\]/.test(trimmed)) {
    throw new AntigravityAcpError(
      'Plugin update spec contains disallowed characters',
      'INVALID_REQUEST',
    );
  }

  const ownerPattern = escapeRegExp(owner);
  const repoPattern = escapeRegExp(repo);
  const refPattern =
    '(?:#(?:[0-9a-fA-F]{7,40}|main|v?\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?))?';

  const shorthandRe = new RegExp(`^github:${ownerPattern}/${repoPattern}${refPattern}$`);
  const httpsRe = new RegExp(
    `^https://github\\.com/${ownerPattern}/${repoPattern}(?:\\.git)?${refPattern}$`,
  );

  if (!shorthandRe.test(trimmed) && !httpsRe.test(trimmed)) {
    throw new AntigravityAcpError(
      `Plugin update spec must target github:${owner}/${repo} or https://github.com/${owner}/${repo}.git`,
      'INVALID_REQUEST',
    );
  }

  return trimmed;
}

async function fetchJsonWithTimeout(
  url: string,
  options: {
    readonly fetchImpl: typeof globalThis.fetch;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly headers?: Record<string, string>;
  },
): Promise<{ readonly status: number; readonly ok: boolean; readonly data?: unknown; readonly statusText: string }> {
  if (options.signal?.aborted) {
    throw new AntigravityAcpError('Update check aborted', 'ABORTED', {
      cause: options.signal.reason,
    });
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${options.timeoutMs}ms`));
  }, options.timeoutMs);
  timer.unref?.();

  const composedSignal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  try {
    const response = await options.fetchImpl(url, {
      method: 'GET',
      headers: options.headers,
      signal: composedSignal,
    });

    let data: unknown;
    if (response.ok) {
      data = await response.json();
    }
    return {
      status: response.status,
      ok: response.ok,
      statusText: response.statusText,
      ...(data !== undefined ? { data } : {}),
    };
  } catch (error: unknown) {
    if (options.signal?.aborted) {
      throw new AntigravityAcpError('Update check aborted', 'ABORTED', {
        cause: options.signal.reason,
      });
    }
    if (timedOut) {
      throw new AntigravityAcpError(
        `Timed out requesting ${url}`,
        'TIMEOUT',
        { cause: error },
      );
    }
    throw new AntigravityAcpError(
      `Failed to query ${url}: ${sanitizeUpdaterError(error)}`,
      'TRANSPORT',
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

function commitsMatch(currentCommit: string | undefined, latestCommit: string | undefined): boolean {
  if (!currentCommit || !latestCommit) {
    return false;
  }
  const left = currentCommit.toLowerCase();
  const right = latestCommit.toLowerCase();
  if (left.length === 40 && right.length === 40) {
    return left === right;
  }
  return right.startsWith(left);
}

function firstCommitLine(message: unknown): string | undefined {
  if (typeof message !== 'string') {
    return undefined;
  }
  const first = message.split(/\r?\n/, 1)[0]?.trim();
  if (!first) {
    return undefined;
  }
  return first.length > 200 ? `${first.slice(0, 197)}...` : first;
}

function buildFallbackInstallSpec(
  owner: string,
  repo: string,
  installedSpec?: string,
): string {
  const baseShorthand = `github:${owner}/${repo}`;
  const mainShorthand = `github:${owner}/${repo}#main`;
  const mainHttps = `https://github.com/${owner}/${repo}.git#main`;
  if (installedSpec === mainShorthand) {
    return mainHttps;
  }
  if (installedSpec === baseShorthand) {
    return mainShorthand;
  }
  return mainShorthand;
}

async function checkLatestCliVersionBestEffort(options: {
  readonly fetchImpl: typeof globalThis.fetch;
  readonly installedVersion?: string;
  readonly manifestBaseUrl: string;
  readonly signal?: AbortSignal;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly musl?: boolean;
}): Promise<{
  readonly cliLatestVersion?: string;
  readonly cliUpdateAvailable?: boolean;
}> {
  const target = antigravityCliTarget(options.platform, options.arch, options.musl);
  if (!target) {
    return {};
  }
  try {
    const manifestUrl = `${options.manifestBaseUrl.replace(/\/+$/, '')}/${target}.json`;
    const res = await fetchJsonWithTimeout(manifestUrl, {
      fetchImpl: options.fetchImpl,
      timeoutMs: DEFAULT_CLI_MANIFEST_TIMEOUT_MS,
      signal: options.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return {};
    }
    const asset = parseAntigravityCliRelease(
      res.data,
      options.platform,
      options.arch,
      options.musl,
    );
    if (!asset) {
      return {};
    }
    let cliUpdateAvailable = false;
    if (options.installedVersion && tryParseSemver(options.installedVersion)) {
      cliUpdateAvailable = compareSemver(asset.version, options.installedVersion) > 0;
    }
    return {
      cliLatestVersion: asset.version,
      cliUpdateAvailable,
    };
  } catch {
    return {};
  }
}

/**
 * Query GitHub (`commits/<branch>` and `package.json`) and optionally the Antigravity CLI manifest
 * to determine whether a newer plugin version or commit is available.
 */
export async function checkPluginUpdate(
  options: CheckPluginUpdateOptions = {},
): Promise<PluginUpdateCheckResult> {
  const info = await readInstalledPluginInfo({
    packageRootDir: options.packageRootDir,
    dshProfileDir: options.dshProfileDir,
    pluginManager: options.pluginManager,
    branch: options.branch,
  });

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new AntigravityAcpError('Global fetch is unavailable for update checks', 'TRANSPORT');
  }

  const githubApiBase = (options.githubApiBase ?? DEFAULT_PLUGIN_GITHUB_API_BASE).replace(
    /\/+$/,
    '',
  );
  const rawGithubBase = (options.rawGithubBase ?? DEFAULT_PLUGIN_RAW_BASE).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const userAgent = `${info.packageName}/${info.currentVersion}`;

  let latestCommit: string | undefined;
  let latestMessage: string | undefined;
  let latestDate: string | undefined;
  let commitUrl: string | undefined;
  let commitError: unknown;

  const commitApiUrl = `${githubApiBase}/repos/${info.owner}/${info.repo}/commits/${encodeURIComponent(info.branch)}`;
  try {
    const commitRes = await fetchJsonWithTimeout(commitApiUrl, {
      fetchImpl,
      timeoutMs,
      signal: options.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': userAgent,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (commitRes.ok && typeof commitRes.data === 'object' && commitRes.data !== null) {
      const payload = commitRes.data as Record<string, unknown>;
      const sha = typeof payload['sha'] === 'string' ? payload['sha'].trim() : '';
      if (HEX_40_RE.test(sha)) {
        latestCommit = sha.toLowerCase();
      }
      const commitObj =
        typeof payload['commit'] === 'object' && payload['commit'] !== null
          ? (payload['commit'] as Record<string, unknown>)
          : undefined;
      latestMessage = firstCommitLine(commitObj?.['message']);
      const committer =
        typeof commitObj?.['committer'] === 'object' && commitObj['committer'] !== null
          ? (commitObj['committer'] as Record<string, unknown>)
          : typeof commitObj?.['author'] === 'object' && commitObj['author'] !== null
            ? (commitObj['author'] as Record<string, unknown>)
            : undefined;
      if (typeof committer?.['date'] === 'string' && committer['date'].trim()) {
        latestDate = committer['date'].trim();
      }
      const rawHtmlUrl =
        typeof payload['html_url'] === 'string' ? payload['html_url'].trim() : '';
      if (rawHtmlUrl.startsWith(`${info.repoUrl}/`)) {
        commitUrl = rawHtmlUrl;
      }
    } else if (!commitRes.ok) {
      commitError = new AntigravityAcpError(
        `GitHub commits API returned HTTP ${commitRes.status}`,
        'TRANSPORT',
      );
    }
  } catch (error: unknown) {
    if (error instanceof AntigravityAcpError && error.code === 'ABORTED') {
      throw error;
    }
    commitError = error;
  }

  let latestVersion: string | undefined;
  let manifestError: unknown;
  const rawRef = latestCommit ?? info.branch;
  const rawPackageUrl = `${rawGithubBase}/${info.owner}/${info.repo}/${rawRef}/package.json`;

  try {
    const pkgRes = await fetchJsonWithTimeout(rawPackageUrl, {
      fetchImpl,
      timeoutMs,
      signal: options.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': userAgent,
      },
    });
    if (pkgRes.ok && typeof pkgRes.data === 'object' && pkgRes.data !== null) {
      const ver = (pkgRes.data as Record<string, unknown>)['version'];
      if (typeof ver === 'string' && ver.trim()) {
        latestVersion = ver.trim();
      }
    } else if (!pkgRes.ok) {
      manifestError = new AntigravityAcpError(
        `Remote package.json returned HTTP ${pkgRes.status}`,
        'TRANSPORT',
      );
    }
  } catch (error: unknown) {
    if (error instanceof AntigravityAcpError && error.code === 'ABORTED') {
      throw error;
    }
    manifestError = error;
  }

  if (!latestVersion && !latestCommit) {
    const primaryError = manifestError ?? commitError;
    if (primaryError instanceof AntigravityAcpError) {
      throw primaryError;
    }
    throw new AntigravityAcpError(
      `Failed to check updates from GitHub: ${sanitizeUpdaterError(primaryError)}`,
      'TRANSPORT',
    );
  }

  let reason: AntigravityPluginUpdateReason = 'up-to-date';
  let updateAvailable = false;

  const parsedCurrent = tryParseSemver(info.currentVersion);
  const parsedLatest = latestVersion ? tryParseSemver(latestVersion) : null;
  let semverCmp: number | null = null;
  if (parsedCurrent && parsedLatest && latestVersion) {
    semverCmp = compareSemver(latestVersion, info.currentVersion);
  }

  if (semverCmp !== null && semverCmp > 0) {
    reason = 'newer-version';
    updateAvailable = true;
  } else if (semverCmp !== null && semverCmp < 0) {
    reason = 'ahead';
    updateAvailable = false;
  } else if (info.currentCommit && latestCommit) {
    if (commitsMatch(info.currentCommit, latestCommit)) {
      reason = 'up-to-date';
      updateAvailable = false;
    } else {
      reason = 'newer-commit';
      updateAvailable = true;
    }
  } else {
    reason = 'up-to-date';
    updateAvailable = false;
  }

  const installSpec = latestCommit
    ? `github:${info.owner}/${info.repo}#${latestCommit}`
    : buildFallbackInstallSpec(info.owner, info.repo, info.installedSpec);

  const cliInfo =
    options.checkCliManifest === false
      ? {}
      : await checkLatestCliVersionBestEffort({
          fetchImpl,
          installedVersion: options.cliInstalledVersion,
          manifestBaseUrl: options.cliManifestBaseUrl ?? ANTIGRAVITY_CLI_MANIFEST_BASE,
          signal: options.signal,
          platform: options.platform ?? process.platform,
          arch: options.arch ?? process.arch,
          musl: options.musl,
        });

  return {
    packageName: info.packageName,
    currentVersion: info.currentVersion,
    ...(info.currentCommit !== undefined ? { currentCommit: info.currentCommit } : {}),
    ...(info.installedSpec !== undefined ? { installedSpec: info.installedSpec } : {}),
    owner: info.owner,
    repo: info.repo,
    repoUrl: info.repoUrl,
    branch: info.branch,
    ...(latestVersion !== undefined ? { latestVersion } : {}),
    ...(latestCommit !== undefined ? { latestCommit } : {}),
    ...(latestMessage !== undefined ? { latestMessage } : {}),
    ...(latestDate !== undefined ? { latestDate } : {}),
    ...(commitUrl !== undefined ? { commitUrl } : {}),
    installSpec,
    updateAvailable,
    reason,
    canAutoUpdate: info.canAutoUpdate,
    ...(cliInfo.cliLatestVersion !== undefined
      ? { cliLatestVersion: cliInfo.cliLatestVersion }
      : {}),
    ...(cliInfo.cliUpdateAvailable !== undefined
      ? { cliUpdateAvailable: cliInfo.cliUpdateAvailable }
      : {}),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Apply a plugin update through DSH's `pluginManager.installBundle(...)` when available,
 * returning a structured status and restart recommendation without throwing host internals.
 */
export async function applyPluginUpdate(
  options: ApplyPluginUpdateOptions,
): Promise<PluginUpdateApplyResult> {
  const owner = options.owner ?? DEFAULT_PLUGIN_REPO_OWNER;
  const repo = options.repo ?? DEFAULT_PLUGIN_REPO_NAME;
  const installSpec = validatePluginUpdateSpec(options.installSpec, owner, repo);

  if (typeof options.pluginManager?.installBundle !== 'function') {
    const msg = `Automatic plugin update requires DSH pluginManager service. Run: dsh plugin --profile web add ${installSpec}`;
    return {
      status: 'failed',
      installSpec,
      restartRequired: false,
      message: msg,
      error: msg,
    };
  }

  let result: PluginManagerChangeResultLike;
  try {
    result = await options.pluginManager.installBundle(installSpec, {
      enabled: true,
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    });
  } catch (error: unknown) {
    const safeErr = sanitizeUpdaterError(error);
    return {
      status: 'failed',
      installSpec,
      restartRequired: false,
      message: safeErr,
      error: safeErr,
    };
  }

  if (result.application === 'cancelled') {
    return {
      status: 'cancelled',
      installSpec,
      restartRequired: false,
      message: 'Plugin update cancelled',
    };
  }

  if (result.application === 'failed') {
    const rawDiag =
      result.error?.diagnostic ||
      (result.error?.code ? `Plugin update rejected (${result.error.code})` : '') ||
      result.packageResult?.output ||
      'Plugin update failed';
    const safeErr = sanitizeUpdaterError(rawDiag);
    return {
      status: 'failed',
      installSpec,
      restartRequired: false,
      message: safeErr,
      error: safeErr,
    };
  }

  const restartRequired =
    result.application === 'restart-required' || Boolean(result.restartReason);
  const warnings =
    Array.isArray(result.warnings) && result.warnings.length > 0 ? result.warnings : undefined;
  const installedVersion = result.version;

  return {
    status: 'succeeded',
    installSpec,
    ...(installedVersion !== undefined ? { installedVersion } : {}),
    restartRequired,
    ...(result.restartReason !== undefined ? { restartReason: result.restartReason } : {}),
    ...(warnings !== undefined ? { warnings } : {}),
    message: restartRequired
      ? `Updated${installedVersion ? ` to v${installedVersion}` : ''}; restart DSH to finish applying the new version.`
      : `Updated${installedVersion ? ` to v${installedVersion}` : ''} and applied.`,
  };
}
