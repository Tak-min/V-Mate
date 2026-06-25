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
    await this.setKv(userId, "conversation_summary", summary);
    await this.setKv(userId, "summary_through_id", String(throughId));
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

  /** 匿名Cookieユーザーのデータをログイン後アカウントへ引き継ぐ。 */
  async reassignUserData(fromUserId: string, toUserId: string): Promise<void> {
    const tables = ["messages", "facts", "diary", "kv"];
    const stmts = tables.map((t) =>
      this.db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id = ?`).bind(toUserId, fromUserId),
    );
    await this.db.batch(stmts);
  }

}
