import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { defaultLocale, errorNotice, requestLocale, resolveLocale } from "../bin/i18n.mjs";

const i18n = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8")).extensions.openagent.i18n;

test("Goal translations cover every declared host label and notice", () => {
  expect(i18n.supported_locales).toEqual(["en", "zh"]);
  expect(defaultLocale).toBe("en");
  const baseline = Object.keys(i18n.translations.en).sort();
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const locale of i18n.supported_locales) {
    expect(Object.keys(i18n.translations[locale]).sort()).toEqual(baseline);
    for (const key of baseline) {
      expect(i18n.translations[locale][key].trim()).not.toBe("");
      expect(placeholders(i18n.translations[locale][key])).toEqual(placeholders(i18n.translations.en[key]));
    }
  }
});

test("Goal follows live tool context and translates validation notices", async () => {
  const host = { locale: { get: async () => "en" } };
  expect(resolveLocale("zh-CN")).toBe("zh");
  expect(resolveLocale("fr")).toBe("en");
  expect(await requestLocale({}, host)).toBe("en");
  expect(await requestLocale({ _openagent: { locale: "zh-CN" } }, host)).toBe("zh");
  expect(errorNotice(new Error("No Goal exists on this branch; start /goal <objective>"), "zh"))
    .toBe("此分支上没有 Goal；请运行 /goal <目标内容> 创建一个");
  expect(errorNotice(new Error("This Goal is cancelled; use the goal lifecycle tool before updating progress"), "zh"))
    .toBe("此 Goal 已处于 cancelled 状态；请先使用 Goal 生命周期工具，再更新进度");
  const unknown = errorNotice(Object.assign(new Error("secret internal text"), { code: "EIO" }), "zh");
  expect(unknown).toContain("EIO");
  expect(unknown).not.toContain("secret internal text");
});
