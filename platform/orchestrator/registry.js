// Capability Registry (§25) — reference prompt/config/id per unit+role, for cloning.
//
// Это каталог «как поднять клон»: для каждого (управление, роль) — ссылка на
// системный промпт (governance единым источником уже есть в core/governance.js),
// конфиг и идентификатор эталонного образа. Карцер (§19) обращается сюда, когда
// нужен свежий клон вместо «виновного».
//
// Стадия — заглушка: только чтение и валидация, in-memory + JSON. Запись в реестр
// (publish новой эталонной капсулы) — отдельная забота и требует отдельной
// авторизации; здесь мы НЕ пишем на диск. Если файла нет — работаем с безопасным
// встроенным сидом (по одному базовому «chief»-профилю на каждое управление).

const fs = require("node:fs");

const { invalid } = require("../core/errors");
const { DIRECTORATES, toUnit } = require("./directorates");

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const keyOf = (unit, role) => `${unit}:${String(role).trim().toLowerCase()}`;

/** Validate one registry entry (read/validate only — no persistence). */
const validateEntry = (entry) => {
  if (!isRecord(entry)) throw invalid("Запись реестра должна быть объектом.");
  const unit = toUnit(entry.unit);
  if (unit === null) throw invalid(`Запись реестра ссылается на неизвестное управление: ${entry.unit}.`);
  const role = String(entry.role ?? "").trim().toLowerCase();
  if (!role) throw invalid("У записи реестра должна быть роль (role).");
  const id = String(entry.id ?? "").trim();
  if (!id) throw invalid("У записи реестра должен быть идентификатор образа (id).");
  return {
    id,
    unit,
    role,
    // promptRef points at the governance single source by default; config is a
    // reference blob (model, tools allowlist, etc.) — opaque to the registry.
    promptRef: String(entry.promptRef ?? "core/governance.js#composeSystemPrompt").slice(0, 300),
    config: isRecord(entry.config) ? entry.config : {},
    note: String(entry.note ?? "").slice(0, 500),
  };
};

/** Built-in safe seed: one baseline chief capsule per directorate. */
const defaultSeed = () =>
  Object.keys(DIRECTORATES)
    .map(Number)
    .map((unit) => ({
      id: `cap_${DIRECTORATES[unit].slug}_chief`,
      unit,
      role: "chief",
      promptRef: "core/governance.js#composeSystemPrompt",
      config: { model: "local/ollama", toolset: "legal-defensive-baseline" },
      note: `Эталонный профиль шефа управления: ${DIRECTORATES[unit].name}`,
    }));

/**
 * @param {object} deps
 * @param {string} [deps.filePath]  JSON catalog; if present and readable it REPLACES the seed
 * @param {object[]} [deps.seed]    explicit seed (tests); defaults to one chief per directorate
 * @param {(message: string, err?: unknown) => void} [deps.logError]
 */
const createRegistry = ({ filePath, seed, logError = () => {} } = {}) => {
  const entries = new Map();

  const load = (list) => {
    for (const raw of Array.isArray(list) ? list : []) {
      try {
        const entry = validateEntry(raw);
        entries.set(keyOf(entry.unit, entry.role), entry);
      } catch (err) {
        logError("Capability Registry: пропущена некорректная запись", err);
      }
    }
  };

  let source = "seed";
  if (filePath && fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      load(Array.isArray(parsed) ? parsed : parsed?.entries);
      source = "file";
    } catch (err) {
      logError("Capability Registry: файл нечитаем, используем встроенный сид", err);
    }
  }
  if (!entries.size) load(seed ?? defaultSeed());

  return {
    source,
    /** Reference capsule for a (unit, role), or null. */
    get(unit, role) {
      const u = toUnit(unit);
      if (u === null) return null;
      const entry = entries.get(keyOf(u, role));
      return entry ? { ...entry, config: { ...entry.config } } : null;
    },
    list() {
      return [...entries.values()].map((e) => ({ ...e, config: { ...e.config } }));
    },
    has: (unit, role) => entries.has(keyOf(toUnit(unit), role)),
    validate: validateEntry,
    get size() {
      return entries.size;
    },
  };
};

module.exports = { createRegistry, validateEntry };
