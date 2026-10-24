# SEO migration contract

URL、metadata、locale、sitemap、social card を伴う移行では、実装前にこの契約を作る。
SEO を `route family × locale × source semantics × deployed state` の4軸で扱い、症状単位の修正にしない。

## 1. 4軸

- **route family**: top、固定ページ、archive、CMS detail、taxonomy、thanks、CMS draft previewなど。同じテンプレートとmetadata生成規則を共有する単位
- **locale**: 言語prefixまたは言語domain。旧サイトに存在しない新localeも「比較元なし」で免除せず、明示した契約で検証する
- **source semantics**: 旧値を保持する、意図的に置換する、別URLへredirectする、承認してretireする、のいずれか
- **deployed state**: source、local build、deployment preview、production、CDN通常URLのreadbackは別々の証拠。1つの成功を別laneへ読み替えない

`/preview/` は **CMS draft preview** と呼び、ホスティング側の **deployment preview** と区別する。

## 2. 実装前に固定する表

`seo-contract.config.json` と案件の判断記録に、全routeがちょうど1つのfamilyへ入るよう次を記録する。

| family | locale | indexable | H1 | canonical / og:url / sitemap | social metadata | social image source | 旧URL |
|---|---|---|---|---|---|---|---|
| `<id>` | `<lang>` | index / noindex | count・文言・表示/非表示 | origin・末尾slash | 必須field・固定値・一致条件 | 選択順・fallback・根拠 | preserve / redirect / retire |

最低限のfield候補:

- `title`、`meta:description`、`meta:robots`
- `h1:count`、`h1:text`、`html:lang`
- `canonical`、`og:url`、`og:locale`、`og:type`
- `og:image`、`og:image:secure_url`、`og:image:type`、`og:image:width`、`og:image:height`、`og:image:alt`
- `twitter:card`、`twitter:title`、`twitter:description`、`twitter:image`、`twitter:image:alt`

`status:"draft"` のままでは `verify:seo` を通さない。`approved` へ変える前に、各routeが1つのfamilyだけへ
matchすること、locale、必須field、固定値、field一致条件、画像の由来、retire判断を埋める。

## 3. URL分類

旧sitemap・WXR・フォーム遷移先・内部リンクから得た全旧URLを次のいずれかへ分類する。

旧sitemapはarchiveに保存することを既定とする。旧サイトがsitemapを公開していなかった等で取得できない場合だけ、
`archiveSitemap.required:false` とし、waiverの理由、承認者、承認日を記録する。未保存・配置ミスは検証失敗とする。

- **preserve**: 新しいsitemapとoutputに同じ公開URL形状で存在する
- **redirect**: 301で新しいindexable URLへ1hopで到達する。旧URLと新URLの末尾slashも生値で固定する
- **retire**: 404/410にする製品判断。`reason`、`approvedBy`、`approvedAt`、Search Console等の検索影響資料、または資料を取得できないwaiverを必須にする

旧sitemapにあったindexable URLがoutput・sitemap・alias・承認済みretireのどれにも入らなければ失敗とする。
特定案件の削除pathを汎用verifierへ直書きしない。

Search Consoleを利用できる場合、公開前のページ別click・impressionを旧URL台帳へ結合する。流入のあるURLの
retireは明示承認なしに進めない。公開後は7日・14日・28日を目安に、削除URL、canonical変更、index coverage、
click、impression、positionを分けて比較する。順位低下を1つの原因へまとめない。

## 4. social imageのprovenance

旧HTMLの最終 `og:image` だけでは、featured image、gallery先頭、本文先頭、共通画像のどれを選んだか分からない。
familyごとに次を調べ、案件側の判断記録へ残す。

1. 旧 `og:image` / `twitter:image`、WXRのfeatured情報、gallery候補、一覧カード、共通fallbackを対応付ける
2. 候補値が異なる **contrastive sample** を最低1件選び、どの候補が旧OGPと一致するか確認する
3. 候補が1つしか存在しない場合だけ、その理由を書く
4. 選択順とfallbackを宣言し、画像URLだけでなく `secure_url` / type / width / height / altも契約化する

ある案件でfeatured imageが正解でも、`featured-first`を汎用既定にしない。汎用化するのは推定・宣言・検証の手順である。
OGP/Twitter画像の意図差分はfamily全体のallowlistで抑制せず、確認したrouteを完全一致で記録する。
意図差分台帳の理由なし、重複、観測差分に対応しない未使用entryは検証失敗とする。

## 5. 検証範囲

- 視覚比較は代表2〜3件でもよい。SEOとURL契約はローカル`out/`を全件機械検証する
- lookup用path正規化と公開URL検査を分ける。`trailingSlash:true` では `/path` と `/path/` を同一視しない
- canonical、`og:url`、sitemap loc、既知outputへ向く内部hrefを生のpathnameで検査する
- 全outputの反対側slash variantが301かつ正確なcanonical URLへ到達し、canonical URL自身は同じ規則へ再一致しないことを検査する
- archive HTMLとbuilt HTMLのH1数・文言を比較する。CSSで非表示のH1もDOM契約に含める
- 新locale・新routeもfamily契約により `html:lang`、OGP、Twitterを必須化する
- 1件の移行回帰を見つけたら、同じfamily・localeの兄弟routeを全件監査してから「局所不具合」と判断する

## 6. 公開後readback

本番を全ページ巡回しない。オフライン全件検証後、変更したfamily × localeから固定サンプルを選び、
deployment previewとproductionを別々に確認する。

各サンプルで確認するもの:

- canonical URLが200、反対側slash URLが301、`Location`がcanonical URLと完全一致
- H1 count/text、`html:lang`、canonical、`og:url`、OGP/Twitter field
- `og:image` のHTTP 200、Content-Type、実寸とwidth/height metadataの整合
- productionの通常URLを再取得して古いHTML/画像が残っていないこと。cache-bustingだけの成功を採用しない
- deployment ID、確認時刻、対象URL、主要cache headerを証拠へ残す

source差分、local build、deployment preview、本番HTML、CDN画像のどこまで確認したかを最終報告で分ける。
