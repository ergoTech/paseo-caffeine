import assert from "node:assert/strict";
import { test } from "node:test";
import { detectAppLocale, detectLocale, resolveLocale, t } from "./i18n.ts";

/** Stands in for the app's localStorage for the duration of one test. The keys are
 *  arbitrary on purpose: the detection finds Paseo's record by shape, not by name. */
function withStorage<T>(records: Record<string, string> | undefined, body: () => T): T {
  const host = globalThis as { localStorage?: unknown };
  const had = "localStorage" in host;
  const before = host.localStorage;
  if (records === undefined) delete host.localStorage;
  else {
    const keys = Object.keys(records);
    host.localStorage = {
      length: keys.length,
      key: (index: number) => keys[index] ?? null,
      getItem: (name: string) => records[name] ?? null,
    };
  }
  try {
    return body();
  } finally {
    if (had) host.localStorage = before;
    else delete host.localStorage;
  }
}

test("a region tag narrows to its catalogue entry", () => {
  assert.equal(resolveLocale("ru-RU"), "ru");
  assert.equal(resolveLocale("uk-UA"), "uk");
  assert.equal(resolveLocale("en-GB"), "en");
  assert.equal(resolveLocale("de-DE"), "en");
});

test("the app's own language wins over the device's", () => {
  // The case this exists for: macOS in English, Paseo in Russian.
  const app = JSON.stringify({ theme: "dark", language: "ru", sendBehavior: "steer" });
  withStorage({ "app-settings": app }, () => assert.equal(detectAppLocale(), "ru"));
});

test("the record is found by shape, so a renamed key still works", () => {
  const app = JSON.stringify({ theme: "light", language: "uk" });
  withStorage({ "some-other-name": app }, () => assert.equal(detectAppLocale(), "uk"));
});

test("a record that is not Paseo's settings is stepped over", () => {
  // Both carry a `language`; only Paseo's carries a `theme` beside it.
  withStorage(
    {
      "query-cache": JSON.stringify({ language: "ru" }),
      "app-settings": JSON.stringify({ theme: "dark", language: "uk" }),
    },
    () => assert.equal(detectAppLocale(), "uk"),
  );
});

test("no storage, junk and 'system' all fall back to the device", () => {
  withStorage(undefined, () => assert.equal(detectAppLocale(), detectLocale()));
  withStorage({ "app-settings": "not json" }, () =>
    assert.equal(detectAppLocale(), detectLocale()),
  );
  withStorage({ "app-settings": '{"theme":"dark","language":"system"}' }, () =>
    assert.equal(detectAppLocale(), detectLocale()),
  );
});

test("every locale carries every string, and none of them is empty", () => {
  // The interface already makes a missing key a compile error; this is about a key that
  // is present and blank, which reaches ⌘K as a row with no text in it.
  for (const locale of ["en", "ru", "uk"] as const) {
    const strings = t(locale);
    for (const [key, value] of Object.entries(strings)) {
      const rendered = typeof value === "function" ? String(value(3)) : value;
      assert.equal(typeof rendered, "string", `${locale}'s ${key} is not a string`);
      assert.notEqual(rendered.trim(), "", `${locale}'s ${key} is empty`);
    }
  }
});

test("every Command Center row names the plugin", () => {
  // ⌘K is one flat list of everything; "Off" on its own belongs to nothing.
  for (const locale of ["en", "ru", "uk"] as const) {
    const strings = t(locale);
    const rows = [
      strings.commandOff,
      strings.commandOn,
      strings.commandTimer(3),
      strings.commandAuto,
    ];
    for (const row of rows) assert.ok(row.startsWith("Caffeine: "), `${locale}: ${row}`);
  }
});
