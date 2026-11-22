import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_CLI_MANIFEST_BASE,
  MINIMUM_AGY_VERSION,
  antigravityCliTarget,
  compareSemver,
  parseAntigravityCliRelease,
} from '../../src/runtime/release.js';

const VALID_SHA512 = 'A'.repeat(128);

describe('release.ts', () => {
  it('exports expected constants', () => {
    expect(ANTIGRAVITY_CLI_MANIFEST_BASE).toBe(
      'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests',
    );
    expect(MINIMUM_AGY_VERSION).toBe('1.5.0');
  });

  describe('antigravityCliTarget', () => {
    it('maps supported platform and arch combinations', () => {
      expect(antigravityCliTarget('darwin', 'arm64')).toBe('darwin_arm64');
      expect(antigravityCliTarget('darwin', 'x64')).toBe('darwin_amd64');
      expect(antigravityCliTarget('linux', 'x64')).toBe('linux_amd64');
      expect(antigravityCliTarget('linux', 'arm64')).toBe('linux_arm64');
      expect(antigravityCliTarget('linux', 'x64', true)).toBe('linux_amd64_musl');
      expect(antigravityCliTarget('linux', 'arm64', true)).toBe('linux_arm64_musl');
      expect(antigravityCliTarget('win32', 'x64')).toBe('windows_amd64');
      expect(antigravityCliTarget('win32', 'arm64')).toBe('windows_arm64');
    });

    it('ignores musl on non-linux platforms and returns null for unsupported targets', () => {
      expect(antigravityCliTarget('darwin', 'arm64', true)).toBe('darwin_arm64');
      expect(antigravityCliTarget('win32', 'x64', true)).toBe('windows_amd64');
      expect(antigravityCliTarget('freebsd', 'x64')).toBeNull();
      expect(antigravityCliTarget('linux', 'ia32')).toBeNull();
      expect(antigravityCliTarget('win32', 'arm')).toBeNull();
    });
  });

  describe('compareSemver', () => {
    it('compares major, minor, patch, prerelease, and build metadata', () => {
      expect(compareSemver('1.5.0', '1.5.0')).toBe(0);
      expect(compareSemver('v1.5.1', '1.5.0')).toBe(1);
      expect(compareSemver('1.5.0', '1.6.0')).toBe(-1);
      expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
      expect(compareSemver('1.5.0-rc.1', '1.5.0')).toBe(-1);
      expect(compareSemver('1.5.0-1', '1.5.0-alpha')).toBe(-1);
      expect(compareSemver('1.5.0-alpha.2', '1.5.0-alpha.10')).toBe(-1);
      expect(compareSemver('1.5.1+build.1', '1.5.1+build.99')).toBe(0);
    });

    it('throws on invalid semantic versions', () => {
      expect(() => compareSemver('1.5', '1.5.0')).toThrow();
      expect(() => compareSemver('1.5.0', 'not-a-version')).toThrow();
    });
  });

  describe('parseAntigravityCliRelease', () => {
    it('parses valid tar.gz and windows executable manifests', () => {
      const darwinAsset = parseAntigravityCliRelease(
        {
          version: '1.5.2',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.2-1774000001/darwin-arm64/cli_darwin_arm64.tar.gz',
          sha512: VALID_SHA512,
        },
        'darwin',
        'arm64',
      );
      expect(darwinAsset).toEqual({
        version: '1.5.2',
        releaseId: '1.5.2-1774000001',
        target: 'darwin_arm64',
        url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.2-1774000001/darwin-arm64/cli_darwin_arm64.tar.gz',
        sha512: VALID_SHA512.toLowerCase(),
        executableName: 'antigravity',
        format: 'tar.gz',
      });

      const winAsset = parseAntigravityCliRelease(
        {
          version: '1.5.0',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.0-999/windows-amd64/cli_windows_amd64.exe',
          sha512: VALID_SHA512.toLowerCase(),
          size: 42_000_000,
        },
        'win32',
        'x64',
      );
      expect(winAsset).toEqual({
        version: '1.5.0',
        releaseId: '1.5.0-999',
        target: 'windows_amd64',
        url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.0-999/windows-amd64/cli_windows_amd64.exe',
        sha512: VALID_SHA512.toLowerCase(),
        executableName: 'agy.exe',
        format: 'executable',
        size: 42_000_000,
      });

      const muslAsset = parseAntigravityCliRelease(
        {
          version: '1.5.3',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.3-555/linux-amd64-musl/cli_linux_amd64_musl.tar.gz',
          sha512: VALID_SHA512,
        },
        'linux',
        'x64',
        true,
      );
      expect(muslAsset?.target).toBe('linux_amd64_musl');
      expect(muslAsset?.executableName).toBe('antigravity');
    });

    it('rejects versions below MINIMUM_AGY_VERSION or non-strict semver', () => {
      expect(
        parseAntigravityCliRelease(
          {
            version: '1.4.9',
            url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.9-123/linux-amd64/cli_linux_amd64.tar.gz',
            sha512: VALID_SHA512,
          },
          'linux',
          'x64',
        ),
      ).toBeNull();

      expect(
        parseAntigravityCliRelease(
          {
            version: 'v1.5.1',
            url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/v1.5.1-123/linux-amd64/cli_linux_amd64.tar.gz',
            sha512: VALID_SHA512,
          },
          'linux',
          'x64',
        ),
      ).toBeNull();
    });

    it('rejects untrusted hosts, tampered paths, wrong targets, and bad sha512', () => {
      const cases: unknown[] = [
        null,
        'string',
        {
          version: '1.5.1',
          url: 'http://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-123/linux-amd64/cli_linux_amd64.tar.gz',
          sha512: VALID_SHA512,
        },
        {
          version: '1.5.1',
          url: 'https://evil.example.com/antigravity-public/antigravity-cli/1.5.1-123/linux-amd64/cli_linux_amd64.tar.gz',
          sha512: VALID_SHA512,
        },
        {
          version: '1.5.1',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-123/linux-amd64/cli_linux_amd64.tar.gz?token=1',
          sha512: VALID_SHA512,
        },
        {
          version: '1.5.1',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-abc/linux-amd64/cli_linux_amd64.tar.gz',
          sha512: VALID_SHA512,
        },
        {
          version: '1.5.1',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.2-123/linux-amd64/cli_linux_amd64.tar.gz',
          sha512: VALID_SHA512,
        },
        {
          version: '1.5.1',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-123/evil-folder/cli_linux_amd64.tar.gz',
          sha512: VALID_SHA512,
        },
        {
          version: '1.5.1',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-123/darwin-arm64/cli_darwin_arm64.tar.gz',
          sha512: VALID_SHA512,
        },
        {
          version: '1.5.1',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-123/linux-amd64/cli_linux_amd64.tar.gz',
          sha512: 'a'.repeat(127),
        },
        {
          version: '1.5.1',
          url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-123/linux-amd64/cli_linux_amd64.tar.gz',
          sha512: 'z'.repeat(128),
        },
      ];

      for (const payload of cases) {
        expect(parseAntigravityCliRelease(payload, 'linux', 'x64')).toBeNull();
      }
    });
  });
});
