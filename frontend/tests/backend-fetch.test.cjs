const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function loadBackendFetch({ cloud = false, tokenFailure = false, status = 200 } = {}) {
  const requests = [];
  const audiences = [];
  const source = ts.transpileModule(readFileSync(path.join(__dirname, "../lib/backend-fetch.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = {
    exports: {}, Headers, URL,
    process: { env: cloud ? { K_SERVICE: "learnos-frontend" } : {} },
    require: (name) => {
      if (name === "server-only") return {};
      assert.equal(name, "google-auth-library");
      return { GoogleAuth: class {
        async getIdTokenClient(audience) {
          audiences.push(audience);
          if (tokenFailure) throw new Error("Identity unavailable");
          return { getRequestHeaders: async () => new Headers({ Authorization: "Bearer service-token" }) };
        }
      } };
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response("{}", { status });
    },
  };
  vm.runInNewContext(source, context);
  return { backendFetch: context.exports.backendFetch, requests, audiences };
}

const backendUrl = "https://learnos-backend.example.run.app/api/tutor/live/session";
const options = { method: "POST", headers: { Authorization: "Bearer firebase-token" }, body: "{}" };

test("local requests do not acquire a Cloud Run identity token", async () => {
  const client = loadBackendFetch();
  await client.backendFetch("http://127.0.0.1:8000/api/tutor/action", options);
  assert.equal(client.audiences.length, 0);
  assert.equal(client.requests.length, 1);
  assert.equal(new Headers(client.requests[0].options.headers).get("authorization"), "Bearer firebase-token");
});

test("Cloud Run requests preserve Firebase authentication and add a separate service token", async () => {
  const client = loadBackendFetch({ cloud: true });
  await client.backendFetch(backendUrl, options);
  assert.deepEqual(client.audiences, ["https://learnos-backend.example.run.app"]);
  const headers = client.requests[0].options.headers;
  assert.equal(headers.get("authorization"), "Bearer firebase-token");
  assert.equal(headers.get("x-serverless-authorization"), "Bearer service-token");
  assert.equal(client.requests[0].options.body, "{}");
});

test("failed live session requests are never automatically retried", async () => {
  const client = loadBackendFetch({ cloud: true, status: 429 });
  const response = await client.backendFetch(backendUrl, options);
  assert.equal(response.status, 429);
  assert.equal(client.requests.length, 1);
});

test("identity failures do not send an unauthenticated request to the backend", async () => {
  const client = loadBackendFetch({ cloud: true, tokenFailure: true });
  await assert.rejects(client.backendFetch(backendUrl, options), /Identity unavailable/);
  assert.equal(client.requests.length, 0);
});

test("manual subsequent requests reuse the identity client", async () => {
  const client = loadBackendFetch({ cloud: true });
  await client.backendFetch(backendUrl, options);
  await client.backendFetch(backendUrl, options);
  assert.equal(client.audiences.length, 1);
  assert.equal(client.requests.length, 2);
});