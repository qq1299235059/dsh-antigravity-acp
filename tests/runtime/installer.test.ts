import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AntigravityInstaller,
  createAntigravityInstaller,
} from '../../src/runtime/installer.js';
import { RuntimeConfigSchema } from '../../src/shared/config.js';
import { AntigravityAcpError } from '../../src/shared/errors.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'agy-inst-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha512Hex(data: Buffer | string): string {
  return crypto.createHash('sha512').update(data).digest('hex');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('installer.ts', () => {
  it('prioritizes explicit config.binaryPath and expands tilde', async () => {
    const root = makeTempDir();
    const homeDir = path.join(root, 'home');
    const binDir = path.join(homeDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    const binaryName = process.platform === 'win32' ? 'agy.cmd' : 'agy';
    const binaryPath = path.join(binDir, binaryName);
    fs.writeFileSync(binaryPath, '@echo off\n', { mode: 0o755 });

    const config = RuntimeConfigSchema({
      binaryPath: `~/bin/${binaryName}`,
      autoDownload: false,
      cacheDir: path.join(root, 'cache'),
    });
    const installer = createAntigravityInstaller(config, {
      homeDir,
      pathEnv: '',
    });

    const resolved = await installer.resolveExecutable();
    expect(resolved).toEqual({
      command: binaryPath,
      argsPrefix: ['acp'],
      source: 'configured',
    });
  });

  it('rejects invalid or non-agy explicit config.binaryPath with AGY_NOT_INSTALLED', async () => {
    const root = makeTempDir();
    const wrongBin = path.join(root, 'node.exe');
    fs.writeFileSync(wrongBin, 'dummy', { mode: 0o755 });

    const configWrongName = RuntimeConfigSchema({
      binaryPath: wrongBin,
      autoDownload: true,
    });
    await expect(
      new AntigravityInstaller(configWrongName).resolveExecutable(),
    ).rejects.toMatchObject({
      code: 'AGY_NOT_INSTALLED',
    });

    const configMissing = RuntimeConfigSchema({
      binaryPath: path.join(root, 'missing', 'agy.exe'),
      autoDownload: true,
    });
    await expect(
      new AntigravityInstaller(configMissing).resolveExecutable(),
    ).rejects.toMatchObject({
      code: 'AGY_NOT_INSTALLED',
    });
  });

  it('resolves cached managed runtime before PATH and verifies file size', async () => {
    const root = makeTempDir();
    const cacheRoot = path.join(root, 'cache');
    const pathDir = path.join(root, 'sysbin');
    fs.mkdirSync(pathDir, { recursive: true });
    fs.writeFileSync(path.join(pathDir, 'agy.cmd'), '@echo off\n', { mode: 0o755 });

    const platformCacheDir = path.join(cacheRoot, 'tools', 'antigravity-acp', 'win32-x64');
    const releaseId = '1.5.2-1001';
    const versionDir = path.join(platformCacheDir, 'versions', releaseId);
    fs.mkdirSync(versionDir, { recursive: true });

    const cachedBin = path.join(versionDir, 'agy.exe');
    const payload = Buffer.from('MZ-fake-agy-binary');
    fs.writeFileSync(cachedBin, payload);

    fs.writeFileSync(
      path.join(versionDir, '.install-complete.json'),
      JSON.stringify({
        releaseId,
        version: '1.5.2',
        target: 'windows_amd64',
        executableRelativePath: 'agy.exe',
        size: payload.byteLength,
      }),
    );
    fs.writeFileSync(
      path.join(platformCacheDir, 'active.json'),
      JSON.stringify({
        releaseId,
        version: '1.5.2',
        target: 'windows_amd64',
        executable: 'agy.exe',
      }),
    );

    const config = RuntimeConfigSchema({ cacheDir: cacheRoot, autoDownload: false });
    const installer = new AntigravityInstaller(config, {
      platform: 'win32',
      arch: 'x64',
      pathEnv: pathDir,
    });

    const resolved = await installer.resolveExecutable();
    expect(resolved).toEqual({
      command: cachedBin,
      argsPrefix: ['acp'],
      source: 'cached',
      version: '1.5.2',
      cacheDir: platformCacheDir,
    });

    // Corrupt size -> falls back to PATH!
    fs.writeFileSync(cachedBin, 'tampered');
    const fallbackResolved = await installer.resolveExecutable();
    expect(fallbackResolved).toEqual({
      command: path.join(pathDir, 'agy.cmd'),
      argsPrefix: ['acp'],
      source: 'path',
    });
  });

  it('finds agy/antigravity on PATH and skips directories', async () => {
    const root = makeTempDir();
    const pathDir = path.join(root, 'bin');
    const dirTrapName = process.platform === 'win32' ? 'agy.exe' : 'agy';
    fs.mkdirSync(path.join(pathDir, dirTrapName), { recursive: true }); // directory trap
    const fallbackName = process.platform === 'win32' ? 'antigravity.cmd' : 'antigravity';
    const fallbackBin = path.join(pathDir, fallbackName);
    fs.writeFileSync(fallbackBin, process.platform === 'win32' ? '@echo off\n' : '#!/bin/sh\n', {
      mode: 0o755,
    });

    const config = RuntimeConfigSchema({
      cacheDir: path.join(root, 'cache'),
      autoDownload: false,
    });
    const installer = new AntigravityInstaller(config, {
      platform: process.platform,
      arch: process.arch,
      pathEnv: pathDir,
    });

    const resolved = await installer.resolveExecutable();
    expect(resolved).toEqual({
      command: fallbackBin,
      argsPrefix: ['acp'],
      source: 'path',
    });
  });

  it('throws AGY_NOT_INSTALLED when absent and autoDownload is false or allowDownload is false', async () => {
    const root = makeTempDir();
    const installer = new AntigravityInstaller(
      RuntimeConfigSchema({ cacheDir: path.join(root, 'cache'), autoDownload: false }),
      { platform: 'win32', arch: 'x64', pathEnv: '' },
    );

    await expect(installer.resolveExecutable()).rejects.toMatchObject({
      code: 'AGY_NOT_INSTALLED',
    });

    const autoInstaller = new AntigravityInstaller(
      RuntimeConfigSchema({ cacheDir: path.join(root, 'cache'), autoDownload: true }),
      { platform: 'win32', arch: 'x64', pathEnv: '' },
    );
    await expect(
      autoInstaller.resolveExecutable({ allowDownload: false }),
    ).rejects.toMatchObject({
      code: 'AGY_NOT_INSTALLED',
    });
  });

  it('downloads, verifies SHA-512, activates Windows binary, and reuses cache', async () => {
    const root = makeTempDir();
    const cacheDir = path.join(root, 'cache');
    const binaryBytes = Buffer.from('MZ-valid-windows-agy-1.5.4');
    const digest = sha512Hex(binaryBytes);
    const assetUrl =
      'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.4-7777/windows-amd64/cli_windows_amd64.exe';

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/windows_amd64.json')) {
        return new Response(
          JSON.stringify({ version: '1.5.4', url: assetUrl, sha512: digest }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === assetUrl) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(binaryBytes.subarray(0, 10));
            controller.enqueue(binaryBytes.subarray(10));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-length': String(binaryBytes.byteLength) },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const installer = new AntigravityInstaller(
      RuntimeConfigSchema({ cacheDir, autoDownload: true }),
      {
        platform: 'win32',
        arch: 'x64',
        pathEnv: '',
        fetch: fetchMock,
      },
    );

    const downloaded = await installer.resolveExecutable();
    expect(downloaded.source).toBe('downloaded');
    expect(downloaded.version).toBe('1.5.4');
    expect(fs.existsSync(downloaded.command)).toBe(true);
    expect(fs.readFileSync(downloaded.command)).toEqual(binaryBytes);

    // Second resolve should hit cache without fetching again
    const cached = await installer.resolveExecutable();
    expect(cached.source).toBe('cached');
    expect(cached.command).toBe(downloaded.command);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('extracts POSIX tar.gz via tarExtractor seam and cleans staging directory', async () => {
    const root = makeTempDir();
    const cacheDir = path.join(root, 'cache');
    const archiveBytes = Buffer.from('fake-tar-gz-bytes');
    const digest = sha512Hex(archiveBytes);
    const assetUrl =
      'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.5-8888/darwin-arm64/cli_darwin_arm64.tar.gz';

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/darwin_arm64.json')) {
        return new Response(
          JSON.stringify({ version: '1.5.5', url: assetUrl, sha512: digest }),
          { status: 200 },
        );
      }
      return new Response(archiveBytes, { status: 200 });
    });

    const installer = new AntigravityInstaller(
      RuntimeConfigSchema({ cacheDir, autoDownload: true }),
      {
        platform: 'darwin',
        arch: 'arm64',
        pathEnv: '',
        fetch: fetchMock,
        tarExtractor: async (_archivePath, destDir) => {
          fs.writeFileSync(path.join(destDir, 'antigravity'), '#!/bin/sh\necho ok\n');
        },
      },
    );

    const result = await installer.installManaged();
    expect(result.source).toBe('downloaded');
    expect(result.version).toBe('1.5.5');
    expect(path.basename(result.command)).toBe('antigravity');
    expect(fs.existsSync(result.command)).toBe(true);

    const platformDir = installer.resolvePlatformCacheDir();
    const leftoverStaging = fs
      .readdirSync(platformDir)
      .filter((name) => name.startsWith('.staging-'));
    expect(leftoverStaging).toEqual([]);
  });

  it('rejects SHA-512 mismatches and oversize downloads with AGY_INSTALL_FAILED', async () => {
    const root = makeTempDir();
    const cacheDir = path.join(root, 'cache');
    const assetUrl =
      'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.4-7777/windows-amd64/cli_windows_amd64.exe';

    const mismatchInstaller = new AntigravityInstaller(
      RuntimeConfigSchema({ cacheDir, autoDownload: true }),
      {
        platform: 'win32',
        arch: 'x64',
        pathEnv: '',
        fetch: async (input) => {
          if (String(input).endsWith('.json')) {
            return new Response(
              JSON.stringify({ version: '1.5.4', url: assetUrl, sha512: 'f'.repeat(128) }),
              { status: 200 },
            );
          }
          return new Response(Buffer.from('wrong-bytes'), { status: 200 });
        },
      },
    );

    await expect(mismatchInstaller.installManaged()).rejects.toSatisfy(
      (err: unknown) => err instanceof AntigravityAcpError && err.code === 'AGY_INSTALL_FAILED',
    );
    expect(fs.existsSync(path.join(mismatchInstaller.resolvePlatformCacheDir(), 'active.json'))).toBe(
      false,
    );

    const oversizeInstaller = new AntigravityInstaller(
      RuntimeConfigSchema({ cacheDir, autoDownload: true }),
      {
        platform: 'win32',
        arch: 'x64',
        pathEnv: '',
        maxDownloadBytes: 8,
        fetch: async (input) => {
          const payload = Buffer.from('0123456789abcdef');
          if (String(input).endsWith('.json')) {
            return new Response(
              JSON.stringify({
                version: '1.5.4',
                url: assetUrl,
                sha512: sha512Hex(payload),
              }),
              { status: 200 },
            );
          }
          return new Response(payload, { status: 200 });
        },
      },
    );

    await expect(oversizeInstaller.installManaged()).rejects.toMatchObject({
      code: 'AGY_INSTALL_FAILED',
    });
  });
});
