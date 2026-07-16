# 引き渡し後モダナイズ(CSS Hardening)— 任意工程

移行完了後にサイトを「育てる」場合の CSS 近代化(legacy CSS の縮小、CSS Modules 化、tokens 導入)の手順。**移行スコープ外の任意工程**であり、顧客が明示的に発注した場合のみ実施する。

> **大原則: 移行完了 ≠ CSS 健全化。** 移行の完了条件は fidelity / verify ゲート通過(`SKILL.md`)であり、legacy CSS の削除・CSS Modules 化・`!important` ゼロはそこに含めない。この工程を移行フェーズに混ぜてはいけない(1テンプレート単位の委任ループと変更範囲の向きが逆になり、再現度と速度の両方が壊れる)。

## 開始条件(全部満たすまで着手しない)

- [ ] 移行ゲート1〜4を通過し、公開済みまたは公開可能な状態
- [ ] fidelity の approvals 台帳と baseline スクショが凍結済み(この工程の退行検知の正)
- [ ] 顧客と合意済み: 別予算であること、意図的な見た目変更を含むか否か(含むなら承認フローも)
- [ ] CSS 台帳を作成済み(下記ステップ0)

**開始しない方がよいケース**: 凍結保守(サイトを育てない)案件。legacy CSS のままが最も安全で、この工程は負債返済ではなくコストにしかならない。

## 完了の定義(先に合意する)

「legacy 全削除」を完了条件にしない。完了とは:

- 変更頻度の高い部分(共有 chrome・繰り返し UI)が CSS Modules に移り、所有者が明確
- 残した legacy CSS が「負債」ではなく「互換層」として台帳に記録されている(出所・対象 surface・残す理由)
- 全承認済み surface で baseline からの退行がない(意図的差分は承認記録あり)

本文 CSS・プラグイン CSS など「残す方が安全なもの」は互換層として維持してよい。**CSS ルールの所有者は常に一つ** — Module 化したら対応する旧ルールを同時削除し、両残しにしない。

## ステップ0: CSS 台帳と baseline 凍結

1. CSS を出所別に棚卸しする: テーマ style.css / 子テーマ / WordPress 追加 CSS / ブロック・theme.json 由来 / プラグイン / ページ内 `<style>` / inline style / JS が付与する class / 外部 CSS(fonts 等)
2. 各ファイル(またはルール群)を分類: `DELETE`(未使用確定)/ `TOKEN` / `BASE` / `COMPONENT` / `LAYOUT` / `WP_CONTENT`(本文用)/ `PAGE`(特定ページ固有)/ `LEGACY`(判定保留)
   - **CSS Coverage だけを根拠に DELETE しない**。hover・focus・開閉状態・エラー表示・CMS 長尾 HTML は通常表示で検出されない
3. `!important` の件数と分布を数える(後述の Cascade Layers 採否の判断材料)
4. fidelity-scan を全 surface で実行し、開始時点のスコアを記録(以後の退行判定の基準)

## ステップ1〜5: 絞り込み式の実行順

優先順位は「変更頻度・障害頻度・bundle 量」で決める。**legacy の削減バイト数を KPI にしない**。

### 1. tokens(完全一致 alias のみ)

- 旧 CSS で繰り返される値(ブランドカラー、共通余白、コンテンツ幅、角丸、フォントサイズ、影)を `:root` の CSS 変数へ抽出する
- **値を一文字も変えない**(文字列完全一致の置換のみ)。近い色・余白の統合、px の丸め、体系化は「デザイン変更」であり、この工程では禁止(やるなら別途承認を取る)
- 変数名には site prefix を付け、テーマ既存の CSS Custom Properties と衝突させない
- breakpoint は CSS 変数を media query 条件に使えないため tokens.css では共有できない(定数はコメントか build 時の仕組みで管理)

### 2. 共有 chrome の CSS Modules 化(1コンポーネントずつ)

- Header / Footer / GlobalNavigation / Breadcrumb など、変更頻度の高い共有部品から
- 移行時とは逆に、ここでは対応する旧ルールを**同時削除**する(所有者一つの原則)
- **共有 CSS の変更は1テンプレートで閉じない** — 1コンポーネント移すたびに全承認済み surface を再スキャンする
- 新規 CSS Modules の規約:
  - 許可: `.root {}` `.title {}` `.root[data-variant='primary'] {}` `.link[aria-current='page'] {}` 状態は `data-*` / `aria-*` / 疑似クラス
  - 禁止: ID セレクタ、`body.home` / `.page-id-*`、3階層超のネスト、DOM 構造依存セレクタ(`div > ul > li > a`)、`!important` の新規追加、親から子コンポーネント内部への指定、ページ固有ルールの Global CSS 混入
- runtime CSS-in-JS は採用しない(RSC・静的エクスポートとの相性、依存追加に利益がない)

### 3. WP 本文の互換層

テーマ本文 CSS を削り始める段階で初めて導入する(それまでは legacy CSS が本文もスタイルしている状態が正):

- `LegacyHtml` のラッパに境界属性を付け(例: `data-wp-content`)、互換 CSS はすべて `[data-wp-content] :where(...)` 配下に限定する
- `:where()` は specificity 0 なので**旧テーマセレクタへの上書きには使えない**。用途は「テーマ CSS を削除した後の生 HTML に最低限のスタイルを供給する」ことに限る
- sanitizer の契約に注意(`kit/templates/next-app/src/lib/legacy-html.tsx`): class/id は保持されるが **`style` 属性は削除される**。inline style の多い本文は互換層では解決しない — データ変換(parse / mapping)の問題として扱う
- 高頻度ブロック(画像・ギャラリー・ボタン・カラム・テーブル)の React 化は ROI があるものだけ。長尾の本文は HTML + 互換層のハイブリッドで残してよい

### 4. Cascade Layers(条件付き)

`@layer` による legacy 隔離は次を全部満たす場合のみ導入する:

- [ ] ステップ0で数えた `!important` 密度が低い(**`!important` は layer 順が逆転するため、legacy 側の important 宣言が新 CSS を貫通する** — Layers はこれを解決しない)
- [ ] legacy を単一バンドルに集約してもページ間のセレクタ衝突が起きないと確認済み(ページ単位読込で成立している案件では、集約が「そのページに無かったルールが効く」退行を生む)
- [ ] `next build` 後の production 出力で CSS 順序を確認済み(dev と prod で chunk 順が変わりうる。`experimental.cssChunking` には依存しない)

導入しない場合の代替: legacy を `styles/legacy/original/`(編集禁止)と `styles/fidelity-patches/`(差分のみ・理由記録)に分けたまま、Module 化した分だけ original から削る。

- 「非 layer の CSS Modules が legacy に常に勝つ」は**通常宣言に限る**。この理解を委任指示書に安全装置として書かない
- legacy 内の `!important` は、対応箇所を Module 化するたびに削除する

### 5. フォント(既定は現状維持)

- 既定は旧サイトと同じ配信経路(元の `@font-face` / link)を維持する
- `next/font` 化する場合は `next/font/local` で**同一フォントバイト・weight・unicode-range・font-display を維持**し、全 surface 再スキャンで折り返し・要素高の変化がないことを確認する。`next/font/google` への置換はメトリクス・サブセット・FOUT が変わるため、差分を意図的変更として承認する場合のみ

### Tailwind / Sass の判断

- Tailwind 併用は「UI の大半を新規設計する」「顧客側が既に Tailwind 前提」の場合のみ。旧 CSS の機械的 Tailwind 変換はしない(本文 HTML に utility を付与できず、旧 DOM 依存も残る)
- `.module.scss` は旧 SCSS 資産のビルド移植の短期手段としてのみ。深いネストの温存は不可

## 各ステップ共通の検証ゲート

1. `next build` が通り、**production 出力(`out/`)に対して** fidelity-scan を実行する(dev サーバで判断しない)
2. 共有 CSS を触ったステップは全承認済み surface、コンポーネント局所の変更は該当 surface + 隣接 surface を再スキャン
3. 退行の定義: 承認済み baseline から測定ノイズ(原文 self-diff のノイズフロア)を超える悪化。ノイズ内の揺れは退行としない
4. 意図的な見た目変更は approvals 台帳に理由付きで記録してから進む

## 委任の形(delegate 規約に従う)

- 1委任 = 1コンポーネント(またはトークン抽出1バッチ)。「Header の Module 化+旧ルール削除+全 surface 再スキャン」で1単位
- 指示書に必ず書く: 対象コンポーネント、削除してよい旧ルールの特定(ファイル・行)、値を変えない制約、検証コマンド(build + scan)、禁止(スコープ外の legacy 削除・値の丸め・`!important` 追加)
- 移行フェーズの指示書雛形(`templates.md`)とは別物。混用しない

---

# 配信モダナイズ(CSS delivery / SPA化)— 任意トラック

外部 CSS の自前化、未使用 CSS の削減、CSS bundle 配信、`next/link` による SPA 遷移を扱うトラック。上の CSS Hardening(CSS Modules 化・tokens 導入)とは**独立**であり、どちらか一方だけを採用してよい。移行の完了条件には含めない。

汎用アセットは [`kit/templates/modernize-css/`](kit/templates/modernize-css/) に置く。案件へのコピー方法、依存、コマンド例は同ディレクトリの README を正とする。

## 開始条件

- [ ] 移行ゲートを通過し、公開済みまたは公開可能な状態
- [ ] 全対象 surface の fidelity baseline と approvals が凍結済み
- [ ] `legacy-meta.json` に URL ごとの stylesheet と body 属性があり、`apply-legacy-body` を含む静的出力フローが動作済み
- [ ] CSS の byte 削減や SPA 化を先行させず、fidelity を再現することを最優先に合意済み

## Phase(必要なものだけ採用する)

1. **外部 CDN CSS の自前化**: `vendor-css.mjs` で legacy-meta の stylesheet とテーマ CSS の外部 `@import` をフォント・画像ごと `public/vendor/` へ再帰ローカル化する。元 URL → ローカル URL は `public/vendor/manifest.json` に出力し、legacy chrome 解決時に適用する。
2. **未使用 CSS 削減**: `audit-css.mjs` で全出力ページ × 全 CSS ルールを棚卸しする。動的 class safelist と JS / TSX 文字列走査を含むため、Coverage だけで削除しない。司令塔レビュー後に `prune-css.mjs` を `--dry-run` から実行し、`@font-face` / `@keyframes` を保護したまま unused selector のみ削除する。
3. **単一スコープCSS + Next import 管理(推奨最終形)**: surface CSS(index/page/archive/single等)を `:where(body.<guard>)` の子孫プレフィックスでスコープ化し(`:where` はspecificityゼロ=原文の優先度不変)、全ソースを1ファイルに統合して `src/app/legacy-generated.css` として layout で `import` する。CSSは常時全適用になり、ページ種別ごとの切替機構が不要になる。前提分析: ガードクラスがそのページ群のbodyクラスに100%含まれること、surface間の相対読み込み順に矛盾がないこと。
4. **`next/link` SPA 化**: `SiteLink.tsx` は内部パスだけを `next/link` にする。`LegacyChrome.tsx` は hidden marker で body class/id を宣言し、layout の MutationObserver(ペイント前のマイクロタスク)が遷移時に同期する。**3の単一CSS化を先に済ませれば、stylesheetの切替・preload・precedence管理は一切不要**(バンドル切替方式は中間形として廃止。下記「罠」はその過程の教訓)。

## 実装上の罠(必ず設計に含める)

- ページ JSX の先頭に head へホイストされる要素（`<link>` / `<meta>` を返すコンポーネント）を置くと Next のスクロールリセットが壊れる。`LegacyChrome` / canonical 系は可視コンテンツの後に置く。
- React は JSX のインライン `<script>` をクライアント遷移時に実行しない（SSR 初期ロードのみ）。ペイント前同期は MutationObserver + marker 方式で行う。
- React 19 の precedence stylesheet はアンマウント後も head に残り、複数 bundle 同時適用でカスケード競合する。さらに `link.disabled` はsheetを破棄し再有効化で再パース(WebKitは再フェッチ)が走るため、切替方式は戻り遷移で必ず崩れる。**この系の問題は単一スコープCSS化(Phase 3)で機構ごと消すのが正解**。
- `trailingSlash: true` では `usePathname()` が末尾スラッシュ付きになる。legacy metadata とのパス照合は正規化してから行う。

## 検証ゲート

1. 見た目だけで判断しない。遷移ペアごとに Playwright で「遷移後の body class / id・有効 bundle 集合 == 同 URL 直接ロード」を機械判定する。
2. CDP スクリーンキャストで遷移フレームを取得し、無スタイルフレームが 0 であることを確認する。
3. prune / bundle 化の前後は `css-visual-diff.mjs` で、対象 CSS を参照する全ページを網羅してピクセル比較する。diff 率 0 以外は進めない。
4. ネットワークスロットリング下でも FOUC フレームを確認する。初回 bundle 読み込みは React が commit を保留するため、無スタイルフレームは 0 になる想定で検査する。


## CSS Modules 段階移行の実測規律(2026-07 実測)

- **凍結HTML・CMS本文が使うクラスはModules化しない**(コンポーネント側だけ変えると凍結HTML側が無スタイル化する。バッチ選定時に fixed-pages / documents.ndjson / 全srcの3点grepを必須とする)
- **分割境界オーバーラップゼロを機械検証してから移す**: 移動ルールと残置ルール(同ファイル残り+共有レガシー)の間に「同一要素×同一プロパティ系統」のペアがあると、チャンク順・詳細度の変化で勝敗が入れ替わる。長い祖先セレクタをモジュールルートに置換すると詳細度が下がり、共有CSSに負ける事故が典型(実測: カード幅-10px)
- 上書きペアは分割しない: 残置側がページ専用なら同居、共有なら移行側を差し戻す(ルート配下単位で。半々にしない)
- 検証は同一セッションの2ビルド比較(視覚回帰)で行う。撮影時期が違うとCMSコンテンツ差が混入する

### 完了ラインと成果物(実測で確定)

- **Modules化できる領域**: Reactだけが描画する共有チューム(Header/Footer等)と専用ページ(トップ等)。方式は「ルートクラスのみハッシュ化+内部は `:global()` 子孫で原文一字一句」
- **互換層に残す領域**: 凍結HTML・CMS本文が使うクラス、surface CSS(archive/single等)の共有クラスタ。監査の結果**「移行ゼロ」が正解になるファイルもある**(実測: archive/single は候補291ルール全て残置が正解だった)。移行数をKPIにしない
- 成果物: `docs/css-ledger.md`(所有権台帳: 移行済み/互換層と理由)と `docs/css-batchN-overlap-audit.md`(境界監査の全列挙)。完了の定義は「変更頻度の高い部分がModulesに移り、残したlegacyが台帳記録された互換層であること」(CSS Hardeningの完了定義と同じ)
