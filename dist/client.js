window.__ModuleLoader__.load({
  id: 'dsh-antigravity-acp',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const PACKAGE_NAME = 'dsh-antigravity-acp';
    const SERVICE_NAME = 'antigravityControl';
    const SECTION_ID = 'antigravity-acp';
    const POLL_INTERVAL_MS = 1500;
    const STYLE_ID = 'dsh-antigravity-acp/SettingsSection.css';

    const ZERO_ARG_METHODS = [
      'status',
      'installCancel',
      'authCancel',
      'logout',
      'refreshModels',
      'refreshQuota',
    ];

    const ONE_ARG_METHODS = [
      'install',
      'saveConfig',
      'authStart',
      'authSubmitCode',
    ];

    const ZERO_ARG_SET = new Set(ZERO_ARG_METHODS);
    const ONE_ARG_SET = new Set(ONE_ARG_METHODS);

    const ACTIVE_AUTH_PHASES = new Set([
      'starting',
      'awaiting_code',
      'awaiting_browser',
      'exchanging',
    ]);

    const AUTH_METHODS = [
      'oauth-personal',
      'oauth-business',
      'gemini-api-key',
      'agent-platform',
    ];

    function createStrictPassthroughCodec(typeSymbol, withDecode) {
      const codec = {
        mode: 'strict',
        typeSymbol,
        create: () => ({ parse: (v) => v }),
      };
      if (withDecode) {
        codec.decode = (v) => v;
      }
      return codec;
    }

    function createDescriptor(method, hasInput) {
      return {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/${method}`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method,
        invocation: { kind: 'direct' },
        parameters: hasInput
          ? [
              {
                name: 'input',
                wire: 'input',
                source: 'json',
                acceptsUndefined: true,
                codec: createStrictPassthroughCodec(`${PACKAGE_NAME}#ControlInput`, false),
              },
            ]
          : [],
        result: createStrictPassthroughCodec(`${PACKAGE_NAME}#ControlStatus`, true),
      };
    }

    const ANTIGRAVITY_CONTROL_DESCRIPTORS = [
      ...ZERO_ARG_METHODS.map((method) => createDescriptor(method, false)),
      ...ONE_ARG_METHODS.map((method) => createDescriptor(method, true)),
    ];

    const SETTINGS_CSS = `
.agp-section {
  max-width: 720px;
  color: var(--dsw-alias-label-primary, #111827);
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
  line-height: 20px;
}
.agp-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.agp-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 24px;
  color: var(--dsw-alias-label-primary, #111827);
}
.agp-subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}
.agp-card {
  border: 0.5px solid var(--dsw-alias-settings-card-stroke, rgba(0, 0, 0, 0.14));
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, #ffffff));
  border-radius: var(--dsw-radius-xl, 16px);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.agp-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.agp-card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 22px;
  color: var(--dsw-alias-label-primary, #111827);
}
.agp-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  color: var(--dsw-alias-label-secondary, #4b5563);
  background: var(--dsw-alias-bg-layer-1, #f9fafb);
}
.agp-badge-ok {
  color: var(--dsw-alias-state-success-primary, #16a34a);
  background: var(--dsw-alias-state-success-tertiary, rgba(34, 197, 94, 0.12));
  border-color: transparent;
}
.agp-badge-warn {
  color: var(--dsw-alias-state-warn-label, #d97706);
  background: var(--dsw-alias-state-warn-tertiary, rgba(245, 158, 11, 0.12));
  border-color: transparent;
}
.agp-badge-err {
  color: var(--dsw-alias-state-error-primary, #dc2626);
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(239, 68, 68, 0.1));
  border-color: transparent;
}
.agp-kv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px 12px;
}
.agp-kv-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.agp-kv-label {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}
.agp-kv-value {
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #111827);
  word-break: break-all;
}
.agp-mono {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
.agp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.agp-fields-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px 12px;
}
.agp-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.agp-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, #374151);
}
.agp-input {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-md, 10px);
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.16));
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #111827);
  font: inherit;
  font-size: 13px;
}
.agp-input:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary, #4176e6);
}
.agp-checkbox-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--dsw-alias-label-primary, #111827);
  font-size: 13px;
}
.agp-btn {
  box-sizing: border-box;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--dsw-radius-md, 10px);
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  background: transparent;
  color: var(--dsw-alias-label-primary, #111827);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-decoration: none;
}
.agp-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
}
.agp-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.agp-btn-primary {
  background: var(--dsw-alias-button-primary-fill, #111827);
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
  border-color: transparent;
}
.agp-btn-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, #1f2937);
}
.agp-btn-danger {
  color: var(--dsw-alias-state-error-primary, #dc2626);
  border-color: var(--dsw-alias-border-l2, rgba(220, 38, 38, 0.25));
}
.agp-btn-danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(239, 68, 68, 0.08));
}
.agp-banner {
  padding: 8px 12px;
  border-radius: var(--dsw-radius-md, 10px);
  font-size: 12px;
  line-height: 18px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  word-break: break-word;
}
.agp-banner-error {
  color: var(--dsw-alias-state-error-primary, #dc2626);
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(239, 68, 68, 0.08));
}
.agp-banner-ok {
  color: var(--dsw-alias-state-success-primary, #16a34a);
  background: var(--dsw-alias-state-success-tertiary, rgba(34, 197, 94, 0.1));
}
.agp-banner-info {
  color: var(--dsw-alias-label-secondary, #374151);
  background: var(--dsw-alias-bg-layer-1, #f3f4f6);
}
.agp-method-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 8px;
}
.agp-method-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md, 10px);
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.15));
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #111827);
  cursor: pointer;
  text-align: left;
  font: inherit;
  font-size: 12px;
}
.agp-method-option[data-selected="true"] {
  border-color: var(--dsw-alias-state-business-primary, #4176e6);
  background: var(--dsw-alias-interactive-bg-hover, rgba(65, 118, 230, 0.08));
  font-weight: 500;
}
.agp-oauth-box {
  border-radius: var(--dsw-radius-lg, 12px);
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14));
  background: var(--dsw-alias-bg-layer-1, #f9fafb);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agp-url-box {
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md, 8px);
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14));
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  font-size: 12px;
  line-height: 18px;
  word-break: break-all;
  user-select: all;
}
.agp-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agp-list-item {
  padding: 10px 12px;
  border-radius: var(--dsw-radius-lg, 12px);
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.agp-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 16px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14));
  color: var(--dsw-alias-label-secondary, #4b5563);
}
.agp-progress-track {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
}
.agp-progress-bar {
  height: 100%;
  border-radius: 999px;
  transition: width 150ms ease;
}
.agp-muted {
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-size: 12px;
  margin: 0;
}
`;

    function ensureStylesInjected() {
      if (typeof document === 'undefined' || !document.head) {
        return;
      }
      if (
        typeof document.querySelector === 'function' &&
        document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') !== null
      ) {
        return;
      }
      const tag = document.createElement('style');
      if (tag.dataset) {
        tag.dataset.plugin = PACKAGE_NAME;
        tag.dataset.pluginCss = STYLE_ID;
      }
      tag.textContent = SETTINGS_CSS;
      document.head.appendChild(tag);
    }

    function isZhLocale() {
      if (typeof navigator === 'undefined' || typeof navigator.language !== 'string') {
        return false;
      }
      return /^zh/i.test(navigator.language);
    }

    const COPY_ZH = {
      title: 'Antigravity ACP',
      subtitle: '安装与管理 Antigravity CLI (agy >= 1.5.0)，配置 OAuth / API Key 鉴权并查看模型与配额。',
      refreshStatus: '刷新状态',
      loading: '正在加载 Antigravity ACP 状态…',
      cliTitle: 'Antigravity CLI 运行时',
      statusInstalled: '已安装',
      statusInstalling: '安装中',
      statusMissing: '未安装',
      fieldCommand: '解析命令路径',
      fieldSource: '来源',
      fieldVersion: '版本',
      fieldProfileDir: '隔离配置目录',
      fieldPool: 'Worker 连接池',
      notDetected: '未检测到',
      unknown: '未知',
      sourceNames: {
        configured: '手动指定 (configured)',
        cached: '托管缓存 (cached)',
        path: '系统 PATH (path)',
        downloaded: '自动下载 (downloaded)',
      },
      installBtn: '安装 / 更新 Antigravity CLI',
      installManagedBtn: '安装托管版 CLI 并切换',
      cancelInstallBtn: '取消安装',
      customBinaryHint: '当前已配置自定义 binaryPath；若路径失效或希望改用插件自动管理的官方 CLI，可点击“安装托管版 CLI 并切换”。',
      binaryPathLabel: '自定义 binaryPath（留空则自动解析或下载）',
      binaryPathPlaceholder: '例如 /usr/local/bin/agy 或留空',
      autoDownloadLabel: '缺失本地 CLI 时自动下载官方托管版本',
      proxyUrlLabel: '代理 URL (proxyUrl)',
      proxyUrlPlaceholder: '例如 http://127.0.0.1:7890',
      proxyBypassLabel: '代理绕过列表 (proxyBypass)',
      proxyBypassPlaceholder: '例如 localhost,127.0.0.1',
      saveRuntimeBtn: '保存运行时配置',
      runtimeSaved: '运行时配置已保存。',
      authTitle: 'OAuth 与鉴权配置',
      authSignedIn: '已登录',
      authSignedOut: '未登录',
      authMethodLabels: {
        'oauth-personal': 'Google 个人账号 OAuth（推荐）',
        'oauth-business': 'Google 企业/GCP OAuth',
        'gemini-api-key': 'Gemini API Key',
        'agent-platform': 'Agent Platform API Key',
      },
      gcpProjectLabel: 'GCP Project ID',
      gcpProjectPlaceholder: '输入 Google Cloud Project ID',
      gcpLocationLabel: 'GCP Location / Region',
      gcpLocationPlaceholder: '例如 us-central1 或 global',
      saveGcpBtn: '保存 GCP 配置',
      apiKeyLabel: 'API Key',
      apiKeyConfiguredPlaceholder: '已配置密钥（留空保留现有密钥，输入新值将覆盖）',
      apiKeyEmptyPlaceholder: '输入 API Key',
      saveVerifyKeyBtn: '保存并验证 API Key',
      clearKeyBtn: '清除 Key',
      codeLoginBtn: '授权码登录（推荐）',
      loopbackLoginBtn: '本地回调登录',
      logoutBtn: '退出登录',
      openAuthPageBtn: '打开授权页面',
      copyAuthUrlBtn: '复制授权链接',
      copiedAuthUrlBtn: '已复制链接',
      authCodeLabel: '粘贴授权码或完整回调 URL',
      authCodePlaceholder: '粘贴浏览器回显的 code 或 http://localhost:... 回调地址',
      submitCodeBtn: '提交授权码',
      cancelAuthBtn: '取消',
      cancelSignInBtn: '取消登录',
      enterCodeRequired: '请先输入授权码或完整回调 URL。',
      authStartedNotice: '已发起登录流程。',
      authSuccessNotice: '鉴权已完成。',
      loggedOutNotice: '已退出登录并清除本地凭证。',
      keyClearedNotice: '已清除保存的 API Key。',
      modelsQuotaTitle: '模型与配额',
      refreshModelsBtn: '刷新模型列表',
      refreshQuotaBtn: '刷新配额',
      modelsHeading: '可用模型',
      defaultModelBadge: '默认',
      noModelsHint: '暂无已发现模型；安装 CLI 并完成登录后可点击“刷新模型列表”。',
      quotaHeading: '配额窗口',
      quotaExhaustedBadge: '部分配额已耗尽',
      noQuotaHint: '暂无配额数据；登录后可点击“刷新配额”获取。',
      remainingLabel: '剩余',
      resetAtLabel: '重置时间',
      resetInLabel: '约剩余',
    };

    const COPY_EN = {
      title: 'Antigravity ACP',
      subtitle: 'Install and manage Antigravity CLI (agy >= 1.5.0), configure OAuth / API Key auth, and inspect models & quota.',
      refreshStatus: 'Refresh',
      loading: 'Loading Antigravity ACP status…',
      cliTitle: 'CLI Runtime & Installation',
      statusInstalled: 'Installed',
      statusInstalling: 'Installing',
      statusMissing: 'Not Installed',
      fieldCommand: 'Resolved Command',
      fieldSource: 'Source',
      fieldVersion: 'Version',
      fieldProfileDir: 'Isolated Profile Directory',
      fieldPool: 'Worker Pool',
      notDetected: 'Not detected',
      unknown: 'Unknown',
      sourceNames: {
        configured: 'Configured (binaryPath)',
        cached: 'Managed Cache',
        path: 'System PATH',
        downloaded: 'Downloaded',
      },
      installBtn: 'Install / Update Antigravity CLI',
      installManagedBtn: 'Install Managed CLI & Switch',
      cancelInstallBtn: 'Cancel Install',
      customBinaryHint: 'A custom binaryPath is configured. If it is missing or you prefer the managed CLI, click "Install Managed CLI & Switch".',
      binaryPathLabel: 'Custom binaryPath (leave blank for auto-detection / managed download)',
      binaryPathPlaceholder: 'e.g. /usr/local/bin/agy or leave blank',
      autoDownloadLabel: 'Automatically download managed CLI when missing',
      proxyUrlLabel: 'Proxy URL (proxyUrl)',
      proxyUrlPlaceholder: 'e.g. http://127.0.0.1:7890',
      proxyBypassLabel: 'Proxy Bypass (proxyBypass)',
      proxyBypassPlaceholder: 'e.g. localhost,127.0.0.1',
      saveRuntimeBtn: 'Save Runtime Config',
      runtimeSaved: 'Runtime configuration saved.',
      authTitle: 'OAuth & Authentication',
      authSignedIn: 'Signed In',
      authSignedOut: 'Signed Out',
      authMethodLabels: {
        'oauth-personal': 'Google Personal OAuth (Recommended)',
        'oauth-business': 'Google Enterprise / GCP OAuth',
        'gemini-api-key': 'Gemini API Key',
        'agent-platform': 'Agent Platform API Key',
      },
      gcpProjectLabel: 'GCP Project ID',
      gcpProjectPlaceholder: 'Enter Google Cloud Project ID',
      gcpLocationLabel: 'GCP Location / Region',
      gcpLocationPlaceholder: 'e.g. us-central1 or global',
      saveGcpBtn: 'Save GCP Config',
      apiKeyLabel: 'API Key',
      apiKeyConfiguredPlaceholder: 'Key configured (leave blank to keep, or enter a new key)',
      apiKeyEmptyPlaceholder: 'Enter API Key',
      saveVerifyKeyBtn: 'Save & Verify API Key',
      clearKeyBtn: 'Clear Key',
      codeLoginBtn: 'Auth Code Login (Recommended)',
      loopbackLoginBtn: 'Localhost Callback Login',
      logoutBtn: 'Sign Out',
      openAuthPageBtn: 'Open Auth Page',
      copyAuthUrlBtn: 'Copy Auth Link',
      copiedAuthUrlBtn: 'Copied',
      authCodeLabel: 'Paste authorization code or callback URL',
      authCodePlaceholder: 'Paste the code or full http://localhost:... callback URL',
      submitCodeBtn: 'Submit Code',
      cancelAuthBtn: 'Cancel',
      cancelSignInBtn: 'Cancel Sign-In',
      enterCodeRequired: 'Enter the authorization code or callback URL first.',
      authStartedNotice: 'Authentication flow started.',
      authSuccessNotice: 'Authentication succeeded.',
      loggedOutNotice: 'Signed out and cleared credentials.',
      keyClearedNotice: 'Cleared saved API key.',
      modelsQuotaTitle: 'Models & Quota',
      refreshModelsBtn: 'Refresh Models',
      refreshQuotaBtn: 'Refresh Quota',
      modelsHeading: 'Discovered Models',
      defaultModelBadge: 'Default',
      noModelsHint: 'No models loaded yet. Install CLI, sign in, and click "Refresh Models".',
      quotaHeading: 'Quota Windows',
      quotaExhaustedBadge: 'Quota Exhausted',
      noQuotaHint: 'No quota snapshot yet. Sign in and click "Refresh Quota".',
      remainingLabel: 'Remaining',
      resetAtLabel: 'Resets at',
      resetInLabel: 'Resets in',
    };

    function getCopy() {
      return isZhLocale() ? COPY_ZH : COPY_EN;
    }

    function cleanInputObject(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
      }
      const out = {};
      const keys = Object.keys(input);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const value = input[key];
        if (value !== undefined) {
          out[key] = value;
        }
      }
      return out;
    }

    function unwrapRemoteResult(res) {
      if (res && typeof res === 'object' && 'ok' in res) {
        if (!res.ok) {
          const message =
            res.error && typeof res.error.message === 'string' && res.error.message
              ? res.error.message
              : 'RPC request failed';
          throw new Error(message);
        }
        return res.value;
      }
      return res;
    }

    function sanitizeDisplayError(err) {
      const raw = err instanceof Error ? err.message : String(err || 'Unknown error');
      return raw
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/AIza[0-9A-Za-z_-]{16,}/g, '[REDACTED]')
        .replace(/sk-[0-9A-Za-z_-]{12,}/g, '[REDACTED]')
        .replace(/https:\/\/accounts\.google\.com\/[^\s"'<>]+/gi, '[REDACTED_AUTH_URL]');
    }

    function formatRemainingSeconds(seconds) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
        return '';
      }
      const total = Math.round(seconds);
      if (total < 60) {
        return `${total}s`;
      }
      const hours = Math.floor(total / 3600);
      const mins = Math.floor((total % 3600) / 60);
      if (hours > 0) {
        return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
      }
      return `${mins}m`;
    }

    function computeRemainingPercent(win) {
      if (!win || typeof win !== 'object') {
        return null;
      }
      if (typeof win.remainingFraction === 'number' && Number.isFinite(win.remainingFraction)) {
        return Math.max(0, Math.min(100, Math.round(win.remainingFraction * 100)));
      }
      if (typeof win.usedFraction === 'number' && Number.isFinite(win.usedFraction)) {
        return Math.max(0, Math.min(100, Math.round((1 - win.usedFraction) * 100)));
      }
      if (
        typeof win.limit === 'number' &&
        Number.isFinite(win.limit) &&
        win.limit > 0 &&
        typeof win.remaining === 'number' &&
        Number.isFinite(win.remaining)
      ) {
        return Math.max(0, Math.min(100, Math.round((win.remaining / win.limit) * 100)));
      }
      return null;
    }

    function AntigravitySectionIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16;
      const active = Boolean(props && props.active);
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          'data-active': active ? 'true' : 'false',
        },
        h('path', { d: 'M8 2.2L12.8 13.4L8 11.1L3.2 13.4L8 2.2Z' }),
        h('path', { d: 'M5.6 9.1H10.4' }),
      );
    }

    function AntigravitySettingsSection(props) {
      const callControl = props && props.callControl;
      const copy = getCopy();

      const [status, setStatus] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [busyAction, setBusyAction] = React.useState(null);
      const [actionError, setActionError] = React.useState(null);
      const [actionNotice, setActionNotice] = React.useState(null);
      const [copiedAuthUrl, setCopiedAuthUrl] = React.useState(false);

      const [binaryPath, setBinaryPath] = React.useState('');
      const [autoDownload, setAutoDownload] = React.useState(true);
      const [proxyUrl, setProxyUrl] = React.useState('');
      const [proxyBypass, setProxyBypass] = React.useState('');

      const [authMethod, setAuthMethod] = React.useState('oauth-personal');
      const [gcpProject, setGcpProject] = React.useState('');
      const [gcpLocation, setGcpLocation] = React.useState('');
      const [apiKey, setApiKey] = React.useState('');
      const [authCode, setAuthCode] = React.useState('');

      const mountedRef = React.useRef(true);
      const initializedRef = React.useRef(false);
      const runtimeDirtyRef = React.useRef(false);
      const authDirtyRef = React.useRef(false);

      const applyStatusSnapshot = React.useCallback((nextStatus) => {
        if (!nextStatus || typeof nextStatus !== 'object') {
          return;
        }
        setStatus(nextStatus);
        const cfg = nextStatus.config;
        if (cfg && typeof cfg === 'object') {
          const isInitial = !initializedRef.current;
          if (isInitial || !runtimeDirtyRef.current) {
            setBinaryPath(typeof cfg.binaryPath === 'string' ? cfg.binaryPath : '');
            setAutoDownload(typeof cfg.autoDownload === 'boolean' ? cfg.autoDownload : true);
            setProxyUrl(typeof cfg.proxyUrl === 'string' ? cfg.proxyUrl : '');
            setProxyBypass(typeof cfg.proxyBypass === 'string' ? cfg.proxyBypass : '');
          }
          if (isInitial || !authDirtyRef.current) {
            setAuthMethod(typeof cfg.authMethod === 'string' ? cfg.authMethod : 'oauth-personal');
            setGcpProject(typeof cfg.gcpProject === 'string' ? cfg.gcpProject : '');
            setGcpLocation(typeof cfg.gcpLocation === 'string' ? cfg.gcpLocation : '');
          }
          initializedRef.current = true;
        }
      }, []);

      const refreshStatus = React.useCallback(async () => {
        if (typeof callControl !== 'function') {
          return null;
        }
        setLoading(true);
        setActionError(null);
        try {
          const nextStatus = await callControl('status');
          if (mountedRef.current && nextStatus) {
            applyStatusSnapshot(nextStatus);
          }
          return nextStatus;
        } catch (err) {
          if (mountedRef.current) {
            setActionError(sanitizeDisplayError(err));
          }
          return null;
        } finally {
          if (mountedRef.current) {
            setLoading(false);
          }
        }
      }, [callControl, applyStatusSnapshot]);

      React.useEffect(() => {
        mountedRef.current = true;
        refreshStatus();
        return () => {
          mountedRef.current = false;
        };
      }, [refreshStatus]);

      const installPhase = status && status.install ? status.install.phase : 'idle';
      const authPhase = status && status.auth ? status.auth.phase : 'idle';
      const isInstalling = installPhase === 'running';
      const isAuthActive = ACTIVE_AUTH_PHASES.has(authPhase);
      const shouldPoll = isInstalling || isAuthActive;

      React.useEffect(() => {
        if (!shouldPoll || typeof callControl !== 'function') {
          return undefined;
        }
        let cancelled = false;
        let inFlight = false;
        const timer = setInterval(() => {
          if (cancelled || inFlight) {
            return;
          }
          inFlight = true;
          Promise.resolve(callControl('status'))
            .then((nextStatus) => {
              if (!cancelled && mountedRef.current && nextStatus) {
                applyStatusSnapshot(nextStatus);
              }
            })
            .catch((err) => {
              if (!cancelled && mountedRef.current) {
                setActionError(sanitizeDisplayError(err));
              }
            })
            .finally(() => {
              inFlight = false;
            });
        }, POLL_INTERVAL_MS);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [shouldPoll, callControl, applyStatusSnapshot]);

      const invokeAction = React.useCallback(
        async (actionKey, method, input, options) => {
          if (typeof callControl !== 'function') {
            return null;
          }
          setBusyAction(actionKey);
          setActionError(null);
          setActionNotice(null);
          try {
            const nextStatus = ZERO_ARG_SET.has(method)
              ? await callControl(method)
              : await callControl(method, input || {});
            if (!mountedRef.current) {
              return nextStatus;
            }
            if (options && typeof options.onSuccess === 'function') {
              options.onSuccess(nextStatus);
            }
            if (nextStatus) {
              applyStatusSnapshot(nextStatus);
            }
            const resolvedNotice =
              options && typeof options.getNotice === 'function'
                ? options.getNotice(nextStatus)
                : options && options.notice;
            if (resolvedNotice) {
              setActionNotice(resolvedNotice);
            }
            return nextStatus;
          } catch (err) {
            if (mountedRef.current) {
              setActionError(sanitizeDisplayError(err));
            }
            return null;
          } finally {
            if (mountedRef.current) {
              setBusyAction(null);
            }
          }
        },
        [callControl, applyStatusSnapshot],
      );

      const handleInstall = (clearBinaryPath) => {
        const input = clearBinaryPath ? { clearBinaryPath: true } : {};
        return invokeAction(clearBinaryPath ? 'installManaged' : 'install', 'install', input, {
          onSuccess: () => {
            if (clearBinaryPath) {
              runtimeDirtyRef.current = false;
              setBinaryPath('');
            }
          },
        });
      };

      const handleSaveRuntimeConfig = () => {
        return invokeAction(
          'saveRuntime',
          'saveConfig',
          {
            binaryPath: binaryPath.trim(),
            autoDownload: Boolean(autoDownload),
            proxyUrl: proxyUrl.trim(),
            proxyBypass: proxyBypass.trim(),
          },
          {
            notice: copy.runtimeSaved,
            onSuccess: () => {
              runtimeDirtyRef.current = false;
            },
          },
        );
      };

      const handleSaveGcpConfig = () => {
        return invokeAction(
          'saveGcp',
          'saveConfig',
          {
            authMethod,
            gcpProject: gcpProject.trim(),
            gcpLocation: gcpLocation.trim(),
          },
          {
            notice: copy.runtimeSaved,
            onSuccess: () => {
              authDirtyRef.current = false;
            },
          },
        );
      };

      const handleSaveVerifyApiKey = () => {
        const payload = { authMethod };
        const trimmedKey = apiKey.trim();
        if (trimmedKey) {
          payload.apiKey = trimmedKey;
        }
        return invokeAction('authApiKey', 'authStart', payload, {
          getNotice: (nextStatus) =>
            nextStatus && nextStatus.auth && nextStatus.auth.phase === 'failed'
              ? null
              : copy.authSuccessNotice,
          onSuccess: (nextStatus) => {
            if (!(nextStatus && nextStatus.auth && nextStatus.auth.phase === 'failed')) {
              authDirtyRef.current = false;
              setApiKey('');
            }
          },
        });
      };

      const handleClearApiKey = () => {
        return invokeAction(
          'clearKey',
          'saveConfig',
          { clearApiKey: true },
          {
            notice: copy.keyClearedNotice,
            onSuccess: () => {
              authDirtyRef.current = false;
              setApiKey('');
            },
          },
        );
      };

      const handleOAuthStart = (mode) => {
        const payload = { mode, authMethod };
        if (authMethod === 'oauth-business') {
          payload.gcpProject = gcpProject.trim();
          payload.gcpLocation = gcpLocation.trim();
        }
        return invokeAction(`auth-${mode}`, 'authStart', payload, {
          getNotice: (nextStatus) => {
            const phase = nextStatus && nextStatus.auth ? nextStatus.auth.phase : null;
            if (phase === 'failed' || phase === 'cancelled') {
              return null;
            }
            if (phase === 'succeeded') {
              return copy.authSuccessNotice;
            }
            return copy.authStartedNotice;
          },
          onSuccess: () => {
            authDirtyRef.current = false;
          },
        });
      };

      const handleAuthSubmitCode = () => {
        const trimmed = authCode.trim();
        if (!trimmed) {
          setActionError(copy.enterCodeRequired);
          return Promise.resolve(null);
        }
        return invokeAction(
          'authSubmitCode',
          'authSubmitCode',
          { code: trimmed },
          {
            onSuccess: () => {
              setAuthCode('');
            },
          },
        );
      };

      const handleCopyAuthUrl = (url) => {
        if (!url) {
          return;
        }
        if (
          typeof navigator !== 'undefined' &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function'
        ) {
          Promise.resolve(navigator.clipboard.writeText(url))
            .then(() => {
              if (mountedRef.current) {
                setCopiedAuthUrl(true);
                setTimeout(() => {
                  if (mountedRef.current) {
                    setCopiedAuthUrl(false);
                  }
                }, 2000);
              }
            })
            .catch(() => {});
        }
      };

      const isBusy = busyAction !== null;
      const installed = Boolean(status && status.installed);
      const executable = status && status.executable ? status.executable : null;
      const profile = status && status.profile ? status.profile : null;
      const cfg = status && status.config ? status.config : null;
      const pool = status && status.pool ? status.pool : null;
      const installState = status && status.install ? status.install : null;
      const authState = status && status.auth ? status.auth : null;
      const models = status && Array.isArray(status.models) ? status.models : [];
      const quota = status && status.quota ? status.quota : null;
      const hasCustomBinaryPath = Boolean(cfg && cfg.binaryPath);
      const hasApiKey = Boolean(
        (profile && profile.hasApiKey) || (cfg && cfg.hasApiKey),
      );
      const isApiKeyMethod =
        authMethod === 'gemini-api-key' || authMethod === 'agent-platform';
      const isOAuthMethod =
        authMethod === 'oauth-personal' || authMethod === 'oauth-business';

      let cliBadgeText = copy.statusMissing;
      let cliBadgeClass = 'agp-badge agp-badge-err';
      if (isInstalling) {
        cliBadgeText = copy.statusInstalling;
        cliBadgeClass = 'agp-badge agp-badge-warn';
      } else if (installed) {
        cliBadgeText = copy.statusInstalled;
        cliBadgeClass = 'agp-badge agp-badge-ok';
      }

      const authBadgeText =
        profile && profile.authenticated
          ? profile.account
            ? `${copy.authSignedIn} (${profile.account})`
            : copy.authSignedIn
          : copy.authSignedOut;
      const authBadgeClass =
        profile && profile.authenticated
          ? 'agp-badge agp-badge-ok'
          : 'agp-badge';

      return h(
        'div',
        { className: 'agp-section', 'data-acp-section': SECTION_ID },
        // Header
        h(
          'div',
          { className: 'agp-header' },
          h(
            'div',
            null,
            h('h2', { className: 'agp-title' }, copy.title),
            h('p', { className: 'agp-subtitle' }, copy.subtitle),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'agp-btn',
              'data-acp-action': 'refresh-status',
              disabled: loading || isBusy,
              onClick: () => {
                refreshStatus();
              },
            },
            copy.refreshStatus,
          ),
        ),

        // Inline global banners
        !status && loading
          ? h('div', { className: 'agp-banner agp-banner-info' }, copy.loading)
          : null,
        actionError
          ? h(
              'div',
              {
                className: 'agp-banner agp-banner-error',
                role: 'alert',
                'data-acp-banner': 'error',
              },
              actionError,
            )
          : null,
        actionNotice
          ? h(
              'div',
              {
                className: 'agp-banner agp-banner-ok',
                role: 'status',
                'data-acp-banner': 'notice',
              },
              actionNotice,
            )
          : null,

        // Card 1: CLI Runtime & Installation
        h(
          'section',
          { className: 'agp-card', 'data-acp-card': 'cli' },
          h(
            'div',
            { className: 'agp-card-head' },
            h('h3', { className: 'agp-card-title' }, copy.cliTitle),
            h('span', { className: cliBadgeClass, 'data-acp-badge': 'cli' }, cliBadgeText),
          ),
          h(
            'div',
            { className: 'agp-kv-grid' },
            h(
              'div',
              { className: 'agp-kv-item' },
              h('span', { className: 'agp-kv-label' }, copy.fieldCommand),
              h(
                'span',
                { className: 'agp-kv-value agp-mono' },
                executable && executable.command ? executable.command : copy.notDetected,
              ),
            ),
            h(
              'div',
              { className: 'agp-kv-item' },
              h('span', { className: 'agp-kv-label' }, copy.fieldSource),
              h(
                'span',
                { className: 'agp-kv-value' },
                executable && executable.source
                  ? copy.sourceNames[executable.source] || executable.source
                  : copy.unknown,
              ),
            ),
            h(
              'div',
              { className: 'agp-kv-item' },
              h('span', { className: 'agp-kv-label' }, copy.fieldVersion),
              h(
                'span',
                { className: 'agp-kv-value agp-mono' },
                executable && executable.version ? executable.version : copy.unknown,
              ),
            ),
            h(
              'div',
              { className: 'agp-kv-item' },
              h('span', { className: 'agp-kv-label' }, copy.fieldProfileDir),
              h(
                'span',
                { className: 'agp-kv-value agp-mono' },
                profile && profile.profileDir ? profile.profileDir : copy.unknown,
              ),
            ),
            pool
              ? h(
                  'div',
                  { className: 'agp-kv-item' },
                  h('span', { className: 'agp-kv-label' }, copy.fieldPool),
                  h(
                    'span',
                    { className: 'agp-kv-value agp-mono' },
                    `active=${pool.activeLeases} idle=${pool.idleWorkers} max=${pool.maxConcurrentSessions}`,
                  ),
                )
              : null,
          ),
          isInstalling ||
            (installState &&
              (installState.phase === 'failed' ||
                installState.phase === 'cancelled' ||
                installState.phase === 'succeeded') &&
              installState.message)
            ? h(
                'div',
                {
                  className:
                    installState && installState.phase === 'failed'
                      ? 'agp-banner agp-banner-error'
                      : 'agp-banner agp-banner-info',
                  'data-acp-install-phase': installState ? installState.phase : 'idle',
                },
                installState && installState.error
                  ? sanitizeDisplayError(installState.error)
                  : installState && installState.message
                    ? installState.message
                    : '',
              )
            : null,
          hasCustomBinaryPath
            ? h('p', { className: 'agp-muted' }, copy.customBinaryHint)
            : null,
          h(
            'div',
            { className: 'agp-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'agp-btn agp-btn-primary',
                'data-acp-action': 'install',
                disabled: isInstalling || isBusy,
                onClick: () => {
                  handleInstall(false);
                },
              },
              copy.installBtn,
            ),
            hasCustomBinaryPath
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'agp-btn',
                    'data-acp-action': 'install-managed',
                    disabled: isInstalling || isBusy,
                    onClick: () => {
                      handleInstall(true);
                    },
                  },
                  copy.installManagedBtn,
                )
              : null,
            isInstalling
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'agp-btn agp-btn-danger',
                    'data-acp-action': 'install-cancel',
                    disabled: isBusy,
                    onClick: () => {
                      invokeAction('installCancel', 'installCancel');
                    },
                  },
                  copy.cancelInstallBtn,
                )
              : null,
          ),
          h(
            'div',
            { className: 'agp-fields-grid' },
            h(
              'label',
              { className: 'agp-field' },
              h('span', { className: 'agp-label' }, copy.binaryPathLabel),
              h('input', {
                type: 'text',
                className: 'agp-input agp-mono',
                'data-acp-input': 'binaryPath',
                value: binaryPath,
                placeholder: copy.binaryPathPlaceholder,
                onChange: (event) => {
                  runtimeDirtyRef.current = true;
                  setBinaryPath(event.target.value);
                },
              }),
            ),
            h(
              'label',
              { className: 'agp-field' },
              h('span', { className: 'agp-label' }, copy.proxyUrlLabel),
              h('input', {
                type: 'text',
                className: 'agp-input agp-mono',
                'data-acp-input': 'proxyUrl',
                value: proxyUrl,
                placeholder: copy.proxyUrlPlaceholder,
                onChange: (event) => {
                  runtimeDirtyRef.current = true;
                  setProxyUrl(event.target.value);
                },
              }),
            ),
            h(
              'label',
              { className: 'agp-field' },
              h('span', { className: 'agp-label' }, copy.proxyBypassLabel),
              h('input', {
                type: 'text',
                className: 'agp-input agp-mono',
                'data-acp-input': 'proxyBypass',
                value: proxyBypass,
                placeholder: copy.proxyBypassPlaceholder,
                onChange: (event) => {
                  runtimeDirtyRef.current = true;
                  setProxyBypass(event.target.value);
                },
              }),
            ),
          ),
          h(
            'div',
            { className: 'agp-row', style: { justifyContent: 'space-between' } },
            h(
              'label',
              { className: 'agp-checkbox-row' },
              h('input', {
                type: 'checkbox',
                'data-acp-input': 'autoDownload',
                checked: autoDownload,
                onChange: (event) => {
                  runtimeDirtyRef.current = true;
                  setAutoDownload(Boolean(event.target.checked));
                },
              }),
              h('span', null, copy.autoDownloadLabel),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'agp-btn',
                'data-acp-action': 'save-runtime',
                disabled: isBusy,
                onClick: () => {
                  handleSaveRuntimeConfig();
                },
              },
              copy.saveRuntimeBtn,
            ),
          ),
        ),

        // Card 2: OAuth & Authentication
        h(
          'section',
          { className: 'agp-card', 'data-acp-card': 'auth' },
          h(
            'div',
            { className: 'agp-card-head' },
            h('h3', { className: 'agp-card-title' }, copy.authTitle),
            h(
              'div',
              { className: 'agp-row' },
              profile && profile.authMethod
                ? h('span', { className: 'agp-chip agp-mono' }, profile.authMethod)
                : null,
              h('span', { className: authBadgeClass, 'data-acp-badge': 'auth' }, authBadgeText),
            ),
          ),
          h(
            'div',
            { className: 'agp-method-grid', role: 'radiogroup', 'aria-label': copy.authTitle },
            ...AUTH_METHODS.map((methodId) => {
              const selected = authMethod === methodId;
              return h(
                'button',
                {
                  key: methodId,
                  type: 'button',
                  role: 'radio',
                  'aria-checked': selected,
                  'data-selected': selected ? 'true' : 'false',
                  'data-acp-auth-method': methodId,
                  className: 'agp-method-option',
                  onClick: () => {
                    authDirtyRef.current = true;
                    setAuthMethod(methodId);
                  },
                },
                h('input', {
                  type: 'radio',
                  name: 'antigravity-auth-method',
                  checked: selected,
                  readOnly: true,
                  tabIndex: -1,
                }),
                h('span', null, copy.authMethodLabels[methodId] || methodId),
              );
            }),
          ),

          authMethod === 'oauth-business'
            ? h(
                'div',
                { className: 'agp-fields-grid' },
                h(
                  'label',
                  { className: 'agp-field' },
                  h('span', { className: 'agp-label' }, copy.gcpProjectLabel),
                  h('input', {
                    type: 'text',
                    className: 'agp-input agp-mono',
                    'data-acp-input': 'gcpProject',
                    value: gcpProject,
                    placeholder: copy.gcpProjectPlaceholder,
                    onChange: (event) => {
                      authDirtyRef.current = true;
                      setGcpProject(event.target.value);
                    },
                  }),
                ),
                h(
                  'label',
                  { className: 'agp-field' },
                  h('span', { className: 'agp-label' }, copy.gcpLocationLabel),
                  h('input', {
                    type: 'text',
                    className: 'agp-input agp-mono',
                    'data-acp-input': 'gcpLocation',
                    value: gcpLocation,
                    placeholder: copy.gcpLocationPlaceholder,
                    onChange: (event) => {
                      authDirtyRef.current = true;
                      setGcpLocation(event.target.value);
                    },
                  }),
                ),
              )
            : null,

          isApiKeyMethod
            ? h(
                'div',
                { className: 'agp-field' },
                h('span', { className: 'agp-label' }, copy.apiKeyLabel),
                h('input', {
                  type: 'password',
                  autoComplete: 'new-password',
                  className: 'agp-input agp-mono',
                  'data-acp-input': 'apiKey',
                  value: apiKey,
                  placeholder: hasApiKey
                    ? copy.apiKeyConfiguredPlaceholder
                    : copy.apiKeyEmptyPlaceholder,
                  onChange: (event) => {
                    setApiKey(event.target.value);
                  },
                }),
              )
            : null,

          isOAuthMethod
            ? h(
                'div',
                { className: 'agp-row' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'agp-btn agp-btn-primary',
                    'data-acp-action': 'auth-start-code',
                    disabled: isBusy,
                    onClick: () => {
                      handleOAuthStart('code');
                    },
                  },
                  copy.codeLoginBtn,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'agp-btn',
                    'data-acp-action': 'auth-start-loopback',
                    disabled: isBusy,
                    onClick: () => {
                      handleOAuthStart('loopback');
                    },
                  },
                  copy.loopbackLoginBtn,
                ),
                authMethod === 'oauth-business'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'agp-btn',
                        'data-acp-action': 'save-gcp',
                        disabled: isBusy,
                        onClick: () => {
                          handleSaveGcpConfig();
                        },
                      },
                      copy.saveGcpBtn,
                    )
                  : null,
                profile && profile.authenticated
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'agp-btn agp-btn-danger',
                        'data-acp-action': 'logout',
                        disabled: isBusy,
                        onClick: () => {
                          invokeAction('logout', 'logout', undefined, {
                            notice: copy.loggedOutNotice,
                            onSuccess: () => {
                              authDirtyRef.current = false;
                              setApiKey('');
                              setAuthCode('');
                            },
                          });
                        },
                      },
                      copy.logoutBtn,
                    )
                  : null,
              )
            : h(
                'div',
                { className: 'agp-row' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'agp-btn agp-btn-primary',
                    'data-acp-action': 'auth-save-api-key',
                    disabled: isBusy,
                    onClick: () => {
                      handleSaveVerifyApiKey();
                    },
                  },
                  copy.saveVerifyKeyBtn,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'agp-btn agp-btn-danger',
                    'data-acp-action': 'clear-api-key',
                    disabled: isBusy || (!hasApiKey && !apiKey),
                    onClick: () => {
                      handleClearApiKey();
                    },
                  },
                  copy.clearKeyBtn,
                ),
                profile && profile.authenticated
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'agp-btn agp-btn-danger',
                        'data-acp-action': 'logout',
                        disabled: isBusy,
                        onClick: () => {
                          invokeAction('logout', 'logout', undefined, {
                            notice: copy.loggedOutNotice,
                            onSuccess: () => {
                              authDirtyRef.current = false;
                              setApiKey('');
                            },
                          });
                        },
                      },
                      copy.logoutBtn,
                    )
                  : null,
              ),

          // Active OAuth flow / error box
          isAuthActive ||
          (authState && (authState.phase === 'failed' || authState.phase === 'cancelled'))
            ? h(
                'div',
                {
                  className: 'agp-oauth-box',
                  'data-acp-auth-phase': authState ? authState.phase : 'idle',
                },
                authState && authState.message
                  ? h('p', { className: 'agp-muted', style: { margin: 0 } }, authState.message)
                  : null,
                authState && authState.phase === 'failed' && authState.error
                  ? h(
                      'div',
                      { className: 'agp-banner agp-banner-error', role: 'alert' },
                      sanitizeDisplayError(authState.error),
                    )
                  : null,
                authState && authState.authUrl
                  ? h(
                      'div',
                      { className: 'agp-field' },
                      h(
                        'div',
                        {
                          className: 'agp-url-box agp-mono',
                          'data-acp-auth-url': authState.authUrl,
                        },
                        authState.authUrl,
                      ),
                      h(
                        'div',
                        { className: 'agp-row' },
                        h(
                          'a',
                          {
                            href: authState.authUrl,
                            target: '_blank',
                            rel: 'noopener noreferrer',
                            className: 'agp-btn agp-btn-primary',
                            'data-acp-action': 'open-auth-url',
                          },
                          copy.openAuthPageBtn,
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'agp-btn',
                            'data-acp-action': 'copy-auth-url',
                            onClick: () => {
                              handleCopyAuthUrl(authState.authUrl);
                            },
                          },
                          copiedAuthUrl ? copy.copiedAuthUrlBtn : copy.copyAuthUrlBtn,
                        ),
                      ),
                    )
                  : null,
                authPhase === 'awaiting_code'
                  ? h(
                      'div',
                      { className: 'agp-field' },
                      h('span', { className: 'agp-label' }, copy.authCodeLabel),
                      h(
                        'div',
                        { className: 'agp-row' },
                        h('input', {
                          type: 'text',
                          className: 'agp-input agp-mono',
                          style: { flex: '1 1 260px' },
                          'data-acp-input': 'authCode',
                          value: authCode,
                          placeholder: copy.authCodePlaceholder,
                          onChange: (event) => {
                            setAuthCode(event.target.value);
                          },
                        }),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'agp-btn agp-btn-primary',
                            'data-acp-action': 'auth-submit-code',
                            disabled: isBusy,
                            onClick: () => {
                              handleAuthSubmitCode();
                            },
                          },
                          copy.submitCodeBtn,
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'agp-btn agp-btn-danger',
                            'data-acp-action': 'auth-cancel',
                            disabled: isBusy,
                            onClick: () => {
                              invokeAction('authCancel', 'authCancel');
                            },
                          },
                          copy.cancelAuthBtn,
                        ),
                      ),
                    )
                  : authPhase === 'awaiting_browser' ||
                      authPhase === 'starting' ||
                      authPhase === 'exchanging'
                    ? h(
                        'div',
                        { className: 'agp-row' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'agp-btn agp-btn-danger',
                            'data-acp-action': 'auth-cancel',
                            disabled: isBusy,
                            onClick: () => {
                              invokeAction('authCancel', 'authCancel');
                            },
                          },
                          copy.cancelSignInBtn,
                        ),
                      )
                    : null,
              )
            : null,
        ),

        // Card 3: Models & Quota
        h(
          'section',
          { className: 'agp-card', 'data-acp-card': 'models-quota' },
          h(
            'div',
            { className: 'agp-card-head' },
            h('h3', { className: 'agp-card-title' }, copy.modelsQuotaTitle),
            h(
              'div',
              { className: 'agp-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'agp-btn',
                  'data-acp-action': 'refresh-models',
                  disabled: isBusy,
                  onClick: () => {
                    invokeAction('refreshModels', 'refreshModels');
                  },
                },
                copy.refreshModelsBtn,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'agp-btn',
                  'data-acp-action': 'refresh-quota',
                  disabled: isBusy,
                  onClick: () => {
                    invokeAction('refreshQuota', 'refreshQuota');
                  },
                },
                copy.refreshQuotaBtn,
              ),
            ),
          ),

          // Models
          h('span', { className: 'agp-label' }, copy.modelsHeading),
          status && status.modelsError
            ? h(
                'div',
                { className: 'agp-banner agp-banner-error', role: 'alert' },
                sanitizeDisplayError(status.modelsError),
              )
            : null,
          models.length > 0
            ? h(
                'div',
                { className: 'agp-list', 'data-acp-list': 'models' },
                ...models.map((model) =>
                  h(
                    'div',
                    {
                      key: model.id,
                      className: 'agp-list-item',
                      'data-acp-model': model.id,
                    },
                    h(
                      'div',
                      { className: 'agp-row', style: { justifyContent: 'space-between' } },
                      h(
                        'div',
                        { className: 'agp-row' },
                        h('strong', null, model.name || model.id),
                        h('span', { className: 'agp-muted agp-mono' }, model.id),
                      ),
                      model.isDefault
                        ? h('span', { className: 'agp-badge agp-badge-ok' }, copy.defaultModelBadge)
                        : null,
                    ),
                    model.description
                      ? h('p', { className: 'agp-muted' }, model.description)
                      : null,
                    Array.isArray(model.thinkingOptions) && model.thinkingOptions.length > 0
                      ? h(
                          'div',
                          { className: 'agp-row' },
                          ...model.thinkingOptions.map((opt) =>
                            h(
                              'span',
                              {
                                key: opt.id,
                                className: 'agp-chip',
                                'data-default':
                                  model.defaultThoughtLevel === opt.id ? 'true' : 'false',
                              },
                              opt.name || opt.id,
                            ),
                          ),
                        )
                      : null,
                  ),
                ),
              )
            : h('p', { className: 'agp-muted' }, copy.noModelsHint),

          // Quota
          h(
            'div',
            { className: 'agp-row', style: { justifyContent: 'space-between', marginTop: '4px' } },
            h('span', { className: 'agp-label' }, copy.quotaHeading),
            quota && quota.exhausted
              ? h('span', { className: 'agp-badge agp-badge-err' }, copy.quotaExhaustedBadge)
              : null,
          ),
          status && status.quotaError
            ? h(
                'div',
                { className: 'agp-banner agp-banner-error', role: 'alert' },
                sanitizeDisplayError(status.quotaError),
              )
            : null,
          quota && Array.isArray(quota.windows) && quota.windows.length > 0
            ? h(
                'div',
                { className: 'agp-list', 'data-acp-list': 'quota' },
                quota.account || quota.tier
                  ? h(
                      'p',
                      { className: 'agp-muted' },
                      [quota.account, quota.tier].filter(Boolean).join(' · '),
                    )
                  : null,
                ...quota.windows.map((win) => {
                  const pct = computeRemainingPercent(win);
                  const resetCountdown = formatRemainingSeconds(win.resetInSeconds);
                  const barColor =
                    pct === null
                      ? 'var(--dsw-alias-state-business-primary, #4176e6)'
                      : pct <= 10
                        ? 'var(--dsw-alias-state-error-primary, #dc2626)'
                        : pct <= 35
                          ? 'var(--dsw-alias-state-warn-primary, #f59e0b)'
                          : 'var(--dsw-alias-state-success-primary, #22c55e)';
                  return h(
                    'div',
                    {
                      key: win.id,
                      className: 'agp-list-item',
                      'data-acp-quota-window': win.id,
                    },
                    h(
                      'div',
                      { className: 'agp-row', style: { justifyContent: 'space-between' } },
                      h('strong', null, win.label || win.id),
                      h(
                        'span',
                        { className: 'agp-muted agp-mono' },
                        pct !== null
                          ? `${copy.remainingLabel} ${pct}%`
                          : typeof win.remaining === 'number' && typeof win.limit === 'number'
                            ? `${win.remaining}/${win.limit}${win.unit ? ' ' + win.unit : ''}`
                            : '',
                      ),
                    ),
                    pct !== null
                      ? h(
                          'div',
                          {
                            className: 'agp-progress-track',
                            role: 'progressbar',
                            'aria-valuenow': pct,
                            'aria-valuemin': 0,
                            'aria-valuemax': 100,
                          },
                          h('div', {
                            className: 'agp-progress-bar',
                            style: { width: `${pct}%`, background: barColor },
                          }),
                        )
                      : null,
                    win.resetAt || resetCountdown
                      ? h(
                          'p',
                          { className: 'agp-muted' },
                          [
                            win.resetAt ? `${copy.resetAtLabel}: ${win.resetAt}` : '',
                            resetCountdown ? `${copy.resetInLabel}: ${resetCountdown}` : '',
                          ]
                            .filter(Boolean)
                            .join(' · '),
                        )
                      : null,
                  );
                }),
              )
            : h('p', { className: 'agp-muted' }, copy.noQuotaHint),
        ),
      );
    }

    ensureStylesInjected();

    const inject = ['slots', 'remote'];

    function apply(ctx) {
      let disposed = false;
      let mountDisposer = null;
      let mountError = null;
      let mountResult;

      try {
        mountResult = ctx.remote.$mount({
          package: PACKAGE_NAME,
          descriptors: ANTIGRAVITY_CONTROL_DESCRIPTORS,
        });
      } catch (err) {
        mountError = err instanceof Error ? err : new Error(String(err));
      }

      if (typeof mountResult === 'function') {
        mountDisposer = mountResult;
      }

      const mountPromise = mountError
        ? Promise.resolve()
        : Promise.resolve(mountResult).then(
            (maybeDisposer) => {
              if (typeof maybeDisposer === 'function') {
                if (disposed) {
                  return Promise.resolve(maybeDisposer()).catch(() => {});
                }
                mountDisposer = maybeDisposer;
              }
              return undefined;
            },
            (err) => {
              mountError = err instanceof Error ? err : new Error(String(err));
            },
          );

      async function callControl(method, input) {
        await mountPromise;
        if (disposed) {
          throw new Error('Antigravity ACP client is disposed');
        }
        if (mountError) {
          throw mountError;
        }
        const service =
          (typeof ctx.get === 'function' ? ctx.get(`remote.${SERVICE_NAME}`) : undefined) ??
          (ctx.remote ? ctx.remote[SERVICE_NAME] : undefined);

        if (!service || typeof service[method] !== 'function') {
          throw new Error(`Remote service "${SERVICE_NAME}.${method}" is unavailable`);
        }

        let result;
        if (ZERO_ARG_SET.has(method)) {
          result = await service[method]();
        } else if (ONE_ARG_SET.has(method)) {
          result = await service[method](cleanInputObject(input));
        } else {
          throw new Error(`Unknown control RPC method: ${String(method)}`);
        }
        return unwrapRemoteResult(result);
      }

      const disposeSectionSlot = ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: 42,
            label: () => 'Antigravity ACP',
            inject: () => ({ callControl }),
          },
          AntigravitySettingsSection,
        ),
      );

      const disposeIconSlot = ctx.slots.inject('settings.section.icon', () =>
        ctx.slots.register(
          {
            name: 'settings.section.icon',
            id: SECTION_ID,
          },
          AntigravitySectionIcon,
        ),
      );

      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            disposed = true;
            if (typeof disposeSectionSlot === 'function') {
              try {
                disposeSectionSlot();
              } catch {}
            }
            if (typeof disposeIconSlot === 'function') {
              try {
                disposeIconSlot();
              } catch {}
            }
            if (typeof mountDisposer === 'function') {
              Promise.resolve(mountDisposer()).catch(() => {});
            }
          },
          'antigravity-acp: client unmount',
        );
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    exports.ANTIGRAVITY_CONTROL_DESCRIPTORS = ANTIGRAVITY_CONTROL_DESCRIPTORS;
    exports.AntigravitySettingsSection = AntigravitySettingsSection;
    exports.AntigravitySectionIcon = AntigravitySectionIcon;

    return module.exports;
  },
});
