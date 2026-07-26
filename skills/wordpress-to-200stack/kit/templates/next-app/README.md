# wp-static-kit Next.js skeleton

WordPress から生成した IR を、microCMS と Next.js 静的エクスポートへつなぐ案件開始用の雛形です。見た目の CSS や案件固有コンポーネントは含みません。

## このテンプレートが保証すること

- `routes.json` 台帳から静的な catch-all ルートを全生成します（`/` は `src/app/page.tsx`）。未登録パスは出力しません。
- ビルド時に microCMS を API ごとに `limit=100` / `offset` で全件取得し、IR と `contentId` で突き合わせます。
- `WPKIT_DATA_SOURCE=ir` なら microCMS を使わず `documents.ndjson` だけでビルドできます。
- microCMS 由来の記事本文の legacy HTML は `LegacyHtml` だけで描画し、script・イベント属性を除去します。iframe は許可ホスト以外を除去します。
- 固定ページは microCMS や catch-all に含めず、App Router の `page.tsx` + CSS Modules + `metadata` で実装します。
- SEO メタ、sitemap、robots、確認画面付きフォーム、検索用の最小 JSON を備えます。

## 配置と起動

`wpkit parse` の出力を、展開先の `site/` に対して次のように置きます。

```
project/
  ir/
    documents.ndjson
    routes.json
  site/                 # このテンプレートを cp -R した場所
```

```sh
cd project/site
cp .env.example .env.local
npm install
WPKIT_DATA_SOURCE=ir npm run build
```

IR の場所が異なる場合は `WPKIT_IR_DIR=/absolute/or/relative/ir` を指定してください。IR モードでは `MICROCMS_SERVICE_DOMAIN` と `MICROCMS_API_KEY` は不要です。ローカル確認は同じ環境変数を付けて `npm run dev` を実行します（起動前にデータを生成します）。

microCMS を使う通常ビルドでは `.env.local` に `MICROCMS_SERVICE_DOMAIN` とサーバー専用の `MICROCMS_API_KEY` を設定し、`npm run build` を実行します。取得結果は `.next-data/` にだけ保存され、公開されません。

## 案件側で行うこと

1. `src/templates/registry.ts` に API / kind ごとのテンプレートと、公開してよい検索フィールドを登録する。
2. 記事テンプレート、header/footer、一覧、フォームを実装し、固定ページは `src/app/<route>/page.tsx` と `page.module.css` に書き起こす。
3. `NEXT_PUBLIC_SITE_URL`、メディアホスト、iframe 許可ホストを案件の値にする。
4. `WPKIT_DATA_SOURCE=ir npm run build` をまず通し、入稿後は microCMS モードでもビルドする。

`registry.ts` 未登録の API は記事用の `ArticleTemplate`（title + legacyBodyHtml）で表示されます。`NotImplemented` は案件側の記事テンプレート作成中に明示的な未実装表示を出したい場合に利用できます。これらを固定ページの描画には使いません。

## 固定ページの雛形方針

固定ページごとに次の App Router 標準構成を作ります。固定ページを一括再掲する共通コンポーネントや JSON データは、この雛形に含めません。

```text
src/app/<route>/
  page.tsx          # JSX と metadata（または generateMetadata）
  page.module.css   # このページに閉じたスタイル
```

アーカイブの `page.html` は文言・リンク・画像・構造の参照素材、desktop/mobile スクショは人間レビューの比較対象としてだけ使います。まず単純な1ページを書き起こし、dev と production build の両方で表示し、原文との対比スクショをレビューして指摘を反映します。パターンの承認後に複雑なページへ進みます。ピクセル一致は完了条件にしません。

画像は 1x/2x の `srcset` または同等のレスポンシブ指定を用意します。アーカイブのクロールは DPR 1 のため 2x 候補や `@2x` 資産を自動取得しません。保存 HTML から候補を列挙し、原点へ同じ URL を繰り返し要求しない fetch-once キャッシュ経由で補完します。

postbuild で body class/id を注入する仕組みや、アーカイブ HTML を実行時に再掲する仕組みは追加しません。dev と静的出力の乖離、原文側の素材欠陥の直伝播、ページ限定 CSS の漏れを避けるためです。記事系の `legacyBodyHtml` / `rewriteBodyMedia` は別の経路として維持します。
