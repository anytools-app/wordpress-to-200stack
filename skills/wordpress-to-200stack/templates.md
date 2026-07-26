# wp-migrate テンプレート集

## mapping.config.ts の書式(実例はパイロット案件リポジトリの mapping.config.ts が最良の参照)

```ts
import { defineMigration } from "./wp-static-kit/src/config.js";

export default defineMigration({
  wxr: "<WXRの絶対パス>",
  site: { origin: "https://www.example.jp", mediaHost: "https://media.example.jp" },
  exclude: {
    postTypes: ["<移行しない型>", "page"],   // page をコード実装するなら除外
    statuses: ["draft", "private"],
  },
  linkCheck: {
    assumeExistPostTypes: ["page"],          // 除外してもURLは存在し続ける型
    assumeExistPaths: ["/<コード実装するパス>"], // コード実装する一覧ページ等
  },
  apis: {
    <api名>: {
      from: "<post_type>" | ["<型A>", "<型B>"],  // 複数なら kindField 必須
      kindField: "kind",
      fields: [
        { metaKey: "<metaキー>", fieldId: "<camelCase>", type: "string|text|html|number|boolean|date|image|stringArray|select", label: "<管理画面表示名>" },
      ],
      repeaters: [
        { fieldId: "<複数形>", label: "<表示名>", columns: [ /* FieldDef。metaKey が zip 対象 */ ] },
      ],
      relations: [
        { metaKey: "<wp_idを持つmetaキー>", fieldId: "<camelCase>", toApi: "<参照先api>" },
      ],
      featuredImage: true,      // _thumbnail_id がある型のみ
      taxonomies: ["<taxonomy>"],
      body: "none",             // 本文を持たない型のみ指定(デフォルトは legacyBodyHtml)
    },
  },
  seo: { yoast: true },
  embeds: { allowIframeHosts: ["www.youtube.com", "player.vimeo.com", "calendar.google.com"] },
});
```

型の決め方チェックリスト(サンプル実値を見てから):

- [ ] 画像系 meta の値は attachment ID(数値)か URL か → どちらも `type: "image"`
- [ ] wp_id 参照(author, item_no, *_item 等)→ relations へ
- [ ] "0"/"1" は boolean、価格・進捗は number(単位をコメントに書く)
- [ ] 同名 meta の複数出現: 単独キーなら stringArray、複数キーの組なら repeater
- [ ] リピータの columns は SCF 定義(`_scratch/analysis/scf-definitions.json`)の repeat グループと一致させる

## テンプレ実装指示書の雛形(delegate で Codex へ)

```markdown
# 実装指示書: <テンプレ名>(例: 記事詳細)

## 目的
site/ の Next.js(静的エクスポート)に <route パターン> の表示テンプレートを実装する。
デザインは現行サイトの忠実再現。凍結済みの基準データを正とする:
- スクショ: _scratch/archive/pages/<page>/desktop.png / mobile.png
- HTML: _scratch/archive/pages/<page>/page.html(class 構成・マークアップの参考)
- データ: _scratch/ir/documents.ndjson の api=<api> のレコード(フィールドは mapping.config.ts 参照)

## 実装
- site/src/templates/<Name>Template.tsx を作成し registry.ts に登録
- 表示項目: <フィールド → 画面要素の対応表>
- 画像は移行後のメディア URL 文字列。next/image は unoptimized 設定済み
- 既存 CSS(site/src/styles/legacy/)のクラスを流用し、新規 CSS は最小限

## 検証
- WPKIT_DATA_SOURCE=ir で next build が通ること
- <代表 URL 2〜3件> の出力 HTML にタイトル・価格・ギャラリーが含まれること

## 禁止
- site/ 外の変更、依存追加、コミット
- styles/legacy/ のルール削除・大規模なセレクタ書き換え・値の統一(CSS モダナイズは移行スコープ外 → modernize.md)
```

## 固定ページ実装指示書の雛形(delegate で Codex へ)

```markdown
# 実装指示書: 固定ページ <route>

## 目的
固定ページを microCMS やアーカイブ HTML の再掲ではなく、App Router の通常ページとして書き起こす。
参照素材:
- スクショ: _scratch/archive/pages/<page>/desktop.png / mobile.png
- HTML: _scratch/archive/pages/<page>/page.html(文言・リンク・画像・構造の参考のみ)

## 実装
- `site/src/app/<route>/page.tsx`、`page.module.css`、ページ固有の `metadata` を実装する
- 固定ページ固有の CSS を Global CSS や別ページへ一般化しない
- 画像は 1x/2x の `srcset` または同等のレスポンシブ指定を持たせ、未回収の `@2x` は fetch-once キャッシュ経由で補完する
- アーカイブ原文 HTML の再掲データ、汎用再掲コンポーネント、postbuild の body 属性注入を追加しない

## 検証とレビュー
- dev サーバーと production build の両方で対象ルートを確認する
- desktop/mobile の実装スクショを原文スクショと並べて提出する
- ピクセル一致を完了条件にせず、人間レビューの指摘を反映して同じページを再確認する
- 単純なページでパターンを承認してから、複雑な固定ページへ進む

## 禁止
- site/ 外の変更、依存追加、コミット
- 記事系 `legacyBodyHtml` / `rewriteBodyMedia` の変更
```

## 切替チェックリスト(コピーして案件 issue に)

- [ ] コンテンツ凍結の合意(日時)
- [ ] 最終 WXR で analyze→parse→import 差分実行
- [ ] media pull 差分 → R2 push
- [ ] 固定ページの `srcset` 1x/2x と `@2x` 資産を照合し、DPR 1 の archive で未回収の候補を fetch-once で補完
- [ ] verify(スクショ込み)エラー0・差分トリアージ済み
- [ ] microCMS webhook → ビルドフック接続確認(テスト更新→自動デプロイ)
- [ ] メディアドメイン DNS・SSL 確認
- [ ] 本番 DNS 切替 → 404/フォーム/画像の監視
- [ ] 旧サーバーはリードオンリーで保持(ロールバック期限を決める)
