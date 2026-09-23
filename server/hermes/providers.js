// Model providers, keys and sign-ins for a Hermes install, as gateway methods.
//
// Everything here is Hermes' own catalog and machinery, reached through its
// dashboard: which providers exist, which are signed in, which env keys they
// read, device-code sign-in (Nous Portal and others), key validation. Office3D
// adds only what an office with many agents needs on top:
//   - a key is written to every agent's profile, not just the main one, so a
//     new provider key reaches the whole team at once (new hires copy the
//     main profile's .env when they are created);
//   - only provider, tool and skill keys can be written from the office. The
//     API server key, messaging tokens and settings stay out of reach: an
//     office session must not be able to rewrite the credentials Office3D
//     itself uses to reach Hermes.

const WRITABLE_KEY_CATEGORIES = new Set(["provider", "tool", "skill"]);
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{1,127}$/;
const MAX_KEY_VALUE_LENGTH = 8_192;
const DEFAULT_PROFILE = "default";

const str = (value) => (typeof value === "string" ? value.trim() : "");
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * @param {object} deps
 * @param {any} deps.client                 Hermes client
 * @param {() => Promise<Array<{name: string}>>} deps.listProfiles
 * @param {(agentId: string) => string} deps.profileOf
 * @param {() => boolean} deps.hasDashboard
 * @param {new (code: string, message: string) => Error} deps.AdapterError
 * @param {(message: string) => void} [deps.log]
 */
const createProviderHandlers = ({ client, listProfiles, profileOf, hasDashboard, AdapterError, log = () => {} }) => {
  const requireDashboard = () => {
    if (!hasDashboard()) {
      throw new AdapterError("UNAVAILABLE", "Управление моделями доступно при подключённой панели Hermes.");
    }
  };

  const envCatalog = async () => {
    const env = await client.dashboard("/api/env");
    return isRecord(env) ? env : {};
  };

  const assertWritableKey = async (key) => {
    if (!ENV_KEY_RE.test(key)) throw new AdapterError("INVALID_REQUEST", `Недопустимое имя ключа: ${key || "(пусто)"}.`);
    const row = (await envCatalog())[key];
    if (!row || !WRITABLE_KEY_CATEGORIES.has(String(row.category))) {
      throw new AdapterError("FORBIDDEN", `Ключ ${key} нельзя менять из офиса.`);
    }
    return row;
  };

  /** Runs `write` for the main profile and every agent profile, reporting each. */
  const forEveryProfile = async (write) => {
    const profiles = await listProfiles();
    const names = [DEFAULT_PROFILE, ...profiles.map((p) => p.name).filter((name) => name !== DEFAULT_PROFILE)];
    const results = await Promise.allSettled(names.map((name) => write(name)));
    const failed = results
      .map((result, index) => (result.status === "rejected" ? { profile: names[index], error: result.reason?.message ?? String(result.reason) } : null))
      .filter(Boolean);
    return { applied: names.filter((_, index) => results[index].status === "fulfilled"), failed };
  };

  return {
    async "hermes.providers.status"() {
      requireDashboard();
      const [options, oauth, env, current] = await Promise.all([
        client.modelOptions(DEFAULT_PROFILE),
        client.dashboard("/api/providers/oauth").catch(() => ({ providers: [] })),
        envCatalog(),
        client.dashboard("/api/model/info").catch(() => null),
      ]);
      const providers = (Array.isArray(options?.providers) ? options.providers : []).filter(isRecord).map((p) => ({
        slug: str(p.slug),
        name: str(p.name) || str(p.slug),
        authenticated: Boolean(p.authenticated),
        authType: str(p.auth_type) || null,
        keyEnv: str(p.key_env) || null,
        warning: str(p.warning) || null,
        isCurrent: Boolean(p.is_current),
        models: Array.isArray(p.models) ? p.models.map(String) : [],
        featuredModels: Array.isArray(p.featured_models) ? p.featured_models.map(String) : [],
      }));
      const signIns = (Array.isArray(oauth?.providers) ? oauth.providers : []).filter(isRecord).map((p) => ({
        id: str(p.id),
        name: str(p.name),
        flow: str(p.flow),
        docsUrl: str(p.docs_url) || null,
        cliCommand: str(p.cli_command) || null,
        signedIn: Boolean(p.status?.logged_in),
        account: str(p.status?.source_label) || null,
        disconnectable: Boolean(p.disconnectable),
      }));
      const keys = Object.entries(env)
        .filter(([, row]) => isRecord(row) && WRITABLE_KEY_CATEGORIES.has(String(row.category)) && !row.channel_managed)
        .map(([key, row]) => ({
          key,
          category: String(row.category),
          provider: str(row.provider) || null,
          providerLabel: str(row.provider_label) || null,
          description: str(row.description) || null,
          url: str(row.url) || null,
          isSecret: Boolean(row.is_password),
          isSet: Boolean(row.is_set),
          // Hermes' own redaction (a few characters at most); never the value.
          preview: row.is_set ? str(row.redacted_value) || null : null,
          advanced: Boolean(row.advanced),
        }));
      return {
        current: isRecord(current) ? { provider: str(current.provider) || null, model: str(current.model) || null } : null,
        providers,
        signIns,
        keys,
      };
    },

    async "hermes.providers.setKey"(p) {
      requireDashboard();
      const key = str(p.key);
      const value = typeof p.value === "string" ? p.value.trim() : "";
      if (!value) throw new AdapterError("INVALID_REQUEST", "Пустое значение ключа.");
      if (value.length > MAX_KEY_VALUE_LENGTH) throw new AdapterError("INVALID_REQUEST", "Слишком длинное значение.");
      await assertWritableKey(key);
      let validation = { ok: true, reachable: false, message: "" };
      if (p.skipValidation !== true) {
        validation = await client.dashboard("/api/providers/validate", { method: "POST", body: { key, value } });
        if (validation && validation.ok === false && validation.reachable !== false) {
          return { ok: false, message: str(validation.message) || "Провайдер отклонил ключ.", applied: [], failed: [] };
        }
      }
      const outcome = await forEveryProfile((profile) => client.setProfileEnv(profile, key, value));
      log(`Key ${key} written to ${outcome.applied.length} profile(s).`);
      return {
        ok: outcome.failed.length === 0,
        verified: Boolean(validation?.ok && validation?.reachable),
        message: validation?.reachable === false ? "Не удалось проверить ключ у провайдера; он сохранён без проверки." : "",
        ...outcome,
      };
    },

    async "hermes.providers.deleteKey"(p) {
      requireDashboard();
      const key = str(p.key);
      await assertWritableKey(key);
      const outcome = await forEveryProfile((profile) =>
        client.dashboard("/api/env", { method: "DELETE", query: { profile }, body: { key, profile } })
      );
      return { ok: outcome.failed.length === 0, ...outcome };
    },

    // Device-code sign-in. The grant lands in the main profile; agent profiles
    // cloned from it read that grant through Hermes' credential-pool fallback.
    async "hermes.signin.start"(p) {
      requireDashboard();
      const provider = str(p.provider);
      if (!/^[a-z0-9-]{1,64}$/.test(provider)) throw new AdapterError("INVALID_REQUEST", "Неизвестный провайдер.");
      const started = await client.dashboard(`/api/providers/oauth/${encodeURIComponent(provider)}/start`, {
        method: "POST",
        body: {},
      });
      return {
        sessionId: str(started?.session_id),
        verificationUrl: str(started?.verification_url) || null,
        userCode: str(started?.user_code) || null,
        expiresIn: Number(started?.expires_in) || null,
        interval: Math.max(2, Number(started?.poll_interval) || 5),
      };
    },

    async "hermes.signin.poll"(p) {
      requireDashboard();
      const provider = str(p.provider);
      const sessionId = str(p.sessionId);
      if (!provider || !sessionId) throw new AdapterError("INVALID_REQUEST", "Нет сеанса входа.");
      const status = await client.dashboard(
        `/api/providers/oauth/${encodeURIComponent(provider)}/poll/${encodeURIComponent(sessionId)}`
      );
      return {
        status: str(status?.status) || "pending",
        error: str(status?.error_message) || null,
        account: str(status?.account_email) || null,
        model: str(status?.model) || null,
      };
    },

    async "hermes.signin.cancel"(p) {
      requireDashboard();
      const sessionId = str(p.sessionId);
      if (!sessionId) return { ok: true };
      await client.dashboard(`/api/providers/oauth/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      return { ok: true };
    },

    async "hermes.signin.disconnect"(p) {
      requireDashboard();
      const provider = str(p.provider);
      if (!/^[a-z0-9-]{1,64}$/.test(provider)) throw new AdapterError("INVALID_REQUEST", "Неизвестный провайдер.");
      const result = await client.dashboard(`/api/providers/oauth/${encodeURIComponent(provider)}`, { method: "DELETE" });
      return { ok: Boolean(result?.ok) };
    },

    /** The model one agent's profile runs on. */
    async "hermes.agents.model"(p) {
      const profile = profileOf(str(p.agentId) || "main");
      const row = (await listProfiles()).find((entry) => entry.name === profile);
      if (!row) throw new AdapterError("NOT_FOUND", "Агент не найден.");
      return { provider: str(row.provider) || null, model: str(row.model) || null };
    },

    /** Sets the model of one agent, or of the main agent (the default new hires copy). */
    async "hermes.agents.setModel"(p) {
      requireDashboard();
      const provider = str(p.provider);
      const model = str(p.model);
      if (!provider || !model) throw new AdapterError("INVALID_REQUEST", "Нужны провайдер и модель.");
      const profile = profileOf(str(p.agentId) || "main");
      await client.setModel(profile, provider, model);
      return { ok: true, agentId: str(p.agentId) || "main", provider, model };
    },
  };
};

module.exports = { createProviderHandlers, WRITABLE_KEY_CATEGORIES };
