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
デザインは現行サイトの忠実再現。完了条件はピクセル比較の収束 + 機能一致(フォーム・リンク・メタ)。
凍結済みの基準データを正とする:
- スクショ: _scratch/archive/pages/<page>/desktop.png / mobile.png
- HTML: _scratch/archive/pages/<page>/page.html(class 構成・マークアップの参考)
- データ: サンプル入稿済み microCMS の api=<api> レコード(フィールドは mapping.config.ts 参照)

## 実装
- `site/src/app/<surface>/page.tsx`(一覧)、`site/src/app/<surface>/[id]/page.tsx`(詳細)、
  `site/src/templates/<Name>Template.tsx`を実装しregistryへ登録する
- 詳細の`generateStaticParams`はmicroCMSから導出し、`dynamicParams = false`にする
- 表示項目: <フィールド → 画面要素の対応表>
- **原文テンプレ `_scratch/wp-theme/<template>.php` の条件分岐を実装に落とす**: クエリ条件
  (`meta_query` / `posts_per_page` / `orderby`)、空値のフォールバック(`&nbsp;` / `-` / 「ASK」)、
  値による出し分け、日付ウィンドウ。**スクショには写らないので原文を読むこと**
- **繰り返しブロックを固定配列に焼き込まない**。原文が`WP_Query`で引いていたものはrepository経由にする
- CSS所有権の意思決定木に従う: 単一サーフェス固有→そのCSS Module、共有クラスタ→`src/styles/`の共有Module、
  要素リセット・基本フォント→globals-reset、横断utility→専用ファイル。1ルール=1所有ファイル
- 内部リンクは`SiteLink`を使い、hrefはルート台帳の**新パス**にする(旧URLは301の入口であって行き先ではない)。素の`<a>`は外部・別タブだけ
- 自前カルーセルの非アクティブスライドは`aria-hidden`+`inert`。アイコンのみのリンクに`aria-label`
- 旧テーマCSS・原文CSS・ページ単位stylesheet読込を持ち込まない
- jQueryプラグイン(imgLiquid / slick / lity)の見た目はCSS + Reactで代替する(scroll-snap等)
- フォームはformrunのaction・input nameを原文と完全一致させる。SDK埋め込み型は同一form IDのembed div
- 原文のDOM順・視覚順を尊重する。構造の完全一致は要求しない

## 検証
- typecheck / lint / production buildが通ること
- <代表 URL 2〜3件> についてdesktop/mobileの原文比較を行い、ピクセル差分を収束させること
- フォームaction/name、内部/外部リンク、title/canonical/OGP/robotsを原文・台帳と照合すること
- DOMタグ実体数カウントは構造差の診断に使ってよいが、完了条件にしない(substringはRSCペイロードで2倍に見える)
- CSS・レイアウト変更は`css-visual-diff.mjs`のbefore/after capture→compareで退行0を確認すること
- axe-coreで本番アーカイブと比較し、**違反を増やしていない**こと(本番由来の違反は別issue)
- スクロール連動(IntersectionObserver)は**実際に描画される環境**で**段階的スクロール**により検証すること
  (瞬間ジャンプは高さ1pxの番兵を交差せず飛び越える)

## 禁止
- site/ 外の変更、依存追加、コミット
- 旧テーマCSSのコピー、class-map、凍結HTML再掲、postbuild body属性注入、独自の静的化・前段データ生成
- 現行出力からfixtureを自動再生成して検証を通すこと
```

## 固定ページ実装指示書の雛形(delegate で Codex へ)

```markdown
# 実装指示書: 固定ページ <route>

## 目的
固定ページを microCMS やアーカイブ HTML の再掲ではなく、App Router の通常ページとして書き起こす。
完了条件はピクセル比較の収束 + 機能一致(フォーム・リンク・メタ)。
参照素材:
- スクショ: _scratch/archive/pages/<page>/desktop.png / mobile.png
- HTML: _scratch/archive/pages/<page>/page.html(文言・リンク・画像・構造の参考のみ)

## 実装
- `site/src/app/<route>/page.tsx`、`page.module.css`、ページ固有の `metadata` を実装する
- CSS所有権の意思決定木に従う。固定ページ固有ルールは`page.module.css`、共有クラスタだけを`src/styles/`の共有Moduleへ置く。値を二重定義しない
- 内部リンクは`SiteLink`を使う。旧テーマCSS・原文CSSを持ち込まない
- jQueryプラグインの見た目はCSS + Reactで代替する
- フォームはformrunのaction・input nameを原文と完全一致させる。SDK埋め込み型は同一form IDのembed div
- 原文のDOM順・視覚順を尊重するが、構造の完全一致は要求しない
- 画像は 1x/2x の `srcset` または同等のレスポンシブ指定を持たせ、未回収の `@2x` は fetch-once キャッシュ経由で補完する
- アーカイブ原文 HTML の再掲データ、汎用再掲コンポーネント、postbuild の body 属性注入を追加しない

## 検証とレビュー
- typecheck / lint / dev / production buildで対象ルートを確認する
- desktop/mobileの実装スクショを原文スクショと並べ、差分発見→修正→再比較を収束まで繰り返す
- フォームaction/name、内部/外部リンク、title/canonical/OGP/robotsを照合する
- DOMタグ実体数カウントは診断に使ってよいが、完了条件にしない
- CSS・レイアウト変更はpixel-gateのbefore/after比較で退行0を確認する
- 単純なページでパターンを承認してから、複雑な固定ページへ進む

## 禁止
- site/ 外の変更、依存追加、コミット
- 旧テーマCSSのコピー、凍結HTML再掲、class-map、独自静的化、前段データ生成
- 現行出力からfixtureを自動再生成して検証を通すこと
```

## 切替チェックリスト(コピーして案件 issue に)

- [ ] コンテンツ凍結の合意(日時)
- [ ] 最終 WXR で analyze→parse→import 差分実行(**本文の `wpautop` 適用と `<br>` 数の整合を確認**)
- [ ] 原文テンプレとの突き合わせ(§6.6)を全テンプレで完了。クエリ条件・表示分岐・enqueue JS の3観点
- [ ] axe-core で本番アーカイブとの差分ゼロ(移行で増やした違反が無い)
- [ ] uploadsはmicroCMSメディア、テーマ資産はwebp同梱の二本立てを最終確認
- [ ] 固定ページの `srcset` 1x/2x と `@2x` 資産を照合し、DPR 1 の archive で未回収の候補を fetch-once で補完
- [ ] verify(スクショ込み)エラー0・差分トリアージ済み
- [ ] `routing-config.jsonc`が旧URLを新routeまたは301で全カバーし、`out/`との重複0
- [ ] formrunのaction・input nameを承認済みfixtureと照合
- [ ] microCMS webhook → ビルドフック接続確認(テスト更新→自動デプロイ)
- [ ] 本番 DNS 切替 → 404/フォーム/画像の監視
- [ ] 旧サーバーはリードオンリーで保持(ロールバック期限を決める)
