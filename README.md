# wordpress-to-200stack

WordPress サイトを **microCMS + formrun + Next.js 静的エクスポート**へ移行し、**200stack** に公開するための Claude Code Agent Skill です。固定ページ・記事テンプレともネイティブ JSX + CSS Modules で実装し、旧テーマ CSS は成果物へ持ち込みません。決定的な CLI(`wpkit`)が機械的な処理を担い、スキル本文が判断と品質ゲートを定めます。

**Note: this skill is written in Japanese.** It migrates WordPress sites to a microCMS + Next.js static export deployed on 200stack, pairing a deterministic CLI (`wpkit`) with a gated workflow.

## 30秒サマリ

WXR(WordPress エクスポート XML)の分析から公開までを、ゲート付きの一本道で進めます:

```text
0. archive(現行サイトの凍結)→ 1. analyze → 2. mapping config(製品判断)
→ 3. parse(ゲート1: errors 0)→ 4. media(ゲート2)
→ 5. schema gen → microCMS作成 → import(ゲート3。実装の前提)
→ 6. next-app展開 → ネイティブ実装ループ(6系統fidelity)
→ artifact-bound archive-built strict parity(文言・属性・common chrome・route intent)
→ 7. verifyスイート→ required gateをscorecard集約(ゲート4)→ 8. 200stack公開
```

- **決定的な処理は `wpkit`**: WXR 解析、画像移行、microCMS スキーマ生成・冪等入稿、新旧照合。保存archive対builtの差分はSHA-256 observationとexact decision ledgerで裁定し、build artifactへ束縛
- **進行台帳は `wpkit status`**: 案件ルートの `migration-state.json` から gate 通過・人の承認・次工程を表示し、台帳を導入した案件だけ後段の前提を強制
- **判断はスキル(司令塔)**: 移行スコープ・フィールド型・404/301 の裁定などの製品判断はユーザーに確認
- **成果物は straight-to-final**: 固定ページは`src/app/<page>/page.tsx`、CMS記事は一覧+`[id]`+`src/templates/`、全てCSS Modules。内部リンクはSiteLink(`next/link`)、フォームはformrun
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
    ├── recipes.md             # 再現実装と診断のレシピ集(次回移行でそのまま使う手順)
    ├── modernize.md           # 旧方式で移行済みの既存案件を最終形へ引き上げる手順
    ├── lessons.md             # 案件ごとの実測記録(WXR の罠、プラグイン固有の癖、事故)
    └── kit/                   # wpkit CLI(TypeScript。vitest テスト・Playwright・golden E2E 同梱)
```

再利用する実装・診断手順は `skills/wordpress-to-200stack/recipes.md`、実案件の知見・事故例は `skills/wordpress-to-200stack/lessons.md` に記録します。このリポジトリは非公開ですが、認証情報・個人情報・`_scratch/` の生成物は記録しません。

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
