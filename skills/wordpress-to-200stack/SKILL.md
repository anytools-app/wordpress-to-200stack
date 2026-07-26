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
- microCMS の API 数はプラン上限から逆算(Hobby 5 / Team 10。原典 2026-07 確認済み)。少数件の型は kind 統合
- config の書式・型の決め方チェックリストは `templates.md`。**フィールド型は必ずサンプル実値で決める**:
  SCF 画像フィールドは attachment の wp_id が入る(`type:"image"` で kit が URL 解決)、wp_id 参照は relation、
  "0"/"1" は boolean、価格は単位に注意(万円単位の実例あり)
- microCMS 対象の記事本文は `legacyBodyHtml`(HTML文字列)。リッチエディタに入れない

### 2.5 現行管理画面のフィールド精査(閲覧のみ・人が画面を開く)

WXR/analyze から起こした config は、フィールドの**表示ラベル・表示順・入力ガイド・登録済みタクソノミー**を持たない(WXR にあるのは meta_key と値だけ)。これらの正本は**現行 WordPress の投稿編集画面**にしかないため、schema を現行に合わせるにはここを精査する。

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

- errors(URL衝突・リピータ列数不一致・metaキー参照ミス)は必ず原因特定。warnings は監査対象
  (タクソノミーアーカイブへのリンク → 再現するか判断 / 数値変換失敗 / Yoast テンプレ変数)
- ルート数 =「publish −(除外+SCF設定投稿)」を census と突き合わせる
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
   (**Team プラン以上・1ファイル5MB**、超過分は upload が自動縮小)へ冪等アップロードし、
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

- **API は1つずつ作成して人間レビューを回す**。スキーマ JSON をインポート → 管理画面でフィールド名・説明・必須・グループを確認 → 指摘を `mapping.config.ts` に反映 → `wpkit schema gen` で再生成 → 再インポート、の順で確定する。レビュー前に全 API を一括作成しない
- フィールドの採否は推測せず、IR の実データで決める:
  - 全件空なら作らない(`body: "none"` / `seoFields: "none"`)
  - SEO は「全件空 → 作らない」「Yoast の定型値のみ → CMS に作らずサイト側フォールバックで生成」「記事ごとの個別文あり → コンテンツを失わないよう維持」の3分岐で判断する
  - サイトが読まず、URL 台帳など別の正本で代替される未使用フィールドは廃止する
- `requiredFields` は、**全件が値を持ち、欠けると表示が壊れるフィールドだけ**に指定する。1件でも欠けるフィールドは例外運用(価格未定など)を確認し、必須にしない
- 表示順専用の数値フィールドは作らず、microCMS コンテンツ一覧のドラッグ並び順を正とする。`orders` 未指定時は管理画面順で取得され、新規コンテンツは先頭に入るため、初期移行は希望表示順の逆から作成し、サイトは取得配列順で表示する
- スキーマインポート後、**relation の参照先 API**と**repeater / カスタムフィールドの紐付け**を管理画面で手動設定する。JSON だけでは復元されないため、API ごとのチェックリストに含める
- mapping から廃止したフィールドは、入稿前に IR の `documents.ndjson` の `fields` からも削除する。スキーマにないキーを送ると `unexpected key` の 400 になる
- 全件入稿の前に各 API から5〜10件をサンプル入稿して人間確認する。公開状態・売約状態・グループ有無などの表示バリエーションを含め、relation の参照先は入稿済みサンプル内に閉じるよう選ぶ(未存在参照への relation PATCH は失敗する)
- Team 以上では API グループ機能(最大10グループ)を使い、商品系・記事系・会社／人など用途別に整理する
- WRITE 5回/秒・1コンテンツ約200KB(kit がレート制御・超過スキップを実装済み)
- 入稿後の totalCount 照合が期待件数と一致すること。`--only` / `--source-id` で部分再実行可
- **画像フィールドへ `null` / `undefined` を送らない**。実測では `null` が 400 ではなく 504 を起こした。kit の import は送信前のペイロード正規化・空キー除去で対処する
- **PUT は新規作成専用、既存 contentId は PATCH**。再実行は already exists を検知して PATCH へ切り替える
- **contentId は `^[a-z0-9_-]+$`**。適合しない旧 ID は microCMS の自動採番を使い、旧 URL は `routing-config.jsonc` の 301 で維持する
- **書込み API の無応答ハングと間欠 504**を前提に、AbortController 60秒 + 5xx 指数バックオフを入れる
- **メディアは拡張子由来の Content-Type 必須**。`application/octet-stream` は画像でなくファイル扱いになり、画像フィールドで参照できない
- **入稿プロセスは同時1つ**。新規 PUT・自動採番を並走させない
- 大量メディアアップロードは 429 帯がある(実測では1,916枚連続後)。`Retry-After` と指数バックオフで回復させる

### 6. ネイティブ実装(デフォルト成果物)

`cp -R kit/templates/next-app <案件>/site` で展開し、**サンプル入稿済みの microCMS 直取得で実装する**。ゲート3は実装の前提であり、前段データ生成やテーマ互換の中間機構を作らない。

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

#### 全ページのネイティブ実装ループ

1. アーカイブの HTML・スクショを原文として、文言、リンク、画像、DOM順、レスポンシブ挙動を読む
2. `page.tsx` / `src/templates/` + CSS Modules + SiteLink でネイティブ実装する
3. §6.5 のピクセル比較で差分を発見し、機能(フォーム・リンク・メタ)も照合する
4. 差分修正と再比較を収束まで繰り返す

ページは難易度順に進める。最初に単純な1ページで JSX・metadata・CSS所有権・画像・比較手順を確立し、承認後にフォームや複雑なレイアウトへ展開する。

#### 委任指示書の規律

記事系・固定ページとも `templates.md` の雛形を使い、次を必ず含める。

1. 完了条件は**ピクセル比較の収束 + 機能一致(フォーム・リンク・メタ)**。DOM タグ実体数一致は完了条件にしない。RSC ペイロードで substring が2倍に見える等の構造診断には使ってよい
2. jQuery プラグイン(imgLiquid / slick / lity)の見た目は CSS + React で代替する。カルーセルは scroll-snap 等を使い、旧ライブラリやテーマ CSS を持ち込まない
3. 原文の DOM 順・視覚順を尊重する。float 回り込み等の診断に有効だが、構造の完全一致は要求しない
4. フォームは formrun の action・input name を原文と完全一致させる

レビューは司令塔が typecheck / build / Playwright の desktop・mobile 実画面比較で行う。

**デフォルトにしない方式**: テーマ CSS のページ単位読込、class-map、fixed-pages(凍結 HTML 配信)、アーカイブ原文 HTML の汎用注入、postbuild の body 属性注入、IR を前段生成して描画時に合成する方式、独自リダイレクト生成器は作らない。いずれも実案件で作った後に撤去された中間機構であり、dev/静的出力の乖離、カスケード事故、二重の正本を生む。必要な機能は Next.js + microCMS + CSS Modules へ直接実装する。

### 6.5 fidelity(原文比較)と pixel-gate(退行検知)

忠実性の完了条件は**原文とのピクセル比較の収束 + 機能一致**。用途の異なる2本を混同しない。

#### fidelity: 原文アーカイブとの比較

- `fidelity-scan.mjs` で凍結スクショと新実装を surface ごとに比較し、`fidelity-report.mjs` でワーストを出す。移行証跡として残す
- ratio は run 間で ±0.08 ぶれる。A/B は同一セッション連続 run で行い、決定的判定はブロック単位の DOM 実測(y/height の `dy=0` / `dh=0`)
- reducedMotion をエミュレートし、自動送り UI は `prefers-reduced-motion: reduce` で停止する
- 意図的差分と承認結果は approvals 台帳へ記録する

#### pixel-gate: 変更前後の自ビルド比較

`css-visual-diff.mjs` の `capture --label before` / `capture --label after` → `compare` で、同じ実装の変更前後を比較する。CSS・レイアウトへ触る変更の標準ゲートとする。CSS Modules化B6では静的監査・typecheckが全通過した変更から3回帰を検出した実測があり、コード検査の代替にはならない。

撮影時の実務:

- lazy 画像は fullPage 撮影前に0.85画面刻みで下端までスクロールし、先頭へ戻してから撮る
- 全外部画像を block すると microCMS 画像が空箱になる。実画像比較は「自社配信のみ許可」の特別キャプチャで新旧ビルドをクロス比較する
- スピナー等の既知ノイズは台帳化し、未知差分と分ける

差分の切り分けは、①scan の高さΔ → ②帯域別 pixelmatch → ③ブロック walk → ④CDP `CSS.getMatchedStylesForNode` の順で行う。CSS の勝者特定は grep より CDP を正とする。

### 7. verify スイート(ゲート4)

```bash
npm run wpkit -- verify --old ../_scratch/archive --new ../site/out -o ../_scratch/verify
```

missing は意図した除外だけにし、metaMismatches は0を目標にする。加えて、テンプレの `scripts/` に次のゲートを置く(未追加のスクリプトは Phase 2 でテンプレへ追加)。

| コマンド | 守るもの | 実行時期 |
|---|---|---|
| `npm run typecheck` / `npm run lint` | 型 / lint・format | 常時 |
| `npm run verify:t6`(`scripts/verify-t6.mjs`) | フォーム構造と承認済み fixture の一致 | フォーム・ページ変更後 |
| `npm run verify:routes` | 旧URL台帳を新routeまたは301で全カバー、重複0。`out/` の実在パスと照合 | URL・ID・リダイレクト変更後 |
| `npm run verify:seo` | title / description / robots / canonical / OGP / JSON-LD / sitemap / preview noindex | SEO・ルート変更後 |
| `npm run verify:stylesheets` | 各ページの期待 stylesheet 構成 | link構成変更後 |
| `npm run verify:webvitals-preload` | preload URL と描画 URL の完全一致 | LCP・画像・preload変更後 |

fixture は原文から作った期待値であり、**承認付き更新のみ**。現行出力から自動再生成する自己参照にしない。

### 8. 200stack 公開

1. ゲート1〜4を通し、A/B 比較中は microCMS 入稿を止める。ビルドごとに live 取得するため、比較中の入稿は差分へ混入する
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

### 9. 旧方式で移行済み案件のモダナイズ(→ `modernize.md`)

新規案件はデフォルトで §6 の最終形へ直接実装するため、本工程は不要。テーマ CSS 温存方式で移行済みの既存案件を、CSS Modules 全ページ化・テーマ CSS 撤去・Next.js 標準機構へ引き上げる場合だけ `modernize.md` の手順を使う。

## 委任・記録の規約

- 実装委任・レビュー・委任ログは delegate スキルの規約に従う(このスキルは何を委任するかの分割と品質ゲートを規定する)
- kit に案件固有ロジックを入れない。案件差は mapping.config と site/ 側で吸収
- 案件で得た WXR・プラグイン固有の癖・事故はこのスキルの `lessons.md` に1行追記する(このリポジトリは非公開なので案件名・実測値を書いてよい)。複数案件で再現した知見は `SKILL.md` / `design.md` へ昇格させ、認証情報・個人情報・`_scratch/` の生成物は書かない
