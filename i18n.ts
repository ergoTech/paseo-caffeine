export type Locale = "en" | "ru" | "uk";

export interface Strings {
  sidebarTitle: string;
  title: string;
  sleeps: string;
  awakeOn: string;
  awakeTimer(remaining: string): string;
  awakeAuto(agents: number): string;
  autoIdle: string;
  autoWaiting: string;
  off: string;
  on: string;
  h1: string;
  h3: string;
  h8: string;
  auto: string;
  hours(n: number): string;
  minutes(n: number): string;
  errorPrefix: string;
}

const en: Strings = {
  sidebarTitle: "Caffeine",
  title: "Caffeine",
  sleeps: "The Mac sleeps as usual.",
  awakeOn: "The Mac stays awake until you turn this off.",
  awakeTimer: (remaining) => `The Mac stays awake, ${remaining} left.`,
  awakeAuto: (agents) => `The Mac stays awake while agents work — ${agents} running.`,
  autoIdle: "No agents running; the Mac may sleep.",
  autoWaiting: "Waiting for the first word from the daemon about agents.",
  off: "Off",
  on: "On",
  h1: "1 h",
  h3: "3 h",
  h8: "8 h",
  auto: "While agents work",
  hours: (n) => `${n} h`,
  minutes: (n) => `${n} min`,
  errorPrefix: "caffeinate failed",
};

const ru: Strings = {
  sidebarTitle: "Кофеин",
  title: "Кофеин",
  sleeps: "Mac засыпает как обычно.",
  awakeOn: "Mac не спит, пока не выключишь.",
  awakeTimer: (remaining) => `Mac не спит, осталось ${remaining}.`,
  awakeAuto: (agents) => `Mac не спит, пока работают агенты — сейчас ${agents}.`,
  autoIdle: "Агенты не работают, Mac может спать.",
  autoWaiting: "Жду первого ответа демона про агентов.",
  off: "Выкл",
  on: "Вкл",
  h1: "1 ч",
  h3: "3 ч",
  h8: "8 ч",
  auto: "Пока работают агенты",
  hours: (n) => `${n} ч`,
  minutes: (n) => `${n} мин`,
  errorPrefix: "caffeinate не запустился",
};

const uk: Strings = {
  sidebarTitle: "Кофеїн",
  title: "Кофеїн",
  sleeps: "Mac засинає як зазвичай.",
  awakeOn: "Mac не спить, доки не вимкнеш.",
  awakeTimer: (remaining) => `Mac не спить, залишилось ${remaining}.`,
  awakeAuto: (agents) => `Mac не спить, доки працюють агенти — зараз ${agents}.`,
  autoIdle: "Агенти не працюють, Mac може спати.",
  autoWaiting: "Чекаю першої відповіді демона про агентів.",
  off: "Вимк",
  on: "Увімк",
  h1: "1 год",
  h3: "3 год",
  h8: "8 год",
  auto: "Доки працюють агенти",
  hours: (n) => `${n} год`,
  minutes: (n) => `${n} хв`,
  errorPrefix: "caffeinate не запустився",
};

const catalogue: Record<Locale, Strings> = { en, ru, uk };

export function resolveLocale(tag: string): Locale {
  const lower = tag.toLowerCase();
  if (lower.startsWith("uk")) return "uk";
  if (lower.startsWith("ru")) return "ru";
  return "en";
}

export function detectLocale(): Locale {
  try {
    return resolveLocale(new Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return "en";
  }
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
