import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createRelayServer, loadListenConfig } from "../server.mjs";

const config = {
  canvasBaseUrl: "https://canvas.example.edu",
  canvasOrigin: "https://canvas.example.edu",
  canvasToken: "canvas-token-for-test",
  relaySecret: "test-relay-secret-".repeat(2),
  canvasUserAgent: "relay-test/0.1.0",
  canvasAccept: "application/json",
  canvasAcceptLanguage: "en-US",
  readOnly: true,
  maxApiResponseBytes: 100_000,
  maxFileBytes: 100_000,
};

async function withServer(fetchImpl, callback) {
  const server = createRelayServer({ config, fetchImpl });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await callback(url);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("health endpoints do not expose Canvas credentials", async () => {
  await withServer(fetch, async (url) => {
    const publicHealth = await fetch(`${url}/healthz`);
    assert.equal(publicHealth.status, 200);
    assert.deepEqual(await publicHealth.json(), { ok: true, service: "canvas-relay" });

    const privateHealth = await fetch(`${url}/v1/health`);
    assert.equal(privateHealth.status, 401);
  });
});

test("relay listen configuration defaults to its IPv6 service port", () => {
  assert.deepEqual(loadListenConfig({}), { host: "::", port: 8300 });
  assert.deepEqual(loadListenConfig({ HOST: "127.0.0.1", PORT: "8123" }), {
    host: "127.0.0.1",
    port: 8123,
  });
  assert.throws(() => loadListenConfig({ PORT: "70000" }), /between 1 and 65535/);
});

test("relay authenticates callers and proxies only Canvas API URLs", async () => {
  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url: url.toString(), init });
    return new Response(JSON.stringify([{ id: 1 }]), {
      headers: { "content-type": "application/json" },
    });
  };

  await withServer(fetchImpl, async (relayUrl) => {
    const response = await fetch(`${relayUrl}/v1/canvas`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.relaySecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method: "GET",
        url: "https://canvas.example.edu/api/v1/courses?per_page=1",
        response_mode: "json",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, [{ id: 1 }]);
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://canvas.example.edu/api/v1/courses?per_page=1");
  assert.equal(fetchCalls[0].init.headers.get("authorization"), "Bearer canvas-token-for-test");
});
