/**
 * GitHub Dev Assistant — Configuration Panel
 *
 * Rendered in the Teleton Web UI plugin settings page.
 * Uses Teleton WebUI design system and Tailwind CSS.
 *
 * Features:
 *  - Current GitHub authorization status display
 *  - "Connect GitHub Account" OAuth flow (popup window)
 *  - Settings form for all plugin config parameters
 *  - "Revoke Access" button to disconnect
 *  - Usage examples for agent commands
 *  - i18n support (en/ru) via sdk.i18n
 *  - Loading states and error handling
 */

import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// i18n strings
// ---------------------------------------------------------------------------

const STRINGS = {
  en: {
    title: "GitHub Dev Assistant",
    subtitle: "Automate your GitHub development workflow from the Telegram agent",
    auth_status: "Authorization Status",
    connected_as: "Connected as",
    not_connected: "Not connected",
    connect_btn: "Connect GitHub Account",
    revoke_btn: "Revoke Access",
    connecting: "Connecting...",
    revoking: "Revoking...",
    settings: "Plugin Settings",
    save_btn: "Save Settings",
    saving: "Saving...",
    saved: "Settings saved",
    default_owner: "Default Owner",
    default_owner_hint: "Default GitHub username or org for operations (optional)",
    default_branch: "Default Branch",
    default_branch_hint: "Default branch name for commits and PRs",
    auto_sign: "Auto-sign Commits",
    auto_sign_hint: "Automatically attribute commits to the agent",
    require_review: "Require PR Review",
    require_review_hint: "Ask for confirmation before merging pull requests",
    commit_name: "Commit Author Name",
    commit_name_hint: "Name shown in git commit history",
    commit_email: "Commit Author Email",
    commit_email_hint: "Email shown in git commit history",
    usage_examples: "Usage Examples",
    example_check: "Check authorization",
    example_list_repos: "List my repositories",
    example_create_issue: "Create an issue",
    example_create_pr: "Create a pull request",
    example_merge_pr: "Merge a pull request",
    error_popup_blocked: "Popup was blocked. Please allow popups for this site.",
    error_save: "Failed to save settings",
    error_revoke: "Failed to revoke access",
    error_connect: "Connection failed",
  },
  ru: {
    title: "GitHub Dev Assistant",
    subtitle: "Автоматизируйте разработку на GitHub из чата с Telegram-агентом",
    auth_status: "Статус авторизации",
    connected_as: "Подключён как",
    not_connected: "Не подключён",
    connect_btn: "Подключить аккаунт GitHub",
    revoke_btn: "Отозвать доступ",
    connecting: "Подключение...",
    revoking: "Отзыв...",
    settings: "Настройки плагина",
    save_btn: "Сохранить настройки",
    saving: "Сохранение...",
    saved: "Настройки сохранены",
    default_owner: "Владелец по умолчанию",
    default_owner_hint: "Имя пользователя или организации GitHub по умолчанию",
    default_branch: "Ветка по умолчанию",
    default_branch_hint: "Ветка по умолчанию для коммитов и PR",
    auto_sign: "Авто-подпись коммитов",
    auto_sign_hint: "Автоматически указывать агента как автора коммитов",
    require_review: "Подтверждение слияния PR",
    require_review_hint: "Запрашивать подтверждение перед слиянием pull request",
    commit_name: "Имя автора коммита",
    commit_name_hint: "Имя в истории git-коммитов",
    commit_email: "Email автора коммита",
    commit_email_hint: "Email в истории git-коммитов",
    usage_examples: "Примеры команд",
    example_check: "Проверить авторизацию",
    example_list_repos: "Список репозиториев",
    example_create_issue: "Создать issue",
    example_create_pr: "Создать pull request",
    example_merge_pr: "Слить pull request",
    error_popup_blocked: "Всплывающее окно заблокировано. Разрешите попапы для этого сайта.",
    error_save: "Не удалось сохранить настройки",
    error_revoke: "Не удалось отозвать доступ",
    error_connect: "Ошибка подключения",
  },
};

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

function StatusBadge({ connected, login }) {
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        {login}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
      <span className="h-1.5 w-1.5 rounded-full bg-gray-400" />
      Not connected
    </span>
  );
}

function ExampleCommand({ label, command }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
      <code className="block px-3 py-2 rounded-md bg-gray-100 dark:bg-gray-800 text-sm font-mono text-gray-800 dark:text-gray-200 select-all">
        {command}
      </code>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ConfigPanel component
// ---------------------------------------------------------------------------

export default function ConfigPanel({ sdk }) {
  const locale = sdk?.i18n?.locale ?? "en";
  const t = STRINGS[locale] ?? STRINGS.en;

  // Auth state
  const [authStatus, setAuthStatus] = useState({ loading: true, connected: false, login: null });
  const [connectLoading, setConnectLoading] = useState(false);
  const [revokeLoading, setRevokeLoading] = useState(false);
  const [authError, setAuthError] = useState(null);

  // Config state
  const [config, setConfig] = useState({
    default_owner: "",
    default_branch: "main",
    auto_sign_commits: true,
    require_pr_review: false,
    commit_author_name: "Teleton AI Agent",
    commit_author_email: "agent@teleton.local",
  });
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState(null);

  // ---------------------------------------------------------------------------
  // Load initial state
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Load current auth status
    async function loadAuth() {
      try {
        const result = await sdk.plugin.call("github_check_auth", {});
        if (result.success && result.data.authenticated) {
          setAuthStatus({
            loading: false,
            connected: true,
            login: result.data.user_login,
          });
        } else {
          setAuthStatus({ loading: false, connected: false, login: null });
        }
      } catch {
        setAuthStatus({ loading: false, connected: false, login: null });
      }
    }

    // Load saved config
    async function loadConfig() {
      try {
        const saved = await sdk.pluginConfig.getAll();
        if (saved) {
          setConfig((prev) => ({ ...prev, ...saved }));
        }
      } catch {
        // Use defaults
      }
    }

    loadAuth();
    loadConfig();
  }, [sdk]);

  // ---------------------------------------------------------------------------
  // OAuth connect flow
  // ---------------------------------------------------------------------------

  const handleConnect = useCallback(async () => {
    setConnectLoading(true);
    setAuthError(null);

    try {
      // Step 1: Get auth URL from plugin
      const initResult = await sdk.plugin.call("github_auth", {
        scopes: ["repo", "workflow", "user"],
      });

      if (!initResult.success) {
        setAuthError(initResult.error ?? t.error_connect);
        setConnectLoading(false);
        return;
      }

      const { auth_url, state } = initResult.data;

      // Step 2: Open OAuth popup
      const popup = window.open(
        auth_url,
        "github-oauth",
        "width=600,height=700,toolbar=0,menubar=0,location=0"
      );

      if (!popup) {
        setAuthError(t.error_popup_blocked);
        setConnectLoading(false);
        return;
      }

      // Step 3: Wait for postMessage from oauth-callback.html
      const handleMessage = async (event) => {
        // Only accept messages from our callback page
        if (event.data?.type !== "github_oauth_callback") return;

        window.removeEventListener("message", handleMessage);
        popup.close();

        const { code, state: returnedState, error } = event.data;

        if (error) {
          setAuthError(`${t.error_connect}: ${error}`);
          setConnectLoading(false);
          return;
        }

        // Step 4: Exchange code for token
        try {
          const exchangeResult = await sdk.plugin.call("github_auth", {
            code,
            state: returnedState,
          });

          if (exchangeResult.success && exchangeResult.data.authenticated) {
            setAuthStatus({
              loading: false,
              connected: true,
              login: exchangeResult.data.user_login,
            });
            setAuthError(null);
          } else {
            setAuthError(exchangeResult.error ?? t.error_connect);
          }
        } catch (err) {
          setAuthError(String(err?.message ?? t.error_connect));
        } finally {
          setConnectLoading(false);
        }
      };

      window.addEventListener("message", handleMessage);

      // Clean up if popup is closed without completing the flow
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          window.removeEventListener("message", handleMessage);
          setConnectLoading(false);
        }
      }, 500);
    } catch (err) {
      setAuthError(String(err?.message ?? t.error_connect));
      setConnectLoading(false);
    }
  }, [sdk, t]);

  // ---------------------------------------------------------------------------
  // Revoke access
  // ---------------------------------------------------------------------------

  const handleRevoke = useCallback(async () => {
    if (!window.confirm("Are you sure you want to revoke GitHub access?")) return;
    setRevokeLoading(true);
    setAuthError(null);

    try {
      // Call auth revoke via plugin — we use github_check_auth to trigger cleanup
      // The actual revoke is in auth.js revokeToken(), called from index.js if we add a tool,
      // but for now we remove the token via the SDK directly in the web UI context
      await sdk.secrets.delete("github_access_token");
      setAuthStatus({ loading: false, connected: false, login: null });
    } catch (err) {
      setAuthError(String(err?.message ?? t.error_revoke));
    } finally {
      setRevokeLoading(false);
    }
  }, [sdk, t]);

  // ---------------------------------------------------------------------------
  // Save config
  // ---------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    setSaveLoading(true);
    setSaveMessage(null);

    try {
      await sdk.pluginConfig.set(config);
      setSaveMessage(t.saved);
      setTimeout(() => setSaveMessage(null), 3000);
    } catch (err) {
      setSaveMessage(`${t.error_save}: ${String(err?.message ?? "")}`);
    } finally {
      setSaveLoading(false);
    }
  }, [sdk, config, t]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{t.title}</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t.subtitle}</p>
      </div>

      {/* Authorization Status */}
      <section className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.auth_status}</h3>

        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            {authStatus.loading ? (
              <span className="text-sm text-gray-400">Loading...</span>
            ) : (
              <>
                <StatusBadge connected={authStatus.connected} login={authStatus.login} />
                {authStatus.connected && (
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {t.connected_as} <strong>{authStatus.login}</strong>
                  </span>
                )}
              </>
            )}
          </div>

          <div className="flex gap-2">
            {!authStatus.connected && (
              <button
                onClick={handleConnect}
                disabled={connectLoading || authStatus.loading}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100 transition-colors"
              >
                {connectLoading ? (
                  <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                )}
                {connectLoading ? t.connecting : t.connect_btn}
              </button>
            )}
            {authStatus.connected && (
              <button
                onClick={handleRevoke}
                disabled={revokeLoading}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors"
              >
                {revokeLoading ? t.revoking : t.revoke_btn}
              </button>
            )}
          </div>
        </div>

        {authError && (
          <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
            {authError}
          </p>
        )}
      </section>

      {/* Settings Form */}
      <section className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.settings}</h3>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Default Owner */}
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
              {t.default_owner}
            </label>
            <input
              type="text"
              value={config.default_owner ?? ""}
              onChange={(e) => setConfig((c) => ({ ...c, default_owner: e.target.value }))}
              placeholder="e.g. octocat"
              className="block w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-400">{t.default_owner_hint}</p>
          </div>

          {/* Default Branch */}
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
              {t.default_branch}
            </label>
            <input
              type="text"
              value={config.default_branch ?? "main"}
              onChange={(e) => setConfig((c) => ({ ...c, default_branch: e.target.value }))}
              placeholder="main"
              className="block w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-400">{t.default_branch_hint}</p>
          </div>

          {/* Commit Author Name */}
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
              {t.commit_name}
            </label>
            <input
              type="text"
              value={config.commit_author_name ?? "Teleton AI Agent"}
              onChange={(e) => setConfig((c) => ({ ...c, commit_author_name: e.target.value }))}
              placeholder="Teleton AI Agent"
              className="block w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-400">{t.commit_name_hint}</p>
          </div>

          {/* Commit Author Email */}
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
              {t.commit_email}
            </label>
            <input
              type="email"
              value={config.commit_author_email ?? "agent@teleton.local"}
              onChange={(e) => setConfig((c) => ({ ...c, commit_author_email: e.target.value }))}
              placeholder="agent@teleton.local"
              className="block w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-400">{t.commit_email_hint}</p>
          </div>
        </div>

        {/* Toggle options */}
        <div className="space-y-3 pt-2">
          {/* Auto-sign commits */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={config.auto_sign_commits ?? true}
              onChange={(e) => setConfig((c) => ({ ...c, auto_sign_commits: e.target.checked }))}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <div>
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t.auto_sign}
              </span>
              <p className="text-xs text-gray-400 mt-0.5">{t.auto_sign_hint}</p>
            </div>
          </label>

          {/* Require PR review */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={config.require_pr_review ?? false}
              onChange={(e) => setConfig((c) => ({ ...c, require_pr_review: e.target.checked }))}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <div>
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t.require_review}
              </span>
              <p className="text-xs text-gray-400 mt-0.5">{t.require_review_hint}</p>
            </div>
          </label>
        </div>

        {/* Save button */}
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={saveLoading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saveLoading && (
              <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
            )}
            {saveLoading ? t.saving : t.save_btn}
          </button>
          {saveMessage && (
            <span className={`text-sm ${saveMessage.startsWith(t.error_save) ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>
              {saveMessage}
            </span>
          )}
        </div>
      </section>

      {/* Usage Examples */}
      <section className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.usage_examples}</h3>
        <div className="space-y-3">
          <ExampleCommand label={t.example_check} command="Check my GitHub auth status" />
          <ExampleCommand label={t.example_list_repos} command="List my GitHub repos" />
          <ExampleCommand
            label={t.example_create_issue}
            command="Create a GitHub issue in owner/repo: title 'Bug: login fails', body 'Steps to reproduce...'"
          />
          <ExampleCommand
            label={t.example_create_pr}
            command="Create a PR in owner/repo from branch 'feat/my-feature' to 'main' with title 'Add feature'"
          />
          <ExampleCommand
            label={t.example_merge_pr}
            command="Merge PR #42 in owner/repo using squash strategy"
          />
        </div>
      </section>
    </div>
  );
}
