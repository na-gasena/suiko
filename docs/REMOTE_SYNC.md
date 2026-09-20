# オンライン同期 技術ノート

最終更新: 2026-09-20

## 目的

編集端末で行った推敲を、異なるネットワークを含む複数の表示端末へリアルタイム配信する。ローカルの別ウィンドウ表示とIndexedDBによる履歴保存は維持する。

## 構成

- 画面配信: GitHub Pages (`https://na-gasena.github.io/suiko/`)
- 接続受付: Cloudflare Worker (`https://suiko-live.nagasena-suiko.workers.dev`)
- 上演ごとの状態・WebSocket接続: SQLite-backed Durable Object
- 編集履歴・CSV: 編集端末のIndexedDB
- 表示設定: 編集端末のlocalStorage

GitHub Pagesは静的ファイルのみを配信する。ブラウザは `VITE_REMOTE_WS_URL` で指定したWorkerへ接続する。Workerは上演IDごとに1つのDurable Objectへ接続を振り分ける。

## 権限

上演ごとに、上演ID、編集トークン、表示トークンをブラウザで生成する。編集URLは編集トークンと初期化用の表示トークンを持ち、表示URLは表示トークンだけを持つ。トークンはURLフラグメントに格納し、HTTPリクエストやRefererには含めない。WebSocket確立後の最初のメッセージで認証する。

Durable ObjectにはトークンそのものではなくSHA-256ハッシュを保存する。表示接続はスナップショットを送信できない。上演IDだけを知っていても接続できない。

## 通信

編集端末は文章、確定文、日本語変換状態、消し跡、設定、セッション状態を1つのスナップショットとして送る。連続入力は200ms単位でまとめる。削除、設定変更、一時停止、新しい文章への切替も同じスナップショットに含まれる。

Durable Objectは最新スナップショットを接続中の全表示端末へすぐ配信し、1秒単位で保存する。途中参加・再接続した表示端末にはメモリ上または保存済みの最新版を送る。履歴全体はサーバーへ送らない。

## 編集権の排他制御

同じ編集URLを複数端末や複数ウィンドウで開いても、最初に認証された1接続だけを編集者として扱う。後から接続した編集画面には `editor_conflict` を返し、再接続ループを止めて入力、タイマー、履歴削除、表示設定の変更を無効にする。先に接続している編集画面はそのまま動作を続ける。

設定の「競合リセット」は、認証メッセージへ `takeover: true` を付けて再接続する。Durable Objectは同じ編集トークンを確認してから既存の編集接続をcode `4001` で閉じ、リセットを実行した接続だけを認証する。閉じられた画面は `conflict` 状態になり、以後スナップショットを送信しない。

同じブラウザ内ではWeb Locks APIとBroadcastChannelも併用する。競合リセット時に現在のウィンドウが `suiko-editor-owner` lockを取得し、ほかのウィンドウへ編集権の移動を通知する。これにより、インターネット接続がないローカル表示でも同じブラウザ内の二重編集を防ぐ。

## 切断時の動作

- 編集端末: ローカル編集と履歴保存を継続する。
- 表示端末: 最後に受け取った紙面を保持する。
- 再接続: 指数バックオフで再接続し、最新版を再送・再取得する。
- ローカル別ウィンドウ: BroadcastChannelを使い続け、インターネット障害の影響を受けない。

## 保持期間と制限

上演状態は最終利用から24時間を目安に失効させる。1メッセージは256KB以下。WorkerはGitHub Pages本番URLとローカル開発URLからの接続だけを受け付ける。

無料枠を守るため、送信は最大毎秒5回、保存は最大毎秒1回とする。表示端末は状態要求と接続維持以外のメッセージを送らない。Durable ObjectsはWebSocket Hibernation APIを使う。

## 無料枠の見積り

2026-09-20時点のWorkers Freeプランは、SQLite-backed Durable Objectsのみ利用可能。主な上限はリクエスト10万件/日、SQLite行書込10万行/日、行読込500万行/日、保存容量5GB。無料枠を超えた種類の処理は、その日のリセットまでエラーになる。

受信WebSocketメッセージは20件を1リクエストとして計算し、送信WebSocketメッセージは課金対象外。現在の編集送信は最大5件/秒なので、連続1時間で約900リクエスト相当。最新版の保存は最大1回/秒、認証の利用時刻更新は最大1回/分なので、連続1時間で最大約3,660行書込となる。実際は入力していない時間に送信・保存しない。無料枠は将来変更されるため、上演前にCloudflareのAnalyticsと公式Pricingを確認する。

無料枠の日次カウントは世界協定時刻の0時、日本時間の午前9時にリセットされる。Freeプランは超過分を自動課金せず、上限を超えた種類の処理がリセットまで失敗する。

### 残り使用量の確認

Cloudflare Dashboardで次の順に確認する。

1. `Workers & Pages` を開き、右側の `Billable usage` を見る。Freeプランでは当日分の課金対象使用量が表示される。
2. `Workers & Pages` → `suiko-live` → `Metrics` で、Worker全体のリクエスト数とエラー数を見る。
3. `Durable Objects` → `SuikoRoom` のnamespace → `Metrics` で、対象期間を `Today` または直近24時間にして、リクエスト、実行時間、ストレージの推移を見る。必要なら上演のobject IDで絞り込む。
4. `Workers & Pages` → `suiko-live` → `Logs` → `Live` で、接続時のエラーをリアルタイムに確認する。

`Billable usage` が使用済み件数を表示する場合、残数は次のように計算する。

```text
残りリクエスト相当 = 100,000 - 当日の課金対象Durable Objectsリクエスト
残り行書込        = 100,000 - 当日のSQLite行書込
```

namespaceのMetricsは動作傾向や異常の確認に使う。WebSocketのグラフには生のメッセージ数が表示されるが、課金上は受信20メッセージを1リクエストとして数えるため、グラフ上のメッセージ数を10万件から直接引かない。

このアプリだけを使っている場合、概算は次の式で求められる。

```text
課金対象リクエストの概算
  = WebSocket接続回数
  + 受信アプリケーションメッセージ数 ÷ 20
  + HTTP、alarm、RPCなどの回数

最大送信時の1時間
  = 5メッセージ/秒 × 3,600秒 ÷ 20
  = 約900リクエスト相当

最大保存時の1時間
  = 約3,660行書込
  = 行書込無料枠の約3.66%
```

8時間をすべて最大頻度で使っても、約7,200リクエスト相当、約29,280行書込となる。現在の設計ではリクエスト数より行書込のほうを先に確認する。Analyticsには反映の遅れや集計差があり得るため、上演では80%を安全確認の目安にする。

## URL

- 編集: `/?room=<上演ID>#editor=<編集トークン>&audience=<表示トークン>`
- 表示: `/?room=<上演ID>&view=audience#audience=<表示トークン>`

表示URLは複数端末で同時に開ける。「別ウィンドウ」はクリックごとに新しい表示ウィンドウを開く。

## Cloudflareの準備

1. Cloudflare無料アカウントを作成する。Workers FreeプランのSQLite-backed Durable Objectsを使用し、有料プランへの変更は不要。
2. `npx wrangler login` を実行し、ブラウザで認証する。
3. `npm run remote:deploy` でWorkerとDurable Objectを作成・更新する。
4. 表示された `wss://...workers.dev` のURLをGitHub Actionsの `VITE_REMOTE_WS_URL` に設定する。
5. GitHub Pagesを再ビルドする。

このプロジェクトでは `nagasena-suiko.workers.dev` をアカウントのサブドメインとして登録し、`suiko-live` を公開済み。フロントエンドには `wss://suiko-live.nagasena-suiko.workers.dev` を設定する。

Cloudflare APIトークンやアカウント情報をGitHub PagesのJavaScriptへ埋め込まない。Workerの公開WebSocket URLは秘密情報ではない。

## 別のPCで開発する

必要なのは、そのPCへの依存パッケージの復元とCloudflare認証である。Worker、Durable Object、workers.devサブドメインを作り直す必要はない。同じCloudflareアカウントへログインすると、公開済みの `suiko-live` を更新できる。

Node.js 22.13以上とGitを用意し、PowerShellで次を実行する。

```powershell
git clone https://github.com/na-gasena/suiko.git
cd suiko
npm ci
npx wrangler login
npx wrangler whoami
```

`npx wrangler login` は初回、ログアウト後、または認証期限が切れたときだけ必要。ブラウザが開いたらCloudflareへのアクセスを許可する。`npx wrangler whoami` にCloudflareアカウント名とIDが表示されれば認証済みである。

`npm ci` は `package-lock.json` の内容どおりに依存パッケージを復元する。別PCで最初にcloneしたとき、または依存関係が更新されたときに実行する。普段の起動のたびには不要。依存パッケージ自体を追加・更新するときだけ `npm install` を使い、変更された `package.json` と `package-lock.json` を一緒にcommitする。

GitHubへpushするには、そのPCでもGitHubの認証が必要。GitHub Actionsの変数 `VITE_REMOTE_WS_URL` はリポジトリ側に保存済みなので、PCごとの再設定は不要。

## Cloudflareの公開状態を確認する

認証、デプロイ履歴、ヘルスチェックを順に確認する。

```powershell
npx wrangler whoami --json
npx wrangler deployments list --config wrangler.remote.jsonc
curl.exe -sS https://suiko-live.nagasena-suiko.workers.dev/health
```

`whoami` が認証情報を返し、`deployments list` に最新のデプロイがあり、`/health` が正常なJSONを返せば公開状態は正常。Workerを更新するときは次を実行する。

```powershell
npm run remote:deploy
```

Cloudflare Dashboardでは `Workers & Pages` → `suiko-live` の `Deployments` でも現在のversionと履歴を確認できる。

リアルタイムログは次のコマンドで表示する。

```powershell
npx wrangler tail suiko-live --format pretty
```

またはDashboardの `Workers & Pages` → `suiko-live` → `Logs` → `Live` を使う。WebSocket処理中のログは、接続が閉じたあとにまとまって表示される場合がある。

## 開発時の確認

別のターミナルで `npm run remote:dev` を起動し、`npm run remote:test` を実行する。テストは編集・表示の2接続を認証し、接続数とスナップショット配信を確認する。画面全体は `npm run dev` で起動し、編集URLと表示URLを別ブラウザで開いて確認する。

公開済みWorkerに対して通信テストを行う場合は、PowerShellで接続先を一時的に指定する。

```powershell
$env:REMOTE_TEST_URL = "wss://suiko-live.nagasena-suiko.workers.dev"
npm run remote:test
Remove-Item Env:REMOTE_TEST_URL
```

テストは短時間だけ使う上演roomを作る。終了後は24時間の失効処理に任せてよい。

## トラブル時の順序

1. `npx wrangler whoami` で認証を確認する。認証エラーなら `npx wrangler login` をやり直す。
2. `curl.exe -sS https://suiko-live.nagasena-suiko.workers.dev/health` でWorkerへ到達できるか確認する。
3. `npx wrangler deployments list --config wrangler.remote.jsonc` で最新版が公開されているか確認する。
4. `npx wrangler tail suiko-live --format pretty` を開いたまま再接続し、エラー内容を見る。
5. オンライン画面だけ接続できない場合は、GitHubリポジトリの `Settings` → `Secrets and variables` → `Actions` → `Variables` で `VITE_REMOTE_WS_URL` を確認し、GitHub Pagesを再ビルドする。
6. 当日分の無料枠が上限に達していたら、日本時間の午前9時のリセットを待つ。

Cloudflareの認証ファイル、APIトークン、`.dev.vars` はGitへcommitしない。編集URLの編集トークンも共有しない。公開してよいのはWorker URLと表示用URLである。

## 検証項目

- 別ネットワークの編集1台・表示2台以上で同期する。
- 同じ編集URLを2台で開くと、先に接続した画面だけが編集できる。
- 編集不可の画面で競合リセットを実行すると、その画面だけが編集可能になり、元の画面は編集不可になる。
- 日本語変換中と確定後の表示が一致する。
- 削除文字の位置・発生時刻・動きが端末間で大きくずれない。
- Wi-Fi切断後、表示は最後の紙面を保ち、復帰後に最新版へ追いつく。
- 表示端末の追加・終了が編集画面の接続数へ反映される。
- 編集URLを持たない表示端末から状態を書き換えられない。
- 1時間連続上演と、最大10台の表示接続で安定する。

## 今後の判断

初期実装は編集1台を前提とする。複数端末から同時編集する場合は、単純な最新版優先ではなくCRDT等による競合解決を別設計として追加する。

## 公式資料

- Durable Objects Pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects Limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- Durable Objects Metrics and analytics: https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/
- Workers Metrics and analytics: https://developers.cloudflare.com/workers/observability/metrics-and-analytics/
- Workers Real-time logs: https://developers.cloudflare.com/workers/observability/logs/real-time-logs/
- Wrangler general commands: https://developers.cloudflare.com/workers/wrangler/commands/general/
- Wrangler Workers commands: https://developers.cloudflare.com/workers/wrangler/commands/workers/
- Billable usage sidebar: https://developers.cloudflare.com/changelog/post/2026-06-04-billable-usage-product-sidebar/

## 変更記録

- 2026-09-20: 編集接続を1画面に限定。後続接続を編集不可にし、設定へ競合リセットを追加。スマートフォンの設定を全画面オーバーレイへ変更。
- 2026-09-20: 別PCでのセットアップ、Cloudflareの認証・デプロイ・ログ・無料枠使用量の確認手順を追加。
- 2026-09-20: 文字サイズを設定スナップショットへ追加。編集面、表示面、折返し計測、消し跡描画へ同じ値を適用。表示面では紙の外枠を描画しない。
