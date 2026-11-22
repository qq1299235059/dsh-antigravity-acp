import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareAntigravityProfile } from '../../src/runtime/profile.js';
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
});
