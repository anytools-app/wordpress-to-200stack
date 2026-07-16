# wp-static-kit 設計書 — WordPress → microCMS + Next.js 静的サイト移行基盤

目的: WordPress サイトの静的リニューアル案件を「決定的なスクリプト群 + Claude Code スキル」で再現可能にし、
案件あたりの人手作業を大幅に圧縮する。
実案件(WordPress サイト)を最初の実データテストケースとして構築した。

## 全体アーキテクチャ

役割分担の原則:
- **決定的な処理はすべて CLI スクリプト**(wp-static-kit): 同じ入力から同じ出力。人もAIも判断しない
- **判断はスキル**(wp-migrate): マッピング設計・品質ゲート・委任手順の「規約」。Claude Code が司令塔として実行
- **テンプレ実装は AI 委任**(delegate 規約に従い Codex へ)。スキルが指示書テンプレを提供する

```
wp-static-kit/                     # 独立リポジトリ(npm workspace / TypeScript)
  packages/
    analyze/    # WXR センサス(post_type・meta・タクソノミー・URL パターン・SCF/ACF 定義)
    parse/      # WXR → 中間表現(documents.ndjson / routes.json / attachments.ndjson / relations.json)
    media/      # 画像回収(原本+派生)・チェックサム台帳・R2 同期・URL 書き換えマップ
    archive/    # 現行サイトのクロール・HTML/アセット保存・Playwright スクショ
    microcms/   # スキーマ JSON 生成(管理画面インポート用)・冪等入稿(レート制御付き)
    verify/     # 新旧照合(URL パリティ・リンク・画像404・メタ比較・スクショ差分)
  templates/
    next-app/   # Next.js スケルトン(後述)
    mapping.config.example.ts
  cli.ts        # wpkit <command>
```

```
~/.claude/skills/wp-migrate/
  SKILL.md       # ワークフロー規約(下記フロー)・判断チェックリスト・品質ゲート
  templates.md   # mapping config の書き方、テンプレ実装指示書の雛形(delegate 用)
  lessons.md     # 案件ごとの実測記録(WXR の罠、プラグイン固有の癖)
```

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
  - 本文 HTML は legacyBodyHtml として保持。画像 URL・内部リンクを台帳で書き換え、
    script 除去・埋め込み(YouTube/Vimeo/Instagram/GCal)はプレースホルダー化
  - relation(投稿間参照)は wp_id で解決し relations.json へ
  - 本文の inline style は inline-styles.json に集計(要素数・出現ページ・プロパティ頻度)。
    サイト側サニタイザが style 属性を除去するため、削除許容かデータ変換かを移行者が判断する材料
- 出力に validation-report.json(URL 衝突・未解決参照・リピータ不一致・画像欠損)。**エラー0が次工程のゲート**

### wpkit media pull / push
- pull: attachment 原本 + `_wp_attachment_metadata` の派生サイズ + 本文 srcset 参照 + CSS url() を
  並列ダウンロード(リトライ・チェックサム・content-type 検証)→ manifest
- push: R2 へ差分同期(パス構造は `/wp-content/uploads/...` を維持し、書き換えをホスト置換のみにする)
- 欠損レポートを人が確認するのが唯一の手作業

### wpkit schema gen / wpkit import
- schema gen: mapping.config から microCMS の API スキーマ JSON を生成(管理画面のインポート機能で投入)
- import: コンテンツ API で冪等入稿
  - contentId = `{type}-{wp_id}` の PUT upsert、payloadChecksum 一致は skip
  - レート制御(WRITE 5回/秒、実効 4/秒)+ 429 指数バックオフ
  - 2パス目で relation を PATCH
  - `--dry-run` / `--only <type>` / `--source-id <id>`
  - 入稿後に GET で全件突き合わせ(件数・checksum)

### wpkit archive <url> / wpkit verify <old> <new>
- archive: sitemap+リンククロールで全 URL 収集 → HTML・ヘッダー・canonical・スクショ(desktop/mobile)保存。
  切替後は取得不能になる基準データなので着手時に必ず実行
- verify: 新旧の URL パリティ(旧200が新でも200)、内部リンク・画像404、title/description/canonical/OGP 比較、
  Playwright スクショ差分(閾値超えのみ人がトリアージ)→ HTML レポート

## mapping.config(案件ごとに書く唯一のファイル)

```ts
export default defineMigration({
  wxr: "./export.xml",
  site: { origin: "https://www.example.jp", mediaHost: "https://media.example.jp" },
  exclude: { postTypes: ["archived"], statuses: ["draft", "private"] },
  apis: {
    items: {
      from: "item",
      fields: { /* meta key → フィールド定義。analyze の出力から半自動生成 */ },
      repeaters: { images: ["image"], points: ["feature_img", "feature_line", "feature_text"] },
      relations: { relatedItem: { key: "item-data", to: "people" } },
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

## Next.js スケルトン(templates/next-app)

案件を跨いで不変の基盤をテンプレ化:
- `output: 'export'` 構成、trailingSlash、custom image loader
- routes.json 駆動の catch-all ルート + `generateStaticParams`(dynamicParams=false)
- Repository 層(microCMS クライアント: 全件ページング取得・ビルド時のみ fetch)
- legacyBodyHtml レンダラ(サニタイズ+埋め込みコンポーネント置換)
- formrun 接続フォーム(入力→確認→送信の状態機械。フォーム台帳から生成)
- 検索インデックス生成(一覧の絞り込み用軽量 JSON)
- sitemap / robots / メタ(Yoast 由来)自動出力
- verify と対になる data-testid 規約

案件固有で書くのは **CSS とテンプレコンポーネントの見た目だけ**。ここは AI 委任(Codex)+人間レビュー。
archive のスクショ・保存 HTML を「凍結された仕様書」として指示書に添付する運用をスキルが規定。

## スキル(wp-migrate)のワークフロー

1. `wpkit analyze` → 出力を読んで移行スコープ・API 構成をユーザーに確認(製品判断)
2. mapping.config 作成 → `wpkit parse` → validation エラー 0 になるまで config を直す(ゲート1)
3. `wpkit archive`(基準凍結)、`wpkit media pull/push`(欠損レポート確認 = ゲート2)
4. `wpkit schema gen` → microCMS へ投入 → `wpkit import --dry-run` → 本入稿 → 突き合わせ(ゲート3)
5. スケルトン展開 → テンプレ実装を delegate 規約で Codex へ(テンプレ単位の指示書、スクショ添付)
6. `wpkit verify` → 差分トリアージ → 修正ループ(ゲート4)
7. 切替チェックリスト(DNS・最終差分移行・監視)


## 新規記事のデフォルト対応(2026-07 確定)

移行後に microCMS だけで作成された新規記事は、**デフォルトで描画対象**とする(IR台帳に無いレコードの合成ハイドレーション)。テンプレート `next-app/src/lib/repository.ts` に実装済み:

- contentId = record.id(記事作成時にIDへスラッグを入力すればそのままURL、無指定なら自動発行ID)
- ルートは「そのAPIの既存ルートの最頻第1セグメント + /{contentId}」(people は kind で /staff | /vendors)。既存ルートと衝突したら既存優先でスキップ
- 画像フィールドは {url,width,height} → URL文字列へ正規化(IRモードと同型)。参照フィールドは relation として復元
- 既存(移行)記事のURL・出力は不変。sitemap/アーカイブ一覧へ自動掲載

これに伴い、サイトのビルド入力は「IRスナップショット(リポジトリにコミット、~5MB)+ビルド時のmicroCMS API取得」を標準構成とする(CI/200stackに _scratch は無い前提。案件の export:build-snapshot 参照)。
