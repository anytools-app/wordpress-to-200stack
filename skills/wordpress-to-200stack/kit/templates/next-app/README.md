# wp-static-kit Next.js skeleton

microCMS を唯一のコンテンツ正本にする Next.js App Router / static export 雛形です。
旧サイトの保存データは実行時も build 前処理でも読みません。固定ページはネイティブ
JSX + CSS Modules、CMS 詳細は surface ごとの動的 segment、taxonomy/archive だけを
残余 catch-all で実装します。

残余 catch-all は `src/app/[...path]/page.tsx.example` として同梱しています。
`output: "export"` は `generateStaticParams` が空配列のルートを
「missing generateStaticParams」としてビルド失敗させる(Next 16 実測)ため、
必要になったら `RESIDUAL_ARCHIVES` を埋めてから `page.tsx` へリネームしてください。

## 起動

```sh
cp .env.example .env.local
npm install
npm run dev
npm run build
```

最低限 `MICROCMS_SERVICE_DOMAIN` とサーバー専用 `MICROCMS_API_KEY` が必要です。
公開 URL は `NEXT_PUBLIC_SITE_ORIGIN`、画像配信先は `NEXT_PUBLIC_MEDIA_HOST` に設定します。
実装済み preview を使う場合だけ、読み取り専用キーを
`NEXT_PUBLIC_MICROCMS_PREVIEW_KEY` に設定します。書き込み権限のあるキーを公開変数へ
入れないでください。

環境変数は次だけを標準契約とします。

- `MICROCMS_SERVICE_DOMAIN`
- `MICROCMS_API_KEY`
- `NEXT_PUBLIC_MICROCMS_SERVICE_DOMAIN`
- `NEXT_PUBLIC_MICROCMS_PREVIEW_KEY`
- `NEXT_PUBLIC_MEDIA_HOST`
- `NEXT_PUBLIC_SITE_ORIGIN`
- `WPKIT_ARCHIVE_DIR`
- `WPKIT_INVENTORY`
- `WPKIT_MEDIA_MAP`
- `WPKIT_OUT_DIR`
- `WPKIT_BUILD_ARTIFACT`
- `WPKIT_ORIGIN`
- `BUILD_MEMORY_LIMIT_MB`

archive-built auditで`WPKIT_ARCHIVE_DIR`を指定した場合、`WPKIT_INVENTORY`を明示しなければ
inventoryはoverride先の`inventory.json`を使います。別directoryのinventoryを暗黙に混ぜません。
`WPKIT_INVENTORY`を指定した場合だけ、その明示パスが優先されます。

## API / surface の追加順

1. `src/templates/registry.ts` に API / kind の描画テンプレートを登録する。
2. `src/app/<surface>/page.tsx` の一覧と `src/app/<surface>/[id]/page.tsx` の詳細を作る。
   詳細では `surface-detail.tsx` の params / metadata / render を共有し、
   `dynamicParams = false` を必ず宣言する。
3. `src/lib/content/microcms-document.ts` の `MICROCMS_APIS` と、必要なら
   `SURFACE_BY_API`、taxonomy・案件フィールドの正規化を更新する。
4. 一覧・詳細・`src/app/sitemap.ts` が同じ `ContentRepository` snapshot を参照する。
5. 実装済み `/preview/` で registry 対象の API・template を確認し、`noindex` と
   sitemap 除外を `verify:seo` で確認する。

詳細ページの最小形:

```tsx
import {
  renderSurfaceDetail,
  surfaceDetailMetadata,
  surfaceDetailParams,
  type SurfaceDetailPageProps,
} from "@/lib/content/surface-detail";

const API = "news";
export const dynamicParams = false;
export const generateStaticParams = () => surfaceDetailParams(API);
export const generateMetadata = async ({ params }: SurfaceDetailPageProps) =>
  surfaceDetailMetadata(API, (await params).id);
export default async function Page({ params }: SurfaceDetailPageProps) {
  return renderSurfaceDetail(API, (await params).id);
}
```

内部リンクは必ず `SiteLink` を使います。`/` 始まりかつ `//` でなく、
`target="_blank"` でないものだけ `next/link` へ渡します。

## build と検証

build wrapper は開始時に `.next/cache/fetch-cache` を消し、1 build 中は
microCMS の fetch を `revalidate:false` で凍結します。
`BUILD_MEMORY_LIMIT_MB` がある環境では webpack、worker 制約、V8 heap 上限を有効にします。

```sh
npm run typecheck
npm run lint
npm run build
npm run artifact:verify
npm run verify:archive-built
npm run verify:t6
npm run verify:routes
npm run verify:seo
npm run verify:stylesheets
npm run verify:webvitals-preload
```

`npm run build` は Next.js の export 成功後に `_scratch/build-artifact.json` を生成します。
artifact は `out/` の path+bytes による SHA-256、`fileCount`、`bytes`、Git source revision を持ち、
後続ゲートは同じ binding を使います。監査後を含め `out/` が1 byteでも変われば
`artifact:verify`、archive-built、scorecard、status は完了扱いにしません。
source revision は site 自身の Git commit、dirty 状態、scope付きworktree hashを必須とします。親repoの
ignore配下など追跡対象が0件のdirectoryではartifactを作れません。秘密をhash対象へ入れないよう `.env*` は
ignoreし、共有可能なキー名だけの `.env.example` だけを追跡してください。

### archive-built 忠実性ゲート

`fidelity-audit.config.json` の `origin`、`internalHosts`、`surfaceRules` と入力パスを案件に合わせ、
標準配置では案件rootの`../_scratch/archive`と`../_scratch/media-map.json`（対応がなくても `{}`）、site内の`src/data/media-manifest.json`、
`fidelity-decisions.config.json` を用意します。比較元は保存済み archive とローカル `out/` だけで、
このコマンドは現行 WordPress や外部 URL へアクセスしません。

route ledger の最小形は次です。`destination` のquery/fragmentも契約値で、collectorは削除しません。

```json
[
  { "path": "/section/", "archiveStatus": 200, "expected": { "type": "output" } },
  { "path": "/legacy/", "archiveStatus": 200, "expected": { "type": "redirect", "status": 301, "destination": "/current/?mode=full#section" } }
]
```

標準 collector は archive inventory、route ledger、built output の和集合を調べます。archive が非200なのに
built output があるroute、archive statusのないbuilt route、未追跡output、欠けたoutputは自動許可しません。
静的outputのpathname routeと、inventory/ledgerのquery・fragment付きURL intentは別に保持します。同一pathnameに
複数intent/status/expectedがあれば`url-intent-variants` Majorとして決定的なvariant一覧を出し、body比較は
query/fragmentなしのbase entryを優先します。
archive crawlerはredirect追跡後の200をinventoryへ記録するため、redirect同値判定は該当pageの`meta.json`にある
redirect chainの先頭statusと最終destinationを使います。複数hop、redirect側のmeta欠落、不一致、archive非200→output、
archive redirect→built output、本文200→redirectはいったんMajor observationとし、意図差ならそのexact observation hashをdecision ledgerへ記録します。
output側の古いarchiveにmetaが無いことだけでは比較を止めず、metaがあり`redirects: []`ならdirect 200と扱います。
各 archive status 200 route では body 全体（header/footer/common chrome とsurface外画像を含む）と、
設定した tracked surface の両方を比較します。静的DOMテキストは exact、whitespace-only、`<br>`、順序、実質差を
別 code にし、`hidden` / `aria-hidden="true"` の文言を除外します。これはcomputed CSS visibilityやJavaScript実行後の
表示状態ではありません。`script/style/template/noscript`、およびconfigの`excludeSelectors`（body全体とsurfaceの両方へ適用）
は対象外です。SVGの`title`/`text`を含む静的テキストは対象に残します。CSS/JS後の可視状態はPlaywright/CDP laneで別に測ります。一方、属性 lane は hidden UI とSVG本体も含め、
`alt`、全 `aria-*`、`title`、`placeholder`、`value`、`role`、`hidden` をstable element/media identityで比較します。
画像 identity は media map/manifest、リンク先、近傍context、occurrenceを組み合わせるため、同一画像を複数配置した
箇所で属性だけを入れ替えても検出します。`picture > source`の`srcset` / `sizes` / `media` / `type`も
child `img` identityのdelivery情報として比較します。
JSON-LDはobject key、`@graph`、script順を決定化して値全体を比較します。built側のparse errorはBlocking、
legacy archive側だけのparse errorは修復を許すMajor observationです。parseできた別scriptの値比較はparse error観測と独立して続けます。

意図的差分は次の全フィールドを持つ decision だけが抑制できます。hash、route、code、severity の完全一致が必要で、
invalid、unused、duplicate、mismatch decision は Blocking です。Blocking observation 自体は承認できません。
route単位の広いallowlistや文言置換の自動推測は標準経路にありません。

```json
{
  "schemaVersion": 1,
  "decisions": [{
    "observationHash": "64桁のSHA-256",
    "route": "/example/",
    "code": "element-attribute-delta",
    "severity": "Major",
    "status": "accepted",
    "rationale": "既存UIを変更する案件判断と根拠",
    "by": "判断者",
    "date": "2026-08-11"
  }]
}
```

実装ループでは `node scripts/archive-built-audit.mjs --only <surface-id>` を使い、common chrome →
代表surface → 同surface全件 → 全routeの順で範囲を広げます。`--only` は標準reportを上書きせず、
`<report-stem>.<surface-id>.partial.json`へpartial evidenceを書きます。非対象routeをsurface未設定扱いにせず、
partial runでは同一routeの別surfaceを含む全unmatched decisionのunused判定とfull-run用expectedCoverageを保留し、
full runだけでstale/unusedを確定します。invalid/duplicateと、今回の観測へhash一致したdecisionのmismatchはpartialでもBlockingです。
partial reportだけを公開判定証跡にしません。
選択したsurface ruleが実routeへ1ページも一致しないpartial runはBlockingです。
fidelity approvalのmeasurement sourceにarchive reportを指定する場合は、`selection.mode: "full"`、`result: "PASS"`、
`summary.unresolved: 0`とcurrent artifactのfull bindingがすべて一致する必要があります。
既存UIはstrict parityが既定です。既存属性の「改善」も observation hash decision が必要です。
新規UIだけは accessible name、form label、iframe title、ARIA参照、画像altの現行基準を別laneで検査します。

### 旧fidelity scriptからの移行

旧script名はaliasとして残しますが、責務とflagの意味は互換ではありません。wrapperは現在の
`--config` / `--only` / `--report`だけを新collectorへ渡し、historical flagまたは読み取り可能な旧config schemaを
受けた場合はexit 2と移行先を表示します。configの読み取り・JSON parse失敗は新collectorの通常エラーとして扱います。

| 旧入口 | historical flag / config | 移行先 |
| --- | --- | --- |
| `scripts/fidelity-static-audit.mjs` | `--archive-dir` / `--out-dir` / `--media-map` / `--scorecard` / `--evidence`、旧schemaの`--config <path>` / `--config=<path>` | `npm run verify:archive-built -- --config fidelity-audit.config.json [--only <surface-id>] [--report <path>]`。入力pathは新configまたは標準環境変数へ移す |
| `scripts/fidelity-text.mjs` | `--port` / `--evidence` | 同じ`verify:archive-built`へ移す。新標準は保存HTMLの静的DOM laneであり、旧Playwright visible-text実行へ読み替えない |

`forms.json` と `stylesheets.json` は凍結 archive 由来の契約です。更新は
`WPKIT_ARCHIVE_DIR=/absolute/archive npm run fixtures:update -- --approve` の承認付き操作だけを
使い、現行 `out/` から再生成しません。stylesheet fixture の `legacyStylesheets` は archive
から更新される「出力に残してはいけない旧CSS」、`expectedStylesheets` は人が最終構成を
レビューして手動承認する完全一致リストです。updater は既存の `expectedStylesheets` を保持し、
新規ページへ自動設定しません。

`verify:webvitals-preload` は preload URL と描画 URL の完全一致、およびローカル URL の
ファイル実在を検証します。オフライン実行を前提とするため remote URL の到達性は検証せず、
スキップしたことをレポートします。

案件リポジトリのルートで scorecard の品質定義を生成・コミットし、公開前に総合判定を確認します。

```sh
npm run wpkit -- scorecard init --site ../site
npm run wpkit -- scorecard --config ../scorecard.config.json
```

`scorecard.config.json` はコミットします。出力される `_scratch/scorecard/` は生成物のためコミットしません。
新規 `scorecard init` は build artifact、archive-built、artifact-bound fidelity/live review/a11y/Lighthouse をrequired gateとして生成します。
既存configは引き続き読み込めますが、新規strict configでは `measurements.source` が同一artifact bindingを持たない
fidelity approval、full artifact bindingのないlive review・quality attestation、監査中/監査後のoutput mutationはFAILです。
既存の`bindArtifact`未指定attestationは読み込み互換を維持します。

```json
{
  "a11y": {
    "date": "2026-08-11",
    "by": "reviewer",
    "binding": { "buildHash": "64桁SHA-256", "fileCount": 1, "bytes": 1, "source": { "commit": "40桁Git commit", "dirty": false, "worktreeHash": "64桁SHA-256" } },
    "values": { "violations": 0 }
  }
}
```

`routing-config.jsonc` は旧 URL の301正本です。`src/data/legacy-routes.json` の全 URL が
実出力または301先の実出力へ到達し、新ルート重複が0であることを `verify:routes` が検証します。

## 実機レビュー行動シナリオ(live-scenarios)

`npm run build` 済みであること、および初回だけ `npx playwright install chromium` を実行していることが前提です。
案件ルートで雛形をコピーし、`TODO(案件)` を実 selector・期待値へ置き換えます。

```sh
cp scripts/fixtures/scenarios.config.json scenarios.config.json
npm run live-scenarios
npm run live-scenarios -- --record
```

`--record` は機械化済みの結果を `docs/live-review.json` の `scenarios` へ転記し、検証済みartifactの
full `binding`（hash / fileCount / bytes / source revision）も同時に固定します。artifactがない、sourceや`out/`が
staleなら記録しません。`reviewer` と `findings` は人が記入します。exit code は全 pass が 0、scenario fail が 1、config・build・環境エラーが 2 です。
実機レビューで見つけた指摘は `scenarios.config.json` へ追加して再実行し、再発を防ぎます。誤設定でも
フォーム等が外部へ送信されないよう、127.0.0.1 / localhost 以外への非 GET/HEAD request はランナーが遮断します。

## fidelity ブロック計測

計測前に `WPKIT_ARCHIVE_DIR` と `WPKIT_ORIGIN` を設定し、`npm run build` で `out/` を作成します。
`blocks.config.json` は案件の selector 正本です。SKILL.md §6.5 の選定規則に従って各 `PLACEHOLDER` を
必ず実 selector へ置き換え、各エントリの `reason` を残します。

```sh
WPKIT_ARCHIVE_DIR=/absolute/path/to/archive \
WPKIT_ORIGIN=https://example.com \
node scripts/measure-blocks.mjs
```

`--only <surfaceId>`、`--viewport desktop|mobile`、`--port 8899`、`--strict` を必要に応じて指定できます。
結果は `_scratch/fidelity/blocks-<surface>.json` と `.md` に出力されます。exit code は、計測完了が 0、
config・archive・`out/`・selector・描画エラーが 1、`--strict` 時だけ非ゼロ dy / dh が残る場合が 2 です。
JSON の `nonZero` とブロック詳細を確認し、意図的差分だけを `docs/fidelity-approvals.json` の
`measurements` (source は生成した JSON) へ転記して承認します。measurement JSON 自体にも
current build artifact binding が記録されます。承認判断そのものは人が行います。
