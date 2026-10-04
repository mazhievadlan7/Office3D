/**
 * Russian numbers in words, for text that is spoken: counts that agree with
 * their noun's gender (одна попытка, две минуты, двадцать один агент),
 * ordinals for dates (третье октября, две тысячи двадцать шестого года) and
 * the clock (шесть часов сорок минут). A voice engine reading bare digits gets
 * the gender and the case wrong, so lines meant for speech spell them here.
 */

export type RussianGender = "m" | "f" | "n";

const UNITS = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = [
  "десять",
  "одиннадцать",
  "двенадцать",
  "тринадцать",
  "четырнадцать",
  "пятнадцать",
  "шестнадцать",
  "семнадцать",
  "восемнадцать",
  "девятнадцать",
];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];

/** Russian plural for a count: one (1, 21, 101), few (2-4, 22-24), many (0, 5-20, 11-14). */
export function plural(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(Math.trunc(count)) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

function unit(digit: number, gender: RussianGender): string {
  if (digit === 1) return gender === "f" ? "одна" : gender === "n" ? "одно" : "один";
  if (digit === 2) return gender === "f" ? "две" : "два";
  return UNITS[digit];
}

/** 1..999 in words, the last word agreeing with `gender`. */
function belowThousand(n: number, gender: RussianGender): string[] {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) words.push(HUNDREDS[hundreds]);
  if (rest >= 10 && rest < 20) {
    words.push(TEENS[rest - 10]);
  } else {
    if (rest >= 20) words.push(TENS[Math.floor(rest / 10)]);
    if (rest % 10) words.push(unit(rest % 10, gender));
  }
  return words;
}

/**
 * A whole number in words, agreeing with a noun of `gender` (masculine by
 * default): 1 → один / одна / одно, 2 → два / две, 1000 → тысяча.
 */
export function cardinal(value: number, gender: RussianGender = "m"): string {
  let n = Math.trunc(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return "ноль";
  const words: string[] = [];
  if (n < 0) {
    words.push("минус");
    n = -n;
  }
  const scales: Array<[number, RussianGender, [string, string, string]]> = [
    [1_000_000_000, "m", ["миллиард", "миллиарда", "миллиардов"]],
    [1_000_000, "m", ["миллион", "миллиона", "миллионов"]],
    [1_000, "f", ["тысяча", "тысячи", "тысяч"]],
  ];
  for (const [size, scaleGender, forms] of scales) {
    const count = Math.floor(n / size);
    if (count === 0) continue;
    n %= size;
    // «тысяча», «миллион» — not «одна тысяча».
    if (count !== 1) words.push(...belowThousand(count % 1000, scaleGender));
    words.push(plural(count, ...forms));
  }
  if (n) words.push(...belowThousand(n, gender));
  return words.join(" ");
}

/** The form an ordinal takes: neuter nominative (третье) or masculine/neuter genitive (третьего). */
export type RussianOrdinalForm = "neuter" | "genitive";

// Ordinal stems; третий is the one soft-stem ordinal (третье, третьего).
const ORD_UNITS = ["", "перв", "втор", "трет", "четвёрт", "пят", "шест", "седьм", "восьм", "девят"];
const ORD_TEENS = [
  "десят",
  "одиннадцат",
  "двенадцат",
  "тринадцат",
  "четырнадцат",
  "пятнадцат",
  "шестнадцат",
  "семнадцат",
  "восемнадцат",
  "девятнадцат",
];
const ORD_TENS = ["", "", "двадцат", "тридцат", "сороков", "пятидесят", "шестидесят", "семидесят", "восьмидесят", "девяност"];
const ORD_HUNDREDS = ["", "сот", "двухсот", "трёхсот", "четырёхсот", "пятисот", "шестисот", "семисот", "восьмисот", "девятисот"];
const ORD_THOUSANDS = ["", "", "двух", "трёх", "четырёх", "пяти", "шести", "семи", "восьми", "девяти"];

function ordinalEnding(stem: string, form: RussianOrdinalForm): string {
  if (stem === "трет") return form === "neuter" ? "третье" : "третьего";
  return stem + (form === "neuter" ? "ое" : "ого");
}

/**
 * An ordinal in words: only its last word declines (две тысячи двадцать
 * шестого, тридцать первое). Covers 1..999 999 except round tens of thousands.
 */
export function ordinal(value: number, form: RussianOrdinalForm): string {
  const n = Math.trunc(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 1_000_000) return cardinal(value);
  const units = n % 10;
  const tens = Math.floor(n / 10) % 10;
  const hundreds = Math.floor(n / 100) % 10;
  const head = (rest: number) => (rest > 0 ? `${cardinal(rest)} ` : "");
  if (tens === 1) return head(n - (n % 100)) + ordinalEnding(ORD_TEENS[units], form);
  if (units) return head(n - units) + ordinalEnding(ORD_UNITS[units], form);
  if (tens) return head(n - (n % 100)) + ordinalEnding(ORD_TENS[tens], form);
  if (hundreds) return head(n - (n % 1000)) + ordinalEnding(ORD_HUNDREDS[hundreds], form);
  const thousands = n / 1000;
  if (thousands < 10) return ordinalEnding(`${ORD_THOUSANDS[thousands]}тысячн`, form);
  // Round tens of thousands (двадцатитысячное) never come up in a greeting.
  return cardinal(n);
}

/** «шесть часов сорок минут», «один час пять минут», «ноль часов ровно». */
export function spokenClock(hours: number, minutes: number): string {
  const h = `${cardinal(hours)} ${plural(hours, "час", "часа", "часов")}`;
  if (minutes === 0) return `${h} ровно`;
  return `${h} ${cardinal(minutes, "f")} ${plural(minutes, "минута", "минуты", "минут")}`;
}
