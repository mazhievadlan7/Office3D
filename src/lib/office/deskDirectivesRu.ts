import type {
  OfficeCallDirective,
  OfficeGymDirective,
  OfficeQaDirective,
  OfficeStandupDirective,
  OfficeTextDirective,
} from "@/lib/office/deskDirectives";

// Russian counterparts of the English office commands in deskDirectives.ts.
//
// Both languages are understood; a message with Cyrillic in it is read with
// these rules first. Russian needs its own patterns rather than translated
// ones: verbs come in several forms (иди / идите / пойди / сходи), nouns
// decline (стол / столу / столом), and \b does not see Cyrillic letters at
// all, so every pattern is built with explicit letter boundaries instead.
//
// The input is already lower-cased and trimmed by the caller.

type InteractionDirective =
  | { target: "desk"; action: "hold" | "release" }
  | { target: "github"; action: "hold" | "release" };

// Whole-word match: not preceded or followed by a letter or digit.
const word = (source: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, "u");

const anyOf = (patterns: RegExp[], text: string) => patterns.some((p) => p.test(text));

// Movement verbs, in the forms people actually type: to one person or to
// several, and the colloquial ones.
const GO = "иди|идите|пойди|пойдите|ступай|ступайте|шагай|шагайте|сходи|сходите|отправляйся|отправляйтесь|двигай|марш|пошли|пойд[её]м|давай|давайте";
const RETURN = "вернись|вернитесь|возвращайся|возвращайтесь";
const SIT = "садись|садитесь|сядь|сядьте|присядь|присядьте";
const LEAVE = "уйти|выйти|отойти|встать|покинуть|уйди|уйдите|уходи|уходите|выйди|выйдите|выходи|выходите|покинь|покиньте|отойди|отойдите|встань|встаньте|оставь|оставьте";
const STOP = "хватит|закончи|закончите|заканчивай|заканчивайте|заверши|завершите|прекрати|прекратите|стоп|перестань|перестаньте";
const DESK = "стол\\p{L}*|рабоч\\p{L}*\\s+мест\\p{L}*";

const DESK_HOLD = [
  // «иди к своему столу», «вернись за стол», «садись за свой стол», «иди на рабочее место»
  word(`(?:${GO}|${RETURN}|${SIT})(?:\\s+(?:обратно|назад|уже|пожалуйста|скорее))*\\s+(?:за|к|на)\\s+(?:сво\\p{L}*\\s+|тво\\p{L}*\\s+|ваш\\p{L}*\\s+)?(?:${DESK})`),
  // «обратно за стол», «назад к столу»
  word(`(?:обратно|назад)\\s+(?:за|к|на)\\s+(?:сво\\p{L}*\\s+)?(?:${DESK})`),
];
const MENTIONS_DESK = word(DESK);
const WALK = [
  word("прогуляйся|прогуляйтесь|погуляй|погуляйте|пройдись|пройдитесь|разомнись|разомнитесь"),
  word(`(?:${GO})\\s+(?:по)?гулять`),
  word("на\\s+прогулку"),
];

const SERVER_ROOM = [
  word("серверн\\p{L}*"),
  word("github|гитхаб\\p{L}*"),
  word("код[- ]?ревью|ревью\\s+кода"),
  word("пулл?[- ]?реквест\\p{L}*|pr"),
];
const GITHUB_HOLD = [
  // «проверь пул-реквесты», «посмотри PR», «сделай ревью кода», «проревьюй код»
  word("(?:(?:давай|давайте)\\s+)?(?:посмотр\\p{L}*|провер\\p{L}*|проревью\\p{L}*|отревью\\p{L}*|сдела\\p{L}*\\s+ревью|займ\\p{L}*\\s+ревью)\\s+(?:нов\\p{L}*\\s+|открыт\\p{L}*\\s+)?(?:пулл?[- ]?реквест\\p{L}*|pr|код\\p{L}*|github|гитхаб\\p{L}*)"),
  word("(?:открой|откройте|покажи|покажите)\\s+(?:github|гитхаб)"),
  word(`(?:${GO})\\s+(?:в|на)\\s+(?:серверн\\p{L}*|код[- ]?ревью|ревью)`),
  // «есть ли пул-реквесты на ревью?», «есть новые PR?»
  word("есть\\s+(?:ли\\s+)?(?:как\\p{L}*[- ]?(?:то|нибудь)\\s+|нов\\p{L}*\\s+)?(?:пулл?[- ]?реквест\\p{L}*|pr)"),
];

const GYM_COMMAND = [
  word(`(?:${GO})\\s+(?:в\\s+)?(?:спортзал\\p{L}*|зал|качалк\\p{L}*|тренажерк\\p{L}*|тренажёрк\\p{L}*)`),
  word(`(?:${GO})\\s+(?:по)?тренир\\p{L}*|позанимайся|позанимайтесь|потренируйся|потренируйтесь`),
];
const GYM_RELEASE = [
  word(`(?:${LEAVE})\\s+(?:из\\s+)?(?:спортзал\\p{L}*|зал\\p{L}*|качалк\\p{L}*)`),
  word(`(?:${STOP})\\s+(?:с\\s+)?(?:тренир\\p{L}*|спортзал\\p{L}*|зал\\p{L}*)`),
];
const SKILL = [word("навык\\p{L}*|скилл?\\p{L}*")];
const SKILL_RELEASE = [
  ...GYM_RELEASE,
  word(`(?:${STOP})\\s+(?:с\\s+|работ\\p{L}*\\s+(?:с|над)\\s+)?(?:навык\\p{L}*|скилл?\\p{L}*)`),
];

const QA_HOLD = [
  word("(?:напиши|напишите|написать|добавь|добавьте)\\s+(?:\\p{L}+\\s+)?тест\\p{L}*"),
  word("(?:запусти|запустите|запустить|прогони|прогоните|прогнать)\\s+(?:\\p{L}+\\s+)?тест\\p{L}*"),
  word("протестируй\\p{L}*|протестировать|потестируй\\p{L}*"),
  word("воспроизвед\\p{L}*|воспроизвести|воспроизводи\\p{L}*"),
  word("отладь|отладьте|отладить|продебаж\\p{L}*"),
  word("провер\\p{L}*,?\\s+(?:работает\\s+ли|что\\s+(?:это|всё|все)\\s+работает|работу|сборку)"),
  word("qa[- ]?(?:комнат\\p{L}*|лаборатор\\p{L}*)|тестов\\p{L}*\\s+лаборатор\\p{L}*"),
  word("контрол\\p{L}*\\s+качества"),
];
// A bare «проверь» / «проверь это» is the QA lab's own suggested prompt.
const QA_BARE = /^(?:провер(?:ь|ьте)(?:\s+(?:это|сборку))?)$/u;
const QA_RELEASE = [
  word(`(?:${LEAVE})\\s+(?:из\\s+)?(?:qa[- ]?(?:комнат\\p{L}*|лаборатор\\p{L}*)|тестов\\p{L}*\\s+лаборатор\\p{L}*|лаборатор\\p{L}*)`),
  word(`(?:${STOP})\\s+(?:тестирова\\p{L}*|тестирование|проверк\\p{L}*|проверять|воспроизв\\p{L}*)`),
];

const MEETING = word("планерк\\p{L}*|планёрк\\p{L}*|стендап\\p{L}*|скрам\\p{L}*|летучк\\p{L}*|собрани\\p{L}*|совещани\\p{L}*|митинг\\p{L}*");
const MEETING_START = word("давай|давайте|пора|время|начн\\p{L}*|начина\\p{L}*|устро\\p{L}*|провед\\p{L}*|провест\\p{L}*|собер\\p{L}*|собира\\p{L}*|созов\\p{L}*|созыва\\p{L}*|запусти\\p{L}*");

export const resolveRuInteraction = (text: string): InteractionDirective | null => {
  if (anyOf(DESK_HOLD, text)) return { target: "desk", action: "hold" };
  const mentionsDesk = MENTIONS_DESK.test(text);
  if ((mentionsDesk && word(LEAVE).test(text)) || anyOf(WALK, text)) {
    return { target: "desk", action: "release" };
  }
  const mentionsServerRoom = anyOf(SERVER_ROOM, text);
  if (anyOf(GITHUB_HOLD, text)) return { target: "github", action: "hold" };
  if (mentionsServerRoom && (word(LEAVE).test(text) || word(STOP).test(text) || word("закрой|закройте").test(text))) {
    return { target: "github", action: "release" };
  }
  return null;
};

export const resolveRuGymCommand = (text: string): OfficeGymDirective | null => {
  if (anyOf(GYM_RELEASE, text)) return "release";
  return anyOf(GYM_COMMAND, text) ? "gym" : null;
};

export const resolveRuGymSkill = (text: string): OfficeGymDirective | null => {
  if (anyOf(SKILL_RELEASE, text)) return "release";
  return anyOf(SKILL, text) ? "gym" : null;
};

export const resolveRuQa = (text: string): OfficeQaDirective | null => {
  if (anyOf(QA_RELEASE, text)) return "release";
  return anyOf(QA_HOLD, text) || QA_BARE.test(text) ? "qa_lab" : null;
};

export const resolveRuStandup = (text: string): OfficeStandupDirective | null =>
  MEETING.test(text) && MEETING_START.test(text) ? "standup" : null;

// «ему», «ей», «им» after «скажи» refer back to the person being called.
const SAY = "(?:скажи|скажите|передай|передайте|сообщи|сообщите)(?:\\s+(?:ему|ей|им))?";
const CALL_SEPARATORS = [
  new RegExp(`,?\\s+и\\s+${SAY}[,:]?\\s+`, "u"),
  new RegExp(`,?\\s+${SAY}[,:]?\\s+`, "u"),
  /:\s+/u,
];
const CALL = /(?<![\p{L}\p{N}])(?:позвони|позвоните|набери|наберите|звякни|звякните|(?:сделай|сделайте|соверши|совершите)\s+звонок)(?:\s+(?:на\s+номер|по\s+номеру|пожалуйста))*\s+(.+)$/u;

const cleanParty = (value: string) =>
  value
    .replace(/^(?:пожалуйста|срочно)\s+/u, "")
    .replace(/[,:]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();

const ME = /^(?:мне|меня|нам)$/u;

export const resolveRuCall = (text: string): OfficeCallDirective | null => {
  const tail = text.match(CALL)?.[1]?.trim();
  if (!tail) return null;
  for (const separator of CALL_SEPARATORS) {
    const parts = tail.split(separator);
    if (parts.length < 2) continue;
    const callee = cleanParty(parts[0] ?? "");
    const message = parts.slice(1).join(" ").trim();
    if (!callee || !message || ME.test(callee)) continue;
    return { callee, message, phase: "ready_to_call" };
  }
  const callee = cleanParty(tail);
  if (!callee || ME.test(callee)) return null;
  return { callee, message: null, phase: "needs_message" };
};

// A message needs a word that says it is one, so «напиши тесты» stays a QA
// request rather than a text to someone called «тесты».
const MESSAGE_WORD = word("сообщени\\p{L}*|смс\\p{L}*|sms|эсэмэс\\p{L}*|whatsapp|ватсап\\p{L}*|вотсап\\p{L}*|вацап\\p{L}*|slack|слак\\p{L}*|телеграм\\p{L}*|telegram|в\\s+личк\\p{L}*");
const TEXT = /(?<![\p{L}\p{N}])(?:напиши|напишите|отправь|отправьте|пошли|пошлите|скинь|скиньте|черкни|черкните|кинь|киньте)\s+(.+)$/u;
const TEXT_KIND = /^(?:(?:(?:сообщени|смс|sms|эсэмэс)\p{L}*|в\s+(?:whatsapp|ватсап\p{L}*|вотсап\p{L}*|вацап\p{L}*|slack|слак\p{L}*|телеграм\p{L}*|telegram|личк\p{L}*))\s+)+/u;
const TEXT_SEPARATORS = [
  /,?\s+что\s+/u,
  /,?\s+(?:со\s+словами|с\s+текстом)\s+/u,
  new RegExp(`,?\\s+и\\s+(?:напиши|${SAY})[,:]?\\s+`, "u"),
  /:\s+/u,
];

export const resolveRuText = (text: string): OfficeTextDirective | null => {
  if (!MESSAGE_WORD.test(text)) return null;
  const tail = text.match(TEXT)?.[1]?.replace(TEXT_KIND, "").trim();
  // «напиши мне сообщение» asks for a message to the user, not to someone else.
  if (!tail || /^(?:мне|нам)(?![\p{L}\p{N}])/u.test(tail)) return null;
  for (const separator of TEXT_SEPARATORS) {
    const parts = tail.split(separator);
    if (parts.length < 2) continue;
    const recipient = cleanParty((parts[0] ?? "").replace(TEXT_KIND, ""));
    const message = parts.slice(1).join(" ").trim();
    if (!recipient || !message || ME.test(recipient)) continue;
    return { recipient, message, phase: "ready_to_send" };
  }
  const recipient = cleanParty(tail);
  if (!recipient || ME.test(recipient)) return null;
  return { recipient, message: null, phase: "needs_message" };
};
