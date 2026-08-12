# ゴールデンケース E2E walkthrough

このチュートリアルは、このスキルで初めて移行を担当するオペレーターが、実案件の前に golden ケースの全工程を一度自分で通すためのものです。実案件のデータやアカウントは使いません。機械 E2E は通常1分未満、ここで手を動かす一巡は読む時間を含めて1〜2時間を目安にしてください。

## 前提と mock の境界

リポジトリを clone し、Node.js 24 系で次を実行します。Playwright のブラウザはこの walkthrough と golden E2E には不要です。

```bash
cd skills/wordpress-to-200stack/kit
npm ci
cd templates/next-app && npm install
cd ../..
npm run e2e
```

最初に `8 tests` がすべて成功することを確認します。以後のコマンドもこの `kit/` をカレントディレクトリとして実行し、生成物は gitignore 済みの `_scratch/walkthrough/` だけに置きます。

- archive は実クロールせず、実出力と同じ形式の `e2e/fixtures/archive/` を使います。
- microCMS の schema 登録、content import、media upload は書き込みません。機械 E2E の工程4が注入 mock で保証します。手動では `import --dry-run` を使います。実案件では microCMS Hobby 無料枠でも開始できます。
- テンプレート build は機械 E2E の工程8が MockAgent 注入で実行します。手での確認は `npm run e2e` のログと `e2e/golden.test.ts` の工程8を読みます。`e2e/spike/run-spike.sh` は spike 遺構であり、本編には使いません。
- 200stack への publish はこのチュートリアルのスコープ外です。ゲート8は公開判断を説明するだけです。

最初に作業変数を設定します。台帳の証跡パスは案件ルートから `_scratch/` を基準にするため、この walkthrough ディレクトリの中にも `_scratch/` を作ります。

```bash
WORK=_scratch/walkthrough
mkdir -p "$WORK/_scratch" "$WORK/site/src/data" "$WORK/docs"
cp -R e2e/fixtures/archive "$WORK/_scratch/archive"
```

期待値は `e2e/fixtures/expected/*.json`、入力は `e2e/fixtures/golden-wxr.xml` と `e2e/fixtures/golden-mapping.config.ts` です。

## 0. archive — 現行凍結

このケースでは上の `cp` が archive の代替です。`$WORK/_scratch/archive/inventory.json` に3 URL、各 `pages/*/page.html` と desktop/mobile screenshot があることを確認します。

```bash
node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).urls.length' "$WORK/_scratch/archive/inventory.json"
```

出力が `3` なら合格です。所要は2分です。実案件では `npm run wpkit -- archive <https://origin> -o _scratch/archive` を使い、このコピーでは代替できません。

## 1. analyze — WXR の棚卸し

```bash
npm run wpkit -- analyze e2e/fixtures/golden-wxr.xml -o "$WORK/_scratch/analysis"
```

`$WORK/_scratch/analysis/census.json` を `e2e/fixtures/expected/census.json` と比較し、`car` は publish 2 / draft 1、attachment は1であることを見ます。`scf-definitions.json` は同 expected と一致し、`Car fields` に `gallery` と `details` があることが合格です。所要は5分です。不正制御文字を含む入力でも analyzer がサニタイズするため、golden WXR の警告0は実案件の警告0を意味しません。

## 2. mapping — 移行判断の承認

golden の mapping は読むだけです。`e2e/fixtures/golden-mapping.config.ts` を開き、`cars` と `pages`、`contentIdStrategy: "legacySlug"`、`wpautop` 既定有効を確認します。台帳は機械証跡がそろう工程5で初期化してまとめて承認します。

```bash
sed -n '1,120p' e2e/fixtures/golden-mapping.config.ts
```

`cars` と `pages` の API 定義、および `legacySlug` が確認できれば合格です。所要は10分です。`--by` は実案件では承認者名に置き換え、設定の製品判断なしに承認しません。

## 2.5. scf-fields — SCF 定義の復元

工程1の `analysis/scf-definitions.json` がこのゲートの機械証跡です。`e2e/fixtures/expected/scf-definitions.json` と比較して、`gallery` が repeat で `image` / `caption`、`details` が `price` を持つことを確認します。

追加コマンドはありません。`status` で scf-fields が `done` であることを確認します。所要は5分です。実案件で SCF 定義が無いことと、復元に失敗したことは区別し、前者だけを mapping の判断で除外します。

## 3. parse — IR と URL 検証

```bash
npm run wpkit -- parse --config e2e/fixtures/golden-mapping.config.ts -o "$WORK/_scratch/ir"
```

`$WORK/_scratch/ir/validation-report.json` の `errors` が空、`routes.json` が3件であることを確認します。`e2e/fixtures/expected/parse.json` のとおり `raw-autop` は paragraph 2、break 2 です。所要は10分です。warnings は golden で7件出るため、errors 0 と取り違えません。実案件では validation error をゼロにしてから次へ進みます。

## 4. media — remote-cache から変換

golden E2E と同じくネットワークを使わず、2x2 JPEG を remote-cache へ充填します。次の短い Node スクリプトは cache の `.bin` / `.json` を URL の SHA-1 名で作ります。

```bash
WORK="$WORK" node --import tsx --input-type=module <<'NODE'
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { collectReferencedMediaUrls } from "./src/media/transform.ts";
const work = process.env.WORK;
const documents = (await readFile(join(work, "_scratch/ir/documents.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#336699" } }).jpeg().toBuffer();
const cache = join(work, "_scratch/remote-cache");
await mkdir(cache, { recursive: true });
for (const url of collectReferencedMediaUrls(documents)) {
  const key = createHash("sha1").update(url).digest("hex");
  await Promise.all([writeFile(join(cache, `${key}.bin`), image), writeFile(join(cache, `${key}.json`), JSON.stringify({ url, status: 200, contentType: "image/jpeg" }))]);
}
NODE
npm run wpkit -- media transform --ir "$WORK/_scratch/ir" --cache "$WORK/_scratch/remote-cache" --out "$WORK/site/public/media" --manifest "$WORK/site/src/data/media-manifest.json"
```

`media-manifest.json` の `missing` が空、entries が2件（`expected/media.json`）なら合格です。所要は10分です。cache の URL や content type が合わないと missing になるので、実案件で remote-cache を手で作らず `media pull` を使います。

## 5. schema-import — schema と dry-run import

```bash
npm run wpkit -- schema gen --config e2e/fixtures/golden-mapping.config.ts -o "$WORK/_scratch/microcms-schema"
npm run wpkit -- import --ir "$WORK/_scratch/ir" --config e2e/fixtures/golden-mapping.config.ts --dry-run
```

`microcms-schema/cars.schema.json` と `pages.schema.json` を `expected/schema.json` と比較し、API が `cars` / `pages` であることを確認します。dry-run は `wouldUpload: 3`、`wouldAutoAssign: 1`、`provisional: 1`、`failures: []` を返し、HTTP 書き込みはしません。所要は15分です。台帳の初期化と3つの承認は、後続の機械証跡もそろう工程7でまとめて行います。実書き込みの POST / PUT / PATCH、provisional ID と relation PATCH は `golden.test.ts` の工程4で mock 検証するため、このチュートリアルでは代替します。

## 6. implement — テンプレート build

このゲートの機械証跡は `site/out` です。golden E2E の工程8が、テンプレートを一時 site にコピーし、microCMS 応答を MockAgent で `microcms-contents.json` に置換して build します。

```bash
npm run e2e
sed -n '/it("8\. builds/,/}, 300_000)/p' e2e/golden.test.ts
cp -R e2e/fixtures/expected-out/. "$WORK/site/out/"
```

E2E が8/8、ログに `[wpkit-e2e] intercept hit`、工程8の `site/out/index.html` existence assertion があることを確認できれば合格です。続く copy は fixture の静的出力を工程7の手動 verify 用に置くだけで、build の代替証拠は E2E の工程8です。工程7ではこのsite自体を一時Git repoとしてcommitし、copy後の`out/`からartifactを作るため、親repoのignored directoryをsource bindingとして誤用しません。所要は10分です。実アカウントを設定して build しないことがこのケースの意図です。

## 6.5. fidelity — 見た目の承認

golden の archive は最小 HTML なので、人の視覚比較は行いません。`e2e/fixtures/golden-blocks.config.json` を読み、`/`、`/about/`、`/cars/raw-autop/` の3 surface が `templates/next-app/blocks.config.json` と同じ `{ common, surfaces }` 形式で定義されることを確認します。

```bash
node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).surfaces.map((s) => s.path).join("\n")' e2e/fixtures/golden-blocks.config.json
```

3 path が出力されれば合格です。承認は工程7で証跡とまとめて行います。所要は10分です。実案件では archive screenshot と実レンダリングを比較し、`docs/fidelity-approvals.json` に測定・承認を残します。

## 6.6. theme-crosscheck — 原文テーマとの突き合わせ

golden はテーマ一式を持たないため、ここは説明のみです。承認は工程7で証跡とまとめて行います。theme-crosscheck が最終 status で `approved` ならチュートリアル上の合格です。所要は5分です。実案件では `_scratch/wp-theme/` の PHP / CSS / JS と archive を照合し、条件分岐・enqueue・動き・フォームを確認してから承認します。

## 7. verify — 新旧照合と scorecard

fixture の archive と static output を照合し、E2E と同じ scorecard の最小証跡を stage して実行します。ここで作る `site/out` は工程6でコピーした fixture であり、実 template build の検証は引き続き E2E 工程8が担当します。

```bash
npm run wpkit -- verify --old "$WORK/_scratch/archive" --new "$WORK/site/out" -o "$WORK/_scratch/verify-site"
cp -R templates/next-app/scripts "$WORK/site/"
cp templates/next-app/package.json templates/next-app/package-lock.json templates/next-app/.gitignore "$WORK/site/"
cp templates/next-app/fidelity-audit.config.json templates/next-app/fidelity-decisions.config.json "$WORK/site/"
cp templates/next-app/routing-config.jsonc "$WORK/site/"
ln -s "$(pwd)/templates/next-app/node_modules" "$WORK/site/node_modules"
cp e2e/fixtures/golden-scorecard.config.json "$WORK/scorecard.config.json"
WORK="$WORK" node --input-type=module <<'NODE'
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const work = process.env.WORK;
await mkdir(join(work, "_scratch/fidelity"), { recursive: true });
await writeFile(join(work, "site/src/data/legacy-routes.json"), JSON.stringify([{ path: "/" }, { path: "/about/" }, { path: "/cars/raw-autop/" }], null, 2));
await writeFile(join(work, "docs/fidelity-approvals.json"), JSON.stringify({ approvals: ["/", "/about/", "/cars/raw-autop/"].map((surface) => ({ surface, date: "2020-01-05", by: "golden-e2e", measurements: { source: "site/_scratch/fidelity/archive-built-audit.json" } })) }, null, 2));
await writeFile(join(work, "_scratch/fidelity/surfaces-summary.json"), JSON.stringify({ surfaces: ["/", "/about/", "/cars/raw-autop/"].map((surface) => ({ surface })) }, null, 2));
await writeFile(join(work, "_scratch/media-map.json"), "{}\n");
const routes = ["/", "/about/", "/cars/raw-autop/"];
for (const route of routes) {
  const built = route === "/" ? join(work, "site/out/index.html") : join(work, "site/out", ...route.slice(1, -1).split("/"), "index.html");
  const target = join(work, "_scratch/archive/pages", encodeURIComponent(route), "page.html");
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, await readFile(built));
}
await writeFile(join(work, "_scratch/archive/inventory.json"), JSON.stringify({ urls: routes.map((route) => ({ url: `https://example.invalid${route}`, status: 200 })) }, null, 2));
NODE
(cd "$WORK/site" && git init --quiet && git add . && git -c user.name=wpkit-walkthrough -c user.email=wpkit@example.invalid commit --quiet -m "walkthrough source")
(cd "$WORK/site" && node scripts/build-artifact.mjs create)
WORK="$WORK" node --input-type=module <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const work = process.env.WORK;
const artifact = JSON.parse(await readFile(join(work, "site/_scratch/build-artifact.json"), "utf8"));
const binding = { buildHash: artifact.buildHash, fileCount: artifact.fileCount, bytes: artifact.bytes, source: artifact.source };
await writeFile(join(work, "docs/quality-attestations.json"), JSON.stringify({ "static-export": { date: "2020-01-05", by: "golden-e2e", binding, values: { network: false } } }, null, 2));
NODE
npm run wpkit -- scorecard --config "$WORK/scorecard.config.json"
npm run wpkit -- status init --dir "$WORK"
npm run wpkit -- status approve mapping --by walkthrough --dir "$WORK"
npm run wpkit -- status approve media --by walkthrough --dir "$WORK"
npm run wpkit -- status approve schema-import --by walkthrough --dir "$WORK"
npm run wpkit -- status approve fidelity --by walkthrough --dir "$WORK"
npm run wpkit -- status approve theme-crosscheck --by walkthrough --dir "$WORK"
npm run wpkit -- status --dir "$WORK"
```

artifact作成stdoutが`PASS`でvalid commit/dirty/worktreeHashを持ち、archive-built reportとscorecardが同じfull bindingを参照することを確認します。verify の stdout が `checked: 3`、missing / metaMismatches / brokenLinks がすべて0で、`$WORK/_scratch/scorecard/scorecard.json` の overall が `PASS`、status の verify が `done` なら合格です。`out/`を1 byte変え、artifactを再生成した場合でもarchive-built/scorecardは差分でFAILするのが工程8のmutation回帰です。所要は10分です。実案件では fixture copyを使わず、実buildの`site/out`と案件のscorecard configを使います。

## 8. publish — 200stack 公開

このチュートリアルでは公開しません。`publish` は pending のままが正しい状態です。

```bash
npm run wpkit -- status --dir "$WORK" --json
```

手動で通した archive / analyze / mapping / scf-fields / parse / media / schema-import / fidelity / theme-crosscheck / verify と、E2E が mock build で代替した implement の境界を確認します。実案件でのみ、200stack の deploy、公開 URL、redirect、監視を確認した後に `npm run wpkit -- status approve publish --by <名前>` を実行します。所要は5分です。
