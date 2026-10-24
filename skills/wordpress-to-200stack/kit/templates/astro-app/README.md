# Astro 静的サイトひな形

kitで `npm run wpkit -- scaffold --framework astro --out-dir ../site` を実行して展開する。このフォルダだけをコピーせず、共通CMS層・監査スクリプトと合成して使う。

Node.js >=22.23.4、npmが必要。生成サイトで `npm ci`、`.env.example` を `.env` へコピーし、`PUBLIC_SITE_ORIGIN`、privateの `MICROCMS_SERVICE_DOMAIN` / `MICROCMS_API_KEY` を設定する。`src/lib/content/microcms-document.ts` のAPI IDとsurface対応を編集する。初回展開後は `npm run format` で共通ソースをAstro側の書式にそろえる。

- `npm run dev`: 開発サーバー
- `npm run typecheck`: Astro/TypeScript/Reactの検査
- `npm run format` / `npm run lint`: Astroを含むソースのformat / 検査
- `npm run build`: 静的HTMLを `out/` へ生成し、案件Gitソースに束縛したartifactを作る
- `npm run start`: ビルド済み成果物のプレビュー
- `npm run artifact:verify` / `npm run verify:archive-built` / `npm run verify:seo` / `npm run verify:routes`: 共通品質ゲート

固定ページは `src/pages/` の `.astro`、記事は `getStaticPaths` + `src/templates/` のReactレンダラ(公開時はHTMLのみ)、プレビューは同じレンダラを使うReact island。本文は共通サニタイザを通す。動的な一覧・ページ送り、言語、OGP画像などは案件ごとに実装する。

`PUBLIC_MICROCMS_PREVIEW_KEY` はブラウザに公開される専用GETキーのみ設定する。privateのビルドキーは入れない。previewはnoindexかつsitemap対象外。SEO契約の初期値はdraftなので、build成功は移行完了や公開可能を意味しない。
