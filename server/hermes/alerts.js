// Where the office's alerts go. Every channel is optional and set in .env:
//
//   ALERT_NTFY_URL        a push to the phone through ntfy: the topic URL, for
//                         example https://ntfy.sh/<a long random topic name>
//                         (the topic name is the only secret on ntfy.sh), or a
//                         self-hosted ntfy server
//   ALERT_NTFY_TOKEN      its access token, when the topic is protected
//   ALERT_SMTP_URL        e-mail through SMTP, e.g.
//                         smtps://user%40gmail.com:<app password>@smtp.gmail.com:465
//   ALERT_EMAIL_TO        recipients, comma-separated
//   ALERT_EMAIL_FROM      sender (default: the SMTP user)
//   ALERT_HEARTBEAT_URL   a dead man's switch, e.g. a healthchecks.io ping URL:
//                         pinged every few minutes while all is well and
//                         `<url>/fail` while something is wrong. When the
//                         server itself is down the pings stop, and that
//                         service raises the alarm the office no longer can.
//
// Sending never throws: a failed channel is logged and reported to the caller.

const nodemailer = require("nodemailer");

const SEND_TIMEOUT_MS = 15_000;

const str = (value) => (typeof value === "string" ? value.trim() : "");

/** Channel settings from the environment, with what is wrong in them. */
const resolveAlertConfig = (env) => {
  const problems = [];
  const url = (name) => {
    const value = str(env[name]);
    if (!value) return "";
    try {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
      return value.replace(/\/+$/, "");
    } catch {
      problems.push(`${name} must be an http(s) URL.`);
      return "";
    }
  };
  const ntfyUrl = url("ALERT_NTFY_URL");
  const heartbeatUrl = url("ALERT_HEARTBEAT_URL");
  const smtpUrl = str(env.ALERT_SMTP_URL);
  const emailTo = str(env.ALERT_EMAIL_TO)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (smtpUrl && !/^smtps?:\/\//.test(smtpUrl)) problems.push("ALERT_SMTP_URL must start with smtp:// or smtps://.");
  if (smtpUrl && emailTo.length === 0) problems.push("ALERT_EMAIL_TO is needed with ALERT_SMTP_URL.");
  let emailFrom = str(env.ALERT_EMAIL_FROM);
  if (!emailFrom && smtpUrl) {
    try {
      emailFrom = decodeURIComponent(new URL(smtpUrl).username);
    } catch {
      // Reported above.
    }
  }
  return {
    ntfy: ntfyUrl ? { url: ntfyUrl, token: str(env.ALERT_NTFY_TOKEN) } : null,
    email: smtpUrl && emailTo.length && /^smtps?:\/\//.test(smtpUrl) ? { smtpUrl, to: emailTo, from: emailFrom || emailTo[0] } : null,
    heartbeatUrl,
    problems,
  };
};

/**
 * @param {object} deps
 * @param {ReturnType<typeof resolveAlertConfig>} deps.config
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(options: object) => {sendMail: (message: object) => Promise<unknown>}} [deps.createTransport]
 * @param {(message: string) => void} [deps.log]
 */
const createAlerter = ({ config, fetchImpl = fetch, createTransport = nodemailer.createTransport, log = () => {} }) => {
  let transport = null;
  const mailer = () => {
    if (!transport) {
      transport = createTransport({
        url: config.email.smtpUrl,
        connectionTimeout: SEND_TIMEOUT_MS,
        greetingTimeout: SEND_TIMEOUT_MS,
        socketTimeout: SEND_TIMEOUT_MS,
      });
    }
    return transport;
  };

  const channels = () => [...(config.ntfy ? ["ntfy"] : []), ...(config.email ? ["email"] : [])];

  /**
   * Sends one alert on every channel. `level` is "problem", "recovered" or
   * "info". Resolves to the channels that failed, with why.
   */
  const send = async ({ title, body, level = "problem" }) => {
    const failed = [];
    const tasks = [];
    if (config.ntfy) {
      tasks.push(
        (async () => {
          const response = await fetchImpl(config.ntfy.url, {
            method: "POST",
            headers: {
              // Header values must be ASCII; ntfy decodes RFC 2047 titles.
              Title: `=?UTF-8?B?${Buffer.from(title, "utf8").toString("base64")}?=`,
              Priority: level === "problem" ? "high" : "default",
              Tags: level === "problem" ? "warning" : level === "recovered" ? "white_check_mark" : "information_source",
              ...(config.ntfy.token ? { Authorization: `Bearer ${config.ntfy.token}` } : {}),
            },
            body,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
          if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
        })().catch((err) => failed.push({ channel: "ntfy", error: err.message })),
      );
    }
    if (config.email) {
      tasks.push(
        mailer()
          .sendMail({ from: config.email.from, to: config.email.to.join(", "), subject: `Office3D: ${title}`, text: body })
          .catch((err) => failed.push({ channel: "email", error: err.message })),
      );
    }
    await Promise.all(tasks);
    for (const failure of failed) log(`Alert via ${failure.channel} failed: ${failure.error}`);
    return { sent: channels().filter((channel) => !failed.some((failure) => failure.channel === channel)), failed };
  };

  /** One ping of the dead man's switch; `ok` false reports a problem. */
  const heartbeat = async (ok) => {
    if (!config.heartbeatUrl) return;
    try {
      const response = await fetchImpl(ok ? config.heartbeatUrl : `${config.heartbeatUrl}/fail`, {
        method: "POST",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`answered ${response.status}`);
    } catch (err) {
      log(`Heartbeat ping failed: ${err.message}`);
    }
  };

  return { send, heartbeat, channels, hasHeartbeat: Boolean(config.heartbeatUrl) };
};

module.exports = { createAlerter, resolveAlertConfig };
