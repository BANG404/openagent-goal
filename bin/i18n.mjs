import { readFileSync } from "node:fs";

const i18n = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
).extensions.openagent.i18n;

export function resolveLocale(requested) {
  const tag = String(requested ?? "").trim().toLowerCase();
  if (i18n.supported_locales.includes(tag)) return tag;
  const base = tag.split("-")[0];
  return i18n.supported_locales.includes(base) ? base : i18n.default_locale;
}

/** MCP calls use transient context; independent command and hook processes ask the authenticated host. */
export async function requestLocale(args, host) {
  const requested = args?._openagent?.locale ?? (host ? await host.locale.get() : i18n.default_locale);
  return resolveLocale(requested);
}

export const defaultLocale = i18n.default_locale;

export function noticeText(key, params = {}, locale = defaultLocale) {
  const template = i18n.translations[resolveLocale(locale)][key];
  if (typeof template !== "string") throw new Error(`Unknown Goal notice: ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, field) => String(params[field] ?? `{${field}}`));
}

export function translateNotice(text, locale = defaultLocale) {
  for (const { key, expression, fields } of patterns) {
    const match = expression.exec(String(text));
    if (!match) continue;
    return noticeText(key, Object.fromEntries(fields.map((field, index) => [field, match[index + 1]])), locale);
  }
  return null;
}

const patterns = Object.entries(i18n.translations[i18n.default_locale])
  .filter(([key]) => key.startsWith("notice.") && key !== "notice.unexpected")
  .map(([key, text]) => {
    const fields = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    const pattern = text
      .split(/\{\w+\}/)
      .map((part) => [...part].map((character) => "\\^$.*+?()[]{}|".includes(character) ? "\\" + character : character).join(""))
      .join("(.+?)");
    return { key, fields, expression: new RegExp("^" + pattern + "$") };
  });

export function errorNotice(error, locale) {
  const text = error instanceof Error ? error.message : String(error);
  const translated = translateNotice(text, locale);
  if (translated !== null) return translated;
  const code = String(error?.code ?? error?.cause?.code ?? error?.status ?? "UNKNOWN");
  return i18n.translations[resolveLocale(locale)]["notice.unexpected"].replace("{code}", code);
}
