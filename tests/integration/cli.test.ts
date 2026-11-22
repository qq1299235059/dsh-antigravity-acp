import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCliArgs, runCli } from '../../src/cli.js';

const FAKE_SERVER_PATH = fileURLToPath(new URL('../acp/fake-agy-server.mjs', import.meta.url));

function writeFakeAgyBinary(binDir: string): string {
  const target = path.join(binDir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
  if (process.platform === 'win32') {
    fs.writeFileSync(
      target,
      `@echo off\r\n"${process.execPath}" "${FAKE_SERVER_PATH}" %*\r\n`,
      'utf8',
    );
  } else {
    fs.writeFileSync(
      target,
      `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVER_PATH}" "$@"\n`,
      { encoding: 'utf8', mode: 0o755 },
    );
  }
  return target;
}

describe('standalone CLI (src/cli.ts)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env['FAKE_AGY_WRITE_TOKEN'];
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses CLI arguments and rejects invalid flags cleanly', () => {
    const parsed = parseCliArgs([
      'login',
      '--code',
      '--profile-dir',
      '/tmp/p',
      '--auth-method',
      'oauth-personal',
      '--json',
    ]);
    expect(parsed.command).toBe('login');
    expect(parsed.loginMode).toBe('code');
    expect(parsed.json).toBe(true);
    expect(parsed.configOverrides.profileDir).toBe('/tmp/p');
    expect(parsed.authMethod).toBe('oauth-personal');

    expect(() => parseCliArgs(['status', '--unknown-flag'])).toThrow(/Unknown option/);
    expect(() => parseCliArgs(['login', '--auth-method', 'bogus'])).toThrow(
      /Unsupported auth method/,
    );
  });

  it('runs login --code, status, models, doctor, and logout end-to-end against fake-agy-server', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cli-e2e-'));
    tempDirs.push(tempDir);

    const binDir = path.join(tempDir, 'bin');
    const profileDir = path.join(tempDir, 'profile');
    const workDir = path.join(tempDir, 'work dir');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });

    const fakeBin = writeFakeAgyBinary(binDir);
    process.env['FAKE_AGY_WRITE_TOKEN'] = '1';

    // 1) login --code
    const loginOut: string[] = [];
    const loginErr: string[] = [];
    const loginCode = await runCli(
      ['login', '--code', '--profile-dir', profileDir, '--binary-path', fakeBin, '--json'],
      {
        stdout: (line) => loginOut.push(line),
        stderr: (line) => loginErr.push(line),
        readLine: async () => 'fake-auth-code-12345',
      },
    );
    expect(loginErr.join('\n')).toContain('accounts.google.com');
    expect(loginCode).toBe(0);
    const loginJson = JSON.parse(loginOut.join('\n')) as {
      authenticated: boolean;
      authMethod: string;
    };
    expect(loginJson.authenticated).toBe(true);
    expect(loginJson.authMethod).toBe('oauth-personal');

    // 2) models
    const modelsOut: string[] = [];
    const modelsErr: string[] = [];
    const modelsCode = await runCli(
      [
        'models',
        '--profile-dir',
        profileDir,
        '--binary-path',
        fakeBin,
        '--cwd',
        workDir,
        '--json',
      ],
      {
        stdout: (line) => modelsOut.push(line),
        stderr: (line) => modelsErr.push(line),
        readLine: async () => '',
      },
    );
    expect(modelsErr).toEqual([]);
    expect(modelsCode).toBe(0);
    const modelsJson = JSON.parse(modelsOut.join('\n')) as Array<{ id: string }>;
    expect(modelsJson.map((m) => m.id)).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);

    // 3) doctor
    const doctorOut: string[] = [];
    const doctorErr: string[] = [];
    const doctorCode = await runCli(
      [
        'doctor',
        '--profile-dir',
        profileDir,
        '--binary-path',
        fakeBin,
        '--cwd',
        workDir,
        '--json',
      ],
      {
        stdout: (line) => doctorOut.push(line),
        stderr: (line) => doctorErr.push(line),
        readLine: async () => '',
      },
    );
    expect(doctorErr).toEqual([]);
    expect(doctorCode).toBe(0);
    const doctorJson = JSON.parse(doctorOut.join('\n')) as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    expect(doctorJson.ok).toBe(true);
    expect(doctorJson.checks.find((c) => c.name === 'acp-handshake')?.status).toBe('pass');
    expect(doctorJson.checks.find((c) => c.name === 'auth')?.status).toBe('pass');

    // 4) logout
    const logoutOut: string[] = [];
    const logoutErr: string[] = [];
    const logoutCode = await runCli(
      ['logout', '--profile-dir', profileDir, '--binary-path', fakeBin, '--json'],
      {
        stdout: (line) => logoutOut.push(line),
        stderr: (line) => logoutErr.push(line),
        readLine: async () => '',
      },
    );
    expect(logoutErr).toEqual([]);
    expect(logoutCode).toBe(0);

    // 5) status reflects logged-out state
    const statusOut: string[] = [];
    const statusCode = await runCli(
      ['status', '--profile-dir', profileDir, '--binary-path', fakeBin, '--json'],
      {
        stdout: (line) => statusOut.push(line),
        stderr: () => {},
        readLine: async () => '',
      },
    );
    expect(statusCode).toBe(0);
    const statusJson = JSON.parse(statusOut.join('\n')) as { authenticated?: boolean; profile: { authenticated: boolean } };
    expect(statusJson.profile.authenticated).toBe(false);
  });

  it('reports unknown command and invalid proxy URL with exit code 1', async () => {
    const err1: string[] = [];
    const code1 = await runCli(['not-a-command'], {
      stdout: () => {},
      stderr: (line) => err1.push(line),
      readLine: async () => '',
    });
    expect(code1).toBe(1);
    expect(err1.join('\n')).toContain('Unknown command');

    const err2: string[] = [];
    const out2: string[] = [];
    const code2 = await runCli(
      ['doctor', '--proxy-url', 'ftp://user:secret@proxy.invalid:21', '--strict', '--no-auto-download'],
      {
        stdout: (line) => out2.push(line),
        stderr: (line) => err2.push(line),
        readLine: async () => '',
      },
    );
    expect(code2).toBe(1);
    expect(out2.join('\n')).not.toContain('secret');
  });
});
