# next build ワーカーへの undici MockAgent 注入 spike

## 判定

**条件付き可**。`NODE_OPTIONS=--import` により、ラッパープロセスと Next CLI の別 PID の双方で注入モジュールがロードされ、同じ注入経路の `globalThis.fetch` は `MockAgent` によりネットワークなしで JSON を返した。`next build` は `output: "export"` の `out/` 生成まで成功した。

ただし、このテンプレートは `MICROCMS_APIS` が空配列の未設定状態なので、build 本体は microCMS `fetch` を **0 件**実行する。従って、設定済み案件の静的生成 worker での intercept ヒットはこの spike だけでは未評価である。テンプレート変更禁止を守るため、API ID を追加して強制しなかった。

| 段階 | 結果 | 根拠 |
| --- | --- | --- |
| (a) `NODE_OPTIONS` 伝播 | 可（main / static-generation worker） | PID 付きロードマーカーがラッパー、Next CLI、TypeScript worker、静的生成 worker 7 プロセスに出力された。 |
| (b) MockAgent 横取り | 注入経路では可、build worker では未評価 | `--probe-only` が `GET /api/v1/spike?limit=50&offset=0` を intercept し、実ネットワークなしで `{ "contents": [], "totalCount": 0 }` を取得した。build は API 設定が空のため fetch 0 件。 |
| (c) 静的 export | 可 | `next build` が exit 0、`out/index.html` を含む静的出力を生成した。 |

## 実測ログ抜粋

以下は 2026-07-31 (JST) の実行結果。PID は実行ごとに変わる。

```text
# run-spike.sh
[spike] mock-inject loaded pid=169
[spike] intercept hit pid=169 path=/api/v1/spike?limit=50&offset=0
[spike] probe passed status=200

[spike] mock-inject loaded pid=179
[spike] mock-inject loaded pid=180
Collecting page data using 7 workers ...
[spike] mock-inject loaded pid=231
[spike] mock-inject loaded pid=232
[spike] mock-inject loaded pid=233
[spike] mock-inject loaded pid=234
[spike] mock-inject loaded pid=235
[spike] mock-inject loaded pid=236
[spike] mock-inject loaded pid=237
✓ Generating static pages using 7 workers (6/6) in 224ms
✓ Finalizing page optimization
[spike] build-exit=0 out-index-exit=0
```

`out/` の確認と PID / build 出力は、下記の再現コマンドであらためて得られる。プローブの intercept 行があることは (b) の注入機構の証拠であり、build 実行中に intercept 行がないことは現テンプレでは fetch が発生しないことを示す。

## 動作の仕組み

`mock-inject.mjs` は kit に既導入の `undici@7.28.0` を、モジュール自身から `kit/package.json` の絶対パスを計算した `createRequire()` で解決する。テンプレート側の依存や設定は変更しない。

ロード時に `MockAgent` を生成して `disableNetConnect()` し、`https://golden-spike.microcms.io` の `/api/v1/<api>?limit=50&offset=<N>`（`X-MICROCMS-API-KEY: spike-key`）だけを persistent intercept する。その後 `setGlobalDispatcher(agent)` を呼ぶため、同一 Node プロセスの組み込み `fetch` がこの dispatcher を使う。intercept はページネーション URL の `limit=50` と数値 `offset` を必須一致にする。

`scripts/build-app.mjs` は `env: { ...process.env }` で `next build` を別 Node プロセスとして起動する。Node は `NODE_OPTIONS` を子プロセスへ継承し、`--import` をその各 Node プロセスの起動時に評価するため、PID マーカーで伝播を観測できる。

## 前提条件と bundler

- Node: `v24.18.0`（組み込み undici も `7.28.0`）。
- 注入元: `kit/node_modules/undici@7.28.0`。テンプレートの `node_modules` からは解決しない。
- build 必須 env: `MICROCMS_SERVICE_DOMAIN=golden-spike` と `MICROCMS_API_KEY=spike-key`。この雛形では API が空でも、将来 API 設定が入った時に `client.ts` がこの二つを必須にするため常に与える。
- `NEXT_PUBLIC_SITE_ORIGIN`、preview 用の public microCMS env、`WPKIT_ARCHIVE_DIR` は、この build の必須値ではない。
- `BUILD_MEMORY_LIMIT_MB` は未設定で実行したため既定の `next build`（Turbopack 系）である。指定時は `scripts/build-app.mjs` が `--webpack` を付けるため、webpack 経路も案件導入前に同じランナーへ env を足して再検証すること。

## 既知の制約

`src/lib/content/microcms-document.ts` の `MICROCMS_APIS` は `[]` で、Home / sitemap が `ContentRepository.load()` を呼んでも `fetchMicroCmsApis([])` は空のまま返る。このため、現テンプレで「最低 1 ページ」は既存 Home の export を指すが、「最低 1 件の microCMS API fetch」は build で発生しない。

設定済みテンプレートでこの結果を一般化する前に、実 API ID を含む `MICROCMS_APIS` で `run-spike.sh` を実行し、静的生成プロセスの `[spike] intercept hit` を確認する必要がある。Mock の最小リスト応答は API ごとに `{ "contents": [], "totalCount": 0 }` でよい。少なくとも文書を作るなら `{ "contents": [{ "id": "spike-document" }], "totalCount": 1 }` を返す。

今回の Next 16.2.12 は build 時に `next-env.d.ts` と `tsconfig.json` を自動更新しようとした。spike 実行後はそれらの追跡対象差分を元の内容へ戻したため、現在の変更は spike ディレクトリだけである。これは注入の失敗ではなく Next の型設定自動同期であり、テンプレート変更禁止のため恒久修正はしていない。再実行時にも同じ差分が出る可能性がある。

## E2E 本実装への推奨構成

1. `kit/e2e/spike/mock-inject.mjs` の機構を E2E 用の注入モジュールとして維持し、各 fixture API の決定的レスポンスを intercept に追加する。
2. テストはテンプレートのディレクトリを `cwd` にして、`MICROCMS_SERVICE_DOMAIN`、`MICROCMS_API_KEY`、`NODE_OPTIONS="--import <注入モジュール絶対パス>"` を渡し `node scripts/build-app.mjs` を子プロセスで起動する。
3. stdout/stderr を保存し、(a) PID ごとのロードマーカー、(b) API ごとの intercept 行、(c) exit 0 と `out/index.html` の存在を別 assertion にする。
4. `BUILD_MEMORY_LIMIT_MB` を使う実運用ケースは webpack 経路になるため、Turbopack と webpack を別ケースにし、両方で (a)〜(c) を記録する。

## フォールバック

フォールバックは未実施。MockAgent の同一 `--import` 注入で `globalThis.fetch` のプローブが成功しているため、(b) の失敗時のみ試すべき直接差し替えは発動条件ではない。Next.js 公式 fetch テストフックも、この spike では必要にならなかった。

## 再現手順

リポジトリ root から実行する。

通常の spike（MockAgent プローブと build）は 1 コマンドで再実行できる。

```sh
skills/wordpress-to-200stack/kit/e2e/spike/run-spike.sh
```

プローブだけを実行する場合は `--probe-only`、build だけを実行する場合は `--build-only` を付ける。build 成功後は `out/index.html` が生成される。
