# セキュリティ / Security

## このスキルが扱うリスク / What this skill touches

`wpkit` は移行元 WordPress サイト・microCMS・200stack に対して実際にネットワークアクセスを行います。移行元サーバを止めない・移行先を壊さないための不変条件を、スキル本文(`skills/wordpress-to-200stack/SKILL.md`)が規約として定めています。

### 移行元(WordPress)への影響

- **書き込みは行いません**。`archive` と `media pull` は読み取りのみです
- HTTP リクエストは適応レート制御付きです(約 1req/s から開始し、応答が健全なら上限までランプアップ。429 / `Retry-After` ・レイテンシ悪化で自動減速。`--no-adaptive` で無効化)
- **`archive` の Playwright スクリーンショット段はレート制御の対象外**で、全ページを desktop / mobile の2回フルロードする最重量経路です。移行元サーバの負荷が懸念される場合は `--no-screenshots` で分離実行してください
- 同一 URL を繰り返し要求しない fetch-once 解決(キャッシュ → archive assets → 未取得時だけネットワーク)を維持します。CSS の視覚差分検証では外部フェッチを全面ブロックします

### 移行先(microCMS / 200stack)への影響

- `import` と `media push` は**移行先の microCMS サービスへ書き込みます**。入稿は冪等設計ですが、本番サービスに向ける前に必ずゲート1〜3を通してください
- `import --dry-run` で件数と oversized を確認してから本入稿します

### 秘密情報

- microCMS の API キー、S3 互換ストレージの認証情報、`.env` はリポジトリにコミットしません。案件リポジトリ側の `.env.local` に置きます
- microCMS ドラフトプレビュー(`/preview/`)は**読み取り専用の GET キー**を必須とし、書き込み権限のあるキーを使いません
- このリポジトリは非公開のため、実案件の知見・実測値・案件名は `skills/wordpress-to-200stack/lessons.md` に記録します。非公開リポジトリでも、認証情報(前項の API キー・トークン・`.env` の中身)、顧客の個人情報・エンドユーザー情報、`_scratch/` の生成物(下記の gitignore 対象)は記録しません
  - **注意**: `kit/templates/` の一部スクリプト(`modernize-css/scripts/verify-stylesheets.mjs`、`next-app/scripts/lib/surfaces.mjs`)には、パイロット案件のルート構造が既定値としてハードコードされています。案件で使う際は自案件のパスへ置き換えてください
  - 分離前の履歴(`anytools-agent-skills` から引き継いだコミット)にも、初期の `lessons.md` と `design.md` に案件を特定しうる記述が残っています。非公開化により現行運用上の問題はありませんが、再公開する場合は現行ファイルの内容だけでなく履歴の扱いも検討してください
- このリポジトリを `claude plugin install` または `~/.claude/skills/` への symlink で配布すると `lessons.md` も一緒に配布されます。案件情報を含むため、配布先を限定してください
- kit の生成物(`_scratch/` 配下)には移行元サイトの全 HTML・画像・フォーム台帳が入ります。案件リポジトリで gitignore してください

`wpkit` reads from the source WordPress site (never writes to it) with adaptive rate limiting, and writes to the destination microCMS service. The Playwright screenshot stage in `archive` bypasses rate limiting and is the heaviest path against the origin — use `--no-screenshots` to run it separately when origin load is a concern. Credentials stay in the project repository's `.env.local`; draft preview requires a read-only key. Because this repository is private, `lessons.md` may record project names and measured findings, but credentials, personal data, and `_scratch/` artifacts remain excluded.

## サポートされるバージョン / Supported versions

最新リリースのみサポートします。Only the latest release is supported.

## 脆弱性の報告 / Reporting a vulnerability

GitHub の [Security Advisories](https://github.com/anytools-app/wordpress-to-200stack/security/advisories) から非公開で報告してください。公開 issue には書かないでください。

Please report privately via GitHub Security Advisories rather than a public issue.
