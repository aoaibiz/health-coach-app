# Requirements / PRD — Health App (個人用 食事 & 筋トレ トラッカー)

> **Status:** Draft v1 (specification only — no app code is implied or authorized by this document).
> **Owner:** 個人利用者（本人）。トレーニング仲間にカジュアルに見せる可能性あり。
> **Date:** 2026-06-17
> **Prototype grounding:** 本リポジトリ `app/` の前身プロトタイプ（logging-only foundation。Next.js 14 App Router / TS strict / Tailwind / localStorage + IndexedDB / `output: "export"` 静的書き出し）を読み込み済み。本 PRD はその基盤の上にフル製品を定義する。

---

## 1. Objective（目的）& Success（成功の定義）

### 1.1 What we're building
個人用の、完成度が極めて高い（"完成度めちゃ高い"）食事 + 筋トレ トラッカー。スマホ優先。シンプルでプレミアムな見た目。白基調（ライト）⇄ 紺基調（ダーク）のテーマ切替。

単なる記録ツールではなく、**プロフィールに基づいて自分の食事と運動を解析し、「今足りないもの・次に何を食べ／鍛えるべきか」を一目で示し、週次・月次でコーチングしてくれる相棒**を作る。アプリ内 AI チャットで、その相棒と会話もできる。

### 1.2 Why（なぜ作るか / 肝）
本人が自分の体づくりを「数値で把握し、迷わず次の一手を打てる」状態になること。記録の手間を最小化し（写真 or 一言テキストで済む）、解析・示唆は機械に任せる。

### 1.3 Target user（ターゲット）
- **第一義:** 本人（単一ユーザー前提でよい）。
- **第二義:** トレーニング仲間に画面を見せる場面。→ 見た目の完成度が高いこと、他人に見られても恥ずかしくない／誤解を生まない（推定値である旨が明示されている）こと。

### 1.4 Success criteria（成功条件 — 具体的・検証可能）
1. プロフィール（身長・体重・体型・年齢・性別・活動量・目標）を初回に入力でき、以降のすべての計算（目標カロリー・PFC 目標・消費カロリー）にそれが反映される。
2. 食事を **写真 and/or テキスト**（飲み物含む）で記録すると、**カロリー + PFC（タンパク質 / 脂質 / 炭水化物）** の推定が出る。誤差・推定であることが UI 上に明示される。
3. その日の「足りないもの / 次に何を食べるとよいか」が、スクロールせずに一目で分かる（ファーストビュー内）。
4. 筋トレ（種目・セット・回数・重量）を記録すると、**プロフィールで個別化された消費カロリー** が推定される。
5. 「今日の成果」が、摂取 vs 消費・PFC バランス・トレーニング総量を含めて一目で分かる。
6. 週次・月次のトレンド（グラフ）と、**コーチング**（"来週/来月はこうしよう"）が出る。
7. アプリ内 AI チャットで相棒と会話でき、会話は本人の当日/直近データを文脈として持つ。
8. ライト/ダーク切替が全画面で破綻なく、設定が永続化される。
9. すべての推定値が「実在の栄養データソース or 明示された計算方法」に裏付けられ、**捏造した数値を事実として提示しない**。
10. `npx tsc --noEmit` ゼロエラー、Lint クリーン、主要ロジックにテストが通る状態でのみ "done"。

### 1.5 What this product is NOT — 非目標（Non-goals）
- **医療機器・医療助言ではない。** 病気の診断・治療・予防を目的としない。
- **収益化・課金を保証しない。** 仲間に見せても「これで痩せる/儲かる」等の保証はしない。
- **多人数 SaaS ではない。** マルチテナント・課金・チーム機能は対象外（単一ユーザー前提。将来クラウド同期は OPEN QUESTION）。
- **完璧な栄養計算ではない。** すべて推定（estimate）。±誤差を許容し、明示する。
- **ソーシャル機能なし。** フォロー・公開フィード・ランキング等は作らない（"見せる" は画面を物理的に見せるだけ）。
- **ウェアラブル連携は初期スコープ外**（HealthKit / Google Fit 等は将来検討、OPEN QUESTION）。
- **栄養士チャットのような無制限の健康相談には踏み込まない**（AI は記録解析と運動/食事の一般的示唆に限定。後述 §10 ガードレール）。

---

## 2. Assumptions（前提 — 違っていれば指摘を）

```
ASSUMPTIONS:
1. 単一ユーザー（本人）。複数アカウント/ログインは初期不要（OPEN QUESTION で再確認）。
2. データは「本人の端末ローカル中心」を出発点とし、LLM 呼び出しのためだけに最小限のデータが
   バックエンド経由で LLM に渡る（写真・食事テキスト等）。フルクラウド同期は未確定。
3. モバイル Web（PWA 化可能性あり）であり、ネイティブアプリ（iOS/Android）ではない。
4. 言語は日本語 UI（プロトタイプが日本語ラベル。MealType="朝/昼/夕/間食" 等）。
5. 既存プロトタイプの技術選定（Next.js 14 / TS strict / Tailwind / navy+accent パレット /
   class ベース dark mode）は踏襲し、作り直さない。
6. LLM はアプリ内バックエンド経由で呼ぶ。クライアントから直接 LLM API を叩いて API キーを
   露出させることはしない。
7. 「Codex SDK」とは公式 @openai/codex-sdk（TypeScript）を指す。コミュニティ "CodexBridge" や
   社内 bridge は使わない。
8. 栄養数値は実在データソース or 明示手法に基づく。LLM 単独の記憶だけで数値を断定しない。
→ 違っていれば §11 OPEN QUESTIONS で確認。
```

---

## 3. Target Platform & Tech Stack（プラットフォーム / 技術スタック）

### 3.1 Frontend（プロトタイプ踏襲 + 拡張）
| 項目 | 採用 | 備考 |
|---|---|---|
| Framework | **Next.js 14（App Router）** | プロトタイプと同一 |
| Language | **TypeScript（strict）** | 既存 `tsconfig` 踏襲。zero `tsc --noEmit` errors 必須 |
| Styling | **Tailwind CSS 3.4** | 既存 `tailwind.config.ts`（navy / accent パレット, `darkMode:"class"`）踏襲 |
| State | React hooks（既存 `useMeals` / `useWorkout` パターン）。グローバルは ThemeProvider 同様の Context | 重い状態管理ライブラリは原則入れない（Simplicity First） |
| Charts | 軽量チャートライブラリ（候補: `recharts` / `visx` / 自前 SVG）— **OPEN QUESTION** | バンドル増を最小化 |
| Local persistence | **localStorage**（メタデータ）+ **IndexedDB**（写真 Blob）。既存 `storage.ts` / `photoStore.ts` を拡張 | |
| 配信形態 | **重要変更:** 現状 `output:"export"`（純静的）。フル製品は LLM 用バックエンドが必要 → 静的のみでは不可。§5 参照 | |

> **アーキテクチャ上の重要事項:** プロトタイプは `next.config.mjs` で `output: "export"`（Node サーバ無しの純静的書き出し、Cloudflare Pages 想定）。LLM 機能はサーバ側シークレットを伴うため、**純静的のままでは実現不可**。フロントは静的のまま別ホストのバックエンドを叩く構成にするか、Next.js の server routes（Edge/Node）を使う構成へ移行するかの判断が必要（§5 と §11 OPEN QUESTIONS）。

### 3.2 Backend（新規 — LLM 呼び出しの最小サーバ）
- 役割は **LLM へのプロキシ + 栄養データ照合 + プロンプト構築** に限定（薄い backend-for-frontend）。
- シークレット（LLM APIキー等）はサーバ側のみ。クライアントへ露出させない（Absolute Rule #3 / §9）。
- 実装候補（**OPEN QUESTION**）: Cloudflare Pages Functions / Workers、または Node ホスト（Next.js API Route を `output:"export"` から外す）。

### 3.3 LLM 層
- **方式 A:** 公式 **@openai/codex-sdk**（TypeScript）をバックエンドから呼ぶ。
- **方式 B:** LLM API 直叩き（Anthropic Claude or OpenAI）。
- **vision 必須:** 食事写真→食品認識には vision 対応モデルが必要。テキストのみのモデルでは写真解析不可。
- 採用モデルは **OPEN QUESTION**（食事 vision 用と、コーチング/チャット用テキスト用で分けてよい）。
- **禁止:** コミュニティ "CodexBridge"、社内 bridge 経由は使わない。

### 3.4 栄養データソース（推定の裏付け）
推定カロリー/PFC は、以下いずれかに必ず接地する（**OPEN QUESTION で確定**）:
- (a) 公的/標準の栄養データベース（例: 日本食品標準成分表、USDA FoodData Central 等）をバックエンドに取り込み、食品名→100gあたり栄養素で照合し、推定量を掛ける。
- (b) 栄養 API（外部）。ただし当社方針は API 最小化（§9）。
- (c) LLM に「データソース名 + 計算手法 + 不確実性」を必ず添えさせる（数値の丸呑み禁止、捏造ガード）。
→ いずれにせよ **"LLM が記憶から出した裸の数字を事実として表示する" のは禁止**。

### 3.5 Commands（開発コマンド — プロトタイプ準拠）
```bash
# 開発サーバ
npm run dev          # next dev  (http://localhost:3000)

# 型チェック（zero errors 必須）
npm run typecheck    # tsc --noEmit

# Lint
npm run lint         # next lint

# ビルド
npm run build        # next build （static export 維持 or 解除は §5 判断に依存）

# テスト（新規導入 — フレームワークは §8 / OPEN QUESTION）
npm test
```

---

## 4. Data Model（データモデル）

既存型（`src/lib/types.ts`）を保持・拡張する。**破壊的変更は避け、フィールド追加で進化させる**（既存ローカルデータの移行を §8 で扱う）。

### 4.1 既存（保持）
```ts
type MealType = "朝" | "昼" | "夕" | "間食";

interface Meal {
  id: string;
  date: string;          // YYYY-MM-DD
  timestamp: string;     // full ISO
  type: MealType;
  text: string;
  photoId?: string;      // IndexedDB key
}

interface Exercise { id: string; name: string; sets: number; reps: number; weight: number; }
interface Workout  { date: string; exercises: Exercise[]; updatedAt: string; }
type Theme = "light" | "dark";
```

### 4.2 新規 — Profile（肝 1）
```ts
type Sex = "male" | "female" | "other";        // 計算は male/female を使用。other は OPEN QUESTION
type BodyType = "slim" | "average" | "muscular" | "heavy"; // 体型（自己申告）
type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";
type Goal = "lose_fat" | "maintain" | "gain_muscle" | "recomp";

interface Profile {
  heightCm: number;
  weightKg: number;
  bodyType: BodyType;
  age: number;
  sex: Sex;
  activityLevel: ActivityLevel;
  goal: Goal;
  // 任意: 体脂肪率（あれば BMR 推定精度↑）
  bodyFatPct?: number;
  updatedAt: string;
}
```
- Profile から導出する **派生目標**（保存ではなく計算）: BMR、TDEE、目標カロリー、PFC 目標（g）。
  - BMR は Mifflin-St Jeor（標準・出典明示可能）等の確立式を使用。体脂肪率があれば Katch-McArdle も選択可（OPEN QUESTION = どこまで個別化するか）。

### 4.3 新規 — 食事解析（肝 2）
```ts
interface NutritionEstimate {
  calories: number;      // kcal（推定）
  proteinG: number;
  fatG: number;
  carbG: number;
  confidence: "low" | "medium" | "high";  // 推定の確からしさ
  source: string;        // 接地したデータソース名 or 手法（捏造防止のため必須）
  items?: FoodItem[];     // 認識した個々の食品
  estimatedAt: string;
}
interface FoodItem { name: string; portion: string; calories: number; proteinG: number; fatG: number; carbG: number; }

// Meal を非破壊拡張
interface Meal { /* ...既存... */ nutrition?: NutritionEstimate; }
```

### 4.4 新規 — 筋トレ消費（肝 3）
```ts
interface ExerciseBurn {
  exerciseId: string;
  caloriesBurned: number;   // kcal（推定）
  met: number;              // 採用した MET 値
  method: string;           // 計算手法（出典明示）
}
interface Workout { /* ...既存... */ burnEstimate?: { totalKcal: number; perExercise: ExerciseBurn[]; estimatedAt: string }; }
```
- 消費カロリー = MET × 体重(kg) × 時間(h)（標準式）。体型/プロフィールで MET・補正係数を個別化（個別化の深さは OPEN QUESTION）。

### 4.5 新規 — トレンド / コーチング（肝 5）
```ts
interface DailyRollup {
  date: string;
  intakeKcal: number; burnKcal: number; netKcal: number;
  proteinG: number; fatG: number; carbG: number;
  volume: number;       // 既存 totalVolume()
}
interface CoachingNote {
  period: "week" | "month";
  rangeStart: string; rangeEnd: string;
  summary: string;          // 自然文（自然な日本語）
  recommendations: string[];
  generatedBy: string;      // モデル名/手法（透明性）
  isEstimate: true;
}
```

### 4.6 新規 — チャット（肝 6）
```ts
interface ChatMessage { id: string; role: "user" | "assistant"; content: string; createdAt: string; }
```
（履歴はローカル保持。LLM へ送る文脈の範囲は §9 / §10 でガード）

---

## 5. Architecture（アーキテクチャ）

```
┌──────────────────────────────────────────────────────────────┐
│  Mobile-first Frontend (Next.js 14 App Router, TS, Tailwind)   │
│  - 既存タブ: 食事 / 筋トレ                                       │
│  - 追加タブ/画面: プロフィール / 成果(ダッシュボード) / トレンド / チャット │
│  - localStorage(メタ) + IndexedDB(写真)                          │
│  - 計算ユーティリティ(BMR/TDEE/PFC目標/volume/burn) はクライアントで完結可 │
└───────────────┬──────────────────────────────────────────────┘
                │  fetch (JSON, 画像は縮小後)
                ▼
┌──────────────────────────────────────────────────────────────┐
│  Thin Backend (BFF) — LLM プロキシ専用                          │
│  - /api/analyze-meal   (写真/テキスト → 栄養推定)               │
│  - /api/estimate-burn  (任意: サーバ側計算 or クライアント計算)  │
│  - /api/coach          (週/月 rollup → コーチング文)            │
│  - /api/chat           (会話 + 当日/直近データ文脈)             │
│  - 栄養データソース照合（§3.4）                                 │
│  - シークレット保持（LLM key）                                  │
└───────────────┬───────────────────────────┬──────────────────┘
                ▼                           ▼
   ┌────────────────────────┐   ┌──────────────────────────┐
   │ LLM (vision + text)     │   │ Nutrition Data Source     │
   │ @openai/codex-sdk       │   │ (DB取り込み or API)        │
   │ or Claude/OpenAI API    │   │ 数値の接地・捏造防止        │
   └────────────────────────┘   └──────────────────────────┘
```

### 5.1 計算はどこで？
- **決定論的計算（BMR/TDEE/PFC 目標、volume、MET ベース消費、rollup）はクライアントで完結可能** → LLM 不要・オフライン可・テスト容易。これらは LLM に投げない（捏造リスク回避 + コスト削減）。
- **LLM が必要なのは:** 写真/自由文の食品認識・ポーション推定、自然文コーチング、チャット。

### 5.2 静的書き出しとの整合（重要判断点）
- 現 `output:"export"` のままだと API Route が使えない → **(i)** フロント静的のまま別ホストのバックエンド、または **(ii)** `output:"export"` を外して server routes を持つホスト（CF Pages Functions / Workers / Node）へ移行。→ **OPEN QUESTION**。
- いずれの場合も「ネットワーク不通時は記録・決定論計算は動く（LLM 解析だけ後回し）」を満たす（オフラインファースト寄り）。

---

## 6. Feature Set & Acceptance Criteria（機能 + 受け入れ基準）

各機能は「Given / When / Then」で検証可能に記述。

### F0. ナビゲーション / シェル拡張
既存 AppShell（ヘッダー + 下部タブバー, max-w-md）を拡張。タブは「食事 / 筋トレ / 成果 / チャット」、プロフィールはヘッダーから。
- **AC:** 全タブがモバイル幅(≤430px)で破綻せず、下部 safe-area を尊重し、テーマ切替が全タブで一貫する。

### F1. プロフィール（肝 1）
- **Given** 初回起動で Profile 未設定 **When** アプリを開く **Then** プロフィール入力（身長/体重/体型/年齢/性別/活動量/目標）へ誘導される。
- **When** 保存 **Then** BMR・TDEE・目標カロリー・PFC 目標(g) が算出され、以降の食事/筋トレ/成果画面に反映される。
- **AC:** 不正入力（身長0、負値、非数値）はバリデーションで弾く。値は localStorage に永続化。体脂肪率は任意。
- **AC:** 採用した計算式名（例: Mifflin-St Jeor）が「計算方法」として参照可能（透明性）。

### F2. 食事ログ + 解析（肝 2）— 最重要
- **Given** プロフィール設定済み **When** 写真 and/or テキストで食事（飲み物含む）を記録 **Then** カロリー + PFC(P/F/C) の推定が表示される。
- **When** 解析完了 **Then** その食事の `NutritionEstimate`（confidence と source 付き）が Meal に保存され、カードに表示される。
- **When** ダッシュボードを見る **Then** 当日の「足りないもの / 次に何を食べるとよいか」が**ファーストビュー内**に出る（例: "あと P 40g 足りない → 鶏むね/プロテイン"）。
- **AC（捏造防止）:** すべての数値に推定ラベル + データソース/手法表示。LLM が出力した裸の数値をソース無しで断定表示しない。認識できない場合は「推定できませんでした」と正直に出す（沈黙や捏造で埋めない）。
- **AC:** 写真は送信前に縮小（既存 `image.ts` の長辺1280px/JPEG 圧縮を流用）。
- **AC:** 解析失敗/オフライン時も食事の記録自体は保存され、後から再解析できる。
- **AC:** テキストのみ（写真なし）でも解析が走る。写真のみ（テキストなし）でも走る。

### F3. 筋トレログ + 消費推定（肝 3）
- **Given** プロフィール設定済み **When** 種目・セット・回数・重量を記録 **Then** プロフィール（身長/体重/体型）で個別化された消費カロリー推定が出る。
- **AC:** 消費 = MET × 体重 × 時間（標準式）に接地。採用 MET と手法を表示。体型/体重で補正。
- **AC:** 既存の `totalVolume`（Σ sets×reps×weight）・種目数・前日比は維持。
- **AC:** 推定であることを明示。

### F4. 今日の成果ダッシュボード（肝 4）
- **When** 成果タブを開く **Then** ①摂取 kcal vs 消費 kcal（と目標との差）②PFC バランス（目標比）③トレーニング総量 を一目で表示。
- **AC:** ファーストビュー（スクロール無し）で主要指標が読める。数字は大きく、premium な見た目。ライト/ダーク両対応。
- **AC:** データ未入力の指標は 0/未記録 と正直に表示（推測で埋めない）。

### F5. 週次 / 月次トレンド + コーチング（肝 5）
- **When** トレンドを開く **Then** 直近 週/月 の 摂取/消費/ネット/PFC/総量 の推移グラフが出る。
- **When** コーチングを見る **Then** "来週/来月はこうしよう" という具体的助言（自然な日本語）が出る。
- **AC:** コーチングは実データ（rollup）に基づき、生成元（モデル/手法）と推定ラベルを明示。医療助言化しない（§10）。データが少ない期間は「まだ判断材料が足りない」と正直に言う。

### F6. アプリ内 AI チャット（肝 6）
- **When** チャットを開いて質問 **Then** 相棒が、本人の当日/直近データを文脈に自然な日本語で応答。
- **AC:** 送信文脈はガード（§9/§10）。医療/診断級の質問には限界を明示し一般情報に留める。捏造禁止。
- **AC:** 会話履歴はローカル保持。クリア可能。

### F7. テーマ（白基調 ⇄ 紺基調）
- 既存 ThemeProvider / Tailwind navy パレットを全新規画面へ適用。
- **AC:** 全画面・全コンポーネントでライト/ダーク破綻なし。設定永続化。初回はシステム設定に追従。

### F8. 透明性 / ディスクレーマ（横断要件）
- **AC:** カロリー/PFC/消費/コーチングのすべてに「推定（estimate）・医療助言ではない」旨が、邪魔にならない形で常時アクセス可能。仲間に見せても誤解されない表現。

---

## 7. Design System（デザインシステム — 白基調 / 紺基調・モバイル優先）

プロトタイプの確立済みデザイン言語を SoT とし、拡張する。

### 7.1 カラー（既存 `tailwind.config.ts`）
- **Light:** `bg-slate-50` / `text-slate-900`、surface = white + `shadow-card` + `border-slate-200/70`。
- **Dark（紺基調）:** `bg-navy-950` / `text-navy-50`、surface = `navy-900` + `shadow-card-dark` + `border-navy-800`。
- **Accent:** teal/green `#1f9d8f`（light `#2db3a3` / dark `#157a6f`）— "健康" を想起させる差し色。新規グラフ・進捗リングもこの accent を基調に。
- `darkMode:"class"`（`<html>.dark`）。`ThemeProvider` 経由でトグル + 永続化。

### 7.2 コンポーネント語彙（既存 globals.css のユーティリティを再利用）
- `.surface`（カード/シート/パネル）、`.field`（入力）、`.btn-primary` / `.btn-ghost`、`.chip`、`.no-scrollbar`。
- 角丸 `rounded-2xl`、フォント = system + Hiragino/Meiryo フォールバック。
- **新規にデザイントークンを乱立させない**（Surgical / Simplicity）。新コンポーネントは既存ユーティリティ上に構築。

### 7.3 レイアウト原則
- `max-w-md` 中央寄せ、`min-h-[100dvh]`、sticky ヘッダー + 固定下部タブバー、`env(safe-area-inset-bottom)` 尊重（既存 AppShell 準拠）。
- ダッシュボードはカードグリッド + 大きな数字 + 進捗リング/バー。一目で読める情報密度。
- タップターゲット ≥44px、数値入力はステッパー（既存 ExerciseRow パターン）。

### 7.4 トーン
- プレミアム・ミニマル・落ち着き。過剰な絵文字や装飾はしない。
- ローディング/解析中は明確なステート表示（"解析中…"）。空状態は既存 EmptyState パターン。

---

## 8. Testing Strategy（テスト方針）

- **フレームワーク（OPEN QUESTION）:** Vitest + React Testing Library を推奨（軽量・Next/TS 親和）。E2E は必要なら Playwright。
- **ユニット（最重要）:** 決定論ロジックを厚くテスト。
  - BMR/TDEE/目標カロリー/PFC 目標 の計算（既知入力→既知出力の表駆動テスト）。
  - MET ベース消費カロリー、`totalVolume`、前日比、`DailyRollup` 集計。
  - 栄養データソース照合（食品名→栄養素マッピング）。
- **解析/LLM 層:** LLM 応答は **モック**してテスト（実 API をテストで叩かない）。捏造ガード（source 無し数値を弾く）を必ずテスト。
- **コンポーネント:** プロフィール入力バリデーション、テーマ切替、ダッシュボード描画、空/エラー/オフライン状態。
- **データ移行:** 既存プロトタイプの localStorage/IndexedDB スキーマ（`health-app:meals:v1` 等）からの非破壊移行をテスト。
- **品質ゲート（CLAUDE.md 準拠）:** `tsc --noEmit` 0 エラー、Lint クリーン、console.log/debugger 残置なし、を "done" の必須条件にする。
- **カバレッジ目標:** 計算/データロジックは高カバレッジ（目安 80%+）。UI は主要パスを優先。

---

## 9. Privacy / Data Handling（プライバシー / データ取り扱い）

- **ローカル中心:** 記録（食事・筋トレ・プロフィール・チャット履歴）は端末ローカル（localStorage / IndexedDB）に保存。
- **外部送信は LLM 解析時のみ:** 食事写真・食事テキスト・（コーチング/チャット用に）必要最小限の集計データだけをバックエンド経由で LLM に送る。**送る範囲は最小化**し、何が送られるかを利用者が理解できるようにする。
- **シークレット非露出:** LLM API キー等はバックエンドのみ。クライアント・git に絶対に置かない（Absolute Rule #3）。`.env*` はコミットしない。
- **API 最小化（当社方針）:** 新規外部 API は必要性を吟味。内部代替（取り込み済み栄養 DB 等）を優先。
- **OSS 採用時:** 5 軸監査（owner / license / install scripts / runtime cred / transitive deps）を経てから依存追加。
- **第三者保持の最小化:** LLM プロバイダのデータ保持/学習利用ポリシーを確認し、可能なら学習オプトアウト/ゼロ保持設定を使う（OPEN QUESTION = プロバイダ選定に依存）。
- **削除可能性:** ローカルデータ（写真含む）と会話履歴をユーザが消去できる。

---

## 10. Safety / Guardrails（安全・ガードレール — 横断必須）

1. **医療助言ではない:** すべての数値・助言に「推定・一般情報であり医療助言ではない」を明示。診断/治療/投薬の助言はしない。
2. **収益/効果の保証なし:** 「必ず痩せる/儲かる」等の断定をしない（仲間に見せる前提でも安全）。
3. **数値の接地（捏造禁止）:** カロリー/PFC/消費は実データソース or 明示手法に裏付ける。LLM の裸の数字を事実として出さない。不明なら「推定できない」と正直に出す（沈黙や捏造で埋めない）。
4. **過小/極端な助言の抑制:** 危険な極端カロリー制限・絶食等を推奨しない。コーチングは穏当な範囲に収める。
5. **透明性:** 生成元（モデル/手法）・confidence を表示。
6. **プロンプトインジェクション/逸脱対策:** チャットは健康/記録の文脈に留め、システム指示の漏洩や逸脱を防ぐガードを backend 側に置く。

---

## 11. Build Plan（段階的ビルド計画）

> 既存 logging foundation → 解析 → LLM/コーチング/チャット の順。各フェーズは独立してデモ可能で、品質ゲート（tsc/lint/test）を通してから次へ。**この PRD は仕様のみ。実装は別途承認の上で着手。**

### Phase 0 — Foundation 確認 & 整地（既存資産）
- 既存プロトタイプ（食事/筋トレ/テーマ/ローカル保存）を baseline として確認。テスト基盤（Vitest 等）と CI 品質ゲートを用意。
- **Exit:** `tsc --noEmit` 0、既存機能リグレッションなし、テストランナー稼働。

### Phase 1 — プロフィール & 決定論計算（肝 1, 4 の土台）
- Profile 入力 UI + バリデーション + 永続化。BMR/TDEE/目標カロリー/PFC 目標 の計算ユーティリティ（出典明示）。成果ダッシュボードの骨格（決定論データだけで動く版）。
- **Exit:** プロフィールから目標が出て、手入力相当のデータで成果が一目で見える。計算は表駆動テストで検証済み。LLM 不要で完結。

### Phase 2 — 筋トレ消費推定（肝 3）
- MET ベース消費カロリー（プロフィール個別化）。既存 volume と統合して成果へ反映。
- **Exit:** 種目記録 → 個別化消費が出て、テスト済み。

### Phase 3 — バックエンド + 食事写真/テキスト解析（肝 2）— 最重要
- 薄い BFF を立ち上げ（静的書き出し方針の判断を含む, §5/§11Q）。栄養データソース接続。`/api/analyze-meal`（vision）。捏造ガード。ダッシュボードに「足りないもの/次に食べる」を統合。
- **Exit:** 写真/テキストから接地済み推定が出て、source/confidence 表示、失敗時も正直に出る。LLM 応答はモックでテスト済み。

### Phase 4 — トレンド & コーチング（肝 5）
- DailyRollup 集計、週/月グラフ、`/api/coach` による自然文コーチング。
- **Exit:** トレンドが描画され、実データに基づくコーチングが推定ラベル付きで出る。

### Phase 5 — AI チャット（肝 6）
- `/api/chat` + チャット UI。当日/直近データを文脈に。ガードレール適用。
- **Exit:** 文脈付きで自然に会話でき、安全ガードが効く。

### Phase 6 — 仕上げ（完成度）
- 全画面のライト/ダーク磨き込み、空/エラー/オフライン状態、PWA 化検討、パフォーマンス（モバイル LCP/CLS）、アクセシビリティ、最終ディスクレーマ配置。
- **Exit:** "完成度めちゃ高い" 体感。仲間に見せても破綻・誤解なし。品質ゲート全通過。

---

## 12. Boundaries（境界）

- **Always:** 推定ラベル + データソース明示を保つ / `tsc --noEmit` 0・Lint クリーンで done / 既存デザイントークン・既存型を再利用（非破壊拡張）/ シークレットはサーバのみ / 写真は送信前縮小。
- **Ask first（owner 判断）:** LLM/モデル選定、栄養データソース選定、認証/クラウド同期の有無、ホスティング先（静的書き出し解除の是非）、消費式の個別化の深さ、新規依存追加、課金を伴う API。→ §13 で集約。
- **Never:** シークレット/`.env` を git に / LLM の裸の数字を事実として表示 / 医療助言・効果保証 / クライアントから直接 LLM キーを叩く / コミュニティ "CodexBridge"・社内 bridge 使用 / 失敗を捏造や沈黙で埋める。

---

## 13. OPEN QUESTIONS FOR OWNER（オーナー判断が必要な事項）

要決定。各々の選択でアーキテクチャ・コスト・プライバシーが変わる。

1. **食事 vision 用 LLM（写真→食品認識）はどれにするか？** — @openai/codex-sdk（GPT-5系 vision）/ OpenAI API / Claude（vision）。コスト・精度・データ保持ポリシーで選ぶ。
2. **コーチング/チャット用テキスト LLM は同じモデルか別か？** — vision とテキストで分けるとコスト最適化できる。
3. **栄養データソースは何にするか？** — (a) 日本食品標準成分表を取り込み（API 不要・当社方針に合致）/ (b) USDA FoodData Central / (c) 外部栄養 API / (d) LLM 推定 + 手法明示のみ。精度と「捏造防止」の担保レベルを決める。
4. **認証 & クラウド同期を入れるか、ローカルのままか？** — 単一端末ローカルで十分か、機種変更/複数端末で同期したいか。同期するなら DB（例: Cloudflare D1 / Supabase）と認証が必要 → スコープ/プライバシーが大きく変わる。
5. **ホスティング先は？ 静的書き出し（`output:"export"`）を解除してよいか？** — フロント静的（CF Pages）+ 別ホスト backend にするか、Next.js server routes を持つ構成（CF Pages Functions/Workers or Node ホスト）へ移行するか。LLM 機能には backend が必須。
6. **筋トレ消費カロリーの個別化はどこまで深くするか？** — MET×体重×時間の標準式（軽量）か、体型・体脂肪率・心拍想定まで踏み込むか。深いほど精度の主張は強まるが推定誤差の説明責任も増す。
7. **BMR 計算式の選択** — Mifflin-St Jeor（標準）固定でよいか、体脂肪率があれば Katch-McArdle に切替えるか。
8. **チャートライブラリ** — recharts / visx / 自前 SVG。バンドルサイズと見た目のどちらを優先するか。
9. **テストフレームワーク** — Vitest + RTL（推奨）で確定してよいか。
10. **トレーニング仲間に見せる際の "共有" は画面表示のみで十分か？** — スクショ/書き出し（PDF・画像）まで要るか（要れば軽い export 機能を追加）。
11. **写真の取り扱い** — 解析後に写真をローカル保持し続けるか、解析だけして破棄するか（プライバシー/容量のトレードオフ）。
12. **言語** — 日本語のみでよいか（UI ラベルは日本語前提で設計）。
```
