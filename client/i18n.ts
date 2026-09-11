export type Locale = "en" | "ru" | "uk";

export interface Strings {
  sidebarTitle: string;
  title: string;
  tagline: string;
  taglineDetail: string;
  stateAwake: string;
  stateAsleep: string;
  remaining(remaining: string): string;
  agentsRunning(agents: number): string;
  agentsIdle: string;
  agentsWaiting: string;
  untilOff: string;
  modeLabel: string;
  off: string;
  offDetail: string;
  on: string;
  onDetail: string;
  timer: string;
  timerDetail: string;
  auto: string;
  autoDetail: string;
  hours(n: number): string;
  minutes(n: number): string;
  howTitle: string;
  how1: string;
  how2: string;
  how3: string;
  updated(secondsAgo: number): string;
  errorPrefix: string;
}

const en: Strings = {
  sidebarTitle: "Caffeine",
  title: "Caffeine",
  tagline: "Keeps the Mac awake for your agents.",
  taglineDetail: "Only system sleep is held; the display goes dark as usual.",
  stateAwake: "AWAKE",
  stateAsleep: "SLEEPS AS USUAL",
  remaining: (remaining) => `${remaining} left`,
  agentsRunning: (agents) => `${agents} agent${agents === 1 ? "" : "s"} running`,
  agentsIdle: "no agents running",
  agentsWaiting: "waiting for the daemon",
  untilOff: "until you turn it off",
  modeLabel: "Mode",
  off: "Off",
  offDetail: "macOS decides",
  on: "On",
  onDetail: "until you turn it off",
  timer: "Timer",
  timerDetail: "then back to Off by itself",
  auto: "While agents work",
  autoDetail: "releases three minutes after the last agent goes quiet",
  hours: (n) => `${n} h`,
  minutes: (n) => `${n} min`,
  howTitle: "How it works",
  how1: "Runs caffeinate -i -s tied to this plugin's process, so it can never be orphaned.",
  how2: "The mode survives a daemon restart; a timer expires within thirty seconds of its deadline.",
  how3: "A closed lid still puts a MacBook to sleep, caffeinate or not.",
  updated: (s) => (s < 5 ? "updated just now" : `updated ${s} s ago`),
  errorPrefix: "caffeinate failed",
};

const ru: Strings = {
  sidebarTitle: "Кофеин",
  title: "Кофеин",
  tagline: "Не даёт Mac уснуть, пока работают агенты.",
  taglineDetail: "Только сон системы: экран гаснет как обычно.",
  stateAwake: "НЕ СПИТ",
  stateAsleep: "СПИТ КАК ОБЫЧНО",
  remaining: (remaining) => `осталось ${remaining}`,
  agentsRunning: (agents) => `работает агентов: ${agents}`,
  agentsIdle: "агенты не работают",
  agentsWaiting: "жду ответа демона",
  untilOff: "пока не выключишь",
  modeLabel: "Режим",
  off: "Выкл",
  offDetail: "решает macOS",
  on: "Вкл",
  onDetail: "пока не выключишь",
  timer: "Таймер",
  timerDetail: "потом сам вернётся в Выкл",
  auto: "Пока работают агенты",
  autoDetail: "отпускает через три минуты после последнего агента",
  hours: (n) => `${n} ч`,
  minutes: (n) => `${n} мин`,
  howTitle: "Как это работает",
  how1: "Держит caffeinate -i -s, привязанный к процессу плагина, так что сирот не остаётся.",
  how2: "Режим переживает перезапуск демона; таймер гаснет в пределах тридцати секунд от срока.",
  how3: "Закрытая крышка всё равно усыпляет MacBook, с caffeinate или без.",
  updated: (s) => (s < 5 ? "обновлено только что" : `обновлено ${s} с назад`),
  errorPrefix: "caffeinate не запустился",
};

const uk: Strings = {
  sidebarTitle: "Кофеїн",
  title: "Кофеїн",
  tagline: "Не дає Mac заснути, доки працюють агенти.",
  taglineDetail: "Лише сон системи: екран гасне як зазвичай.",
  stateAwake: "НЕ СПИТЬ",
  stateAsleep: "СПИТЬ ЯК ЗАЗВИЧАЙ",
  remaining: (remaining) => `залишилось ${remaining}`,
  agentsRunning: (agents) => `працює агентів: ${agents}`,
  agentsIdle: "агенти не працюють",
  agentsWaiting: "чекаю відповіді демона",
  untilOff: "доки не вимкнеш",
  modeLabel: "Режим",
  off: "Вимк",
  offDetail: "вирішує macOS",
  on: "Увімк",
  onDetail: "доки не вимкнеш",
  timer: "Таймер",
  timerDetail: "потім сам повернеться у Вимк",
  auto: "Доки працюють агенти",
  autoDetail: "відпускає через три хвилини після останнього агента",
  hours: (n) => `${n} год`,
  minutes: (n) => `${n} хв`,
  howTitle: "Як це працює",
  how1: "Тримає caffeinate -i -s, прив'язаний до процесу плагіна, тож сиріт не лишається.",
  how2: "Режим переживає перезапуск демона; таймер гасне в межах тридцяти секунд від строку.",
  how3: "Закрита кришка все одно присипляє MacBook, з caffeinate чи без.",
  updated: (s) => (s < 5 ? "оновлено щойно" : `оновлено ${s} с тому`),
  errorPrefix: "caffeinate не запустився",
};

const catalogue: Record<Locale, Strings> = { en, ru, uk };

export function resolveLocale(tag: string): Locale {
  const lower = tag.toLowerCase();
  if (lower.startsWith("uk")) return "uk";
  if (lower.startsWith("ru")) return "ru";
  return "en";
}

/** The device's language: what the daemon-side title uses, and the fallback everywhere. */
export function detectLocale(): Locale {
  try {
    return resolveLocale(new Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return "en";
  }
}

/**
 * The language chosen in Paseo's own settings, when it can be read.
 *
 * The plugin SDK does not hand a surface the app's language, but on the desktop and the
 * web the plugin runs in the same window as Paseo, whose settings live in localStorage as
 * one JSON record carrying `language` and `theme`. The record is found by shape rather
 * than by key, so a renamed key degrades to the device language instead of breaking.
 * "system" means the device language; the phone has no localStorage and gets the same.
 */
export function detectAppLocale(): Locale {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        const raw = key ? storage.getItem(key) : null;
        if (!raw || raw[0] !== "{" || !raw.includes('"language"')) continue;
        const parsed = JSON.parse(raw) as { language?: unknown; theme?: unknown };
        if (typeof parsed.language !== "string" || !("theme" in parsed)) continue;
        if (parsed.language === "system") break;
        return resolveLocale(parsed.language);
      }
    }
  } catch {
    // Storage may be absent, blocked, or hold something that is not JSON; the device
    // language is the right answer in every one of those cases.
  }
  return detectLocale();
}

export function t(locale: Locale = detectLocale()): Strings {
  return catalogue[locale];
}

/** "2 h 40 min" from milliseconds; never negative, never empty. */
export function formatRemaining(ms: number, strings: Strings): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return strings.minutes(m);
  if (m === 0) return strings.hours(h);
  return `${strings.hours(h)} ${strings.minutes(m)}`;
}
