/** 記憶ストア — D1(SQLite)によるユーザー分離データ層。backend/app/memory.py の移植。
 *
 * すべてのデータは user_id でスコープされる。created_at は JST の ISO 文字列を明示挿入する。
 * テーブル定義は schema.sql を参照(デプロイ前に `wrangler d1 execute` で適用する)。 */

import { jstIso } from "./util";

export interface MessageRow {
  id: number;
  role: string;
  content: string;
  emotion: string | null;
  created_at: string;
}

export class Store {
  constructor(private db: D1Database) {}

  // --- kv ---

  async getKv(userId: string, key: string, def: string | null = null): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM kv WHERE user_id = ? AND key = ?")
      .bind(userId, key)
      .first<{ value: string }>();
    return row ? row.value : def;
  }

  async setKv(userId: string, key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO kv (user_id, key, value) VALUES (?, ?, ?) " +
          "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
      )
      .bind(userId, key, value)
      .run();
  }

  async getAffinity(userId: string): Promise<number> {
    const v = await this.getKv(userId, "affinity", "0");
    return parseInt(v || "0", 10) || 0;
  }

  /**
   * 親密度をSQL側で原子的に加算する。get→setの2段階だと、同一ユーザーからの並行リクエスト
   * (フロントの二重送信や複数タブ/デバイス)で両方が同じ古い値を読んでしまい、片方の加算が
   * 失われるread-modify-writeレースが起きる。INSERT..ON CONFLICT..RETURNINGで1クエリにする。
   */
  async addAffinity(userId: string, delta: number): Promise<number> {
    const row = await this.db
      .prepare(
        "INSERT INTO kv (user_id, key, value) VALUES (?, 'affinity', ?) " +
          "ON CONFLICT(user_id, key) DO UPDATE SET value = CAST(CAST(kv.value AS INTEGER) + ? AS TEXT) " +
          "RETURNING value",
      )
      .bind(userId, String(delta), delta)
      .first<{ value: string }>();
    return parseInt(row?.value ?? "0", 10) || 0;
  }

  // --- messages ---

  async addMessage(userId: string, role: string, content: string, emotion: string | null = null): Promise<void> {
    await this.db
      .prepare("INSERT INTO messages (user_id, role, content, emotion, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, role, content, emotion, jstIso())
      .run();
  }

  /** 直近 limit 件を時系列(古→新)で返す。 */
  async recentMessages(userId: string, limit = 30): Promise<MessageRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, role, content, emotion, created_at FROM messages " +
          "WHERE user_id = ? ORDER BY id DESC LIMIT ?",
      )
      .bind(userId, limit)
      .all<MessageRow>();
    return results.reverse();
  }

  /** 指定 JST 日付("YYYY-MM-DD")の全メッセージを時系列で。 */
  async messagesOn(userId: string, day: string): Promise<{ role: string; content: string }[]> {
    const { results } = await this.db
      .prepare(
        "SELECT role, content FROM messages " +
          "WHERE user_id = ? AND substr(created_at, 1, 10) = ? ORDER BY id",
      )
      .bind(userId, day)
      .all<{ role: string; content: string }>();
    return results;
  }

  async userMessageCount(userId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND role = 'user'")
      .bind(userId)
      .first<{ n: number }>();
    return row ? row.n : 0;
  }

  /** 要約対象 = 直近 keepRecent 件(逐語の窓)より古く、かつ未要約(id > afterId)のもの。 */
  async messagesToSummarize(userId: string, afterId: number, keepRecent: number): Promise<MessageRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, role, content, emotion, created_at FROM messages " +
          "WHERE user_id = ?1 AND id > ?2 AND id < (" +
          "  SELECT MIN(id) FROM (" +
          "    SELECT id FROM messages WHERE user_id = ?1 ORDER BY id DESC LIMIT ?3" +
          "  )" +
          ") ORDER BY id ASC",
      )
      .bind(userId, afterId, keepRecent)
      .all<MessageRow>();
    return results;
  }

  // --- 会話要約 ---

  async getSummary(userId: string): Promise<string> {
    return (await this.getKv(userId, "conversation_summary", "")) || "";
  }

  async getSummaryThroughId(userId: string): Promise<number> {
    const v = await this.getKv(userId, "summary_through_id", "0");
    return parseInt(v || "0", 10) || 0;
  }

  async setSummary(userId: string, summary: string, throughId: number): Promise<void> {
    // 2つのKV更新を1バッチにして原子性を確保する。個別書き込みだとWorkerが途中で
    // 終了した場合にsummary_through_idが古いまま残り、同じメッセージが再要約される。
    const upsertSql =
      "INSERT INTO kv (user_id, key, value) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value";
    await this.db.batch([
      this.db.prepare(upsertSql).bind(userId, "conversation_summary", summary),
      this.db.prepare(upsertSql).bind(userId, "summary_through_id", String(throughId)),
    ]);
  }

  // --- facts ---

  async addFact(userId: string, content: string): Promise<void> {
    const c = content.trim();
    if (!c) return;
    // (user_id, content) の重複は無視
    await this.db
      .prepare("INSERT INTO facts (user_id, content, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(userId, c, jstIso())
      .run();
  }

  async listFacts(userId: string, limit = 20): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT content FROM facts WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .bind(userId, limit)
      .all<{ content: string }>();
    return results.map((r) => r.content);
  }

  // --- diary ---

  async addDiary(userId: string, entryDate: string, content: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO diary (user_id, entry_date, content, created_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(user_id, entry_date) DO UPDATE SET content = excluded.content",
      )
      .bind(userId, entryDate, content, jstIso())
      .run();
  }

  async listDiary(userId: string, limit = 30): Promise<{ entry_date: string; content: string }[]> {
    const { results } = await this.db
      .prepare("SELECT entry_date, content FROM diary WHERE user_id = ? ORDER BY entry_date DESC LIMIT ?")
      .bind(userId, limit)
      .all<{ entry_date: string; content: string }>();
    return results;
  }

  async hasDiary(userId: string, entryDate: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id FROM diary WHERE user_id = ? AND entry_date = ?")
      .bind(userId, entryDate)
      .first<{ id: number }>();
    return row != null;
  }

  /** last_seen を更新し、更新前の値を返す。 */
  async touchLastSeen(userId: string): Promise<string | null> {
    const prev = await this.getKv(userId, "last_seen");
    await this.setKv(userId, "last_seen", jstIso());
    return prev;
  }

  // --- users(認証) ---

  async createUser(userId: string, email: string, passwordHash: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(userId, email, passwordHash, jstIso())
      .run();
  }

  async getUserByEmail(email: string): Promise<{ id: string; email: string; password_hash: string } | null> {
    return await this.db
      .prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
      .bind(email)
      .first<{ id: string; email: string; password_hash: string }>();
  }

  async getUserById(userId: string): Promise<{ id: string; email: string } | null> {
    return await this.db
      .prepare("SELECT id, email FROM users WHERE id = ?")
      .bind(userId)
      .first<{ id: string; email: string }>();
  }

  async getIdentity(provider: string, externalId: string): Promise<{ user_id: string } | null> {
    return await this.db
      .prepare("SELECT user_id FROM identities WHERE provider = ? AND external_id = ?")
      .bind(provider, externalId)
      .first<{ user_id: string }>();
  }

  async createAppleUser(userId: string, externalId: string, email: string | null): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, NULL, ?)")
        .bind(userId, email, jstIso()),
      this.db
        .prepare("INSERT INTO identities (provider, external_id, user_id, email, created_at) VALUES ('apple', ?, ?, ?, ?)")
        .bind(externalId, userId, email, jstIso()),
    ]);
  }

  async deleteAccount(userId: string): Promise<void> {
    const tables = ["messages", "facts", "diary", "kv", "user_age", "reports", "entitlements", "purchases", "identities", "users"];
    await this.db.batch(tables.map((table) => this.db.prepare(`DELETE FROM ${table} WHERE ${table === "users" ? "id" : "user_id"} = ?`).bind(userId)));
  }

  async getActiveEntitlements(userId: string, now = jstIso()): Promise<Array<{ entitlement_key: string; expires_at: string | null }>> {
    const { results } = await this.db
      .prepare("SELECT entitlement_key, expires_at FROM entitlements WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)")
      .bind(userId, now)
      .all<{ entitlement_key: string; expires_at: string | null }>();
    return results;
  }

  async isEntitled(userId: string, entitlementKey: string, now = jstIso()): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS ok FROM entitlements WHERE user_id = ? AND entitlement_key = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)")
      .bind(userId, entitlementKey, now)
      .first<{ ok: number }>();
    return row?.ok === 1;
  }

  /** P4 の検証器のみが呼ぶ内部 API。古い通知による状態巻き戻しを拒否する。 */
  async upsertEntitlement(userId: string, key: string, status: string, source: string, expiresAt: string | null, updatedAt: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO entitlements (user_id, entitlement_key, status, source, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(user_id, entitlement_key) DO UPDATE SET status = excluded.status, source = excluded.source, expires_at = excluded.expires_at, updated_at = excluded.updated_at WHERE excluded.updated_at >= entitlements.updated_at",
      )
      .bind(userId, key, status, source, expiresAt, updatedAt)
      .run();
  }

  async recordPurchaseIfAbsent(input: {
    userId: string; provider: string; externalId: string; originalExternalId?: string | null; productId: string;
    kind: string; status: string; occurredAt: string; expiresAt?: string | null;
  }): Promise<void> {
    await this.db
      .prepare("INSERT INTO purchases (user_id, provider, external_id, original_external_id, product_id, kind, status, occurred_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, external_id) DO NOTHING")
      .bind(input.userId, input.provider, input.externalId, input.originalExternalId ?? null, input.productId, input.kind, input.status, input.occurredAt, input.expiresAt ?? null, jstIso())
      .run();
  }

  /** (scope, day) のカウンタを +1 して新しい値を返す(レート制限用)。 */
  async bumpUsage(scope: string, day: string): Promise<number> {
    const row = await this.db
      .prepare(
        "INSERT INTO usage (scope, day, count) VALUES (?, ?, 1) " +
          "ON CONFLICT(scope, day) DO UPDATE SET count = count + 1 RETURNING count",
      )
      .bind(scope, day)
      .first<{ count: number }>();
    return row ? row.count : 1;
  }

  /** 個人を紐付けない日次の積み上げ指標。計測不能でもプロダクト本線は止めない呼出側で使う。 */
  async recordDailyMetric(
    day: string,
    metric: string,
    dimension: string,
    elapsedMs = 0,
    bytes = 0,
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO daily_metrics (day, metric, dimension, count, total_ms, total_bytes) VALUES (?, ?, ?, 1, ?, ?) " +
          "ON CONFLICT(day, metric, dimension) DO UPDATE SET count = count + 1, " +
          "total_ms = total_ms + excluded.total_ms, total_bytes = total_bytes + excluded.total_bytes",
      )
      .bind(day, metric, dimension, Math.max(0, Math.round(elapsedMs)), Math.max(0, Math.round(bytes)))
      .run();
  }

  /** 匿名Cookieユーザーのデータをログイン後アカウントへ引き継ぐ。 */
  async reassignUserData(fromUserId: string, toUserId: string): Promise<void> {
    // entitlements/purchases は匿名uidでは作られない(購入は認証必須のため)。
    // それでも deleteAccount のテーブル網羅と一貫させ、将来の経路変更に備えて含める(防御的)。
    const tables = ["messages", "facts", "diary", "kv", "user_age", "entitlements", "purchases"];
    const stmts = tables.map((t) =>
      this.db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id = ?`).bind(toUserId, fromUserId),
    );
    await this.db.batch(stmts);
  }

  // --- 年齢ゲート ---

  async getUserAge(
    userId: string,
  ): Promise<{ birth_date: string; age_band: string; method: string; updated_at: string } | null> {
    return await this.db
      .prepare("SELECT birth_date, age_band, method, updated_at FROM user_age WHERE user_id = ?")
      .bind(userId)
      .first<{ birth_date: string; age_band: string; method: string; updated_at: string }>();
  }

  async setUserAge(userId: string, birthDate: string, ageBand: string, method: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO user_age (user_id, birth_date, age_band, method, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET birth_date = excluded.birth_date, age_band = excluded.age_band, " +
          "method = excluded.method, updated_at = excluded.updated_at",
      )
      .bind(userId, birthDate, ageBand, method, jstIso())
      .run();
  }

  // --- 通報(Apple 1.2 UGC対応) ---

  async createReport(userId: string, messageId: number | null, reason: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO reports (user_id, message_id, reason, status, created_at) VALUES (?, ?, ?, 'open', ?)")
      .bind(userId, messageId, reason, jstIso())
      .run();
  }

  // --- lorebook (OSS Phase B-B) ---

  /**
   * 直近メッセージと現在のユーザー入力からキーワードにマッチする Lorebook エントリを取得し、
   * system prompt に挿入する文字列として返す。マッチがなければ空文字。
   * user_id = 'global' のエントリはシロ共通設定として常に検索対象に含まれる。
   */
  async gatherLorebook(userId: string, message: string, recentMessages: MessageRow[]): Promise<string> {
    try {
      const { results } = await this.db
        .prepare("SELECT keyword, description FROM lorebook WHERE user_id = ?1 OR user_id = 'global'")
        .bind(userId)
        .all<{ keyword: string; description: string }>();
      if (results.length === 0) return "";
      const allText = recentMessages.map((m) => m.content).join(" ") + " " + message;
      const matched = results.filter((e) => allText.includes(e.keyword));
      if (matched.length === 0) return "";
      return "Lore:\n" + matched.map((e) => `${e.keyword}: ${e.description}`).join("\n");
    } catch {
      // lorebook テーブルが未作成(schema_v2.sql 未適用)の場合は空文字を返してグレースフルに続行する
      return "";
    }
  }

  // --- RAG FTS5 (OSS Phase B-A) ---

  /**
   * FTS5 全文検索で過去メッセージを検索し、上位3件を返す。
   * excludeRecent 件の直近メッセージは除外する(HISTORY_WINDOW との重複を避ける)。
   */
  async searchSimilarMessages(userId: string, query: string, excludeRecent = 24): Promise<MessageRow[]> {
    // FTS5 の MATCH クエリ中の特殊文字をエスケープ
    const escaped = query.replace(/['"*^()]/g, " ").trim();
    if (!escaped) return [];
    try {
      const { results } = await this.db
        .prepare(
          "SELECT m.id, m.role, m.content, m.emotion, m.created_at " +
            "FROM messages m JOIN messages_fts f ON m.id = f.rowid " +
            "WHERE m.user_id = ?1 AND f.content MATCH ?2 " +
            "AND m.id < COALESCE((" +
            "  SELECT MIN(id) FROM (" +
            "    SELECT id FROM messages WHERE user_id = ?1 ORDER BY id DESC LIMIT ?3" +
            "  )" +
            "), 0) " +
            "ORDER BY rank LIMIT 3",
        )
        .bind(userId, escaped, excludeRecent)
        .all<MessageRow>();
      return results;
    } catch {
      return [];
    }
  }

}
