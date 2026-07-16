---
name: wordpress-to-200stack
description: WordPress サイトを microCMS + Next.js 静的エクスポートに変換して 200stack にデプロイする移行手順。WXR エクスポートの分析、mapping config の設計、画像・コンテンツ移行、microCMS スキーマ生成・冪等入稿、デザイン忠実再現、新旧照合、200stack 公開までを、同梱の決定的 CLI(wpkit)と品質ゲートで進める。トリガー例:「WordPressを移行して」「WXRからmicroCMSへ」「wpkitで移行」「WordPressを200stackに」「静的サイト化して」「WordPressサイトをNext.jsにリニューアル」。
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
→ 4. media pull/push(ゲート2)→ 5. schema gen → microCMS作成 → import(ゲート3)
→ 6. next-app 展開 → テンプレ実装委任 → 7. verify(ゲート4)→ 8. 200stack 公開
```

### 0. 現行サイトの凍結(最初に必ず)

```bash
npm run wpkit -- archive <https://origin> -o ../_scratch/archive   # まず --limit 5 で試す
```

- **切替後は二度と取れない基準データ**(HTML・メタ・スクショ・アセット・フォーム台帳・リダイレクト記録)
- `forms.json` が外部フォーム endpoint の台帳。`meta.json` の redirects 記録が 301 表の材料になる

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
- 本文は `legacyBodyHtml`(HTML文字列)。リッチエディタに入れない

### 3. parse(ゲート1: errors 0)

```bash
npm run wpkit -- parse --config ../mapping.config.ts -o ../_scratch/ir
```

- errors(URL衝突・リピータ列数不一致・metaキー参照ミス)は必ず原因特定。warnings は監査対象
  (タクソノミーアーカイブへのリンク → 再現するか判断 / 数値変換失敗 / Yoast テンプレ変数)
- ルート数 =「publish −(除外+SCF設定投稿)」を census と突き合わせる
- コード実装するページは `exclude.postTypes` + `linkCheck.assumeExistPostTypes`

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
  `link[rel=stylesheet]` を集計してから回収リストを作る)

### 5. microCMS(ゲート3: 件数照合)

```bash
npm run wpkit -- schema gen --config ../mapping.config.ts -o ../_scratch/microcms-schema
# 管理画面で API 作成 → 各 .schema.json をインポート → relation 参照先を手動設定(README のチェックリスト)
npm run wpkit -- import --ir ../_scratch/ir --dry-run   # oversized 0 を確認 → 本実行
```

- WRITE 5回/秒・1コンテンツ約200KB(kit がレート制御・超過スキップを実装済み)
- 入稿後の totalCount 照合が期待件数と一致すること。`--only` / `--source-id` で部分再実行可

### 6. Next.js(テンプレ実装は delegate へ)

- `cp -R kit/templates/next-app <案件>/site` → `WPKIT_DATA_SOURCE=ir` で microCMS 未契約でもビルド可
- **デザイン検証中は dev 用 config(mediaHost=現行ドメイン)で parse した ir-dev を使い、
  本番切替時に本 config で parse し直す**(media transform 前でも画像が見える)
- テンプレ実装指示書は `templates.md` の雛形を使用。**指示書に必ず入れる規律**(実案件で確立):
  1. 原文 page.html との DOM タグ実体数一致を完了条件にする(substring 数は RSC ペイロードで2倍に見える)
  2. jQuery プラグイン(imgLiquid/slick/lity)の見た目は追加 CSS で代替(テーマ CSS は編集禁止)
  3. 原文の DOM 順を崩さない(float 回り込み)。原文に無い要素を追加しない
  4. フォームは formrun 等の action・input name を原文と完全一致(SDK 埋め込み型は同一フォーム ID の embed div を再現)
- レビューは司令塔がローカルで実施: typecheck / build / **Playwright 実画面スクショと原文スクショの比較**
  (委任先 sandbox は listen・ブラウザ不可のため実画面確認は司令塔の仕事)

### 6.5 デザイン忠実再現の diff-first ループ(fidelity)

テンプレ実装後の再現度追い込みは、感覚でなく機械スクショ差分で回す。kit の
`templates/next-app/scripts/` に `fidelity-scan.mjs`(全ページを凍結スクショと
pixelmatch 比較、surface=テンプレ種別ごとに集計)と `fidelity-report.mjs`
(ワースト表の TODO 生成)、`lib/surfaces.mjs`(パス→surface 規則。
**案件のURL設計に合わせて必ず調整**)がある。

```bash
node scripts/fidelity-scan.mjs [--only <surfaceId>]   # WPKIT_ARCHIVE / WPKIT_IR_DIR / WPKIT_ORIGIN を環境変数で
node scripts/fidelity-report.mjs                      # FIDELITY_TODO.md を再生成
```

運用ループ(実案件で確立):

1. ワースト surface を選ぶ → 代表ページを**ブロック単位のDOM実測**(原文 page.html を
   レンダリングして y/height を突き合わせ)で診断 → 根因を特定してから修正を委任
2. 修正 → 再スキャン → champion(新旧比較)をユーザーに提示 → 承認されたら
   approvals 台帳(例: docs/fidelity-approvals.json)に記録し、現行スクショを
   baseline として凍結(以後は退行検知に使う)
3. **scan の ratio は絶対値でなく相対比較に使う**: リモート資源・埋め込みの描画で
   run 間にぶれる。決定的な判定は DOM 実測が正。ページ固有の到達下限は
   「原文 page.html を今日レンダリングして原文スクショ自身と比較」(ノイズフロア)で測れる
4. スクショの決定性のため、スキャンは reducedMotion をエミュレートする。
   自動送りカルーセル等は `prefers-reduced-motion: reduce` で停止するガードを実装に入れる
5. 意図的差分(製品判断による原文からの乖離)は approvals 台帳の notes に集約する

### 7. verify(ゲート4)

```bash
npm run wpkit -- verify --old ../_scratch/archive --new ../site/out -o ../_scratch/verify
```

- missing は「意図した除外」だけになるまで潰す。metaMismatches は 0 を目標
  (Yoast テンプレ変数 %%title%% 等の展開、canonical・OGP・robots の原文一致、title テンプレの二重付与に注意)
- **SEO/sitemap 原本照合(必須)**: テンプレの `scripts/verify-seo.mjs`(`npm run verify:seo`)で、全ページの title / description / robots / canonical / og:* / twitter:* / JSON-LD をローカル原本アーカイブと突き合わせ、sitemap.xml はルート台帳との過不足0・移動URLは新URL掲載・プレビュー画面の除外+noindex を検証する。**非意図差分0が合格条件**。意図差分は `docs/seo-intentional-diffs.json` に台帳化して PASS 扱いにする(外部fetchは行わない)。実測の罠: OG/Twitterタグの部分実装・HTML entity の二重エスケープ・snapshot 経路での alias 欠落は、この照合を入れるまで気づけなかった
- dev 用 ir(画像=現行ドメイン)のままだと brokenLinks が大量誤検知になる — 本番 ir で最終確認する

### 8. 200stack 公開

1. 本番 config で `parse` し直し → `media transform`(フル)+ CMS 編集対象画像は microCMS メディアへ移行 → `site/` を本番ビルド
2. 200stack でサイト作成 → GitHub 連携(push で自動ビルド。変換済み `public/media/` はリポジトリに含める)
3. **microCMS の webhook → 200stack の webhook 受信 API** を接続(コンテンツ更新で自動再デプロイ)
4. リダイレクト設定: archive の redirects 記録から生成した 301 表(kit の meta.json → `redirects.txt`)を 200stack に設定
5. カスタムドメイン+SSL → DNS 切替
6. 切替チェックリスト(`templates.md`)に従う: コンテンツ凍結 → 最終 WXR 差分移行 → 監視 → 旧環境はロールバック可能に保持

### 9. 引き渡し後モダナイズ(任意工程 → `modernize.md`)

**移行完了 ≠ CSS 健全化。** legacy CSS の削除・CSS Modules 化・tokens 導入・`!important` ゼロは移行の完了条件に含めない(移行の完了はゲート4まで)。引き渡し後にサイトを育てる案件で顧客が発注した場合のみ、`modernize.md` の手順(開始条件・絞り込み式・検証ゲート)で別工程として実施する。移行フェーズの委任指示書にモダナイズ作業を混ぜない。

## 委任・記録の規約

- 実装委任・レビュー・委任ログは delegate スキルの規約に従う(このスキルは何を委任するかの分割と品質ゲートを規定する)
- kit に案件固有ロジックを入れない。案件差は mapping.config と site/ 側で吸収
- 案件で得た WXR・プラグイン固有の癖は**案件リポジトリ側の `docs/lessons.md`(非公開)**に1行追記する(実測ノウハウはこの公開リポジトリに置かない)
