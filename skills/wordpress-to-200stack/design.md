# wp-static-kit 設計書 — WordPress → microCMS + Next.js 静的サイト移行基盤

目的: WordPress サイトの静的リニューアル案件を「決定的なスクリプト群 + Claude Code スキル」で再現可能にし、
案件あたりの人手作業を大幅に圧縮する。
複数の実案件で得た再現性・運用負荷・障害の知見を設計へ反映する。案件固有の実測は `lessons.md` に残し、複数案件で再現したものを設計へ昇格させる。

## 全体アーキテクチャ

役割分担の原則:
- **決定的な処理はすべて CLI スクリプト**(wp-static-kit): 同じ入力から同じ出力。人もAIも判断しない
- **判断はスキル**(wp-migrate): マッピング設計・品質ゲート・委任手順の「規約」。Claude Code が司令塔として実行
- **ネイティブ実装は AI 委任**(delegate 規約に従い Codex へ)。スキルが記事・固定ページ共通の指示書テンプレを提供する
- **デフォルト成果物**: microCMS + Next.js App Router の静的エクスポート。固定ページ・CMS記事ともネイティブ JSX + CSS Modules、内部リンクは SiteLink、フォームは formrun。旧テーマ CSS は参照素材としてだけ使い、成果物へ持ち込まない

```
wp-static-kit/                     # 独立リポジトリ(npm workspace / TypeScript)
  packages/
    analyze/    # WXR センサス(post_type・meta・タクソノミー・URL パターン・SCF/ACF 定義)
    parse/      # WXR → 中間表現(documents.ndjson / routes.json / attachments.ndjson / relations.json)
    media/      # 画像回収(原本+派生)・チェックサム台帳・microCMSメディア移行・URL書き換えマップ
    archive/    # 現行サイトのクロール・HTML/アセット保存・Playwright スクショ
    microcms/   # スキーマ JSON 生成(管理画面インポート用)・冪等入稿(レート制御付き)
    verify/     # 新旧照合(URL パリティ・リンク・画像404・メタ比較・スクショ差分)
  templates/
    next-app/   # Next.js スケルトン(後述)
    mapping.config.example.ts
  cli.ts        # wpkit <command>
```

```
skills/wordpress-to-200stack/
  SKILL.md       # ワークフロー規約(下記フロー)・判断チェックリスト・品質ゲート
  design.md      # 設計書(このファイル)
  templates.md   # mapping config の書き方、テンプレ実装指示書の雛形(delegate 用)
  modernize.md   # テーマCSS温存方式で移行済みの既存案件を最終形へ引き上げる別工程
  lessons.md     # 案件ごとの実測記録(WXR の罠、プラグイン固有の癖、事故)
```

### 成果物のアーキテクチャ地図

```
microCMS
  │ build/dev 中に直接 fetch
  ▼
src/lib/content/
  ├─ client.ts            取得の単一窓口。revalidate / PAGE_SIZE / retry はここだけが決める
  ├─ microcms-document.ts 生レコードを表示用documentへ正規化
  └─ documents.ts         全APIのContentSnapshotをプロセス内保持
  ▼
src/lib/repository.ts     全ルートの読み口
  ├─ src/app/<surface>/page.tsx       一覧
  ├─ src/app/<surface>/[id]/page.tsx  詳細(generateStaticParamsはmicroCMS由来)
  ├─ src/templates/                    記事テンプレート
  └─ src/app/<page>/page.tsx           固定ページ

内部リンク: src/components/SiteLink.tsx → 内部だけ next/link、外部は a
CSS: layout の global importを固定順にする → 各ルート/テンプレ/部品のCSS Module
301正本: routing-config.jsonc(200stackが適用。凍結・手編集)
```

- CMS取得・正規化・repository・描画の境界を越えて fetch を分散させない
- 1ルール=1所有ファイル。単一サーフェス固有はその Module、共有クラスタは `src/styles/` の共有 Module、要素リセット・基本フォントは globals-reset、横断 utility は専用ファイル
- CSS Module で既存クラスを子孫参照する共有クラスタは `:where(.root) :global(.c-...)` とし、root class を祖先へ付ける

### microCMS キャッシュ方針の実測3原則

1. **`revalidate` を必ず明示する**。無指定ではビルド中にページごとの実 fetch が飛び、実測651ページ・2300リクエストでレート制限に達してビルド失敗。build は `revalidate: false`、dev は5秒
2. **`PAGE_SIZE = 50`**。Data Cache の1エントリ上限は2MB。100件では実測1.85MB(本文のbase64化で約1.33倍)となり、数件増えるだけで無キャッシュへ転落する
3. **プロセス内スナップショットを併用する**。Data Cache hit も1ページ約40ms(17エントリ読込 + 4MB JSON.parse + 539文書正規化)。毎ページ繰り返すと静的生成が5.2s→64s。`documents.ts` が保持し、dev のみTTL失効

dev 中の microCMS 更新はサーバー再起動不要で、最大5秒後のリロードで反映する。ビルド間の鮮度はビルドラッパーが fetch cache を開始時に破棄して担保する。

## CLI コマンド設計(すべて冪等・再実行可能)

### wpkit analyze <wxr.xml>
- 入力: WXR ファイル(不正制御文字は自動サニタイズして一時ストリーム化)
- 出力: `analysis/` — post_type 別件数・status 内訳、meta キー頻度表、タクソノミー、
  URL パターン分類(<link> の形状クラスタリング)、custom_permalink 一覧、
  SCF/ACF 定義の復元(リピータグループ構造)、post_type 別サンプル抜粋、
  本文内の iframe/script/table/外部埋め込みの統計
- ここまで人の判断ゼロ。パイロット案件で手作業した分析を完全自動化する

### wpkit parse --config mapping.config.ts
- WXR → 中間表現。設計原則:
  - **URL は <link> を正とするルート台帳**(routes.json)。post_type から導出しない。
    1回だけ percent-decode + Unicode NFC 正規化、末尾スラッシュ情報を保持、衝突検査
  - **SCF/ACF リピータは同名 meta の出現順 zip 復元**。空文字も行として保持し、列数不一致は error
    (プラグイン別アダプタ: smart-custom-fields / ACF / 素の postmeta)
  - publish のみ移行対象(draft/private は監査用に分離出力)。設定投稿(SCF定義等)は自動除外
  - microCMS へ移行する記事本文 HTML は legacyBodyHtml として保持。画像 URL・内部リンクを台帳で書き換え、
    script 除去・埋め込み(YouTube/Vimeo/Instagram/GCal)はプレースホルダー化
  - relation(投稿間参照)は wp_id で解決し relations.json へ
  - 本文の inline style は inline-styles.json に集計(要素数・出現ページ・プロパティ頻度)。
    サイト側サニタイザが style 属性を除去するため、削除許容かデータ変換かを移行者が判断する材料
- 出力に validation-report.json(URL 衝突・未解決参照・リピータ不一致・画像欠損)。**エラー0が次工程のゲート**

### wpkit media pull / push
- pull: attachment 原本 + `_wp_attachment_metadata` の派生サイズ + 本文 srcset 参照 + CSS url() を
  並列ダウンロード(リトライ・チェックサム・content-type 検証)→ manifest
- push: S3互換ストレージを指定された例外案件向けの残置コマンド。デフォルト成果物はuploadsをmicroCMSメディア、テーマ資産をサイト同梱とする
- 欠損レポートを人が確認するのが唯一の手作業

### wpkit schema gen / wpkit import
- schema gen: mapping.config から microCMS の API スキーマ JSON を生成(管理画面のインポート機能で投入)
  - 管理画面が受理する正式エクスポート形式で生成する。`customFields` は決定的な過去日時の `createdAt` / `updatedAt` を持ち、各サブフィールドに sha256 先頭10桁の `idValue` を付け、`position` は fieldId でなくその `idValue` 配列にする
  - API 側の単一カスタムフィールドは `customFieldCreatedAt`、repeater は `customFieldCreatedAtList` で対応する `customFields[].createdAt` を参照する。boolean の初期値は `booleanInitialValue`、select は `selectInitialValue` を使う
  - `requiredFields` に指定した共通フィールド・通常フィールド・repeater / カスタムフィールド等は、生成後の API フィールドで `required: true` にする
  - `fields` / `repeaters` / `relations` / `groups` / `taxonomyFields` の `description` を microCMS の説明文へ反映する。`richText` は `richEditorV2` として生成し、共通本文 `legacyBodyHtml` にも使用する
  - relation の表示名は `label`、単一カスタムフィールドは `groups` でフラットな `fieldIds` / `relationIds` を束ねる。未定義参照・fieldId 重複・複数グループ所属は config 検証で拒否する
  - `taxonomyFields` は WordPress term を `value=term名`、`id=slugのsha256先頭10桁` の複数選択肢として記事 API 内に生成する。既存の IR 凍結用 `taxonomies` は併存する
  - `seoFields: "none"` は `seoTitle` / `seoDescription` を生成せず、`noindex` は常に残す
- import: コンテンツ API で冪等入稿
  - contentId は `^[a-z0-9_-]+$` に適合する旧slugを優先し、不適合ならmicroCMS自動採番。旧URL→新IDを301台帳へ残す
  - PUT は新規作成専用、既存contentIdはPATCH。already exists時のPATCHフォールバックとpayloadChecksum一致skipで再実行可能にする
  - ペイロードは送信前に正規化し、`null` / `undefined` キーを除去する(画像フィールドの`null`は実測504)
  - レート制御(WRITE 5回/秒、実効 4/秒)+ 429 / 5xx 指数バックオフ、AbortController 60秒
  - 非参照グループ値は `{ fieldId, ...サブフィールド }` へネストし、内包 relation は2パス目でグループ全体を PATCH する
  - boolean フィールドの WordPress 文字列値は `"1"` / `"true"` を `true`、`"0"` / `"false"` / 空文字を `false` に変換する。サブフィールドがなく `{ fieldId }` だけになる空グループは create ペイロードから除外する
  - `taxonomyFields` は `document.taxonomies` から該当 taxonomy の term 名配列を入稿する
  - `seoFields: "none"` は SEO テキストをペイロードから除外する
  - 原文公開日は予約フィールド `publishedAt` へ ISO8601 UTC で入稿し、不正日時は送らない。旧共通フィールド `legacyPath` / `wpId` / `publishedAtLegacy` は生成・入稿しない
  - `--dry-run` / `--only <type>` / `--source-id <id>`
  - 入稿後に GET で全件突き合わせ(件数・checksum)

microCMS の前提:
- Content 管理 API の POST / PUT / PATCH は `publishedAt` を ISO8601 で指定でき、移行元の公開日時を保持できる
- カスタムフィールドはコンテンツ参照を内包できるが、カスタムフィールド自体のネストはできない。値は `{ fieldId, ...サブフィールド }`、内包参照は contentId 文字列で書き込む
- 単一選択 select も配列で返るため、描画側は string / 配列の両方を扱う。選択肢なしの select は操作できないため、`options` を必ず指定する
- WordPress タクソノミーは専用 API を増やさず、記事内の複数選択フィールドで表現できる。これは microCMS の API 数上限対策になる

### wpkit archive <url> / wpkit verify <old> <new>
- archive: sitemap+リンククロールで全 URL 収集 → HTML・ヘッダー・canonical・スクショ(desktop/mobile)保存。
  切替後は取得不能になる基準データなので着手時に必ず実行。保存 HTML とスクショは固定ページの
  書き起こし・人間レビューにも使うが、実行時に再掲するデータソースにはしない
- archive のブラウザは DPR 1 でクロールするため、`srcset` の 2x 候補や `@2x` 資産は要求されず、
  通常のキャッシュには入らない。保存 HTML の `srcset` とテーマ資産参照から 2x 候補を列挙し、
  アーカイブ検証時に fetch-once キャッシュ経由で別途回収する。書き起こし側でも 1x/2x の組を照合する
- アーカイブ取得・スクショ比較・ローカルレビューの外部リクエストは、キャッシュ → archive assets →
  未取得時だけネットワーク、の fetch-once 解決を維持し、原点へ同一 URL を繰り返し要求しない
- verify: 新旧の URL パリティ(旧200が新でも200)、内部リンク・画像404、title/description/canonical/OGP 比較、
  Playwright スクショ差分(閾値超えのみ人がトリアージ)→ HTML レポート

## mapping.config(案件ごとに書く唯一のファイル)

```ts
export default defineMigration({
  wxr: "./export.xml",
  site: { origin: "https://www.example.jp", mediaHost: "https://media.example.jp" },
  exclude: { postTypes: ["page", "<除外する型>"], statuses: ["draft", "private"] },
  linkCheck: {
    assumeExistPostTypes: ["page"],
    assumeExistPaths: ["/<コード実装するパス>"],
  },
  apis: {
    articles: {
      from: "post",
      fields: { /* meta key → フィールド定義。analyze の出力から半自動生成 */ },
      repeaters: { images: ["image"], points: ["feature_img", "feature_line", "feature_text"] },
      relations: { author: { key: "author", to: "people" } },
    },
    // ...
    people: { from: ["staff", "vendors"], kindField: "kind" },
  },
  seo: { yoast: true },          // _yoast_wpseo_* を自動マッピング
  forms: { provider: "formrun" }, // 既存 endpoint を検出してフォーム台帳を生成
});
```

analyze が config の雛形(フィールド定義込み)を自動生成し、人は削る・名前を整える・統合を決めるだけ。
**ここが案件ごとの主要な判断ポイント**で、スキルのチェックリストが確認観点を規定する。

固定ページ(通常は `page`)は `exclude.postTypes` で IR / microCMS の対象外にし、移行後も存在する URL を
`linkCheck.assumeExistPostTypes` / `assumeExistPaths` へ登録する。記事本文の `legacyBodyHtml` 方針は維持し、
固定ページへ流用しない。

## Next.js スケルトン(templates/next-app)

案件を跨いで不変の基盤をテンプレ化:
- `output: "export"` / `trailingSlash: true` / `dynamicParams = false`
- CMS一覧 `src/app/<surface>/page.tsx` と詳細 `src/app/<surface>/[id]/page.tsx`。`generateStaticParams` はmicroCMSのcontentIdから毎ビルド導出
- Repository 層(microCMSクライアント + Next.js Data Cache + プロセス内ContentSnapshot)
- 記事用 legacyBodyHtml レンダラ(サニタイズ+埋め込みコンポーネント置換)
- 固定ページ用の App Router ネイティブ実装規約(`src/app/<route>/page.tsx` + `page.module.css` + `metadata`)
- SiteLink(`next/link`を内部リンクだけに適用)
- formrun接続フォーム(原文のaction・input nameを完全一致)
- sitemap / robots / メタ(Yoast 由来)自動出力
- microCMS ドラフトプレビュー(`/preview/` CSR シェル。読み取り専用キー+実画面と同一テンプレで描画。後述)
- verifyスイートと対になる承認済みfixture

> テンプレコードの Data Cache / ルート分解 / verifyスクリプトへの追随は Phase 2 で行う。本設計では前段生成やIR描画合成を現行方式として正当化しない。

案件固有で書くのは **記事テンプレ・一覧・固定ページの JSX / CSS Modules / metadata**。
ここは AI 委任(Codex)+人間レビュー。archive のスクショ・保存 HTML は「凍結された参照資料」として
指示書に添付するが、ランタイム入力にはしない。

### ネイティブページの提供設計

- 固定ページは1ページずつ JSX とページローカル CSS Modules へ書き起こす。記事は一覧・詳細・テンプレの所有境界でModuleを分ける
- 旧テーマ CSS・原文 CSSをコピーしない。原文の値と見た目を読み取り、owner Moduleへ必要なルールだけを書く
- まず単純なページでルート、metadata、レスポンシブ画像、CSS スコープ、レビュー手順のパターンを確立し、
  承認後にフォームや複雑なレイアウトを持つページへ進む
- 各ページで「書き起こし → dev / production build の表示確認 → 原文との desktop/mobile 対比スクショ →
  人間レビュー → 指摘反映」を繰り返す。完了条件はピクセル比較の収束 + フォーム・リンク・メタの機能一致
- 画像は 1x/2x の `srcset` または同等のレスポンシブ指定を持たせ、DPR 1 のアーカイブで回収されない
  `@2x` 資産を fetch-once キャッシュ経由で補完する
- jQueryプラグイン(imgLiquid / slick / lity)の見た目はCSS + Reactで再実装する
- 内部リンクはSiteLink、外部リンク・別タブだけ素の`<a>`を使う

## スキル(wp-migrate)のワークフロー

1. `wpkit archive` → `wpkit analyze` → mapping.configの製品判断
2. `wpkit parse` → validationエラー0(ゲート1)
3. media回収・変換・microCMSメディア移行 → missing確認(ゲート2)
4. `wpkit schema gen` → microCMS作成 → `wpkit import` → 件数照合(ゲート3)
5. スケルトン展開 → microCMS直取得でネイティブ実装 → fidelity / pixel-gateを収束
6. `wpkit verify` + verifyスイート(ゲート4)
7. `routing-config.jsonc`確定 → release → 200stack自動デプロイ → DNS・監視

## 新規記事のデフォルト対応

移行後にmicroCMSで作成された新規記事はデフォルトで描画対象とする。

- contentIdはmicroCMSのrecord.idをそのままURLへ使う
- 一覧・詳細・sitemapのデータは同じrepositoryから取得する
- `src/app/<surface>/[id]/page.tsx`の`generateStaticParams`が毎ビルドmicroCMSから全IDを導出する。手動ルート台帳を増やさない
- `dynamicParams = false`のためdevでも未列挙パスは500/404になる。新規入稿直後はTTLとworker反映を待ってリロードし、500→404→200の遷移を正常扱いする
- 画像の`{url,width,height}`を正規化後も並列保持し、`aspect-ratio`予約とsurface別`w=`に使う

## React / Next.js の罠(実測)

1. ページJSX先頭がheadへホイストされる`link` / `meta`要素だと、Next.jsのスクロールリセットが無効化される。可視コンテンツの後ろへ置く
2. JSXのインライン`<script>`はクライアント遷移で実行されない(SSR初期ロードのみ)。key変更でも実行されない
3. React 19のprecedence stylesheetはアンマウント後もheadに残る。ページ別stylesheet切替は多段遷移でカスケード競合する
4. `trailingSlash: true`では`usePathname()`が末尾スラッシュ付きを返す。マップキーとの照合前に正規化する

## 作らない機構

いずれも案件Aで作って撤去した。新規案件では最初から現在の姿を作る。

| 作らない機構 | 撤去理由 / 今の姿 |
|---|---|
| fixed-pages(凍結HTML配信) | 固定ページは`src/app/<page>/page.tsx`のネイティブJSX |
| 前段生成`build:data`・IR hydration | `src/lib/content/`がmicroCMSを直接取得し、Next.js Data Cache + プロセス内snapshotを使う |
| postbuild body属性注入 | body class/id依存を持たないCSS Modulesと素の`<body>` |
| `redirects.txt` + 生成器 | `routing-config.jsonc`を200stack向けの凍結・手編集正本にする |
| 独自検索インデックス | no-opの独自生成器は撤去。必要なら現在の要件からクライアント検索を設計する |

## 少RAMビルドの設計

- **ビルド中不変のデータはプロセス内で読込1回**。ページごとの`readFile` + `JSON.parse`をモジュールスコープPromise共有へ変えた実測で、worker 2,892MB→337MB、静的生成85s→5.6s
- Next 16.2.10の静的生成workerは`isolatedMemory=true`でheap上限を除去する。`max-old-space-size`だけで守れないため、保持要因の除去を本筋とする
- 少RAM環境は`BUILD_MEMORY_LIMIT_MB`を入口に、ビルドラッパーが起動前にheap上限を設定し、webpackへ切替え、workers / concurrencyを制約する
- Turbopackのネイティブメモリ(実測約2.6GB)は実質制御不能。制約環境では`webpackMemoryOptimizations`を有効にする
- Next config読込後の`NODE_OPTIONS`変更はメインプロセス自身へ効かない。必ずラッパーのspawn前に注入する


## microCMS ドラフトプレビュー(デフォルト実装、2026-07 確定)

静的エクスポート構成でも編集者が下書きを確認できるよう、`/preview/` を CSR シェルとしてデフォルトで実装する。

- **ルート**: `/preview/?api=<endpoint>&id={CONTENT_ID}&draftKey={DRAFT_KEY}`。静的ルート1枚(`robots: noindex`)+ Suspense 配下の `"use client"` コンポーネントが useSearchParams で受けてコンテンツ API を直接 GET する
- **draftKey は任意**: 下書きは microCMS がコンテンツ単位の draftKey を自動付与、公開中コンテンツは draftKey なしで公開データを表示する(必須にしない — 実測で編集者が公開後の画面確認にも使う)
- **API キー**: `NEXT_PUBLIC_MICROCMS_SERVICE_DOMAIN` / `NEXT_PUBLIC_MICROCMS_PREVIEW_KEY` の2環境変数。`NEXT_PUBLIC_*` はブラウザへ露出するため、プレビューキーは **GET のみ許可の読み取り専用キー必須**(入稿用 Management キーの流用禁止)
- **実画面と同一コード**: レコード正規化とテンプレ props 生成をサーバ/クライアント共通モジュールへ切り出し、SSG とプレビュー CSR が**同じ関数・同じ templates/registry** を通る構成にする。プレビュー専用の描画分岐を作らない(分岐した瞬間に「プレビューでは崩れない」保証が消える)
- **関連コンテンツ**(サイドバー・関連記事・relation)は公開 API からベストエフォート取得し、失敗しても本体は空の関連データで描画する(API 単位の関連マップを定義)
- **SEO ゲートとの接続**: `/preview/` の noindex と sitemap 除外は `verify:seo` の検証項目に含める
- **管理画面設定**: microCMS 各 API の「画面プレビュー」へ上記 URL 形式を設定(API ごとに `api=` のみ変更)。環境変数と合わせて案件 docs に `microcms-setup.md` として手順を残し、設定はユーザー(管理画面オーナー)へ依頼する

## コーディング標準(テンプレートのデフォルト)

- **import エイリアス**: `tsconfig.json` の `paths` で `@/* → src/*` を定義し、親ディレクトリ跨ぎの相対 import(`../../lib/...`)は書かない(`@/lib/...`)。同一ディレクトリの `./Foo` と CSS Modules の `./X.module.css` は相対のまま
- **Biome**: フォーマッタ/リンタは Biome(`biome.json` 同梱: 2スペース・lineWidth 120・organizeImports)。`npm run format` / `npm run lint` を標準スクリプトとする。移行コードも生成物を除き全て format 済みで納品する
