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
- `BUILD_MEMORY_LIMIT_MB`

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
npm run verify:t6
npm run verify:routes
npm run verify:seo
npm run verify:stylesheets
npm run verify:webvitals-preload
```

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

`--record` は機械化済みの結果を `docs/live-review.json` の `scenarios` へ転記します。`reviewer` と
`findings` は人が記入します。exit code は全 pass が 0、scenario fail が 1、config・build・環境エラーが 2 です。
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
`measurements` (source は生成した JSON) へ転記して承認します。承認判断そのものは人が行います。
