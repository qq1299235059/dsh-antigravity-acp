import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTIGRAVITY_OAUTH_TOKEN_FILENAME, prepareAntigravityProfile } from '../../src/runtime/profile.js';
import { probeAntigravityQuota } from '../../src/runtime/quota.js';
import { RuntimeConfigSchema } from '../../src/shared/config.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'agy-quota-'): string {
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

describe('quota.ts', () => {
  it('throws AGY_AUTH_REQUIRED when no OAuth credentials exist', async () => {
    const root = makeTempDir();
    const config = RuntimeConfigSchema({ profileDir: path.join(root, 'empty') });
    await expect(probeAntigravityQuota(config)).rejects.toMatchObject({
      code: 'AGY_AUTH_REQUIRED',
    });
  });

  it('probes retrieveUserQuotaSummary and parses QuotaSnapshot cleanly', async () => {
    const root = makeTempDir();
    const config = RuntimeConfigSchema({ profileDir: path.join(root, 'p1') });
    const profile = await prepareAntigravityProfile(config);
    const fixedNow = new Date('2026-11-22T00:00:00.000Z');
    fs.writeFileSync(
      profile.cliTokenPath,
      JSON.stringify({
        access_token: 'ya29.valid_token_1234',
        expiry_date: fixedNow.getTime() + 3600_000,
        email: 'quota@example.com',
      }),
    );

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer ya29.valid_token_1234',
      );
      return new Response(
        JSON.stringify({
          currentTier: { name: 'Pro' },
          buckets: [
            {
              modelId: 'gemini-3-pro',
              displayName: 'Gemini 3 Pro',
              remainingFraction: 0.75,
              resetTime: '2026-11-22T01:00:00.000Z',
            },
            {
              modelId: 'claude-sonnet',
              remainingFraction: 0,
              resetInSeconds: 1800,
            },
          ],
          access_token: 'ya29.should_be_redacted_in_raw',
        }),
        { status: 200 },
      );
    });

    const snapshot = await probeAntigravityQuota(config, {
      fetch: fetchMock,
      now: () => fixedNow,
    });

    expect(snapshot.capturedAt).toBe('2026-11-22T00:00:00.000Z');
    expect(snapshot.account).toBe('quota@example.com');
    expect(snapshot.tier).toBe('Pro');
    expect(snapshot.exhausted).toBe(true);
    expect(snapshot.windows).toEqual([
      {
        id: 'gemini-3-pro',
        label: 'Gemini 3 Pro',
        remainingFraction: 0.75,
        usedFraction: 0.25,
        resetAt: '2026-11-22T01:00:00.000Z',
        resetInSeconds: 3600,
      },
      {
        id: 'claude-sonnet',
        remainingFraction: 0,
        usedFraction: 1,
        resetInSeconds: 1800,
      },
    ]);
    expect(snapshot.raw?.access_token).toBe('[REDACTED]');
  });

  it('refreshes expired OAuth token when refresh fields exist and persists new access_token', async () => {
    const root = makeTempDir();
    const config = RuntimeConfigSchema({ profileDir: path.join(root, 'p2') });
    const profile = await prepareAntigravityProfile(config);
    fs.writeFileSync(
      profile.tokenPath,
      JSON.stringify({
        access_token: 'ya29.expired_old',
        refresh_token: '1//refresh_secret_99',
        client_id: 'client-id-123',
        client_secret: 'client-secret-abc',
        expiry_date: Date.now() - 10_000,
      }),
    );

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        expect(String(init?.body)).toContain('grant_type=refresh_token');
        return new Response(
          JSON.stringify({ access_token: 'ya29.refreshed_fresh', expires_in: 3600 }),
          { status: 200 },
        );
      }
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer ya29.refreshed_fresh',
      );
      return new Response(
        JSON.stringify({
          userTier: 'Standard',
          buckets: [{ id: 'default', remainingFraction: 0.9 }],
        }),
        { status: 200 },
      );
    });

    const snapshot = await probeAntigravityQuota(config, { fetch: fetchMock });
    expect(snapshot.tier).toBe('Standard');
    expect(snapshot.exhausted).toBe(false);

    const updatedDisk = JSON.parse(fs.readFileSync(profile.tokenPath, 'utf8'));
    expect(updatedDisk.access_token).toBe('ya29.refreshed_fresh');
  });

  it('falls back to cloudcode-pa and v1internal:fetchAvailableModels', async () => {
    const root = makeTempDir();
    const config = RuntimeConfigSchema({ profileDir: path.join(root, 'p3') });
    const profile = await prepareAntigravityProfile(config);
    fs.writeFileSync(
      profile.tokenPath,
      JSON.stringify({ access_token: 'synthetic-secret-token-value' }),
    );

    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('retrieveUserQuotaSummary')) {
        return new Response('unavailable', { status: 404 });
      }
      if (url.startsWith('https://daily-cloudcode-pa.googleapis.com')) {
        return new Response('upstream glitch', { status: 503 });
      }
      return new Response(
        JSON.stringify({
          models: {
            'gemini-2.5-pro': {
              displayName: 'Gemini 2.5 Pro',
              quotaInfo: { remainingFraction: 0.4, resetTime: '2026-11-22T02:00:00.000Z' },
            },
          },
        }),
        { status: 200 },
      );
    });

    const snapshot = await probeAntigravityQuota(config, { fetch: fetchMock });
    expect(calls).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    ]);
    expect(snapshot.windows[0]).toMatchObject({
      id: 'gemini-2.5-pro',
      label: 'Gemini 2.5 Pro',
      remainingFraction: 0.4,
      usedFraction: 0.6,
    });
  });

  it('maps 401/403/429 errors without leaking secret tokens', async () => {
    const root = makeTempDir();
    const config = RuntimeConfigSchema({ profileDir: path.join(root, 'p4') });
    const profile = await prepareAntigravityProfile(config);
    const secretToken = 'custom-unprefixed-bearer-token-987654';
    fs.writeFileSync(profile.tokenPath, JSON.stringify({ access_token: secretToken }));

    await expect(
      probeAntigravityQuota(config, {
        fetch: async () => new Response(`bad token ${secretToken}`, { status: 401 }),
      }),
    ).rejects.toSatisfy(
      (err: { code?: string; message: string }) =>
        err.code === 'AGY_AUTH_REQUIRED' && !err.message.includes(secretToken),
    );

    await expect(
      probeAntigravityQuota(config, {
        fetch: async () =>
          new Response(`ACCOUNT_SUSPENDED for ${secretToken}`, { status: 403 }),
      }),
    ).rejects.toSatisfy(
      (err: { code?: string; message: string }) =>
        err.code === 'AGY_ACCOUNT_SUSPENDED' && !err.message.includes(secretToken),
    );

    await expect(
      probeAntigravityQuota(config, {
        fetch: async () =>
          new Response(`slow down ${secretToken}`, {
            status: 429,
            headers: { 'retry-after': '12' },
          }),
      }),
    ).rejects.toSatisfy(
      (err: { code?: string; retryAfterMs?: number; message: string }) =>
        err.code === 'RATE_LIMIT' &&
        err.retryAfterMs === 12_000 &&
        !err.message.includes(secretToken),
    );
  });

  it('probes quota from agy 1.5.x antigravity-oauth-token and preserves nested token wrapper on refresh', async () => {
    const root = makeTempDir();
    const config = RuntimeConfigSchema({ profileDir: path.join(root, 'p5-agy15') });
    const profile = await prepareAntigravityProfile(config);
    const agyTokenPath = path.join(profile.acpDirectory, ANTIGRAVITY_OAUTH_TOKEN_FILENAME);
    const fixedNow = new Date('2026-11-22T06:00:00.000Z');

    fs.writeFileSync(
      agyTokenPath,
      JSON.stringify({
        token: {
          access_token: 'ya29.valid_agy15_token',
          token_type: 'Bearer',
          refresh_token: '1//agy15_refresh',
          expiry: new Date(fixedNow.getTime() + 1800_000).toISOString(),
          expires_in: 1800,
        },
        auth_method: 'oauth-personal',
        id_token_email: 'agy15@example.com',
      }),
    );

    const directQuota = await probeAntigravityQuota(config, {
      now: () => fixedNow,
      fetch: async (_input, init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          'Bearer ya29.valid_agy15_token',
        );
        return new Response(
          JSON.stringify({
            currentTier: { name: 'Pro' },
            buckets: [{ modelId: 'gemini-3-pro', remainingFraction: 0.88 }],
          }),
          { status: 200 },
        );
      },
    });
    expect(directQuota.account).toBe('agy15@example.com');
    expect(directQuota.windows[0]).toMatchObject({ id: 'gemini-3-pro', remainingFraction: 0.88 });

    // Now write expired token.expiry with client_id and verify nested wrapper refresh
    fs.writeFileSync(
      agyTokenPath,
      JSON.stringify({
        token: {
          access_token: 'ya29.stale_agy15',
          token_type: 'Bearer',
          refresh_token: '1//agy15_refresh',
          client_id: 'cid-agy15',
          expiry: new Date(fixedNow.getTime() - 10_000).toISOString(),
          expires_in: 10,
        },
        auth_method: 'oauth-personal',
        id_token_email: 'agy15@example.com',
      }),
    );

    const refreshedQuota = await probeAntigravityQuota(config, {
      now: () => fixedNow,
      fetch: async (input) => {
        if (String(input) === 'https://oauth2.googleapis.com/token') {
          return new Response(
            JSON.stringify({ access_token: 'ya29.refreshed_nested', expires_in: 3600 }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            buckets: [{ id: 'flash', remainingFraction: 1 }],
          }),
          { status: 200 },
        );
      },
    });
    expect(refreshedQuota.windows[0]?.id).toBe('flash');

    const persisted = JSON.parse(fs.readFileSync(agyTokenPath, 'utf8'));
    expect(persisted.auth_method).toBe('oauth-personal');
    expect(persisted.id_token_email).toBe('agy15@example.com');
    expect(persisted.access_token).toBeUndefined();
    expect(persisted.token.access_token).toBe('ya29.refreshed_nested');
    expect(persisted.token.expiry).toBe(new Date(fixedNow.getTime() + 3600_000).toISOString());
    expect(persisted.token.expires_in).toBe(3600);
  });
});
