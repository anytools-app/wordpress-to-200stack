---
name: wordpress-to-200stack
description: WordPress サイトを microCMS + formrun + Next.js 静的エクスポートへ移行し、固定ページ・記事テンプレをネイティブ実装(CSS Modules)して 200stack にデプロイする手順。WXR 分析、mapping config、画像・コンテンツ移行、microCMS スキーマ生成・冪等入稿、ピクセル比較ゲート、機能照合、200stack 公開までを、同梱の決定的 CLI(wpkit)と品質ゲートで進める。トリガー例:「WordPressを移行して」「WXRからmicroCMSへ」「wpkitで移行」「WordPressを200stackに」「静的サイト化して」「WordPressサイトをNext.jsにリニューアル」。
---

# WordPress → microCMS + Next.js 静的サイト → 200stack 移行

役割分担: **決定的な処理は同梱の wpkit(`kit/`)、判断はこのスキル(司令塔)、テンプレのデザイン実装は delegate スキルで Codex へ委任**。

## セットアップ(案件開始時に1回)

```bash
cp -R <このスキルの>kit <案件リポジトリ>/wp-static-kit   # 案件にピン留め(再現性のため)
cd <案件>/wp-static-kit && npm install && npx playwright install chromium
```

- 生成物はすべて案件リポジトリの `_scratch/`(gitignore)に置く。/tmp に置かない
- 実行形: `cd wp-static-kit && npm run wpkit -- <cmd>`

## 全体フロー(ゲート順)

```
0. archive(現行凍結)→ 1. analyze → 2. mapping config(製品判断)→ 3. parse(ゲート1)
→ 4. media(ゲート2)→ 5. schema gen → microCMS作成 → import(ゲート3。実装の前提)
→ 6. next-app 展開 → ネイティブ実装ループ(ピクセル比較)→ 7. verify スイート(ゲート4)
→ 8. 200stack 公開
```

### 0. 現行サイトの凍結(最初に必ず)

```bash
npm run wpkit -- archive <https://origin> -o ../_scratch/archive   # まず --limit 5 で試す
```

- **切替後は二度と取れない基準データ**(HTML・メタ・スクショ・アセット・フォーム台帳・リダイレクト記録)
- **稼働テーマ一式(`wp-content/themes/<active>/`)も同時に凍結する**。FTP・管理画面のテーマエディタ・
  クライアント経由のいずれでもよいので、着手時に必ず入手して `_scratch/wp-theme/` へ置く。
  **アーカイブ HTML とスクショは「そのサンプル時点で発火した分岐の結果」しか写していない**ため、
  テンプレートの条件分岐(`meta_query` の絞り込み、空値の `&nbsp;` フォールバック、値による分岐、
  日付ウィンドウ判定)は原文 PHP を読まないと復元できない。§6.6 の突き合わせゲートの入力になる。
  テーマが後から届いた実案件では、この突き合わせだけで**実装漏れ13件**が出た
- `forms.json` が外部フォーム endpoint の台帳。`meta.json` の redirects 記録が 301 表の材料になる
- 保存 HTML とスクショは、固定ページを書き起こす際の参照素材・レビュー比較対象として使う。実行時に HTML を再掲するデータソースにはしない
- archive の Playwright クロールは DPR 1 で行うため、`srcset` の 2x 候補や `@2x` 資産はブラウザから要求されず、通常のキャッシュには入らない。保存 HTML の `srcset` とテーマ資産参照を棚卸しし、2x 候補を fetch-once キャッシュ経由で別途回収してからアーカイブ完了とする

### 原点サーバー保護(fetch-once。違反すると本番を止める)

**検証・レビュー系ツールは、現行本番サーバーへ同じURLに二度アクセスしてはならない。**
スクショ比較・レビュー用サーバー・ブラウザ検証は、ページが参照する画像・アセットを毎回
原点から取得しがちで、「ページ数 × 画像 × 実行回数」で本番の転送量クォータを食い潰す
(実案件で月間200GBを使い切り本番サーバーが停止した事故あり)。

- 全リモート取得を**ディスクキャッシュ経由**にする: 解決順 = キャッシュ → archive の assets
  (ファイル名がURLエンコードされた完全URL、そのままURL→ファイル台帳になる)→ ネットワーク
  (成功時のみ保存)。kit の `templates/next-app/scripts/` に `lib/remote-cache.mjs`(核)と
  `serve-cached.mjs`(静的配信+fetch-once プロキシ)の実装がある
- レビューは素の `npx serve out` でなく `node scripts/serve-cached.mjs` を使う
  (`NEXT_PUBLIC_MEDIA_HOST` をローカルプロキシに向ける)
- Playwright での機械スクショは context に外部ホストの route interception を張り、
  フォント CDN 含む全外部リクエストをキャッシュ経由にする(副次効果: スクショが決定的になる)

### 1. analyze → 2. mapping config(製品判断)

```bash
npm run wpkit -- analyze <export.xml> -o ../_scratch/analysis
```

- `census.md` で移行スコープをユーザーに確認する(どの post_type を移行/廃止するか、捨てる URL は 404 か 301 か)
- microCMS の API 数は §5 のプラン上限から逆算する。少数件の型は kind 統合
- config の書式・型の決め方チェックリストは `templates.md`。**フィールド型は必ずサンプル実値で決める**:
  SCF 画像フィールドは attachment の wp_id が入る(`type:"image"` で kit が URL 解決)、wp_id 参照は relation、
  "0"/"1" は boolean、価格は単位に注意(万円単位の実例あり)
- microCMS 対象の記事本文は `legacyBodyHtml`(HTML文字列)。リッチエディタに入れない

### 2.5 SCF 定義の復元と現行管理画面のフィールド精査

**SCF 案件ではまず `wpkit analyze` の `_scratch/analysis/scf-definitions.json` を見る。**
SCF のフィールド定義(表示ラベル・表示順・入力ガイド・選択肢・repeat 指定)は WXR 内の
`smart-cf-setting`(PHP シリアライズ)に丸ごと入っており、管理画面巡回をほぼ省略できる。
draft の SCF 投稿に設定が無いという警告は正常。

WXR から復元できない情報が残る場合(SCF 以外のフィールド機構、登録済みの空タクソノミー等)だけ、
現行 WordPress の投稿編集画面を精査する。

- **人(オペレーター)が各 post_type の投稿編集画面をブラウザで1つずつ開く**。AI 側から自動で本番を巡回しない(「原点サーバー保護」。編集画面は画像・アセットを読むため、人が開いた1ページだけを読むのが最小負荷)。
- AI は**閲覧のみ**でページを読む(ブラウザの get_page_text 等)。**編集フォームなので、入力・保存・クリックなど状態を変える操作は絶対に行わない。**
- 抽出する: フィールドの**表示ラベル**、**メタボックス内の表示順**、種別(select / 真偽 / 画像 / 繰り返し / TinyMCE リッチテキスト)、**選択肢**、**補足文(help text)**、サイドバーの**タクソノミー**(現行 term が無い**登録済みの空タクソノミーも含む**)。
- 反映: 表示ラベル → `label`、補足文 → `description`、表示順 → config のフィールド順、タクソノミー表示名 → `taxonomyFields[].label`。
- **典型的な齟齬(WXR/analyze では気づけない)**:
  - 同種の複数タクソノミーで**ラベルを取り違える**(term の内容と突き合わせて確定する)
  - `"0"/"1"` フィールドが**真偽**か文字列か(管理画面 UI で確定。真偽なら 0/1→bool 変換をデータ準備に加える)
  - WXR に term/値が無い**登録済みフィールド・タクソノミー**(空タクソノミーの slug は register_taxonomy=テーマ側にあり WXR/analyze から特定できない → 要確認としてフラグ)
  - 文字列と思っていたフィールドが **TinyMCE リッチテキスト**(→ `richText`)
- 調査結果は参照ドキュメント(例: `_scratch/wp-admin-field-reference.md`)に保存し、schema 反映(config 修正)の作業指示として使う。反映後は `wpkit schema gen` を再実行してスキーマ JSON を更新する。

### 3. parse(ゲート1: errors 0)

```bash
npm run wpkit -- parse --config ../mapping.config.ts -o ../_scratch/ir
```

- **本文は `wpautop` 相当を適用してから IR へ入れる(取り込み後は復元不能)**。WordPress は
  `wpautop()` を**表示時**に適用するため、WXR の `content:encoded` は改行だけのプレーンテキストで、
  `<p>` も `<br>` も持たない。素のまま入稿すると**改行が全部空白に潰れる**。実測で 537件中245件(46%)が
  該当し、`<br>` を含む本文は1件だけになった。数週間気づかれず、クライアントの記事が1行に潰れていた
  - 変換規則は WP の `formatting.php` の `wpautop()` に合わせる(空行 → `<p>`、単独改行 → `<br />`、
    ブロック要素の前後は段落化しない)
  - **保存先 CMS のサニタイザが落とす構造を検出して警告する**。microCMS は HTML 仕様上不正な入れ子
    (`<h2>` 内の `<p>` 等)を除去するため、wpautop の出力がそのまま保存できない記事がある(実測67件)。
    落ちると見出しの中身が丸ごと見出しサイズで出る
  - ゲート: IR の `<br>` 数が WXR の単独改行数と整合すること
- errors(URL衝突・リピータ列数不一致・metaキー参照ミス)は必ず原因特定。warnings は監査対象
  (タクソノミーアーカイブへのリンク → 再現するか判断 / 数値変換失敗 / Yoast テンプレ変数)
- ルート数 =「publish −(除外+SCF設定投稿)」を census と突き合わせる
- **`page` 型の全件リストを WXR から出し、実装済みページ+301 で全カバーされることをゲートにする**。
  archive クロール由来のページ一覧だけを実装対象にしない — フォーム送信後の thanks ページは
  noindex(sitemap 非掲載)かつ被リンクゼロ(form.run リダイレクトでのみ到達)でクローラーに
  構造的に不可視。実案件で thanks 7枚がこれで漏れた(検出は WXR の page 全件と `out/` の突き合わせ
  1コマンドだった)。旧URL台帳(verify:routes)は CMS ルート由来で page 型を守らないことに注意
- 固定ページ(通常は WordPress の `page`)は microCMS に入れない。`exclude.postTypes` で除外し、移行後も存在する URL は `linkCheck.assumeExistPostTypes` / `assumeExistPaths` に登録する。提供は App Router の専用ルート(`src/app/<route>/page.tsx` + `page.module.css` + `metadata`)としてコード実装する

### 4. media(ゲート2: missing を人が確認)

**画像の配信方針(全案件共通)**: 外部ストレージ(R2 等)は使わない。画像は次の二本立てにする。
uploads(記事に紐づく画像)は本文 HTML 内の参照も含めて microCMS 側、サイト同梱はテーマ資産だけが原則。

1. **サイト同梱 + 200stack 配信**(テーマ装飾画像。uploads は移行完了までの dev つなぎのみ):
   ビルド時に `wpkit media transform` で webp 化(既定 q75・max-width 1600・アップスケールなし、
   gif は素通し)して `public/media/` に同梱する。**必要十分なサイズ・軽量フォーマットで置く**のが原則
   (実測で jpg/png → webp は総量 56% 減)。ファイル名には変換後バイト列の sha256 先頭8桁が入り
   (`a.jpg.<hash8>.webp`)、パス固定のまま immutable キャッシュとキャッシュバストが成立する。
   再生成時の孤児ファイルは `--prune` 指定時のみ削除。
   **バンドラ import 化(`src/assets` + 生成 manifest モジュール)はしない** — 数千枚規模の実測で
   Turbopack ビルドが 27s→795s(29倍)になり、CMS webhook 再ビルド運用と両立しない
2. **microCMS 添付 + 画像 API 配信**(`/wp-content/uploads/` の記事画像すべて: 画像フィールドも
   本文 HTML 内参照も)。`wpkit media upload`(`--scope fields|body|all`)でメディアアップロード API
   (利用条件は §5 の制約表。超過分は upload が自動縮小)へ冪等アップロードし、
   `import --media-map` が画像フィールド値と本文 `src/srcset` を asset URL へ差し替える。
   配信 URL に `?fm=webp&q=75`(+表示幅×2 の `w`)を必ず付ける(`auto=format` 非対応なので明示指定。
   本文分はテンプレの `rewriteBodyMedia()` が付与)。テーマ資産のハッシュ化は `media transform-static`
   (CSS 内 url() の書き換え込み)

```bash
npm run wpkit -- media transform --ir ../_scratch/ir --cache ../_scratch/remote-cache \
  --out ../site/public/media --manifest ../site/src/data/media-manifest.json --dry-run  # missing を確認 → 本実行(再生成時は --prune)
```

- 旧ドメインの別名ホスト(例: 引退した media サブドメイン)が本文に混在する場合は
  `WPKIT_ORIGIN_ALIASES`(カンマ区切り)で正規ホスト(`WPKIT_ORIGIN`)に正規化してキャッシュを引く

- transform は fetch-once の remote-cache だけを読む(キャッシュミスはネットワークに出ず manifest の
  `missing` に列挙 → 司令塔が回収してから再実行)。派生サイズ URL(`-WxH.ext`)は原本に解決せず
  独立資産として扱う(レンダリング寸法を変えないため)
- サイト側はテンプレの `src/lib/media.ts`(`mediaUrl()` / `rewriteBodyMedia()`)が manifest を引いて
  ローカル webp / microCMS 画像 API パラメータに解決する。**画像の src と転送量だけを変え、
  レンダリング寸法は 1px も変えない**(fidelity 承認を壊さない)
- **ノイズ / グレイン系テクスチャは非可逆 webp にしない**。実測では q75 で決定的に劣化しても
  min / max では検出できなかった。隣接画素差の平均で原本と比較し、差が潰れる資産は lossless webp へ切り替える
- `media pull` / `media push`(S3 互換)は外部ストレージが指定された例外案件向けに残置
- 見落としがちな回収物: テーマ外の `/docs/*.pdf` 等の添付、ページ限定 CSS(archive 全ページの
  `link[rel=stylesheet]` を集計してから回収リストを作る)、`srcset` の 1x/2x 画像と `@2x` テーマ資産。
  **DPR 1 の archive クロールは 2x 候補を取得しない**ため、書き起こし時とアーカイブ検証時の両方で
  `srcset` 候補を抽出し、fetch-once の枠内で未回収の 2x 資産を補完する

### 5. microCMS(ゲート3: 件数照合)

```bash
npm run wpkit -- schema gen --config ../mapping.config.ts -o ../_scratch/microcms-schema
# 管理画面で API 作成 → 各 .schema.json をインポート → relation 参照先を手動設定(README のチェックリスト)
npm run wpkit -- import --ir ../_scratch/ir --dry-run   # oversized 0 を確認 → 本実行
```

#### microCMS のプラン・API 制約(2026-07 実測)

| 項目 | 制約 / 運用 |
|---|---|
| Hobby | 5 API。転送量20GB/月を超えるとコンテンツ API ごと翌月1日まで停止する。画像配信も CDN ヒット込みで計上される |
| Team | 10 API。API グループは最大10 |
| メディアアップロード API | Team 以上、5MB/file、1req 1file |
| Content API | WRITE 5回/秒、1コンテンツ約200KB、POST / PUT 約300KB、GET 60回/秒 |
| Management API | 10回/10秒 |
| 下書き作成 | API から作成できない。`?status=draft` は無視され公開で作成される。非公開レコードは「公開入稿 → 管理画面で下書きへ戻す」を人手手順にする |
| コンテンツモデル作成 | API 作成の管理 API は無い。API 作成 + スキーマ JSON インポートは管理画面の人手作業なので、計画の最初にユーザー作業として切り出す |
| select | 単一選択でも配列で送受信する |
| number | 非数値文字列と空文字を送らない。入稿前に警告付きで drop し、400 の原因調査ではレスポンス本文を確認する |
| contentId | `^[a-z0-9_-]+$`。不適合の旧 ID は自動採番し、旧 URL は 301 で維持する |

- **API は1つずつ作成して人間レビューを回す**。スキーマ JSON をインポート → 管理画面でフィールド名・説明・必須・グループを確認 → 指摘を `mapping.config.ts` に反映 → `wpkit schema gen` で再生成 → 再インポート、の順で確定する。レビュー前に全 API を一括作成しない
- フィールドの採否は推測せず、IR の実データで決める:
  - 全件空なら作らない(`body: "none"` / `seoFields: "none"`)
  - SEO は「全件空 → 作らない」「Yoast の定型値のみ → CMS に作らずサイト側フォールバックで生成」「記事ごとの個別文あり → コンテンツを失わないよう維持」の3分岐で判断する
  - サイトが読まず、URL 台帳など別の正本で代替される未使用フィールドは廃止する
- `requiredFields` は、**全件が値を持ち、欠けると表示が壊れるフィールドだけ**に指定する。1件でも欠けるフィールドは例外運用(価格未定など)を確認し、必須にしない
- **WP 側の実描画順は `menu_order` 昇順のことが多い**(2案件連続の実測)。並び替えプラグインが
  `pre_get_posts` で `get_posts()` を含む全クエリへ作用する例があるため、テーマ PHP の `orderby`
  だけで判断しない。一覧・ページ送り・トップ・関連ブロック等の全サーフェスで archive の実描画順と
  WXR の `wp:menu_order` 昇順・公開日降順を突き合わせ、一致する方を正本として確定する
  - `menu_order` 由来だった場合は `wp:menu_order` を疑似 metaKey として取り込める(kit の parse が対応)。
    案件側で別途 JSON を静的抽出する手間を増やさない
- 公開日順で足りる場合は表示順専用の数値フィールドを作らず、microCMS コンテンツ一覧のドラッグ並び順を正とする。`orders` 未指定時は管理画面順で取得され、新規コンテンツは先頭に入るため、初期移行は希望表示順の逆から作成し、サイトは取得配列順で表示する
- スキーマインポート後、**relation の参照先 API**と**repeater / カスタムフィールドの紐付け**を管理画面で手動設定する。JSON だけでは復元されないため、API ごとのチェックリストに含める
- mapping から廃止したフィールドは、入稿前に IR の `documents.ndjson` の `fields` からも削除する。スキーマにないキーを送ると `unexpected key` の 400 になる
- 全件入稿の前に各 API から5〜10件をサンプル入稿して人間確認する。公開状態・売約状態・グループ有無などの表示バリエーションを含め、relation の参照先は入稿済みサンプル内に閉じるよう選ぶ(未存在参照への relation PATCH は失敗する)
- Team 以上では API グループを使い、商品系・記事系・会社／人など用途別に整理する
- 入稿後の totalCount 照合が期待件数と一致すること。`--only` / `--source-id` で部分再実行可
- **画像フィールドへ `null` / `undefined` を送らない**。実測では `null` が 400 ではなく 504 を起こした。kit の import は送信前のペイロード正規化・空キー除去で対処する
- **PUT は新規作成専用、既存 contentId は PATCH**。再実行は already exists を検知して PATCH へ切り替える
- **書込み API の無応答ハングと間欠 504**を前提に、AbortController 60秒 + 5xx 指数バックオフを入れる
- **メディアは拡張子由来の Content-Type 必須**。`application/octet-stream` は画像でなくファイル扱いになり、画像フィールドで参照できない
- **入稿プロセスは同時1つ**。新規 PUT・自動採番を並走させない
- 大量メディアアップロードは 429 帯がある(実測では1,916枚連続後)。`Retry-After` と指数バックオフで回復させる

### 6. ネイティブ実装(デフォルト成果物)

`cp -R kit/templates/next-app <案件>/site` で展開し、**サンプル入稿済みの microCMS 直取得で実装する**。ゲート3は実装の前提であり、前段データ生成やテーマ互換の中間機構を作らない。実装・診断の定石は `recipes.md` を参照する。

#### 成果物の姿

- 固定ページ: `src/app/<page>/page.tsx` + ページローカル `page.module.css` + `metadata`
- CMS 記事: `src/app/<surface>/page.tsx`(一覧) + `src/app/<surface>/[id]/page.tsx`(詳細) + `src/templates/`。`generateStaticParams` は microCMS の contentId から導出する
- 旧テーマ CSS は成果物へ持ち込まない。アーカイブの CSS・HTML・スクショは、値・DOM順・見た目を読み取る参照素材とピクセル比較の基準に限定する
- **microCMS ドラフトプレビュー(`/preview/` CSR シェル)はデフォルト成果物**。読み取り専用 GET キー、実画面と同一テンプレ、draftKey 任意、noindex、sitemap 除外を守る。仕様は `design.md`

#### データ取得は Next.js Data Cache に一本化

キャッシュ方針は `src/lib/content/client.ts` だけが決める。

1. **`revalidate` 明示必須**。無指定はビルド中にページごとの実 fetch を起こす。実測で651ページ・2300リクエストとなりビルド失敗。build は `false`、dev は5秒
2. **`PAGE_SIZE = 50`**。Data Cache は1エントリ2MB上限で、100件時の実測1.85MBは記事追加で容易に超える
3. **プロセス内スナップショットを併用**。Data Cache hit だけでもページごと約40msかかり、静的生成が5.2s→64sへ悪化した。`documents.ts` で保持し、dev だけ TTL 失効

dev 中の microCMS 更新はサーバー再起動不要で、最大5秒待ってリロードすれば反映される。

#### 内部リンクは SiteLink

内部リンクを素の `<a>` にしない。`src/components/SiteLink.tsx` を単一の窓口にする。

```tsx
import NextLink from "next/link";
import type { ComponentPropsWithoutRef } from "react";

/** Internal links keep App Router client navigation for native React page chrome updates. */
export function SiteLink({ href, ...props }: ComponentPropsWithoutRef<"a">) {
  if (typeof href === "string" && href.startsWith("/") && !href.startsWith("//") && props.target !== "_blank") {
    return <NextLink href={href} {...props} />;
  }

  return <a href={href} {...props} />;
}
```

`/` 始まりかつ `//` でなく、`target="_blank"` でないリンクだけ `next/link` を使い、それ以外は素の `<a>` にする。

#### 静的化は Next.js の標準機構を使う

- `output: "export"` / `trailingSlash: true` / `dynamicParams = false`
- `generateStaticParams` が返さないパスはビルド時404。dev でも同じ制約が効き、新規入稿直後の数秒は 500 → 404 → 200 の遷移が正常
- ページネーションを含む内部 `href` は末尾スラッシュを統一する
- runtime fetch が必要なプレビュー等は client component にする。独自の静的化機構を作らない

#### CSS 所有権の意思決定木

**1ルール=1所有ファイル。値を二重定義しない。**

1. 単一のルート・テンプレ・コンポーネント固有 → そのサーフェスの CSS Module
2. 複数サーフェス共有クラスタ → `src/styles/` の共有 Module。既存クラスを受ける場合は `:where(.root) :global(.c-...)` とし、祖先へ root class を付ける
3. 要素リセット・基本フォント → `globals-reset.css`
4. 横断 utility → 専用 utility ファイル

#### formrun

- 現行フォームの `action`(`form.run` endpoint)と各 `input name` を原文と完全一致させる
- SDK 埋め込み型は同一フォーム ID の embed div を再現する
- メルマガ等の直 POST 型も同じ endpoint・name を使う

#### 原文が `WP_Query` で引いていたブロックは CMS クエリで実装する

アーカイブ HTML から起こす際、繰り返しブロック(オーナーの声・関連記事・スタッフ一覧等)を
**固定配列に焼き込まない**。原文が `WP_Query` / `get_posts` で引いていたものは必ず repository 経由にする。
固定配列は「凍結HTML再掲」に見えないので見過ごされやすいが、**CMS を編集しても反映されない**という
同じ欠陥を持つ(実案件で3ブロック・28件が固定配列のまま残っていた)。

- 件数(`posts_per_page`。未指定なら WP の既定表示件数)と並び順を原文から確定して定数にする
- **CMS 駆動にした箇所では派生サイズ画像(`-WxH.ext`)を使わない**。派生は移行済みレコードにしか
  存在せず、クライアントが追加した新規レコードで 404 になる。原本 + 画像 API パラメータへ切り替える
  (忠実再現のために派生を独立資産として扱う §4 の原則は、固定ブロック側にだけ適用される)

#### 内部リンクは旧 URL でなく新ルートへ

旧 URL は **301 の入口**であって内部リンクの行き先ではない。ルート台帳の新パスを使う。
アーカイブ HTML の `href` をそのまま写すと、全クリックに 301 が1ホップ挟まる
(実案件で `/item/{id}` のまま残り、実体は `/about-item/{id}/` だった)。

#### 全ページのネイティブ実装ループ

1. アーカイブの HTML・スクショを原文として、文言、リンク、画像、DOM順、レスポンシブ挙動を読む
2. **原文テンプレ(`_scratch/wp-theme/`)の該当ファイルを開き、条件分岐と JS を確認する**(§6.6)
3. `page.tsx` / `src/templates/` + CSS Modules + SiteLink でネイティブ実装する
4. §6.5 のピクセル比較で差分を発見し、機能(フォーム・リンク・メタ)も照合する
5. 差分修正と再比較を収束まで繰り返す

ページは難易度順に進める。最初に単純な1ページで JSX・metadata・CSS所有権・画像・比較手順を確立し、承認後にフォームや複雑なレイアウトへ展開する。

#### 委任指示書の規律

記事系・固定ページとも `templates.md` の雛形を使い、次を必ず含める。

1. 完了条件は**ピクセル比較の収束 + 機能一致(フォーム・リンク・メタ)**。DOM タグ実体数一致は完了条件にしない。RSC ペイロードで substring が2倍に見える等の構造診断には使ってよい
2. jQuery プラグイン(imgLiquid / slick / lity)の見た目は CSS + React で代替する。カルーセルは scroll-snap 等を使い、旧ライブラリやテーマ CSS を持ち込まない
3. 原文の DOM 順・視覚順を尊重する。float 回り込み等の診断に有効だが、構造の完全一致は要求しない
4. フォームは formrun の action・input name を原文と完全一致させる
5. 対象ページ・部品に関係する `recipes.md` のレシピを指示書へ本文ごと転記する。リンクだけにしない
6. Codex sandbox は 127.0.0.1 への listen も不可(`listen EPERM`)。ローカルサーバーが必要な
   ピクセル比較・DOM 実測は司令塔が実行し、差分を委任先へ戻す往復にする

レビューは司令塔が typecheck / build / Playwright の desktop・mobile 実画面比較で行う。

**デフォルトにしない方式**: テーマ CSS のページ単位読込、class-map、fixed-pages(凍結 HTML 配信)、アーカイブ原文 HTML の汎用注入、postbuild の body 属性注入、IR を前段生成して描画時に合成する方式、独自リダイレクト生成器は作らない。いずれも実案件で作った後に撤去された中間機構であり、dev/静的出力の乖離、カスケード事故、二重の正本を生む。必要な機能は Next.js + microCMS + CSS Modules へ直接実装する。

### 6.5 fidelity(原文比較)と pixel-gate(退行検知)

忠実性の完了条件は**原文とのピクセル比較の収束 + 機能一致**。用途の異なる2本を混同しない。

#### fidelity: 原文アーカイブとの比較

- `fidelity-scan.mjs` で凍結スクショと新実装を surface ごとに比較し、`fidelity-report.mjs` でワーストを出す。移行証跡として残す
- ratio は run 間で ±0.08 ぶれる。A/B は同一セッション連続 run で行い、決定的判定はブロック単位の DOM 実測(y/height の `dy=0` / `dh=0`)
- 粒状背景のサイトでは、1px の高さズレ以降で背景ノイズが総崩れするため不一致率を進捗指標にしない。
  `heightDelta=0` までは比率を見ず、背景だけの帯の差分率と「ズレが始まる y 座標」で追い込む
- reducedMotion をエミュレートし、自動送り UI は `prefers-reduced-motion: reduce` で停止する
- 意図的差分と承認結果は approvals 台帳へ記録する
- スクリーンショットには合成レイヤー由来の寸法アーティファクトが混じり得る。
  `getBoundingClientRect()` + CDP matched rules を判定の正とする
- **全ゲート通過後、動き系を実機で人が触るレビューを必須にする**。スクロール連動・SDK 初期化・
  ホバー演出を確認し、指摘は Playwright の行動シナリオ(スクロール→computed、空送信→エラー、
  遷移→プリフィル)へ機械化する。実測では収束・全ゲート通過後に9件の指摘が出た

#### pixel-gate: 変更前後の自ビルド比較

`css-visual-diff.mjs` の `capture --label before` / `capture --label after` → `compare` で、同じ実装の変更前後を比較する。CSS・レイアウトへ触る変更の標準ゲートとする。CSS Modules化B6では静的監査・typecheckが全通過した変更から3回帰を検出した実測があり、コード検査の代替にはならない。

撮影時の実務:

- lazy 画像は fullPage 撮影前に0.85画面刻みで下端までスクロールし、先頭へ戻してから撮る
- 全外部画像を block すると microCMS 画像が空箱になる。実画像比較は「自社配信のみ許可」の特別キャプチャで新旧ビルドをクロス比較する
- スピナー等の既知ノイズは台帳化し、未知差分と分ける

差分の切り分けと CSS 勝者の特定は `recipes.md` §5 の診断手順を使う。

### 6.6 原文テンプレとの突き合わせ(ゲート3.5。ピクセル比較では絶対に見つからない)

ピクセル比較が保証するのは「**サンプル時点で発火した分岐**の見た目」だけで、発火しなかった分岐は
存在ごと見えない。§0 で凍結したテーマ一式を読み、実装と突き合わせる。実案件ではこの工程を後から
やって**実装漏れ13件**が出た(一覧の公開状態フィルタ欠落、空の仕様行の `&nbsp;` 削除、付帯情報行の
分岐取り違え、NEW バッジの日付ウィンドウ、問い合わせ導線の誤誘導など)。

観点は3つ。

1. **クエリ条件**: `WP_Query` / `get_posts` の `meta_query` / `tax_query` / `posts_per_page` / `orderby`
2. **表示分岐**: `if` の条件、空値のフォールバック(`&nbsp;` / `-` / 「ASK」)、値による出し分け、
   日付ウィンドウ(`$diff <= 7` 等)
3. **enqueue されている JS 全部**: 見た目(slick / imgLiquid / lity)だけでなく**副作用も棚卸しする**。
   実案件で漏れた例 — CTA のスムーススクロール(ヘッダー高オフセット)、PC での `tel:` 無効化、
   自動送り速度(原文 5000ms を 4000ms で実装)、無限スクロール、本文 iframe のラッパー付与

**指摘は必ずデータで裏を取ってから実装する。** テーマにコードがあっても、それを動かすデータが
存在しないことがある。実案件では報告24件のうち**7件が誤報**で、原因は毎回この3つのいずれかだった。

| 誤報のパターン | 確認方法 |
|---|---|
| ターム・メタが一度も付与されていない | WXR を全走査して付与数を数える(実測: `item_tag` / `model` / `media_badge` が0件、`media_has_secret` が全件 false) |
| 公開 URL として使われていない | 旧URL台帳・archive のページ集合・本番HTMLのリンクを全部見て0件か確認 |
| テーマ外プラグインが `orderby` を上書き | archive の実描画順と突き合わせる(§5 の並び順) |

**CSS → DOM の逆方向監査も同時にやる。** 移植した CSS のセレクタが実 DOM に到達しない箇所は、
機能の取りこぼしのサイン。実案件の2件 —
`.main-img .slick-arrow{opacity:0}` とホバー表示指定まで移植済みなのに矢印の DOM が無い、
`.wp-pagenavi{opacity:0}` でページャを隠しているのに無限スクロールの代替が無く**2ページ目へ到達不能**。

### 7. verify スイート(ゲート4)

```bash
npm run wpkit -- verify --old ../_scratch/archive --new ../site/out -o ../_scratch/verify
```

missing は意図した除外だけにし、metaMismatches は0を目標にする。加えて、テンプレの `scripts/` に次のゲートを置く。

| コマンド | 守るもの | 実行時期 |
|---|---|---|
| `npm run typecheck` / `npm run lint` | 型 / lint・format | 常時 |
| `npm run verify:t6`(`scripts/verify-t6.mjs`) | フォーム構造と承認済み fixture の一致 | フォーム・ページ変更後 |
| `npm run verify:routes`(`scripts/verify-routes.mjs`) | 旧URL台帳を新routeまたは301で全カバー、重複0。`out/` の実在パスと照合 | URL・ID・リダイレクト変更後 |
| `npm run verify:seo`(`scripts/verify-seo.mjs`) | title / description / robots / canonical / OGP / JSON-LD / sitemap / preview noindex | SEO・ルート変更後 |
| `npm run verify:stylesheets`(`scripts/verify-stylesheets.mjs`) | 各ページの期待 stylesheet 構成 | link構成変更後 |
| `npm run verify:webvitals-preload`(`scripts/verify-webvitals-preload.mjs`) | preload URL と描画 URL の完全一致 | LCP・画像・preload変更後 |
| axe-core 差分(§8.6) | 本番アーカイブに対して**違反を増やしていない**こと | DOM・属性・クライアント挙動の変更後 |

fixture は原文から作った期待値であり、**承認付き更新のみ**。現行出力から自動再生成する自己参照にしない。

#### scorecard による集約

案件リポジトリのルートへ、品質の定義である `scorecard.config.json` をコミットする。最初に既定ゲート一式を生成し、各 build/review の完了時には scorecard を実行する。

```bash
npm run wpkit -- scorecard init --site ../site
npm run wpkit -- scorecard --config ../scorecard.config.json
```

`scorecard` は既存の verify スクリプトや `wpkit verify` の結果、承認台帳を**集約・裁定するだけ**で、検証ロジックを再実装しない。command ゲートは毎回実行して鮮度を保証し、必須ゲートの未実施は `NOT_RUN` として総合 `FAIL` にする。ゲート4の合否は `scorecard.md` / `scorecard.json` の総合判定で機械判定する。基準を外す・緩める編集は案件側の config diff に残る。

**基準ref方式のゲート(正規化HTML全文比較)を置く場合の運用**: 意図的な DOM 差分を出す変更のたびに
基準 ref を前進させる必要がある。**2コミット制**にする — ①実装(+差分の根拠をコミットメッセージへ)
→ ②基準 ref を①へ進める**機械コミット**。台帳や ref を手で書き換えてゲートを黙らせない。
実案件では1セッションで5回前進した(そのたびに何が変わったかがコミット履歴に残る)。

### 8. 200stack 公開

1. `scorecard.md` の総合 PASS を確認してから公開する(ゲート1〜4を通過済みであること)。A/B 比較中は microCMS 入稿を止める。ビルドごとに live 取得するため、比較中の入稿は差分へ混入する
2. `routing-config.jsonc` を旧URL301の正本として確定する。200stack が適用し、凍結・手編集する。`verify:routes` で `out/` の実在パスとの全カバー・重複0を担保する
3. 200stack でサイトを作成し、microCMS webhook → 200stack webhook 受信 API を接続する
4. release スクリプトで検証ゲート通過を確認し、バージョン更新・タグ・pushを行う。200stack の自動デプロイを正とする
5. 少RAM環境では `BUILD_MEMORY_LIMIT_MB` を設定する。ラッパーが webpack へ切替え、ワーカー数と heap を制約する。Turbopack のネイティブメモリは実質制御不能
6. カスタムドメイン・SSL・DNSを切替え、`templates.md` のチェックリストで監視する。旧環境はロールバック期限まで保持する

### 8.5 Web Vitals(デフォルト品質基準)

- **LCP**: LCP画像は preload + `fetchpriority="high"`。背景画像は preload がなければ発見が遅い。実測22.0s→9.6s
- **CLS**: 寸法が実在する箇所だけ `{url,width,height}` を並列保持し、`aspect-ratio` で予約する。推測 `min-height` は禁止。実測0.229→0.000
- **画像API**: `w=` は surface 別固定値を単一ヘルパーへ集約する。preload URL と描画 URL は完全一致させ、`verify:webvitals-preload` で機械検証する
- **TBT**: 静的エクスポートでは通常ボトルネックにならない(実測19〜50ms)。画像・CSS・LCP/CLSを先に測る

### 8.6 アクセシビリティ(デフォルト品質基準)

忠実再現案件では**「本番と同等」が基準**で、**移行で増やした違反をゼロにする**のが完了条件。
本番由来の違反(配色のコントラスト等)は直すとデザイン変更になるため、別issueで製品判断にする。

```bash
# axe-core を注入して「本番アーカイブ vs 新実装」を同じルールセットで比較する
```

- DOM だけで判定されるルール(`link-name` / `frame-title` / `aria-hidden-focus` / `heading-order` /
  `image-redundant-alt` / `list` 系)は**アーカイブ HTML を `setContent` するだけで比較できる**。
  CSS が要るのは `color-contrast` だけ
- 比較は**JS 実行後**の DOM で行う。archive は取得時点で JS 実行済みの HTML なので、新実装側も
  `networkidle` まで待つ。`domcontentloaded` で比べるとハイドレーション後に出る違反を取り逃す

テンプレ側のデフォルト(実案件で踏んだ順):

- **自前カルーセルの非アクティブスライドは `aria-hidden` だけでは不十分**。中のリンクにキーボード
  フォーカスが入る。`inert`(React 19 は boolean 属性として対応)を併用する。**これが移行で増やした
  唯一の違反だった**
- アイコンのみのリンク(`<a><i class="fa fa-facebook"></i></a>`)に `aria-label`。全ページのフッターに
  出るので影響が大きい
- 背景画像 div だけを包むリンクに `aria-label`(カード内の別リンクがタイトルを持っていても、
  そのリンク自体には名前が要る)
- 本文 HTML 中の iframe に `title` が無ければパイプラインで補う(動画ホストなら「動画」)
- リンクテキストと重複する装飾アイコンの `alt` は空にする

**検証環境の罠**: `IntersectionObserver` を使う実装は、①実際に描画されている環境で ②段階的に
スクロールして検証する。描画していないペイン(`innerWidth: 0`)では IO が一度も発火せず、
`window.scrollTo(0, scrollHeight)` の瞬間ジャンプは高さ1pxの番兵を交差せずに飛び越える。
実案件では正しい実装を2回「壊れている」と誤判定した。
なお原文の `infinitescroll` は scroll ごとに**位置を判定**するので、IO のエッジ検出だけでは等価にならない
(瞬間ジャンプで発火しない)。passive な scroll リスナでの位置判定を併用する

### 9. 旧方式で移行済み案件のモダナイズ(→ `modernize.md`)

新規案件はデフォルトで §6 の最終形へ直接実装するため、本工程は不要。テーマ CSS 温存方式で移行済みの既存案件を、CSS Modules 全ページ化・テーマ CSS 撤去・Next.js 標準機構へ引き上げる場合だけ `modernize.md` の手順を使う。

## 委任・記録の規約

- 実装委任・レビュー・委任ログは delegate スキルの規約に従う(このスキルは何を委任するかの分割と品質ゲートを規定する)
- kit に案件固有ロジックを入れない。案件差は mapping.config と site/ 側で吸収
- 案件へピン留めした kit からスキルへ変更を還元するときは、委任先が変更したファイルだけを列挙してコピーする。古いスナップショットを `rsync` で一括同期せず、反映後に `git diff --stat` で対象を照合する
- 案件で得た WXR・プラグイン固有の癖・事故はこのスキルの `lessons.md` に1行追記する(このリポジトリは非公開なので案件名・実測値を書いてよい)。複数案件で再現した知見に加え、1案件でも案件非依存が明白な外部仕様・FW 挙動・実装パターンは待たずに `SKILL.md` / `design.md` / `recipes.md` へ昇格し、`lessons.md` には案件固有の実測値・経緯だけを残す。認証情報・個人情報・`_scratch/` の生成物は書かない
