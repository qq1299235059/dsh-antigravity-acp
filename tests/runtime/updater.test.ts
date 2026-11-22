import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyPluginUpdate,
  checkPluginUpdate,
  extractInstalledCommitFromLockfile,
  inferDshProfileDir,
  parseGitHubRepoUrl,
  readInstalledPluginInfo,
  validatePluginUpdateSpec,
  type PluginManagerLike,
} from '../../src/runtime/updater.js';

function createValidManifestPayload(version: string) {
  return {
    version,
    url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-1001/windows-amd64/cli_windows_x64.exe`,
    sha512: 'a'.repeat(128),
    size: 123456,
  };
}

describe('plugin self-updater (src/runtime/updater.ts)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('parses GitHub repository URLs across formats and falls back safely', () => {
    expect(parseGitHubRepoUrl('git+https://github.com/qq1299235059/dsh-antigravity-acp.git')).toEqual({
      owner: 'qq1299235059',
      repo: 'dsh-antigravity-acp',
      repoUrl: 'https://github.com/qq1299235059/dsh-antigravity-acp',
    });
    expect(parseGitHubRepoUrl('github:my-org/custom-plugin#main')).toEqual({
      owner: 'my-org',
      repo: 'custom-plugin',
      repoUrl: 'https://github.com/my-org/custom-plugin',
    });
    expect(parseGitHubRepoUrl('https://gitlab.com/other/repo')).toEqual({
      owner: 'qq1299235059',
      repo: 'dsh-antigravity-acp',
      repoUrl: 'https://github.com/qq1299235059/dsh-antigravity-acp',
    });
  });

  it('extracts resolved 40-char commit SHA from pnpm v9 lockfiles', () => {
    const sampleLock = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      other-pkg:',
      '        specifier: ^1.0.0',
      '        version: 1.0.0',
      '      dsh-antigravity-acp:',
      '        specifier: github:qq1299235059/dsh-antigravity-acp',
      '        version: https://codeload.github.com/qq1299235059/dsh-antigravity-acp/tar.gz/9cf1ae56dd825931c9c79bd3ece18018903d22fa(zod@4.6.7)',
      '      helmd:',
      '        specifier: github:ADWMC/helm-d#v0.6.0',
      '        version: https://codeload.github.com/ADWMC/helm-d/tar.gz/0e36a8e300ca8ae13d95fb1d2056f9d92de9a12a',
    ].join('\n');

    expect(extractInstalledCommitFromLockfile(sampleLock, 'dsh-antigravity-acp')).toBe(
      '9cf1ae56dd825931c9c79bd3ece18018903d22fa',
    );
    expect(extractInstalledCommitFromLockfile(sampleLock, 'missing-pkg')).toBeUndefined();
  });

  it('reads installed plugin info from profile node_modules, lockfile, #sha spec, and .git fallback', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agp-updater-info-'));
    tempDirs.push(tmp);

    const profileDir = path.join(tmp, 'profile-web');
    const pkgDir = path.join(profileDir, 'node_modules', 'dsh-antigravity-acp');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-antigravity-acp',
        version: '0.1.0',
        repository: { url: 'git+https://github.com/qq1299235059/dsh-antigravity-acp.git' },
      }),
    );
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        dependencies: {
          'dsh-antigravity-acp': 'github:qq1299235059/dsh-antigravity-acp',
        },
        dsh: { profile: { bundles: ['dsh-antigravity-acp'] } },
      }),
    );
    const shaA = 'a'.repeat(40);
    fs.writeFileSync(
      path.join(profileDir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      dsh-antigravity-acp:\n        specifier: github:qq1299235059/dsh-antigravity-acp\n        version: https://codeload.github.com/qq1299235059/dsh-antigravity-acp/tar.gz/${shaA}(zod@4.6.7)\n`,
    );

    expect(inferDshProfileDir(pkgDir)).toBe(profileDir);

    const pm: PluginManagerLike = {
      installBundle: vi.fn(),
    };
    const infoFromProfile = await readInstalledPluginInfo({
      packageRootDir: pkgDir,
      pluginManager: pm,
    });
    expect(infoFromProfile.currentVersion).toBe('0.1.0');
    expect(infoFromProfile.currentCommit).toBe(shaA);
    expect(infoFromProfile.installedSpec).toBe('github:qq1299235059/dsh-antigravity-acp');
    expect(infoFromProfile.canAutoUpdate).toBe(true);

    // Pinned #sha in dependencies overrides lockfile lookup cleanly
    const shaB = 'b'.repeat(40);
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({
        dependencies: {
          'dsh-antigravity-acp': `github:qq1299235059/dsh-antigravity-acp#${shaB}`,
        },
      }),
    );
    const infoPinned = await readInstalledPluginInfo({ packageRootDir: pkgDir });
    expect(infoPinned.currentCommit).toBe(shaB);
    expect(infoPinned.canAutoUpdate).toBe(false);

    // Standalone .git checkout fallback
    const gitPkgDir = path.join(tmp, 'git-checkout');
    fs.mkdirSync(path.join(gitPkgDir, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(
      path.join(gitPkgDir, 'package.json'),
      JSON.stringify({ name: 'dsh-antigravity-acp', version: '0.2.0' }),
    );
    fs.writeFileSync(path.join(gitPkgDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const shaC = 'c'.repeat(40);
    fs.writeFileSync(path.join(gitPkgDir, '.git', 'refs', 'heads', 'main'), `${shaC}\n`);
    const infoGit = await readInstalledPluginInfo({ packageRootDir: gitPkgDir });
    expect(infoGit.currentCommit).toBe(shaC);
  });

  it('detects newer semver, newer commit, up-to-date, ahead-of-remote, rate-limit fallback, and CLI manifest updates', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agp-updater-check-'));
    tempDirs.push(tmp);
    const profileDir = path.join(tmp, 'profile');
    const pkgDir = path.join(profileDir, 'node_modules', 'dsh-antigravity-acp');
    fs.mkdirSync(pkgDir, { recursive: true });
    const shaOld = '1'.repeat(40);
    const shaNew = '2'.repeat(40);
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-antigravity-acp',
        version: '0.1.0',
        repository: { url: 'https://github.com/qq1299235059/dsh-antigravity-acp' },
      }),
    );
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({
        dependencies: {
          'dsh-antigravity-acp': `github:qq1299235059/dsh-antigravity-acp#${shaOld}`,
        },
        dsh: { profile: {} },
      }),
    );

    // 1. Newer SemVer + newer CLI manifest
    const fetchNewVer = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/commits/main')) {
        return new Response(
          JSON.stringify({
            sha: shaNew,
            html_url: `https://github.com/qq1299235059/dsh-antigravity-acp/commit/${shaNew}`,
            commit: {
              message: 'feat(updater): release v0.2.0\n\ndetails',
              committer: { date: '2026-11-22T06:30:00Z' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith(`/${shaNew}/package.json`)) {
        return new Response(JSON.stringify({ name: 'dsh-antigravity-acp', version: '0.2.0' }), {
          status: 200,
        });
      }
      if (url.endsWith('/windows_amd64.json')) {
        return new Response(JSON.stringify(createValidManifestPayload('1.6.0')), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const resNewVer = await checkPluginUpdate({
      packageRootDir: pkgDir,
      dshProfileDir: profileDir,
      fetch: fetchNewVer as unknown as typeof globalThis.fetch,
      cliInstalledVersion: '1.5.14',
      platform: 'win32',
      arch: 'x64',
    });
    expect(resNewVer.updateAvailable).toBe(true);
    expect(resNewVer.reason).toBe('newer-version');
    expect(resNewVer.latestVersion).toBe('0.2.0');
    expect(resNewVer.latestCommit).toBe(shaNew);
    expect(resNewVer.latestMessage).toBe('feat(updater): release v0.2.0');
    expect(resNewVer.installSpec).toBe(`github:qq1299235059/dsh-antigravity-acp#${shaNew}`);
    expect(resNewVer.cliLatestVersion).toBe('1.6.0');
    expect(resNewVer.cliUpdateAvailable).toBe(true);

    // 2. Same SemVer, newer commit SHA
    const resNewCommit = await checkPluginUpdate({
      packageRootDir: pkgDir,
      dshProfileDir: profileDir,
      checkCliManifest: false,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/commits/main')) {
          return new Response(JSON.stringify({ sha: shaNew, commit: { message: 'fix: bug' } }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ version: '0.1.0' }), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    expect(resNewCommit.updateAvailable).toBe(true);
    expect(resNewCommit.reason).toBe('newer-commit');

    // 3. Same SemVer + matching commit => up-to-date, and CLI manifest failure is non-fatal
    const resUpToDate = await checkPluginUpdate({
      packageRootDir: pkgDir,
      dshProfileDir: profileDir,
      cliInstalledVersion: '1.5.14',
      platform: 'win32',
      arch: 'x64',
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/commits/main')) {
          return new Response(JSON.stringify({ sha: shaOld, commit: { message: 'head' } }), {
            status: 200,
          });
        }
        if (url.includes('package.json')) {
          return new Response(JSON.stringify({ version: '0.1.0' }), { status: 200 });
        }
        throw new Error('CLI manifest unreachable');
      }) as typeof globalThis.fetch,
    });
    expect(resUpToDate.updateAvailable).toBe(false);
    expect(resUpToDate.reason).toBe('up-to-date');
    expect(resUpToDate.cliLatestVersion).toBeUndefined();

    // 4. GitHub API 403 rate limit falls back to raw main package.json cleanly
    const resRateLimitFallback = await checkPluginUpdate({
      packageRootDir: pkgDir,
      dshProfileDir: profileDir,
      checkCliManifest: false,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/commits/main')) {
          return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
            status: 403,
          });
        }
        return new Response(JSON.stringify({ version: '0.2.5' }), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    expect(resRateLimitFallback.updateAvailable).toBe(true);
    expect(resRateLimitFallback.reason).toBe('newer-version');
    expect(resRateLimitFallback.installSpec).toBe('github:qq1299235059/dsh-antigravity-acp#main');

    // 5. Local version ahead of remote
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'dsh-antigravity-acp', version: '0.3.0' }),
    );
    const resAhead = await checkPluginUpdate({
      packageRootDir: pkgDir,
      dshProfileDir: profileDir,
      checkCliManifest: false,
      fetch: (async () => new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 })) as typeof globalThis.fetch,
    });
    expect(resAhead.updateAvailable).toBe(false);
    expect(resAhead.reason).toBe('ahead');

    // 6. Total network failure throws sanitized error
    await expect(
      checkPluginUpdate({
        packageRootDir: pkgDir,
        dshProfileDir: profileDir,
        checkCliManifest: false,
        fetch: (async () => {
          throw new Error('Bearer secretToken1234 failed to connect');
        }) as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/Bearer \[REDACTED\]/);
  });

  it('validates update specs strictly and applies updates via pluginManager', async () => {
    const validSpec = `github:qq1299235059/dsh-antigravity-acp#${'a'.repeat(40)}`;
    expect(validatePluginUpdateSpec(validSpec)).toBe(validSpec);
    expect(
      validatePluginUpdateSpec('https://github.com/qq1299235059/dsh-antigravity-acp.git#v0.2.0'),
    ).toBe('https://github.com/qq1299235059/dsh-antigravity-acp.git#v0.2.0');

    expect(() => validatePluginUpdateSpec('github:evil/other-repo#main')).toThrow(/INVALID|target/i);
    expect(() => validatePluginUpdateSpec('file:/tmp/local')).toThrow(/INVALID|target/i);
    expect(() =>
      validatePluginUpdateSpec('https://user:pass@github.com/qq1299235059/dsh-antigravity-acp.git'),
    ).toThrow(/disallowed|target/i);

    // Missing pluginManager -> actionable manual CLI command
    const noPm = await applyPluginUpdate({ installSpec: validSpec });
    expect(noPm.status).toBe('failed');
    expect(noPm.message).toContain(`dsh plugin --profile web add ${validSpec}`);

    // Restart required
    const pmRestart: PluginManagerLike = {
      installBundle: vi.fn(async () => ({
        changed: true,
        application: 'restart-required' as const,
        restartReason: 'no-hmr',
        version: '0.2.0',
      })),
    };
    const resRestart = await applyPluginUpdate({
      installSpec: validSpec,
      requestId: 'req-1',
      pluginManager: pmRestart,
    });
    expect(resRestart).toMatchObject({
      status: 'succeeded',
      restartRequired: true,
      restartReason: 'no-hmr',
      installedVersion: '0.2.0',
    });

    // Live HMR applied
    const pmApplied: PluginManagerLike = {
      installBundle: vi.fn(async () => ({
        changed: true,
        application: 'applied' as const,
        version: '0.2.0',
      })),
    };
    const resApplied = await applyPluginUpdate({
      installSpec: validSpec,
      pluginManager: pmApplied,
    });
    expect(resApplied).toMatchObject({
      status: 'succeeded',
      restartRequired: false,
      installedVersion: '0.2.0',
    });

    // Cancelled
    const pmCancelled: PluginManagerLike = {
      installBundle: vi.fn(async () => ({
        changed: false,
        application: 'cancelled' as const,
      })),
    };
    const resCancelled = await applyPluginUpdate({
      installSpec: validSpec,
      pluginManager: pmCancelled,
    });
    expect(resCancelled.status).toBe('cancelled');

    // Failed with sanitized diagnostic
    const pmFailed: PluginManagerLike = {
      installBundle: vi.fn(async () => ({
        changed: false,
        application: 'failed' as const,
        error: {
          code: 'operation-error',
          diagnostic: 'pnpm failed with https://alice:topsecret@proxy.local',
        },
      })),
    };
    const resFailed = await applyPluginUpdate({
      installSpec: validSpec,
      pluginManager: pmFailed,
    });
    expect(resFailed.status).toBe('failed');
    expect(resFailed.error).not.toContain('topsecret');
  });
});
