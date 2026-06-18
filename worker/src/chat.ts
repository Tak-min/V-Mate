/** チャット(SSE)と、応答後に走るバックグラウンド処理(事実抽出・会話要約)。
 * backend/app/main.py の /api/chat と _extract_facts / _summarize_old_history を移植。
 *
 * FastAPI の BackgroundTasks に相当する「応答後の処理」は ctx.waitUntil で実行する。 */

import type { Env } from "./env";
import type { Store } from "./db";
import { streamChat, complete, provider } from "./llm";
import {
  buildSystemPrompt,
  factExtractionPrompt,
  summaryPrompt,
  stageFor,
  nextStageThreshold,
} from "./persona";
import {
  EMOTION_TAG_RE,
  stripEmotion,
  stripTags,
  sanitizeFourthWall,
  sse,
  jstToday,
  timeContext,
} from "./util";

const FACT_EXTRACTION_INTERVAL = 6; // ユーザー発言N回ごとに事実抽出
const DAILY_FIRST_CHAT_BONUS = 5;
const HISTORY_WINDOW = 24; // 逐語でLLMに渡す直近メッセージ数
// シロは「1〜3文」の短い相づち的な会話が persona.ts の指示だが、LLMが指示を無視して
// 長文を返すことがあり、チャット欄が一方的なAI長文で埋まって人間らしさが失われる原因になっていた。
// max_tokens で物理的に上限を切る(日本語1〜3文+感情タグなら十分収まる長さ)。
const CHAT_MAX_TOKENS = 260;
const SUMMARY_CHUNK = 16; // 窓から溢れた未要約メッセージがN件たまったら要約に畳み込む
const SUMMARY_MAX_CHARS = 1200; // 要約の安全上限
const RESEARCH_METRICS_VERSION = "2026-06-18-v1";
const SENSITIVE_SELF_DISCLOSURE_RE =
  /悩|不安|怖|こわ|つら|辛|疲|しんど|泣|孤独|寂|さび|死|消えたい|自傷|自殺|病|家族|友達|恋|好き|嫌い|秘密|恥|失敗|将来|進路|受験|anxious|lonely|depress|suicide|self-harm|secret|family|friend|love/i;

export interface StatePayload {
  user_name: string | null;
  affinity: number;
  stage: string;
  next_stage_at: number | null;
  provider: string;
}

export async function statePayload(store: Store, env: Env, userId: string): Promise<StatePayload> {
  const score = await store.getAffinity(userId);
  const [stageName] = stageFor(score);
  return {
    user_name: await store.getKv(userId, "user_name"),
    affinity: score,
    stage: stageName,
    next_stage_at: nextStageThreshold(score),
    provider: provider(env),
  };
}

function messageMetrics(text: string): Record<string, unknown> {
  const stripped = text.trim();
  return {
    char_count: stripped.length,
    line_count: stripped ? stripped.split("\n").length : 0,
    question_count: (stripped.match(/[?？]/g) ?? []).length,
    contains_sensitive_self_disclosure: SENSITIVE_SELF_DISCLOSURE_RE.test(stripped),
  };
}

async function addResearchEvent(
  store: Store,
  uid: string,
  condition: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await store.addResearchEvent(
    uid,
    condition,
    eventType,
    JSON.stringify({ metrics_version: RESEARCH_METRICS_VERSION, ...payload }),
  );
}

/** チャット応答を SSE ストリームで返す。レート制限は呼び出し側(index.ts)で済ませておくこと。 */
export function handleChat(
  env: Env,
  store: Store,
  execCtx: ExecutionContext,
  uid: string,
  message: string,
  condition = "stylized",
): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (obj: unknown) => writer.write(encoder.encode(sse(obj)));

  const work = (async () => {
    // 親密度: 1発言 +1、その日最初の会話はボーナス
    const today = jstToday();
    const todayMsgs = await store.messagesOn(uid, today);
    const todayFirst = !todayMsgs.some((m) => m.role === "user");
    await store.addMessage(uid, "user", message);
    await addResearchEvent(store, uid, condition, "chat_sent", {
      message: messageMetrics(message),
      today_first: todayFirst,
    });
    const affinity = await store.addAffinity(uid, 1 + (todayFirst ? DAILY_FIRST_CHAT_BONUS : 0));
    await store.touchLastSeen(uid);

    const system = buildSystemPrompt({
      userName: await store.getKv(uid, "user_name"),
      affinity,
      facts: await store.listFacts(uid),
      timeContext: timeContext(),
      summary: await store.getSummary(uid),
    });
    const recent = await store.recentMessages(uid, HISTORY_WINDOW);
    const history = recent.map((m) => ({ role: m.role, content: m.content }));

    // 事実抽出の判定(Python と同じく user メッセージ追加後の件数で判定)
    const shouldExtract = (await store.userMessageCount(uid)) % FACT_EXTRACTION_INTERVAL === 0;

    let buffer = "";
    let emotion: string | null = null;
    let fullText = "";
    try {
      for await (const chunk of streamChat(env, system, history, CHAT_MAX_TOKENS)) {
        buffer += chunk;
        if (emotion === null) {
          // 感情タグが確定するまでバッファし、確定後にまとめて流す
          const m = buffer.match(EMOTION_TAG_RE);
          if (m) {
            emotion = m[1];
            await write({ type: "emotion", emotion });
            buffer = stripTags(buffer).replace(/^\s+/, "");
          } else if (buffer.length > 24) {
            emotion = "neutral";
            await write({ type: "emotion", emotion });
          } else {
            continue;
          }
        }
        if (buffer) {
          const clean = sanitizeFourthWall(stripTags(buffer));
          fullText += clean;
          await write({ type: "token", text: clean });
          buffer = "";
        }
      }
      if (emotion === null) {
        const [e, rest] = stripEmotion(buffer);
        emotion = e;
        await write({ type: "emotion", emotion });
        if (rest) {
          fullText += rest;
          await write({ type: "token", text: rest });
        }
      }
    } catch (exc) {
      const name = exc instanceof Error ? exc.constructor.name : "Error";
      await write({
        type: "error",
        message:
          `応答の生成に失敗しました (${name})。` +
          "LLM_API_KEY の設定とネットワーク接続を確認してください。",
      });
      await writer.close();
      return;
    }

    fullText = fullText.trim();
    if (fullText) {
      await store.addMessage(uid, "assistant", fullText, emotion);
      await addResearchEvent(store, uid, condition, "assistant_done", {
        emotion: emotion ?? "neutral",
        response: messageMetrics(fullText),
      });
    }
    const state = await statePayload(store, env, uid);
    await write({ type: "done", ...state });
    await writer.close();

    // --- 応答後のバックグラウンド処理 ---
    if (shouldExtract) await extractFacts(env, store, uid);
    await summarizeOldHistory(env, store, uid);
  })();

  execCtx.waitUntil(work);
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

/** 直近の会話からユーザー本人の事実を抽出して保存する。 */
async function extractFacts(env: Env, store: Store, userId: string): Promise<void> {
  const msgs = await store.recentMessages(userId, FACT_EXTRACTION_INTERVAL * 2);
  const conversation = msgs
    .map((m) => `${m.role === "user" ? "ユーザー" : "シロ"}: ${m.content}`)
    .join("\n");
  let result: string;
  try {
    result = await complete(env, factExtractionPrompt(conversation));
  } catch {
    return;
  }
  for (const raw of result.split("\n")) {
    const line = raw.trim().replace(/^[-・*0-9.\s]+/, "").trim();
    if (line && line !== "なし" && line.length < 120) {
      await store.addFact(userId, line);
    }
  }
}

/** 逐語の窓から溢れた古い会話を、たまったら要約へ畳み込む。閾値未満なら LLM を呼ばない。 */
async function summarizeOldHistory(env: Env, store: Store, userId: string): Promise<void> {
  const through = await store.getSummaryThroughId(userId);
  const pending = await store.messagesToSummarize(userId, through, HISTORY_WINDOW);
  if (pending.length < SUMMARY_CHUNK) return;
  const conversation = pending
    .map((m) => `${m.role === "user" ? "ユーザー" : "シロ"}: ${m.content}`)
    .join("\n");
  let raw: string;
  try {
    raw = await complete(
      env,
      summaryPrompt((await store.getSummary(userId)) || "(まだ要約はない)", conversation),
    );
  } catch {
    return; // 失敗時は through_id を進めないので次回再試行される
  }
  const [, newSummary] = stripEmotion(raw);
  const trimmed = newSummary.trim();
  if (trimmed) {
    await store.setSummary(userId, trimmed.slice(0, SUMMARY_MAX_CHARS), pending[pending.length - 1].id);
  }
}
