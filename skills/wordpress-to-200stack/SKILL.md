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

```bash
npm run wpkit -- media pull --ir ../_scratch/ir -o ../_scratch/media   # まず --limit 30
npm run wpkit -- media push --media ../_scratch/media --bucket <R2バケット> --endpoint <R2 endpoint> --dry-run
```

- **200stack はリクエスト従量課金のため、画像は R2 + カスタムドメイン(例: media.<domain>)に分離**し、
  HTML/CSS/JS だけを 200stack に置くのが原則(画像リクエストが課金を支配する)
- パス構造 `/wp-content/uploads/...` を維持(本文書き換えがホスト置換のみで済む)
- R2 認証は AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY(region auto)。秘密情報は delegate 規約に従い委任先へ渡さない
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
  本番切替時に本 config で parse し直す**(R2 未配置でも画像が見える)
- テンプレ実装指示書は `templates.md` の雛形を使用。**指示書に必ず入れる規律**(実案件で確立):
  1. 原文 page.html との DOM タグ実体数一致を完了条件にする(substring 数は RSC ペイロードで2倍に見える)
  2. jQuery プラグイン(imgLiquid/slick/lity)の見た目は追加 CSS で代替(テーマ CSS は編集禁止)
  3. 原文の DOM 順を崩さない(float 回り込み)。原文に無い要素を追加しない
  4. フォームは formrun 等の action・input name を原文と完全一致(SDK 埋め込み型は同一フォーム ID の embed div を再現)
- レビューは司令塔がローカルで実施: typecheck / build / **Playwright 実画面スクショと原文スクショの比較**
  (委任先 sandbox は listen・ブラウザ不可のため実画面確認は司令塔の仕事)

### 7. verify(ゲート4)

```bash
npm run wpkit -- verify --old ../_scratch/archive --new ../site/out -o ../_scratch/verify
```

- missing は「意図した除外」だけになるまで潰す。metaMismatches は 0 を目標
  (Yoast テンプレ変数 %%title%% 等の展開、canonical・OGP・robots の原文一致、title テンプレの二重付与に注意)
- dev 用 ir(画像=現行ドメイン)のままだと brokenLinks が大量誤検知になる — 本番 ir で最終確認する

### 8. 200stack 公開

1. 本番 config で `parse` し直し → R2 へ media push(フル)→ `site/` を本番ビルド
2. 200stack でサイト作成 → GitHub 連携(push で自動ビルド)
3. **microCMS の webhook → 200stack の webhook 受信 API** を接続(コンテンツ更新で自動再デプロイ)
4. リダイレクト設定: archive の redirects 記録から生成した 301 表(kit の meta.json → `redirects.txt`)を 200stack に設定
5. カスタムドメイン+SSL(本体と media の両方)→ DNS 切替
6. 切替チェックリスト(`templates.md`)に従う: コンテンツ凍結 → 最終 WXR 差分移行 → 監視 → 旧環境はロールバック可能に保持

## 委任・記録の規約

- 実装委任・レビュー・委任ログは delegate スキルの規約に従う(このスキルは何を委任するかの分割と品質ゲートを規定する)
- kit に案件固有ロジックを入れない。案件差は mapping.config と site/ 側で吸収
- 案件で得た WXR・プラグイン固有の癖は `lessons.md` に1行追記(次案件の分析が速くなる)
