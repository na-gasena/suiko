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

## 切断時の動作

- 編集端末: ローカル編集と履歴保存を継続する。
- 表示端末: 最後に受け取った紙面を保持する。
- 再接続: 指数バックオフで再接続し、最新版を再送・再取得する。
- ローカル別ウィンドウ: BroadcastChannelを使い続け、インターネット障害の影響を受けない。

## 保持期間と制限

上演状態は最終利用から24時間を目安に失効させる。1メッセージは256KB以下。WorkerはGitHub Pages本番URLとローカル開発URLからの接続だけを受け付ける。

無料枠を守るため、送信は最大毎秒5回、保存は最大毎秒1回とする。表示端末は状態要求と接続維持以外のメッセージを送らない。Durable ObjectsはWebSocket Hibernation APIを使う。

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

## 開発時の確認

別のターミナルで `npm run remote:dev` を起動し、`npm run remote:test` を実行する。テストは編集・表示の2接続を認証し、接続数とスナップショット配信を確認する。画面全体は `npm run dev` で起動し、編集URLと表示URLを別ブラウザで開いて確認する。

## 検証項目

- 別ネットワークの編集1台・表示2台以上で同期する。
- 日本語変換中と確定後の表示が一致する。
- 削除文字の位置・発生時刻・動きが端末間で大きくずれない。
- Wi-Fi切断後、表示は最後の紙面を保ち、復帰後に最新版へ追いつく。
- 表示端末の追加・終了が編集画面の接続数へ反映される。
- 編集URLを持たない表示端末から状態を書き換えられない。
- 1時間連続上演と、最大10台の表示接続で安定する。

## 今後の判断

初期実装は編集1台を前提とする。複数端末から同時編集する場合は、単純な最新版優先ではなくCRDT等による競合解決を別設計として追加する。
