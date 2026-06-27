# Health — 食事 & 筋トレ記録アプリ

個人用の、シンプルでミニマルな食事・筋トレ記録アプリ（MVP）。
スマホ優先。画面データは端末内に保存し、写真解析/チャットだけ同一オリジンの Node サーバー経由で処理します。

## 主な機能

- **食事管理（食事タブ）** — テキストと写真（飲み物も）で記録。種類（朝/昼/夕/間食）、
  時刻、本文、任意の写真を保存。カード表示・編集・削除に対応。日付スイッチャーで過去の日も閲覧。
- **筋トレ（筋トレタブ）** — 種目ごとに セット数 × 回数 × 重量(kg) を `−/＋` でパチパチ入力。
  「今日の成果」パネルで 総挙上量(Σ sets×reps×weight)・種目数・前日比 を一目で確認。
- **テーマ切替** — 白基調（ライト）⇄ 紺基調（ダーク）。右上のボタンでアプリ全体を切替、設定は保存されます。
- **ナビゲーション** — 画面下のタブバーで「食事」と「筋トレ」を行き来。

## データ保存

- メタデータ（食事・筋トレの記録）→ `localStorage`
- 食事の写真 → `IndexedDB`（localStorage を肥大化させないため。保存前に長辺1280pxへ縮小しJPEG圧縮）

すべて端末内に保存され、外部送信は一切ありません。

## 技術スタック

- Next.js 14（App Router）+ TypeScript + Tailwind CSS
- 静的エクスポート（`output: "export"`）を `server/index.mjs` で配信
- `POST /api/analyze-meal` / `POST /api/chat` は Node サーバー側でトークン保護して処理

## セットアップ & 起動

```bash
cd /home/info/health-app
npm install

# 開発サーバー（http://localhost:3000）
npm run dev
```

## 型チェック / ビルド / 本番起動

```bash
# TypeScript エラーチェック（0 エラー）
npm run typecheck      # = tsc --noEmit

# 本番ビルド（Next 静的エクスポート → out/、Node サーバー → dist/）
npm run build:all

# 本番起動（HEALTH_APP_TOKEN は実値を環境変数で渡す）
HEALTH_APP_TOKEN=... PORT=8787 npm start
```

公開時は `npm run build:all` のあと、`PORT` と `HEALTH_APP_TOKEN` を設定して
`npm start`（= `node server/index.mjs`）で起動します。`npm start` は `next start` ではありません。

## ディレクトリ構成

```
src/
  app/
    layout.tsx          ルートレイアウト（テーマ初期化スクリプト含む）
    page.tsx            食事ページ（ホーム）
    workout/page.tsx    筋トレページ
    globals.css         Tailwind + デザインユーティリティ
  components/
    AppShell.tsx        ヘッダー + 下部タブバー
    DateSwitcher.tsx    日付スイッチャー
    ThemeProvider.tsx   テーマ状態（light/dark, 永続化）
    PhotoImage.tsx      IndexedDB から写真を表示
    icons.tsx           インライン SVG アイコン
    meal/
      useMeals.ts       食事の状態管理（localStorage）
      MealEditor.tsx    追加/編集シート
      MealCard.tsx      食事カード
    workout/
      useWorkout.ts     筋トレの状態管理（localStorage）
      SummaryPanel.tsx  「今日の成果」パネル
      ExerciseRow.tsx   種目入力行（ステッパー）
  lib/
    types.ts            ドメイン型
    date.ts             日付ユーティリティ
    storage.ts          localStorage 読み書き
    photoStore.ts       IndexedDB（写真）
    image.ts            写真の縮小・圧縮
    workout.ts          総挙上量などの計算
```
