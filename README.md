# wordpress-to-200stack

WordPress サイトを **microCMS + Next.js 静的エクスポート**へ移行し、**200stack** に公開するための Claude Code Agent Skill です。決定的な CLI(`wpkit`)が機械的な処理を担い、スキル本文が判断と品質ゲートを定めます。

**Note: this skill is written in Japanese.** It migrates WordPress sites to a microCMS + Next.js static export deployed on 200stack, pairing a deterministic CLI (`wpkit`) with a gated workflow.

## 30秒サマリ

WXR(WordPress エクスポート XML)の分析から公開までを、ゲート付きの一本道で進めます:

```text
0. archive(現行サイトの凍結)→ 1. analyze → 2. mapping config(製品判断)
→ 3. parse(ゲート1: errors 0)→ 4. media pull/push(ゲート2)
→ 5. schema gen → microCMS 作成 → import(ゲート3)
→ 6. next-app 展開 → テンプレ実装委任 → 7. verify(ゲート4: 新旧照合)→ 8. 200stack 公開
```

- **決定的な処理は `wpkit`**: WXR 解析、画像移行、microCMS スキーマ生成・冪等入稿、新旧照合
- **判断はスキル(司令塔)**: 移行スコープ・フィールド型・404/301 の裁定などの製品判断はユーザーに確認
- **記事テンプレと固定ページの実装は Codex へ委任**(委任規約は別リポジトリの [delegate](https://github.com/anytools-app/anytools-agent-skills/blob/main/skills/delegate/README.ja.md) スキル)

詳細な移行フロー・ゲート・判断基準は [skills/wordpress-to-200stack/README.md](skills/wordpress-to-200stack/README.md) と、その `SKILL.md` を参照してください。

## インストール

### A. プラグインとして(このリポジトリへのアクセス権が必要)

```bash
claude plugin marketplace add anytools-app/wordpress-to-200stack
claude plugin install wordpress-to-200stack
```

### B. symlink で

```bash
git clone git@github.com:anytools-app/wordpress-to-200stack.git
cd wordpress-to-200stack
ln -s "$PWD/skills/wordpress-to-200stack" ~/.claude/skills/wordpress-to-200stack
```

`~/.claude/skills/` 配下は次回セッションから自動で読み込まれ、`git pull` で更新されます。

## 構成

```text
.
├── .claude-plugin/            # plugin / marketplace マニフェスト
└── skills/wordpress-to-200stack/
    ├── SKILL.md               # 移行フロー・ゲート・判断基準(正)
    ├── README.md              # スキル単体の説明
    ├── design.md              # 設計書(kit のアーキテクチャと設計判断)
    ├── templates.md           # mapping config の書式・型の決め方チェックリスト
    ├── modernize.md           # 引き渡し後の CSS モダナイズ手順(任意工程。移行スコープ外)
    └── kit/                   # wpkit CLI(TypeScript。vitest テスト・Playwright 同梱)
```

実案件の知見(`lessons.md` 相当)は各案件リポジトリの `docs/lessons.md` に置き、このリポジトリには置きません。

## 前提

- Claude Code。スキル本文は日本語
- Node.js + npm(kit の実行)、Playwright Chromium(archive のスクリーンショット)
- microCMS アカウント(API 数はプラン上限に注意: Hobby 5 / Team 10)
- 200stack のデプロイ先
- WordPress 側から WXR エクスポートを取得できること

## セキュリティ

対象 WordPress サイトへのクロール、microCMS への書き込みなど、外部に影響する挙動は [SECURITY.md](SECURITY.md) に記載しています。

## バージョンとライセンス

[CHANGELOG.md](CHANGELOG.md)(SemVer)。[MIT](LICENSE)。

このスキルは 2026-07-26 に [anytools-agent-skills](https://github.com/anytools-app/anytools-agent-skills) から分離しました。分離前の履歴は本リポジトリの `git log` に保持しています。
