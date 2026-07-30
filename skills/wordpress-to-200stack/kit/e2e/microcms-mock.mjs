import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// テンプレートへ undici を追加せず、kit が固定している版を絶対パスから解決する。
const requireFromKit = createRequire(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const { MockAgent, setGlobalDispatcher } = requireFromKit("undici");
const contentsPath = process.env.WPKIT_E2E_CONTENTS;
if (!contentsPath) throw new Error("WPKIT_E2E_CONTENTS が必要です");

const contentsByApi = JSON.parse(readFileSync(contentsPath, "utf8"));
const origin = `https://${process.env.MICROCMS_SERVICE_DOMAIN ?? "golden"}.microcms.io`;
const agent = new MockAgent();
agent.disableNetConnect();

agent.get(origin)
  .intercept({ method: "GET", path: /^\/api\/v1\/[^/?]+\?limit=50&offset=\d+$/ })
  .reply((options) => {
    const url = new URL(options.path, origin);
    const api = decodeURIComponent(url.pathname.slice("/api/v1/".length));
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const records = Array.isArray(contentsByApi[api]) ? contentsByApi[api] : [];
    const page = records.slice(offset, offset + 50);
    // IPC を持つ PID は Next が静的生成用に fork した worker。main/CLI での hit を除外できる。
    process.stderr.write(`[wpkit-e2e] intercept hit pid=${process.pid} ipc=${typeof process.send === "function"} api=${api} offset=${offset}\n`);
    return {
      statusCode: 200,
      data: JSON.stringify({ contents: page, totalCount: records.length }),
      headers: { "content-type": "application/json" },
    };
  })
  .persist();

setGlobalDispatcher(agent);
process.stderr.write(`[wpkit-e2e] mock-inject loaded pid=${process.pid} ipc=${typeof process.send === "function"}\n`);
