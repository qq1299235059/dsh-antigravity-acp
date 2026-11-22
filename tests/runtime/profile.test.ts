import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  buildAcpSpawnArgs,
  buildAntigravityEnvironment,
  parseAntigravityAuthorizationUrl,
  prepareAntigravityProfile,
  removedEnvironmentKeys,
  resolveDefaultProfileDir,
  resolveProfileSnapshot,
  validateAuthConfig,
  validateLoginResponse,
  validateProxyUrl,
} from '../../src/runtime/profile.js';
import { RuntimeConfigSchema } from '../../src/shared/config.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'agy-prof-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('profile.ts', () => {
  it('exports expected constants and complete removedEnvironmentKeys list', () => {
    expect(ANTIGRAVITY_AUTH_STDOUT_PREFIX).toBe(
      'Open the following link to authenticate the ACP server: ',
    );
    expect(ANTIGRAVITY_AUTH_BROWSER_MARKER).toBe('__DSH_ANTIGRAVITY_AUTH_URL__');
    expect(removedEnvironmentKeys).toEqual([
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
      'GOOGLE_CLOUD_QUOTA_PROJECT',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GCLOUD_PROJECT',
      'CLOUDSDK_CORE_PROJECT',
      'AGY_ACP_CCPA_PROJECT',
      'AGY_ACP_ENABLE_OAUTH',
      'GEMINI_HOME',
      'AGY_ACP_FORCE_FILE_STORAGE',
      'AGY_CLI_DISABLE_AUTO_UPDATE',
      'BROWSER',
      'PYTHONUNBUFFERED',
      'ELECTRON_RUN_AS_NODE',
      'CHROME_CRASHPAD_PIPE_NAME',
    ]);
  });

  it('resolves default profile directories across platforms and expands tilde', () => {
    const homeDir = path.join(os.tmpdir(), 'test-home');
    expect(
      resolveDefaultProfileDir(RuntimeConfigSchema({ profileDir: '~/custom-agy' }), {}, homeDir),
    ).toBe(path.resolve(path.join(homeDir, 'custom-agy')));

    expect(
      resolveDefaultProfileDir(
        RuntimeConfigSchema({}),
        { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
        homeDir,
        'win32',
      ),
    ).toBe(path.resolve('C:\\Users\\demo\\AppData\\Local', 'dsh-antigravity-acp', 'profile'));

    expect(
      resolveDefaultProfileDir(RuntimeConfigSchema({}), {}, homeDir, 'darwin'),
    ).toBe(path.resolve(homeDir, 'Library', 'Application Support', 'dsh-antigravity-acp', 'profile'));

    expect(
      resolveDefaultProfileDir(
        RuntimeConfigSchema({}),
        { XDG_STATE_HOME: '/var/lib/state' },
        homeDir,
        'linux',
      ),
    ).toBe(path.resolve('/var/lib/state', 'dsh-antigravity-acp', 'profile'));
  });

  it('prepares profile directories, settings.json, short tempDirectory, browser interceptor, and Linux CA bundle', async () => {
    const root = makeTempDir();
    const longProfileDir = path.join(
      root,
      'a-very-deeply-nested-directory-segment-designed-to-exceed-windows-ninety-character-threshold',
      'profile',
    );
    const shortTmp = path.join(root, 't');
    fs.mkdirSync(shortTmp, { recursive: true });

    const config = RuntimeConfigSchema({
      profileDir: longProfileDir,
      authMethod: 'oauth-business',
      gcpProject: 'my-gcp-project',
      gcpLocation: 'us-central1',
    });

    const profile = await prepareAntigravityProfile(config, {
      platform: 'win32',
      env: { TEMP: shortTmp },
      suppressBrowser: true,
    });

    expect(fs.existsSync(profile.geminiHome)).toBe(true);
    expect(fs.existsSync(profile.acpDirectory)).toBe(true);
    expect(fs.existsSync(profile.tempDirectory)).toBe(true);
    expect(profile.tempDirectory.startsWith(shortTmp)).toBe(true);
    expect(profile.tempDirectory.length).toBeLessThan(120);
    expect(profile.browserCommand).toBeDefined();
    expect(fs.existsSync(profile.browserCommand!)).toBe(true);

    const settings = JSON.parse(
      fs.readFileSync(path.join(profile.acpDirectory, 'settings.json'), 'utf8'),
    );
    expect(settings).toEqual({
      auth: { type: 'oauth-business' },
      gcp: { project: 'my-gcp-project', location: 'us-central1' },
    });

    const linuxProfile = await prepareAntigravityProfile(
      RuntimeConfigSchema({ profileDir: path.join(root, 'linux-prof') }),
      {
        platform: 'linux',
        suppressBrowser: false,
        existsSync: (p) => p === '/etc/ssl/certs/ca-certificates.crt',
      },
    );
    expect(linuxProfile.browserCommand).toBeUndefined();
    expect(linuxProfile.caBundlePath).toBe('/etc/ssl/certs/ca-certificates.crt');
  });

  it('scrubs removedEnvironmentKeys case-insensitively on Windows and configures runtime env', async () => {
    const root = makeTempDir();
    const config = RuntimeConfigSchema({
      profileDir: path.join(root, 'prof'),
      authMethod: 'oauth-personal',
      proxyUrl: 'http://127.0.0.1:8080',
      proxyBypass: 'localhost,127.0.0.1',
    });
    const profile = await prepareAntigravityProfile(config, {
      platform: 'win32',
      env: { TEMP: root },
    });

    const baseEnv: Record<string, string> = {
      Path: 'C:\\Windows\\System32',
      SAFE_CUSTOM: 'keep-me',
      gemini_api_key: 'ambient-secret',
      Google_Api_Key: 'ambient-secret-2',
      GOOGLE_CLOUD_PROJECT: 'ambient-proj',
      Electron_Run_As_Node: '1',
      CHROME_CRASHPAD_PIPE_NAME: 'pipe-name',
      browser: 'chrome.exe',
      TEMP: 'C:\\ambient\\temp',
    };

    const env = buildAntigravityEnvironment(profile, config, baseEnv);

    expect(env.SAFE_CUSTOM).toBe('keep-me');
    expect(env.Path).toBe('C:\\Windows\\System32');
    expect(env.gemini_api_key).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.Google_Api_Key).toBeUndefined();
    expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
    expect(env.Electron_Run_As_Node).toBeUndefined();
    expect(env.CHROME_CRASHPAD_PIPE_NAME).toBeUndefined();
    expect(env.browser).toBeUndefined();

    expect(env.SSH_CONNECTION).toBe('127.0.0.1 0 127.0.0.1 0');
    expect(env.GEMINI_HOME).toBe(profile.geminiHome);
    expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBe('1');
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('1');
    expect(env.PYTHONUNBUFFERED).toBe('1');
    expect(env.BROWSER).toBe(profile.browserCommand);
    expect(env.TEMP).toBe(profile.tempDirectory);
    expect(env.TMP).toBe(profile.tempDirectory);
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:8080');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:8080');
    expect(env.ALL_PROXY).toBe('http://127.0.0.1:8080');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
  });

  it('injects API key only for gemini-api-key or agent-platform and uses relative --app-data-dir', async () => {
    const root = makeTempDir();
    const apiConfig = RuntimeConfigSchema({
      profileDir: path.join(root, 'api-prof'),
      authMethod: 'gemini-api-key',
      apiKeyEnv: 'CUSTOM_GEMINI_KEY',
    });
    const apiProfile = await prepareAntigravityProfile(apiConfig, {
      platform: 'linux',
      env: { CUSTOM_GEMINI_KEY: 'AIzaTestKey1234567890123456' },
    });
    const apiEnv = buildAntigravityEnvironment(apiProfile, apiConfig, {
      CUSTOM_GEMINI_KEY: 'AIzaTestKey1234567890123456',
      GEMINI_API_KEY: 'ambient-override-should-not-win',
    });

    expect(apiEnv.GEMINI_API_KEY).toBe('AIzaTestKey1234567890123456');
    expect(apiEnv.SSH_CONNECTION).toBeUndefined();
    expect(apiEnv.TMPDIR).toBe(apiProfile.tempDirectory);
    expect(apiProfile.authenticated).toBe(true);
    expect(apiProfile.hasApiKey).toBe(true);

    const args = buildAcpSpawnArgs(
      { argsPrefix: ['acp'] },
      apiProfile,
      ['--verbose'],
    );
    expect(args).toEqual([
      'acp',
      '--gemini-dir',
      apiProfile.geminiHome,
      '--app-data-dir',
      'antigravity-acp',
      '--verbose',
    ]);
    expect(path.isAbsolute(args[4]!)).toBe(false);
  });

  it('validates proxy URLs and rejects invalid or credential-bearing errors cleanly', () => {
    for (const valid of [
      'http://127.0.0.1:8080',
      'https://proxy.corp.local:8443',
      'socks5://127.0.0.1:1080',
      'socks5h://127.0.0.1:1080',
      'socks4://127.0.0.1:1080',
      'socks4a://127.0.0.1:1080',
    ]) {
      expect(() => validateProxyUrl(valid)).not.toThrow();
    }

    for (const invalid of ['', '   ', 'ftp://proxy:21', 'not-a-url', 'http://proxy with space:80']) {
      expect(() => validateProxyUrl(invalid)).toThrowError(
        expect.objectContaining({ code: 'AGY_PROXY_INVALID' }),
      );
    }

    let captured: unknown;
    try {
      validateProxyUrl('ftp://alice:s3cr3t@proxy.internal:21');
    } catch (err) {
      captured = err;
    }
    expect(captured).toMatchObject({ code: 'AGY_PROXY_INVALID' });
    expect((captured as Error).message).not.toContain('s3cr3t');
  });

  it('validates OAuth URLs, login responses, auth configs, and profile snapshots', () => {
    const root = makeTempDir();
    const profDir = path.join(root, 'snap');
    const geminiHome = path.join(profDir, '.gemini');
    fs.mkdirSync(geminiHome, { recursive: true });
    const jwtPayload = Buffer.from(JSON.stringify({ email: 'dev@example.com' })).toString(
      'base64url',
    );
    fs.writeFileSync(
      path.join(geminiHome, 'oauth_creds.json'),
      JSON.stringify({
        refresh_token: '1//refresh-token-value',
        id_token: `hdr.${jwtPayload}.sig`,
      }),
    );

    const snap = resolveProfileSnapshot(RuntimeConfigSchema({ profileDir: profDir }));
    expect(snap.authenticated).toBe(true);
    expect(snap.account).toBe('dev@example.com');

    const codeUrl =
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&response_type=code&state=xyz123';
    const loopbackUrl =
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&redirect_uri=http%3A%2F%2F127.0.0.1%3A44112%2Foauth2callback&response_type=code&state=state99';

    const parsedCode = parseAntigravityAuthorizationUrl(codeUrl, 'code');
    expect(parsedCode).toMatchObject({ kind: 'code', state: 'xyz123' });
    expect(parseAntigravityAuthorizationUrl(loopbackUrl, 'loopback')).toMatchObject({
      kind: 'loopback',
      state: 'state99',
    });
    expect(parseAntigravityAuthorizationUrl(loopbackUrl, 'code')).toBeNull();
    expect(parseAntigravityAuthorizationUrl('https://evil.example.com/o/oauth2/v2/auth')).toBeNull();
    expect(
      parseAntigravityAuthorizationUrl(
        'https://accounts.google.com/o/oauth2/v2/auth?response_type=token',
      ),
    ).toBeNull();

    expect(
      validateLoginResponse(
        parsedCode!,
        'https://codeassist.google.com/authcode?code=4/0AfJohX_code_value&state=xyz123',
      ),
    ).toEqual({ code: '4/0AfJohX_code_value', state: 'xyz123' });

    expect(validateLoginResponse(parsedCode!, '4/0AfRawCodeToken123')).toEqual({
      code: '4/0AfRawCodeToken123',
    });

    expect(() =>
      validateLoginResponse(
        parsedCode!,
        'https://codeassist.google.com/authcode?code=4/0AfJohX_code_value&state=WRONG',
      ),
    ).toThrowError(expect.objectContaining({ code: 'AUTH' }));

    expect(() =>
      validateAuthConfig(RuntimeConfigSchema({ authMethod: 'gemini-api-key' }), {}),
    ).toThrowError(expect.objectContaining({ code: 'AGY_AUTH_REQUIRED' }));

    expect(() =>
      validateAuthConfig(RuntimeConfigSchema({ authMethod: 'agent-platform' }), {}),
    ).toThrowError(expect.objectContaining({ code: 'AGY_AUTH_REQUIRED' }));

    expect(() =>
      validateAuthConfig(RuntimeConfigSchema({ authMethod: 'oauth-personal' }), {}),
    ).not.toThrow();
  });

  it('serializes concurrent prepareAntigravityProfile calls on the same profileDir without EPERM', async () => {
    const root = makeTempDir();
    const config = RuntimeConfigSchema({
      profileDir: path.join(root, 'concurrent-prof'),
      authMethod: 'oauth-personal',
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => prepareAntigravityProfile(config)),
    );
    expect(results).toHaveLength(8);
    for (const prof of results) {
      expect(prof.profileDir).toBe(results[0]!.profileDir);
      expect(fs.existsSync(path.join(prof.acpDirectory, 'settings.json'))).toBe(true);
    }
  });
});
