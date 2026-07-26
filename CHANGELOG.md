# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

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
