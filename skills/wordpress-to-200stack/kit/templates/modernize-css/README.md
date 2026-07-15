# CSS delivery / SPA 化テンプレート

WordPress 由来の CSS を残したまま Next.js App Router の静的エクスポートへ移行した案件向けの、**移行完了後に任意で採用する**配信モダナイズ用アセットです。fidelity を先に凍結し、各 Phase を独立して採用します。CSS Modules 化などを扱う [../../../modernize.md](../../../modernize.md) の CSS Hardening とは別トラックです。

## 前提

- 移行ゲートを通過し、対象 surface の fidelity baseline と approvals が凍結済みであること
- `.next-data/legacy-meta.json` に URL ごとの `stylesheets` と `body` 属性があること
- 静的出力は `out/`、公開アセットは `public/`、legacy body の静的出力への反映は `scripts/apply-legacy-body.mjs` を使う構成であること
- `linkedom`、`css-tree`、`playwright`、`pixelmatch`、`pngjs` を案件側の開発依存に追加できること

`scripts/vendor-css.mjs`、`scripts/audit-css.mjs`、`scripts/css-visual-diff.mjs` の先頭にある `TODO(案件):` は、取り込み前に必ず埋めます。`legacy-origin.invalid` は内部の URL 解決用ダミーオリジンなので変更不要です。

## ファイルと役割

| ファイル | 役割 |
| --- | --- |
| `scripts/vendor-css.mjs` | `legacy-meta` の外部 stylesheet とテーマ CSS の外部 `@import` を再帰ダウンロードし、フォント・画像も `public/vendor/` にローカル化する。元 URL → ローカル URL の `public/vendor/manifest.json` を出力する。 |
| `scripts/apply-legacy-body.mjs` | 静的出力の `<body>` に legacy の class / id を反映する。stylesheet の vendor manifest 解決は `legacy-chrome-resolve.mjs` と `LegacyChrome.tsx` が行う。 |
| `scripts/audit-css.mjs` | 全出力ページと CSS ルールを `linkedom` + `css-tree` で棚卸しし、`used` / `unused` / `dynamic` / `unknown` に分類する。動的 class 接頭辞と JS / TSX 文字列も確認する。 |
| `scripts/prune-css.mjs` | レビュー済みの `unused` セレクタだけを削除する。`@font-face` / `@keyframes` を守り、`--dry-run` と `_scratch/css-audit/prune-log.json` を提供する。 |
| `scripts/build-css-bundles.mjs`, `scripts/lib/bundle-css.mjs` | ページ別 stylesheet 構成のユニーク集合ごとに `@import` をインライン展開し、`url()` を絶対化・minify して `public/assets/css/bundle-<hash8>.css` を生成する。 |
| `scripts/lib/legacy-chrome-resolve.mjs` | vendor manifest と bundle manifest を使い、URL に対応する stylesheet と body 属性を解決する。 |
| `src/components/LegacyChrome.tsx` | React 19 の stylesheet precedence と hidden marker で、ルート固有の legacy CSS / body 属性を宣言する。 |
| `src/components/SiteLink.tsx` | 内部パスだけを `next/link` にし、外部 URL と新規タブは通常の `<a>` に保つ。 |
| `src/app/layout.tsx.example` | 遷移時に body 属性と有効 CSS bundle を同期する MutationObserver と、`LegacyChrome` の安全な設置位置の例。 |
| `scripts/css-visual-diff.mjs` | 静的 `out/` を配信して before / after の全ページ・desktop / mobile スクリーンショットを pixel diff する。 |

## 適用順

各 Phase は前の Phase を必須にはしません。ただし削除・統合は baseline との diff 率 0 が条件です。

1. **外部 CDN CSS の自前化** — `vendor-css.mjs` を実行し、外部 CSS・フォント・画像を `public/vendor/` へ移す。生成した manifest は `LegacyChrome` の stylesheet 解決で使用する。
2. **未使用 CSS 削減** — `audit-css.mjs` を実行し、`_scratch/css-audit/` を人間がレビューする。`prune-css.mjs --dry-run` で予定を確認してから本実行し、前後を `css-visual-diff.mjs` で比較する。
3. **bundle 統合 + minify** — `build-css-bundles.mjs` で URL ごとの CSS 構成を hashed bundle に統合する。build 前に走るよう package script へ登録する。
4. **`next/link` SPA 化 + legacy chrome 同期** — `SiteLink` を内部リンクへ適用し、`LegacyChrome` と layout の Observer を導入する。ページ JSX では可視コンテンツの**後**に `LegacyChrome` を置く。

## 取り込み手順

1. このディレクトリの `scripts/` を案件の `scripts/`、`src/components/` を案件の `src/components/` へコピーする。`src/app/layout.tsx.example` の Observer 部分を既存 layout に統合する。
2. `vendor-css.mjs` の `legacyThemeBundlePath`、`audit-css.mjs` の `legacyOrigin` / `legacyThemeScriptRoot`、`css-visual-diff.mjs` の `requiredPages` を案件値へ変更する。
3. `LegacyChrome` が参照する `.next-data/legacy-meta.json` と `.next-data/css-bundles.json` を、既存の prebuild / static export フローで生成する。各ページには可視コンテンツの後で `<LegacyChrome path={normalizedPath} />` を置く。
4. `package.json` に少なくとも bundle 生成を組み込む。既存の build 前処理へ連結する場合の例:

```json
{
  "scripts": {
    "build:css": "node scripts/build-css-bundles.mjs",
    "prebuild": "npm run build:data && npm run build:css",
    "css:audit": "node scripts/audit-css.mjs",
    "css:prune": "node scripts/prune-css.mjs",
    "css:visual-diff": "node scripts/css-visual-diff.mjs"
  }
}
```

5. Phase ごとに下の検証を通してから次へ進む。`vendor-css.mjs` はネットワーク取得を行うため、再現可能な入力と生成物をレビュー対象にする。

## 実装上の罠

- ページ JSX の先頭に head へホイストされる要素（`<link>` / `<meta>` を返すコンポーネント）を置くと Next のスクロールリセットが壊れる。`LegacyChrome` / canonical 系は可視コンテンツの後に配置する。
- React は JSX のインライン `<script>` をクライアント遷移時に実行しない（SSR 初期ロードのみ）。ペイント前同期は MutationObserver + hidden marker 方式で行う。
- React 19 の precedence stylesheet はアンマウント後も head に残る。複数 bundle の同時適用によるカスケード競合を防ぐため、Observer は現行 bundle 以外を常に `disabled` にする。
- `trailingSlash: true` では `usePathname()` が末尾スラッシュ付きになる。legacy metadata とのパス照合は必ず正規化してから行う。

## 検証プロトコル

- 見た目だけで判断しない。遷移ペアごとに Playwright で、遷移後の body class / id と有効 bundle 集合が、同 URL の直接ロードと一致することを機械判定する。
- CDP スクリーンキャストで遷移フレームを取得し、無スタイルフレームが 0 であることを確認する。
- prune / bundle 化の前後には `css-visual-diff.mjs capture --label before` と同 `after`、続けて `compare` を実行する。対象 CSS を参照する全ページを含め、diff 率 0 を要求する。
- ネットワークスロットリング下でも FOUC フレームを確認する。初回 bundle 読み込みは React が commit を保留するため、無スタイルフレームは 0 になる想定で検査する。
