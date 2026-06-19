import { allEntries, type FoodEntry } from "../_data/lookup";
import { normalizeName } from "./normalize";
import type { Confidence } from "./ground";

export interface AliasMatch {
  food: FoodEntry;
  confidence: Confidence;
}

interface AliasDef {
  aliases: string[];
  foodCode: string;
  confidence?: Confidence;
}

// Common spoken names mapped to verified MEXT food_code rows. Staples, meats,
// and noodles intentionally point to cooked rows when a cooked row exists.
const ALIAS_DEFS: AliasDef[] = [
  { aliases: ["ごはん", "ご飯", "白米", "米飯", "めし", "飯", "ライス"], foodCode: "01088" },
  { aliases: ["玄米ごはん", "玄米ご飯", "玄米飯"], foodCode: "01085" },
  { aliases: ["おかゆ", "粥", "かゆ"], foodCode: "01093" },
  { aliases: ["おにぎり"], foodCode: "01111" },
  { aliases: ["もち", "餅"], foodCode: "01117" },
  { aliases: ["赤飯"], foodCode: "01118" },
  { aliases: ["食パン", "パン", "トースト"], foodCode: "01026" },
  { aliases: ["うどん", "うどんゆで", "ゆでうどん", "茹でうどん"], foodCode: "01039" },
  { aliases: ["そば", "蕎麦", "そばゆで", "ゆでそば", "茹でそば"], foodCode: "01128" },
  { aliases: ["パスタ", "スパゲッティ", "スパゲティ", "ゆでパスタ", "茹でパスタ", "ゆでスパゲッティ", "茹でスパゲッティ"], foodCode: "01064" },
  { aliases: ["中華麺", "中華めん", "ラーメンの麺", "ラーメン麺", "ゆで中華麺", "ゆで中華めん"], foodCode: "01048" },
  { aliases: ["ラーメン", "インスタントラーメン"], foodCode: "01198" },
  // Compound dishes that DO have a genuine DB row (NOT a sauce/derivative). These
  // are also in the ground.ts COMPOUND_DISH_DENYLIST, so the single-token
  // substring matcher is blocked for them — the alias is what makes them ground.
  // Every food_code below was verified against functions/_data/nutrition-lookup.json.
  { aliases: ["焼きそば", "焼そば", "ソース焼きそば"], foodCode: "01188" }, // 蒸し中華めん ソテー = 211
  { aliases: ["焼きおにぎり", "焼おにぎり"], foodCode: "01112" }, // こめ 焼きおにぎり = 166
  { aliases: ["焼き飯", "焼飯", "焼きめし", "チャーハン", "炒飯"], foodCode: "18057", confidence: "low" }, // チャーハン = 206
  { aliases: ["卵焼き", "玉子焼き", "厚焼き卵", "厚焼きたまご", "たまご焼き"], foodCode: "12018", confidence: "medium" }, // たまご焼 厚焼きたまご = 146
  { aliases: ["だし巻き卵", "だし巻きたまご", "出汁巻き卵"], foodCode: "12019", confidence: "medium" }, // たまご焼 だし巻きたまご = 123
  { aliases: ["どら焼き", "どら焼", "ドラ焼き"], foodCode: "15027", confidence: "medium" }, // どら焼 つぶしあん入り = 292
  { aliases: ["今川焼き", "今川焼", "大判焼き", "回転焼き"], foodCode: "15005", confidence: "medium" }, // 今川焼 こしあん入り = 217
  { aliases: ["しゅうまい", "シュウマイ", "シューマイ", "焼売", "蒸ししゅうまい"], foodCode: "18012", confidence: "low" }, // 中国料理 しゅうまい = 191
  { aliases: ["焼き餃子", "蒸し餃子", "ゆで餃子", "水餃子"], foodCode: "18002", confidence: "low" }, // 中国料理 ぎょうざ = 209
  { aliases: ["卵", "たまご", "玉子", "生卵"], foodCode: "12004" },
  { aliases: ["ゆで卵", "ゆでたまご", "茹で卵"], foodCode: "12005" },
  { aliases: ["目玉焼き"], foodCode: "12021" },
  { aliases: ["鶏むね", "鶏むね肉", "鶏胸", "鶏胸肉", "とりむね", "むね肉"], foodCode: "11288" },
  { aliases: ["ささみ", "鶏ささみ", "とりささみ"], foodCode: "11229" },
  { aliases: ["鶏もも", "鶏もも肉", "とりもも", "もも肉"], foodCode: "11222" },
  // Generic meat aliases are representative substitutions, so confidence is
  // lower than an explicit part/cooking-state alias.
  { aliases: ["鶏肉", "とり肉", "鳥肉", "チキン"], foodCode: "11221", confidence: "medium" },
  { aliases: ["唐揚げ", "からあげ", "鶏の唐揚げ", "鶏から"], foodCode: "18054", confidence: "low" },
  { aliases: ["豚ロース", "豚ロース肉"], foodCode: "11124" },
  { aliases: ["豚バラ", "豚ばら", "豚バラ肉"], foodCode: "11277" },
  { aliases: ["豚もも", "豚もも肉"], foodCode: "11132" },
  { aliases: ["豚肉", "ぶた肉", "ポーク"], foodCode: "11131", confidence: "medium" },
  { aliases: ["豚ひき肉", "豚ミンチ"], foodCode: "11280" },
  { aliases: ["牛ロース", "牛ロース肉"], foodCode: "11268" },
  { aliases: ["牛バラ", "牛ばら", "牛バラ肉"], foodCode: "11252" },
  { aliases: ["牛もも", "牛もも肉"], foodCode: "11270" },
  { aliases: ["牛肉", "うし肉", "ビーフ"], foodCode: "11047", confidence: "medium" },
  { aliases: ["牛ひき肉", "牛ミンチ"], foodCode: "11272" },
  { aliases: ["ひき肉", "挽き肉", "ミンチ"], foodCode: "11163", confidence: "medium" },
  { aliases: ["ベーコン", "ロースベーコン"], foodCode: "11184" },
  { aliases: ["ハム", "ロースハム"], foodCode: "11176" },
  { aliases: ["ウインナー", "ウィンナー", "ソーセージ", "ウインナーソーセージ"], foodCode: "11186" },
  { aliases: ["納豆"], foodCode: "04046" },
  { aliases: ["豆腐", "木綿豆腐"], foodCode: "04032" },
  { aliases: ["絹豆腐", "絹ごし豆腐"], foodCode: "04033" },
  { aliases: ["油揚げ", "あぶらあげ"], foodCode: "04040" },
  { aliases: ["牛乳", "ミルク"], foodCode: "13003" },
  { aliases: ["チーズ", "プロセスチーズ"], foodCode: "13040", confidence: "medium" },
  { aliases: ["ヨーグルト", "無糖ヨーグルト"], foodCode: "13025" },
  { aliases: ["バター", "有塩バター"], foodCode: "14017" },
  { aliases: ["バナナ"], foodCode: "07107" },
  { aliases: ["りんご", "リンゴ", "林檎"], foodCode: "07148" },
  { aliases: ["みかん"], foodCode: "07026" },
  { aliases: ["オレンジ"], foodCode: "07040" },
  { aliases: ["キウイ"], foodCode: "07054" },
  { aliases: ["ぶどう", "ブドウ"], foodCode: "07116" },
  { aliases: ["いちご", "イチゴ"], foodCode: "07012" },
  // Beverages — the meal tracker had ZERO drink aliases, so common drinks
  // (coffee/tea) either missed entirely (ブラックコーヒー → 0 kcal dead-end) or the
  // bare single-token substring matcher landed on the WRONG row (コーヒー →
  // 15088 ゼリー コーヒー, a dessert). Map the common spoken names to the verified
  // beverage 浸出液/液状 rows so they ground to 公式DB directly. Every food_code
  // below was confirmed against functions/_data/nutrition-lookup.json.
  // ブラックコーヒー/コーヒー = 16045 コーヒー 浸出液 = 4kcal/100g (brewed black coffee).
  { aliases: ["コーヒー", "ブラックコーヒー", "ホットコーヒー", "アイスコーヒー", "珈琲"], foodCode: "16045" },
  { aliases: ["インスタントコーヒー"], foodCode: "16046" }, // 287kcal/100g (粉末)
  { aliases: ["缶コーヒー", "微糖コーヒー"], foodCode: "16047", confidence: "medium" }, // コーヒー飲料 乳成分入り 加糖 = 38kcal
  { aliases: ["カフェオレ", "カフェラテ", "コーヒー牛乳", "ミルクコーヒー"], foodCode: "13007", confidence: "medium" }, // 乳飲料 コーヒー = 56kcal
  { aliases: ["緑茶", "煎茶", "せん茶", "お茶", "日本茶"], foodCode: "16037" }, // せん茶 浸出液 = 2kcal
  { aliases: ["玉露"], foodCode: "16034" }, // 玉露 浸出液 = 5kcal
  { aliases: ["ほうじ茶", "焙じ茶"], foodCode: "16040" }, // ほうじ茶 浸出液 = 0kcal
  { aliases: ["番茶"], foodCode: "16039" }, // 番茶 浸出液 = 0kcal
  { aliases: ["ウーロン茶", "烏龍茶"], foodCode: "16042" }, // ウーロン茶 浸出液 = 0kcal
  { aliases: ["麦茶"], foodCode: "16055" }, // 麦茶 浸出液 = 1kcal
  { aliases: ["紅茶"], foodCode: "16044" }, // 紅茶 浸出液 = 1kcal
  { aliases: ["抹茶"], foodCode: "16035", confidence: "medium" }, // 抹茶 茶 = 237kcal (powder)
  { aliases: ["コーラ"], foodCode: "16053" }, // コーラ = 46kcal
  { aliases: ["サイダー", "ラムネ"], foodCode: "16054" }, // サイダー = 41kcal
  { aliases: ["スポーツドリンク", "ポカリ", "アクエリアス"], foodCode: "16057", confidence: "medium" }, // スポーツドリンク = 21kcal
  { aliases: ["ビール"], foodCode: "16006", confidence: "medium" }, // ビール 淡色 = 39kcal
  { aliases: ["黒ビール"], foodCode: "16007" }, // ビール 黒 = 45kcal
  { aliases: ["日本酒", "清酒", "お酒"], foodCode: "16001", confidence: "medium" }, // 清酒 普通酒 = 107kcal
  { aliases: ["白ワイン"], foodCode: "16010" }, // ぶどう酒 白 = 75kcal
  { aliases: ["赤ワイン"], foodCode: "16011" }, // ぶどう酒 赤 = 68kcal
  { aliases: ["ワイン"], foodCode: "16010", confidence: "medium" }, // default to 白 (representative)
  { aliases: ["豆乳", "無調整豆乳"], foodCode: "04052" }, // だいず 豆乳 豆乳 = 43kcal
  { aliases: ["調製豆乳"], foodCode: "04053" }, // だいず 豆乳 調製豆乳 = 61kcal
  { aliases: ["オレンジジュース"], foodCode: "07043", confidence: "medium" }, // オレンジ 濃縮還元ジュース = 46kcal
  { aliases: ["りんごジュース", "アップルジュース"], foodCode: "07150", confidence: "medium" }, // りんご 濃縮還元ジュース = 47kcal
  { aliases: ["鮭", "さけ", "サケ", "焼き鮭", "焼鮭"], foodCode: "10136" },
  { aliases: ["塩鮭"], foodCode: "10139" },
  { aliases: ["さば", "サバ", "焼きさば", "焼きサバ"], foodCode: "10156" },
  { aliases: ["サバ缶", "さば缶"], foodCode: "10164" },
  // Representative-species substitutions for short, generic fish/seafood names
  // (2-char names the single-token substring guard intentionally blocks).
  { aliases: ["まぐろ", "マグロ", "鮪"], foodCode: "10253", confidence: "medium" },
  { aliases: ["あじ", "アジ", "鯵", "焼きあじ"], foodCode: "10003", confidence: "medium" },
  { aliases: ["えび", "エビ", "海老"], foodCode: "10321", confidence: "medium" },
  { aliases: ["いか", "イカ", "烏賊"], foodCode: "10345", confidence: "medium" },
  { aliases: ["キャベツ"], foodCode: "06061" },
  { aliases: ["レタス"], foodCode: "06312" },
  { aliases: ["トマト"], foodCode: "06182" },
  { aliases: ["きゅうり"], foodCode: "06065" },
  { aliases: ["ブロッコリー"], foodCode: "06264" },
  { aliases: ["玉ねぎ", "玉葱", "たまねぎ", "タマネギ"], foodCode: "06153" },
  { aliases: ["にんじん", "人参", "ニンジン"], foodCode: "06214" },
  { aliases: ["じゃがいも", "ジャガイモ", "じゃが芋"], foodCode: "02019" },
  { aliases: ["さつまいも", "サツマイモ", "さつま芋", "薩摩芋"], foodCode: "02006" },
  // Cooking-variant aliases for さつまいも. The base "芋"/"いも" is too generic to
  // match on its own, so these prepared names need explicit, DB-verified codes:
  //   02008 さつまいも 塊根 皮なし 焼き = 151kcal/100g
  //   02007 さつまいも 塊根 皮なし 蒸し = 131kcal/100g
  { aliases: ["焼きさつまいも", "焼さつまいも", "焼き芋", "焼芋", "焼きいも", "やきいも", "ヤキイモ"], foodCode: "02008" },
  { aliases: ["蒸しさつまいも", "蒸さつまいも", "ふかし芋", "ふかしいも", "蒸し芋", "蒸しいも"], foodCode: "02007" },
  { aliases: ["里芋", "さといも", "サトイモ"], foodCode: "02010" },
  { aliases: ["かぼちゃ", "カボチャ", "南瓜"], foodCode: "06048" },
  { aliases: ["とうもろこし", "トウモロコシ", "コーン", "スイートコーン"], foodCode: "06175" },
  { aliases: ["ねぎ", "長ねぎ", "長ネギ", "白ねぎ", "白ネギ"], foodCode: "06226" },
  { aliases: ["ほうれん草", "ほうれんそう", "ホウレンソウ"], foodCode: "06267" },
  { aliases: ["だいこん", "大根", "ダイコン"], foodCode: "06134" },
  { aliases: ["なす", "茄子", "ナス"], foodCode: "06191" },
  { aliases: ["ピーマン"], foodCode: "06245" },
  { aliases: ["白菜", "はくさい", "ハクサイ"], foodCode: "06233" },
  { aliases: ["もやし", "モヤシ"], foodCode: "06291" },
  { aliases: ["サラダ", "野菜サラダ"], foodCode: "06312", confidence: "low" },
  { aliases: ["味噌汁", "みそ汁", "味噌しる"], foodCode: "18028", confidence: "low" },
  { aliases: ["豚汁", "とん汁"], foodCode: "18028" },
  { aliases: ["カレー", "カレーライス"], foodCode: "18001", confidence: "low" },
  { aliases: ["チキンカレー"], foodCode: "18040", confidence: "low" },
  { aliases: ["ポークカレー"], foodCode: "18041", confidence: "low" },
  { aliases: ["ハンバーグ"], foodCode: "18050", confidence: "low" },
  { aliases: ["餃子", "ぎょうざ", "ギョーザ"], foodCode: "18002", confidence: "low" },
  { aliases: ["コロッケ"], foodCode: "18018", confidence: "low" },
  { aliases: ["麻婆豆腐", "マーボー豆腐"], foodCode: "18049", confidence: "low" },
  { aliases: ["お好み焼き"], foodCode: "18053", confidence: "low" },
];

const byCode = new Map(allEntries().map((entry) => [entry.food_code, entry]));
const byAlias = new Map<string, { foodCode: string; confidence: Confidence }>();

for (const def of ALIAS_DEFS) {
  for (const alias of def.aliases) {
    byAlias.set(normalizeName(alias), {
      foodCode: def.foodCode,
      confidence: def.confidence ?? "high",
    });
  }
}

export function lookupAlias(name: string): AliasMatch | null {
  const alias = byAlias.get(normalizeName(name));
  if (!alias) return null;
  const food = byCode.get(alias.foodCode);
  if (!food) {
    throw new Error(`Missing nutrition alias target food_code=${alias.foodCode}`);
  }
  return { food, confidence: alias.confidence };
}
