# 実装フレームワークの選択

工程2のmappingと同時に `next` / `astro` を案件方針へ記録する。ユーザーの指定を優先し、既存案件は採用済みの方式を維持する。指定のない新規案件では従来と同じNext.jsを既定とする。Astroを指定された案件はAstroで実装する。途中のフレームワーク変更は別の移行として扱う。

| 項目 | Next.js | Astro |
|---|---|---|
| 展開 | `wpkit scaffold --framework next --out-dir ../site` | `wpkit scaffold --framework astro --out-dir ../site` |
| 固定ページ | `src/app/<route>/page.tsx` | `src/pages/<route>/index.astro` |
| 記事・一覧 | `generateStaticParams` / `[id]` / APIごとの一覧 | `getStaticPaths` / `[...path].astro`。一覧・ページ送りは `paginate` で案件ごとに実装 |
| スタイル | CSS Modules | `.astro` のscoped `<style>` またはCSS Modules |
| head | `metadata` / `generateMetadata` | `SiteLayout.astro` のpropsとhead slot |
| リンク | `SiteLink.tsx` + `next/link` | `SiteLink.astro` + 通常の `<a>`。Reactテンプレ内も通常の `<a>` |
| 取得 | Next Data Cache + Promise snapshot | ビルド時fetch + Promise snapshot。devは5秒TTL |
| 静的出力 | `output:"export"` / `trailingSlash:true` | `output:"static"` / `trailingSlash:"always"` / `build.format:"directory"` |
| 出力先 | `out/` | `out/` (Astro既定の `dist/` から変更) |
| 公開origin | `NEXT_PUBLIC_SITE_ORIGIN` | `PUBLIC_SITE_ORIGIN` |
| ドラフト | React CSRシェル | `/preview/` のReact island (`client:only="react"`) |

## Astroの展開と実装

Astroひな形にはNode.js >=22.23.4が必要。kitから実行する。出力先は新規ディレクトリを指定する。同名の既存ファイル・ディレクトリ・リンクは上書きしない。

```bash
npm run wpkit -- scaffold --framework astro --out-dir ../site
cd ../site
npm ci
npm run format
cp .env.example .env
# origin、サービス名、読み取りキーを設定し、API IDとsurface対応を編集
npm run dev
```

`kit/templates/astro-app` はAstro固有の差分。scaffoldはNext側で管理する共通監査スクリプト、データ型、正規化、repository、画像helper、サニタイザ、記事registryと組み合わせ、単独で動くサイトを生成する。Astroディレクトリの `cp -R` だけでは共通ファイルが揃わないため、必ずscaffoldを使う。

- `src/lib/content/microcms-document.ts` の `MICROCMS_APIS` とAPI→surface対応を設定する。空の初期値は空サイトのひな形であり、実案件の完成ではない
- 固定ページは `.astro` に直接書く。記事は `DocumentView` → `src/templates/registry.ts` のReactテンプレをビルド時HTMLとして出力する。記事をReactにしているのは公開ページとドラフトで同じレンダラを使うため。公開記事にはhydrationを付けない
- `/preview/` だけReact islandを起動する。公開してよい専用GETキーだけを `PUBLIC_MICROCMS_PREVIEW_KEY` に設定し、ビルド取得キー `MICROCMS_API_KEY` はprivateのままにする。既存サービスの権限やキーは変更しない
- アニメーションやフォームはAstroの `<script>` と標準DOM API、必要な箇所だけislandsを使う。App Router、`next/link`、`generateMetadata`、Next Data Cache、React Client Componentの制約をAstroへ持ち込まない
- `.astro` のscoped styleは子のReactテンプレ内へ自動で適用されない。記事のCSSはReact側のCSS Moduleで所有し、本文HTMLへの規則だけ親root下の明示的なglobal selectorを使う
- Astroの通常の全画面遷移を既定とする。ClientRouterを追加する場合はscriptの再実行・イベント解除・戻る操作を別途検証する
- CMS由来の本文だけ `LegacyHtml` のサニタイザを通す。固定ページや記事全体を保存HTMLで再掲しない
- `SiteLayout.astro` の言語、metadata、OGP/Twitter画像・構造化データを案件のSEO契約へ合わせる。初期サンプルは契約がdraftなのでSEO PASSにならない
- 旧URLの301は `routing-config.jsonc` / 200stack側で維持する。Astroのstatic redirect HTMLをHTTP 301の証拠にしない
- CMS更新後はwebhookで再ビルドする。静的成果物への実行時サーバーAPI・SSR adapterは前提にしない

## 共通の検証

`typecheck` / `lint` / `build` / `artifact:verify` / `verify:archive-built` / `verify:t6` / `verify:routes` / `verify:seo` / fidelity / scorecardは両方式で必須。Astroも出力を `out/` へ統一しているので `wpkit scorecard init --site ../site` とstatusの既定をそのまま使う。生成サイトは案件Gitリポジトリ内に置く。`npm run build` は成功した静的出力のartifactを作り、ソース・成果物と検証証跡を束縛する。

フレームワークの選択だけで既存の文言・属性・URL・フォーム・ピクセル比較・公開承認のゲートは緩和しない。Astroのテストは `kit/templates/astro-app` で `npm ci` 後、kitの `npm run e2e` でNextと併せて実行する。

公式仕様: [Astro設定](https://docs.astro.build/en/reference/configuration-reference/)、[ルーティング](https://docs.astro.build/en/guides/routing/)、[環境変数](https://docs.astro.build/en/guides/environment-variables/)、[React integration](https://docs.astro.build/en/guides/integrations-guide/react/)。
