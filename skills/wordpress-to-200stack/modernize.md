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
