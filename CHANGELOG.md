# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.7.0] - 2026-07-30

### Added

- `wpkit scorecard` / `wpkit scorecard init` と、案件ごとにコミットする宣言的な `scorecard.config.json` を追加
- fidelity 承認、実機レビュー、a11y / Lighthouse 手動計測を記録する `fidelity-approvals.json` / `live-review.json` / `quality-attestations.json` の様式を追加

### Changed

- `SKILL.md` §7 / §8、テンプレート README、切替チェックリストを、scorecard 総合 PASS を公開前提とする運用へ更新

## [0.6.0] - 2026-07-27

### Added

- `recipes.md` を新設し、カルーセル、レイアウト、formrun、React / Next.js、診断・計測の再利用手順を集約

### Changed

- `lessons.md` を案件固有の実測・事故・製品判断の記録へスリム化し、共通ノウハウを本則と `recipes.md` へ昇格
- lessons の記録ルールを改訂し、1案件でも案件非依存が明白な外部仕様・FW 挙動・実装パターンは即昇格する基準を追加
- `SKILL.md` §2.5 に SCF 定義の WXR 復元、§4 に粒状画像の lossless 判定、§5 に microCMS のプラン・API 制約と表示順、§6 / §6.5 にレシピ転記・sandbox 往復・動き系の実機レビューを追加

## [0.5.0] - 2026-07-26

### Added

- 稼働テーマ一式の凍結取得を §0 に追加し、実装後の突き合わせゲート §6.6(クエリ条件・表示分岐・enqueue JS)を新設
- アクセシビリティを §8.6 としてデフォルト品質基準に追加(本番アーカイブとの axe-core 差分で「違反を増やさない」を完了条件に)
- 本文の `wpautop` 適用を parse の必須ルール化。保存先サニタイザが落とす不正な入れ子の検出も設計へ
- 並び順の正本を「archive の実描画順」と明記(`pre_get_posts` の並び替えプラグイン対策)。`wp:menu_order` の取り込み方針を追記
- `WP_Query` ブロックの固定配列化禁止、内部リンクの新ルート化、CMS 駆動箇所での派生サイズ画像の不使用を実装規約へ
- 基準ref方式ゲートの2コミット運用、スクロール連動(IntersectionObserver)の検証手順を追記

### Note

- 契機は 案件A 案件でテーマ入手後に実施した突き合わせ(実装漏れ13件・誤報7件)。実測値は `lessons.md` §12

## [0.4.0] - 2026-07-26

### Changed

- Next.js 雛形を前段 `build:data` / IR hydration から、microCMS Data Cache + Promise snapshot の直接取得へ移行
- CMS 詳細を surface 別動的 segment へ分解し、SiteLink、低メモリ build wrapper、route/form/stylesheet/Web Vitals 検証を標準化
- import / media upload の null 正規化、60秒 timeout、5xx retry、`Retry-After` 対応を強化

## [0.3.0] - 2026-07-26

### Changed

- 案件A移行の最終形(ネイティブ実装、CSS Modules、Next.js Data Cache、SiteLink、formrun、fidelity + pixel-gate、verifyスイート、`routing-config.jsonc`)を新規移行のデフォルト成果物へ昇格し、スキル文書を全面改訂
- `modernize.md`を、テーマCSS温存方式で移行済みの既存案件を最終形へ引き上げる手順へ再位置づけ
- `lessons.md`へ案件Aの実測ノウハウ全11章を取り込み

### Note

- kitテンプレのコード追随はPhase 2(次リリース)で行う

## [0.2.0] - 2026-07-26

### Added

- `skills/wordpress-to-200stack/lessons.md` を復活。以前削除した内容を復元し、記録ルールのヘッダを追加

### Changed

- リポジトリの非公開化に伴い「実測ノウハウ・案件固有情報をこのリポジトリに置かない」方針を撤廃。`README.md` / `skills/wordpress-to-200stack/README.md` / `SKILL.md` / `SECURITY.md` / `design.md` / `CLAUDE.md` を新方針へ更新し、認証情報・個人情報・`_scratch/` 生成物を記録しない線引きは維持

## [0.1.0] - 2026-07-26

### Added

- **`anytools-agent-skills` から `wordpress-to-200stack` スキルを独立リポジトリへ分離**。`git filter-repo` でパス抽出したため、分離前の45コミットの履歴を保持している(分離前の変更経緯は本リポジトリの `git log` を参照)
- 単体でインストールできる plugin / marketplace マニフェスト(`.claude-plugin/`)、`README.md`、`SECURITY.md`、`.gitignore`、`CLAUDE.md`(plan.md ワークフロー)を新設

### Changed

- スキル本文の相対リンク `../delegate/README.ja.md` を、分離後も解決できる `anytools-agent-skills` の URL へ変更
- `skills/wordpress-to-200stack/README.md` の構成ツリーを新リポジトリのレイアウトに更新し、公開リポジトリに置かない `lessons.md` の記載を実態(案件リポジトリの `docs/lessons.md`)に合わせた

### 分離時点でスキルが提供するもの

- 決定的 CLI `wpkit`(analyze / parse / media / archive / schema gen / import / verify)を `kit/` に同梱。TypeScript + vitest(8ファイル81件)
- WXR 分析 → mapping config → 冪等入稿 → デザイン忠実再現(委任規律込み)→ 新旧照合 → 200stack 公開までを4つの品質ゲートで規定
- Next.js 静的エクスポートのテンプレート(`kit/templates/next-app`)、CSS モダナイズのテンプレート(`kit/templates/modernize-css`)
- 記事系テンプレの fidelity 差分ループ、固定ページの App Router ネイティブ実装ループ、microCMS ドラフトプレビュー、SEO / sitemap の原本照合
- 移行元サーバ保護の不変条件(fetch-once 解決、適応レート制御、CSS 視覚差分での外部フェッチ全面ブロック)
