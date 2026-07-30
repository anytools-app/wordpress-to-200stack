# wordpress-to-200stack — WordPress 静的サイト移行

WordPress サイトを **microCMS + formrun + Next.js 静的エクスポート**に変換して **200stack** にデプロイするための移行スキルです。固定ページ・記事テンプレともネイティブ JSX + CSS Modules で実装し、旧テーマ CSS は成果物へ持ち込みません。同梱の決定的 CLI(`wpkit`)が機械的な処理を担い、スキル本文(`SKILL.md`)が判断と品質ゲートを定めます。

**Note: this skill is written in Japanese.**

## 30秒サマリ

WXR(WordPress エクスポート XML)の分析から公開までを、ゲート付きの一本道で進めます:

```text
0. archive(現行サイトの凍結)→ 1. analyze → 2. mapping config(製品判断)
→ 3. parse(ゲート1: errors 0)→ 4. media(ゲート2)
→ 5. schema gen → microCMS作成 → import(ゲート3。実装の前提)
→ 6. next-app展開 → ネイティブ実装ループ(ピクセル比較)
→ 7. verifyスイート→ scorecard集約(ゲート4)→ 8. 200stack公開
```

- **決定的な処理は `wpkit`**(`kit/` 同梱): WXR 解析、画像移行、microCMS スキーマ生成・冪等入稿、新旧照合
- **判断はスキル(司令塔)**: 移行スコープ・フィールド型・404/301 の裁定などの製品判断はユーザーに確認
- **成果物は straight-to-final**: 固定ページは`src/app/<page>/page.tsx`、CMS記事は一覧+`[id]`+`src/templates/`、全てCSS Modules。内部リンクはSiteLink(`next/link`)、フォームはformrun
- **テンプレのデザイン実装は [delegate](https://github.com/anytools-app/anytools-agent-skills/blob/main/skills/delegate/README.ja.md) スキルで Codex へ委任**

## セットアップ

案件開始時に kit を案件リポジトリへコピーしてピン留めします(再現性のため):

```bash
cp -R <このスキルの>kit <案件リポジトリ>/wp-static-kit
cd <案件>/wp-static-kit && npm install && npx playwright install chromium
```

生成物はすべて案件リポジトリの `_scratch/`(gitignore)に置きます。

## 構成

```text
skills/wordpress-to-200stack/
├── SKILL.md       # 移行フロー・ゲート・判断基準(正)
├── README.md      # スキル単体の説明
├── design.md      # 設計書(kit のアーキテクチャと設計判断)
├── templates.md   # mapping config の書式・型の決め方チェックリスト
├── recipes.md     # 再現実装と診断のレシピ集(次回移行でそのまま使う手順)
├── modernize.md   # 旧方式で移行済みの既存案件を最終形へ引き上げる手順
├── lessons.md     # 案件ごとの実測記録(WXR の罠、プラグイン固有の癖、事故)
└── kit/           # wpkit CLI(TypeScript。vitest テスト・Playwright 同梱)
```

実装・診断の再利用手順は `recipes.md`、案件固有の実測記録・事故例は `lessons.md` に記録します。このリポジトリは非公開ですが、認証情報・個人情報・`_scratch/` の生成物は記録しません。

## 前提

- Claude Code。スキル本文は日本語
- Node.js + npm(kit の実行)、Playwright Chromium(archive のスクリーンショット)
- microCMS アカウント(API 数はプラン上限に注意: Hobby 5 / Team 10)
- 200stack のデプロイ先
- WordPress 側から WXR エクスポートを取得できること

## ネットワークアクセスと破壊的操作

- `wpkit` は対象 WordPress サイト・microCMS API・200stack へアクセスします(archive で現行サイトをクロール、media/import で microCMS へ書き込み)
- microCMS への入稿は冪等設計ですが、**移行先の microCMS サービスに書き込みます**。本番サービスに向ける前にゲート1〜3を通してください
- 元の WordPress サイトへの書き込みは行いません(archive は読み取りのみ)
- archive・media pull の HTTP リクエストは適応レート制御付きです(約1req/sから開始し、応答が健全なら現行上限までランプアップ。429/Retry-After・レイテンシ悪化で自動減速。`--no-adaptive` で無効化)
- **警告**: archive の Playwright スクリーンショット段はレート制御の対象外で、全ページを desktop/mobile の2回フルロードする最重量経路です。移行元サーバの負荷が懸念される場合は `--no-screenshots` で分離実行を検討してください
