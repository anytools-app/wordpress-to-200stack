# 再現実装と診断のレシピ集

次回の移行でそのまま使う実装・診断手順を置く。
実測の経緯・案件固有の数値は案件リポジトリ側(非公開)に置き、ここには案件を特定できない形で一般化して載せる。規約・ゲート・判断基準は `SKILL.md` を正とする。
対象ページや部品に関係するレシピは、委任指示書へリンクではなく本文を転記する。

## 1. カルーセル / slick の静的再現

- slick の間隔はスライド間の `gap` ではなく、各スライド内側の padding / margin で再現する。原文の間隔方式を確認せず `gap` を足すと二重間隔になる。
- `appendArrows` は矢印コンテナへポータルし、prev / next の DOM 順を原文に合わせる。矢印コンテナ配下で `position` / `transform` を明示リセットし、片側だけに既定値が残る事故を防ぐ。
- fade は全スライドを同じ grid セルへ重ねる。`position:absolute; inset:0` は padding box まで広がり、切替中だけ旧スライドが拡大するため使わない。
- `asNavFor` 相当の連動カルーセルは active index を単一 state で持ち、主表示とナビへ同じ値を渡す。
- centerMode + 無限ループは前後へクローンを置く scroll-snap で再現し、端では `scroll-behavior:auto` で中央組へ戻す。スライド幅の `%` はスクロールコンテナの内容幅基準なので、padding 分を `calc()` で再度引かない。
- pointer down では開始座標だけを記録し、移動が 5px を超えてから pointer capture、snap 無効化、ドラッグ後 click 抑止を有効にする。リンクと画像の native drag は別途抑止する。
- 無限循環の DOM 複製は前1組・中央1組・後1組の3組を既定にする。同時表示数に対して端へ到達しないことを検証し、必要以上に HTML を増やさない。
- 横スクロール要素は `overflow-y:hidden` を明示し、`scrollHeight === clientHeight` を確認する。`overflow-x:auto` だけでは縦方向も auto になり、わずかなはみ出しでページの縦スクロールを吸う。
- slick の class は初期化前にスライドを隠す規則を伴うため、静的再現へ安易に付けない。付ける場合は初期化後の DOM 状態まで再現する。
- 自動送りは `prefers-reduced-motion:reduce`、hover、ページ非表示で停止させ、凍結比較を決定的にする。

## 2. レイアウト再現の落とし穴

- マージン相殺は主要ブロックの y / height を原文と突き合わせて追う。`flow-root` は子の下マージンだけでなく空要素を通って脱出するマージンも内包するため、単独適用で直ったと判断しない。
- フォント、サイズ、幅が一致するのに折り返し行数だけ違う場合は `letter-spacing` を調べる。body の字間と見出し共通字間の二段構えを globals へ移す。
- 原文で省略したブロックが clear を担っていないか確認する。float の clear 漏れは後続ブロックを横へ回り込ませるため、DOM 順と実画面の両方で検証する。
- 意味のない空白テキストノードも行ボックスを作る。特に U+3000 が inline-block の前にある場合は、削除前にレイアウト寄与を実測する。
- 区切り記号だけが `span` に入る原文では、値まで `span` へ包まない。子セレクタが区切り専用の色や余白を与えていることを確認する。
- 縦積み用の `margin-bottom` を持つ共通部品を flex 横並びへ入れるときは、そのコンテキストで margin を 0 に戻す。
- 原文の構造ブロックは、スコープ CSS が期待する親の中へ置く。HTML を固定断片へ分ける場合はタグ対応が崩れない境界で分割する。
- stylesheet のリンクだけでなく、原文 HTML の body 内にあるテンプレート直書き `<style>` も回収対象にする。適用先と詳細度を CDP で確認してから owner の CSS Module へ移す。
- 移行途中で補正 CSS がテーマ CSS より先に読み込まれる場合、同じ詳細度では後勝ちでテーマ側が勝つ。matched rules で勝者を確認し、補正の適用範囲を増やさず必要な詳細度だけを与える。

## 3. 外部 SDK・フォーム(formrun)

- v2 SDK は `DOMContentLoaded` だけを待ち `document.readyState` を見ないため、イベント後の遅延注入では初期化されない。SDK は原文どおり head で同期読みする。
- SDK が書き換える `<form>` サブツリーは `dangerouslySetInnerHTML` で React 管理外へ置き、ハイドレーションによる option・バリデーション DOM の巻き戻しを防ぐ。
- プリフィルと送信フックは mount 後に素の DOM API で配線し、SDK と React が同じサブツリーを管理しないようにする。
- SDK embed 型は原文と同一フォーム ID の embed div を使う。直 POST 型は action と全 input name を原文と一致させる。

## 4. React / Next.js の定石

- preload は JSX の `<link rel="preload">` ではなく `ReactDOM.preload()` を使う。ページが返すツリーの先頭は常に可視要素にし、head へ巻き上がる link / meta と JSON-LD script は main の後ろへ置く。
- スクロール復元は push 遷移の組合せで `scrollY=0`、ブラウザ戻るで元の位置へ復元することの両方を検証する。pathname 監視の `scrollTo(0,0)` は戻る側を壊すため使わない。
- Turbopack が JSX の RDFa 属性 `typeof` を `typeOf` へ変換する場合は `{...{ typeof: "ListItem" }}` の spread で出力名を維持する。
- CSS Modules を跨ぐ文書レベルの状態はグローバル名1個へ統一し、双方の Module から `:global()` で参照する。別 Module の同名 local class を状態共有に使わない。
- JSX のインライン `<script>` はクライアント遷移で実行されない。初期ロードだけで成立する実装にせず、クライアント側のライフサイクルへ移す。
- `trailingSlash:true` の `usePathname()` は末尾スラッシュ付きになり得るため、ルート台帳や状態マップとの照合前に正規化する。

## 5. 診断・計測の手順

- DOM の正は生 HTML、見た目の正はスクリーンショット、JS 設定の正はテーマ JS と分けて読む。いずれか1つだけを原文の全てとして扱わない。
- 案件の `blocks.config.json` に selector と選定理由を固定し、`WPKIT_ARCHIVE_DIR=/absolute/archive WPKIT_ORIGIN=https://example.com node scripts/measure-blocks.mjs` を実行する。凍結 `page.html` は実 origin 基準で再描画され、`_scratch/fidelity/blocks-<surface>.json` / `.md` に原文・自ビルドの y / height と dy / dh が出力される。
- 同一 viewport で出力された主要ブロックの dy / dh を 0 へ収束させる。全ページ共通の差を系統的原因へ分解してから局所 CSS を直す。
- 差分は高さΔ、帯域別 pixelmatch、ブロック walk、CDP `CSS.getMatchedStylesForNode` の4段で切り分ける。勝者ルールの特定は grep ではなく CDP を正とする。
- 粒状背景は本文のない背景だけの帯をサンプリングし、レイアウト差と画像変換差を分ける。
- ノイズ / グレイン系テクスチャの劣化は隣接画素差の平均で判定する。min / max は圧縮リンギングの外れ値を拾うため品質判定に使わない。
- `transition:all` を持つ要素の凍結スクリーンショットには合成レイヤー由来の寸法アーティファクトが混じり得る。スクリーンショットへ合わせて CSS を縮めず、`getBoundingClientRect()` と CDP matched rules で実寸を確定する。
- 未描画ペインでは IntersectionObserver が発火せず、遷移中の computed transform は中間値になる。Playwright で実際に描画し、段階スクロールと遷移完了後の computed 値で判定する。`live-scenarios` は実描画・段階スクロール・安定待ちを内蔵する。
- 動き系は静的ゲート通過後に実機で人が操作し、見つかった差を `scenarios.config.json` の `live-scenarios` 組み込み6種の宣言へ落とし、`node scripts/live-scenarios.mjs` で再実行する。
- webpack と Turbopack の HTML を比較するときは、script、`/_next/static/` link、CSS Modules class、RSC module ID、head 内要素順を正規化する。バンドラ由来の非決定差を DOM 回帰として扱わない。
- zsh から複雑な計測式を `node -e` へ渡さず、スクリプトをファイル化してリポジトリ直下から実行する。相対パスが古い計測結果を読む事故を防ぐ。
- build memory は opt-in の preload probe で PID 別 `process.memoryUsage()` を定点採取し、しきい値超過時だけ heap snapshot を取る。外部の node プロセスを混ぜないよう開始前 PID を除外する。
- 一時 stash を使うゲートでは、build 後・pop 前に生成ファイルを元へ戻す。`--include-untracked` の pop が失敗した場合は tracked / untracked の復元状況を確認し、競合する生成物を退避して tracked を restore してから pop を再実行する。
