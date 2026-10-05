import { expect, test } from "bun:test";
import { createHostClient } from "../bin/lib/openagent-host.mjs";

const environment = {
  OPENAGENT_PLUGIN_HOST_URL: "http://127.0.0.1/host",
  OPENAGENT_PLUGIN_HOST_TOKEN: "test-token",
  OPENAGENT_PLUGIN_ID: "goal",
};

test("locale.get reads the versioned application locale from the host", async () => {
  let request;
  const host = createHostClient({
    environment,
    fetch: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ ok: true, result: { version: 1, locale: "zh-CN" } }));
    },
  });
  expect(await host.locale.get()).toBe("zh-CN");
  expect(request.url).toBe(environment.OPENAGENT_PLUGIN_HOST_URL);
  expect(request.body).toEqual({ operation: "locale.get", args: { plugin_id: "goal" } });
});

test("locale.get rejects responses outside the versioned host contract", async () => {
  const host = createHostClient({
    environment,
    fetch: async () => new Response(JSON.stringify({ ok: true, result: { version: 2, locale: "zh" } })),
  });
  await expect(host.locale.get()).rejects.toThrow("unsupported host locale response");
});
