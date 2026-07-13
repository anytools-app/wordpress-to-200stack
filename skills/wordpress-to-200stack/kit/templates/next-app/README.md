# wp-static-kit Next.js skeleton

WordPress から生成した IR を、microCMS と Next.js 静的エクスポートへつなぐ案件開始用の雛形です。見た目の CSS や案件固有コンポーネントは含みません。

## このテンプレートが保証すること

- `routes.json` 台帳から静的な catch-all ルートを全生成します（`/` は `src/app/page.tsx`）。未登録パスは出力しません。
- ビルド時に microCMS を API ごとに `limit=100` / `offset` で全件取得し、IR と `contentId` で突き合わせます。
- `WPKIT_DATA_SOURCE=ir` なら microCMS を使わず `documents.ndjson` だけでビルドできます。
- legacy HTML は `LegacyHtml` だけで描画し、script・イベント属性を除去します。iframe は許可ホスト以外を除去します。
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
2. テンプレートコンポーネント、CSS、header/footer、一覧ページ、フォームの実際の項目を実装する。
3. `NEXT_PUBLIC_SITE_URL`、メディアホスト、iframe 許可ホストを案件の値にする。
4. `WPKIT_DATA_SOURCE=ir npm run build` をまず通し、入稿後は microCMS モードでもビルドする。

`registry.ts` 未登録の API は `ArticleTemplate`（title + legacyBodyHtml）で表示されます。`NotImplemented` は案件側のテンプレート作成中に明示的な未実装表示を出したい場合に利用できます。
