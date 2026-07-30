import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// テンプレートには undici を追加しない。kit に導入済みの同版を絶対パスで解決する。
const requireFromKit = createRequire(
  fileURLToPath(new URL("../../package.json", import.meta.url)),
);
const { MockAgent, setGlobalDispatcher } = requireFromKit("undici");

const origin = "https://golden-spike.microcms.io";
const agent = new MockAgent();
agent.disableNetConnect();

const pool = agent.get(origin);
pool
  .intercept({
    method: "GET",
    path: /^\/api\/v1\/[^/?]+\?limit=50&offset=\d+$/,
    headers: { "x-microcms-api-key": "spike-key" },
  })
  .reply((options) => {
    process.stderr.write(
      `[spike] intercept hit pid=${process.pid} path=${options.path}\n`,
    );
    return {
      statusCode: 200,
      data: JSON.stringify({ contents: [], totalCount: 0 }),
      headers: { "content-type": "application/json" },
    };
  })
  .persist();

setGlobalDispatcher(agent);
process.stderr.write(`[spike] mock-inject loaded pid=${process.pid}\n`);
