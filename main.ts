// main.ts
import {
  load,
  create,
  verify,
  getNumericDate,
  OpenAPIHono,
  createRoute,
  z,
  swaggerUI,
  cors,
} from "./deps.ts";
import "https://deno.land/x/dotenv@v3.2.2/load.ts";

// Load .env locally (safe no-op in most hosted envs)
await load({ export: true }).catch(() => {});

const PORT = parseInt(Deno.env.get("PORT") ?? "8787", 10);

// ---- Postmark / App settings ----
const POSTMARK_SERVER_TOKEN = mustEnv("POSTMARK_SERVER_TOKEN");
const POSTMARK_FROM_EMAIL = mustEnv("POSTMARK_FROM_EMAIL"); // e.g. "CoachStack <noreply@yourdomain.com>"
const APP_NAME = Deno.env.get("APP_NAME") ?? "coachstack";

const MAGIC_LINK_SCHEME = Deno.env.get("MAGIC_LINK_SCHEME") ?? "coachstack";
const MAGIC_LINK_FALLBACK_BASE_URL = mustEnv("MAGIC_LINK_FALLBACK_BASE_URL"); // e.g. http://localhost:8787 or https://api.yourdomain.com

// ---- JWT settings ----
const JWT_ISSUER = Deno.env.get("JWT_ISSUER") ?? "coachstack-gateway";
const JWT_AUDIENCE = Deno.env.get("JWT_AUDIENCE") ?? "coachstack-mobile";
const JWT_SECRET = mustEnv("JWT_SECRET"); // long random string

// ---- Base44 settings ----
const BASE44_APP_ID = mustEnv("BASE44_APP_ID");
const BASE44_API_KEY = mustEnv("BASE44_API_KEY");

const BASE44_CLIENT_ENTITY = Deno.env.get("BASE44_CLIENT_ENTITY") ?? "Client";
const BASE44_PROGRESS_ENTITY = Deno.env.get("BASE44_PROGRESS_ENTITY") ?? "ProgressLog";
const BASE44_DAILY_ENTITY = Deno.env.get("BASE44_DAILY_ENTITY") ?? "DailyCheckIn";
const BASE44_SESSION_ENTITY = Deno.env.get("BASE44_SESSION_ENTITY") ?? "Session";
const BASE44_PROGRAM_ENTITY = Deno.env.get("BASE44_PROGRAM_ENTITY") ?? "Program";
const BASE44_EXERCISE_ENTITY = Deno.env.get("BASE44_EXERCISE_ENTITY") ?? "Exercise";

// ---- KV storage ----
const kv = await Deno.openKv();

// ---- Types ----
type StartAuthBody = { email?: string };
type VerifyAuthBody = { token?: string };

type StoredMagicToken = {
  token: string;
  email: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
  ip?: string;
  ua?: string;
};

type StoredUser = {
  userId: string; // internal user id
  email: string;
  createdAt: number;
};

// Base44 upserts
type ProgressLogInput = {
  log_date: string; // YYYY-MM-DD
  weight?: number | null;
  body_fat_percentage?: number | null;
  measurements?: Record<string, number | null> | null;
  photo_url?: string | null;
  notes?: string | null;
};

type DailyCheckInInput = {
  log_date: string; // YYYY-MM-DD
  mood?: number | null; // 1-10
  sleep_hours?: number | null;
  stress?: number | null; // 1-10
  soreness?: number | null; // 1-10
  energy?: number | null; // 1-10
  notes?: string | null;

  idempotency_key?: string | null;
  device_id?: string | null;
  source?: string | null;
  updated_at?: string | null; // ISO
};

type SessionSetInput = {
  weight?: number | null;
  reps?: number | null;
  completed?: boolean | null;
};

type SessionExerciseLogInput = {
  exercise_id?: string | null;
  exercise_name?: string | null;
  sets?: SessionSetInput[] | null;
  notes?: string | null;
  client_feedback?: "easy" | "moderate" | "hard" | "failed" | null;
};

type SessionCardioLogInput = {
  type?: string | null;
  duration_minutes?: number | null;
  distance?: number | null;
  notes?: string | null;
};

type SessionInput = {
  id?: string | null;
  client_id?: string | null;
  client_name?: string | null;
  trainer_email?: string | null;
  program_id?: string | null;
  program_name?: string | null;
  scheduled_date?: string | null; // ISO date-time
  status?: "scheduled" | "in_progress" | "completed" | "cancelled" | null;
  duration_minutes?: number | null;
  session_notes?: string | null;
  exercise_logs?: SessionExerciseLogInput[] | null;
  cardio_logs?: SessionCardioLogInput[] | null;
};

type ProgramScheduleItem = {
  exercise_id?: string | null;
  exercise_name?: string | null;
  sets?: number | null;
  target_reps?: string | null;
  weight?: number | null;
  rest_seconds?: number | null;
  notes?: string | null;
};

// ---- Helpers ----
function mustEnv(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function nowMs() {
  return Date.now();
}

function minutesFromNowMs(min: number) {
  return nowMs() + min * 60_000;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization, x-dev-token-secret",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
  });
}

function ok(data: unknown) {
  return json(200, data);
}

function badRequest(message: string) {
  return json(400, { error: message });
}

function unauthorized(message = "Unauthorized") {
  return json(401, { error: message });
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Basic rate limit per IP + endpoint (KV-based)
async function rateLimitOrThrow(ip: string, key: string, limit: number, windowMs: number) {
  const bucketKey = ["ratelimit", key, ip, Math.floor(nowMs() / windowMs)];
  const current = (await kv.get<number>(bucketKey)).value ?? 0;
  if (current >= limit) throw new Error("Rate limit exceeded. Please try again shortly.");
  await kv.set(bucketKey, current + 1, { expireIn: windowMs * 2 });
}

function assertYYYYMMDD(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Date must be YYYY-MM-DD");
  }
}

function assertDateTime(dateTime: string) {
  if (!dateTime || Number.isNaN(Date.parse(dateTime))) {
    throw new Error("scheduled_date must be a valid date-time");
  }
}

function isoDateOnly(d: Date) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function daysAgoIso(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDateOnly(d);
}

function toTime(dateStr: string) {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  return Number.isNaN(t) ? 0 : t;
}

function toAnyTime(dateTimeStr: string) {
  const t = Date.parse(dateTimeStr);
  return Number.isNaN(t) ? 0 : t;
}

function lastNDaysByDateField(items: any[], dateField: string, days: number) {
  const from = daysAgoIso(days - 1); // include today as day 0
  const fromT = toTime(from);

  return items
    .filter((r) => typeof r?.[dateField] === "string" && toTime(r[dateField]) >= fromT)
    .sort((a, b) => toTime(a[dateField]) - toTime(b[dateField])); // ascending for charts
}

function lastNDaysByDateTimeField(items: any[], dateField: string, days: number) {
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  from.setHours(0, 0, 0, 0);
  const fromT = from.getTime();

  return items
    .filter((r) => typeof r?.[dateField] === "string" && toAnyTime(r[dateField]) >= fromT)
    .sort((a, b) => toAnyTime(a[dateField]) - toAnyTime(b[dateField]));
}

function nextNDaysByDateTimeField(items: any[], dateField: string, days: number) {
  const nowT = Date.now();
  const toT = nowT + (days * 24 * 60 * 60 * 1000);

  return items
    .filter((r) => {
      if (typeof r?.[dateField] !== "string") return false;
      const t = toAnyTime(r[dateField]);
      return t >= nowT && t <= toT;
    })
    .sort((a, b) => toAnyTime(a[dateField]) - toAnyTime(b[dateField]));
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : null;
}

function asNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "number" ? value : null;
}

function asNullableBoolean(value: unknown) {
  if (value === null || value === undefined) return null;
  return typeof value === "boolean" ? value : null;
}

function isCardioFromTargetReps(targetReps: string | null | undefined) {
  const t = (targetReps ?? "").toLowerCase();
  return t.includes("minute") || t.includes("min");
}

function parseDurationMinutes(targetReps: string | null | undefined) {
  if (!targetReps) return null;
  const m = targetReps.match(/(\d+(\.\d+)?)\s*(minute|min)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function isoDayKey(dateTime: string): string {
  const d = new Date(dateTime);
  const day = d.getUTCDay();
  const keys = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return keys[day] ?? "monday";
}

function normalizeProgramScheduleItem(item: any): ProgramScheduleItem {
  return {
    exercise_id: asNullableString(item?.exercise_id),
    exercise_name: asNullableString(item?.exercise_name),
    sets: asNullableNumber(item?.sets),
    target_reps: asNullableString(item?.target_reps),
    weight: asNullableNumber(item?.weight),
    rest_seconds: asNullableNumber(item?.rest_seconds),
    notes: asNullableString(item?.notes),
  };
}

async function buildLogsFromProgramDay(scheduleItems: ProgramScheduleItem[]) {
  const exerciseLogs: SessionExerciseLogInput[] = [];
  const cardioLogs: SessionCardioLogInput[] = [];
  const exerciseCategoryCache = new Map<string, string>();

  for (const row of scheduleItems) {
    const exerciseId = row.exercise_id ?? "";
    let isCardio = isCardioFromTargetReps(row.target_reps);

    if (exerciseId) {
      if (!exerciseCategoryCache.has(exerciseId)) {
        const ex = await base44FindOne(BASE44_EXERCISE_ENTITY, { id: exerciseId });
        exerciseCategoryCache.set(exerciseId, asString(ex?.category).toLowerCase());
      }
      const category = exerciseCategoryCache.get(exerciseId) ?? "";
      if (category === "cardio") isCardio = true;
    }

    if (isCardio) {
      cardioLogs.push({
        type: row.exercise_name ?? "",
        duration_minutes: parseDurationMinutes(row.target_reps),
        distance: null,
        notes: row.notes ?? null,
      });
      continue;
    }

    const setCount = Math.max(0, Math.floor(row.sets ?? 0));
    const sets = Array.from({ length: setCount }, () => ({
      weight: row.weight ?? null,
      reps: null,
      completed: false,
    }));

    const notesParts = [row.notes];
    if (row.target_reps) notesParts.push(`Target reps: ${row.target_reps}`);
    if (row.rest_seconds !== null && row.rest_seconds !== undefined) notesParts.push(`Rest: ${row.rest_seconds}s`);

    exerciseLogs.push({
      exercise_id: row.exercise_id ?? "",
      exercise_name: row.exercise_name ?? "",
      sets,
      notes: notesParts.filter(Boolean).join(" | ") || null,
      client_feedback: null,
    });
  }

  return { exercise_logs: exerciseLogs, cardio_logs: cardioLogs };
}

async function resolveProgramDayLogs(
  clientId: string,
  programName: string,
  scheduledDate: string,
  cache: Map<string, any>,
) {
  const cacheKey = `${clientId}:${programName}`;
  let program = cache.get(cacheKey);
  if (!program) {
    program = await base44FindOne(BASE44_PROGRAM_ENTITY, { name: programName, client_id: clientId });
    if (!program) {
      program = await base44FindOne(BASE44_PROGRAM_ENTITY, { name: programName });
    }
    cache.set(cacheKey, program ?? null);
  }
  if (!program) return null;

  const dayKey = isoDayKey(scheduledDate);
  const weeklySchedule = (program as any)?.weekly_schedule ?? {};
  const rawDayRows = Array.isArray(weeklySchedule?.[dayKey]) ? weeklySchedule[dayKey] : [];
  const dayRows = rawDayRows.map((r: any) => normalizeProgramScheduleItem(r));

  return await buildLogsFromProgramDay(dayRows);
}

function normalizeSessionPayload(input: SessionInput, client: any) {
  const scheduledDate = asString(input.scheduled_date);
  if (!scheduledDate) throw new Error("scheduled_date is required");
  assertDateTime(scheduledDate);

  const allowedStatuses = new Set(["scheduled", "in_progress", "completed", "cancelled"]);
  const rawStatus = asString(input.status ?? "scheduled");
  const status = rawStatus || "scheduled";
  if (!allowedStatuses.has(status)) {
    throw new Error("status must be one of: scheduled, in_progress, completed, cancelled");
  }

  const allowedFeedback = new Set(["easy", "moderate", "hard", "failed"]);
  const rawExerciseLogs = Array.isArray(input.exercise_logs) ? input.exercise_logs : [];
  const exerciseLogs = rawExerciseLogs.map((log) => {
    const rawSets = Array.isArray(log?.sets) ? log.sets : [];
    const sets = rawSets.map((set) => ({
      weight: asNullableNumber(set?.weight),
      reps: asNullableNumber(set?.reps),
      completed: asNullableBoolean(set?.completed),
    }));

    const feedback = asNullableString(log?.client_feedback);
    if (feedback && !allowedFeedback.has(feedback)) {
      throw new Error("client_feedback must be one of: easy, moderate, hard, failed");
    }

    return {
      exercise_id: asString(log?.exercise_id),
      exercise_name: asString(log?.exercise_name),
      sets,
      notes: asNullableString(log?.notes),
      client_feedback: feedback,
    };
  });

  const rawCardioLogs = Array.isArray(input.cardio_logs) ? input.cardio_logs : [];
  const cardioLogs = rawCardioLogs.map((log) => ({
    type: asString(log?.type),
    duration_minutes: asNullableNumber(log?.duration_minutes),
    distance: asNullableNumber(log?.distance),
    notes: asNullableString(log?.notes),
  }));

  return {
    client_id: client.id,
    client_name: asString(input.client_name) || asString(client.name),
    trainer_email: asNullableString(input.trainer_email),
    program_id: asString(input.program_id),
    program_name: asString(input.program_name),
    scheduled_date: scheduledDate,
    status,
    duration_minutes: asNullableNumber(input.duration_minutes),
    session_notes: asNullableString(input.session_notes),
    exercise_logs: exerciseLogs,
    cardio_logs: cardioLogs,
  };
}

// ---- KV keys ----
function magicTokenKey(token: string) {
  return ["magic_token", token];
}
function userByEmailKey(email: string) {
  return ["user_by_email", email];
}
function userByIdKey(userId: string) {
  return ["user_by_id", userId];
}

// ---- Auth + Email ----
async function sendMagicLinkEmail(email: string, token: string) {
  const deepLink = `${MAGIC_LINK_SCHEME}://auth?token=${encodeURIComponent(token)}`;
  const fallback =
    `${MAGIC_LINK_FALLBACK_BASE_URL.replace(/\/$/, "")}/auth/callback?token=${encodeURIComponent(token)}`;

  const subject = `${APP_NAME} login link`;
  const textBody =
    `Use this link to sign in to ${APP_NAME}:

Open in the app:
${deepLink}

Or open in your browser:
${fallback}

This link expires in 15 minutes. If you didn’t request this, you can ignore this email.`;

  const htmlBody = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111827; line-height: 1.5;">
    <h2 style="margin: 0 0 12px 0;">${APP_NAME} sign-in link</h2>
    <p style="margin: 0 0 12px 0;">Use the button below to open the app and finish signing in.</p>
    <p style="margin: 0 0 16px 0;">
      <a href="${deepLink}" style="display:inline-block;padding:12px 16px;border-radius:10px;text-decoration:none;background:#111827;color:#ffffff;">
        Open ${APP_NAME}
      </a>
    </p>
    <p style="margin: 0 0 8px 0;">If that does not work, open in browser:</p>
    <p style="margin: 0 0 12px 0;">
      <a href="${fallback}">${fallback}</a>
    </p>
    <p style="margin: 0;color:#6b7280;">This link expires in 15 minutes. If you didn’t request this, you can ignore this email.</p>
  </body>
</html>`;

  const payload = {
    From: POSTMARK_FROM_EMAIL,
    To: email,
    Subject: subject,
    TextBody: textBody,
    HtmlBody: htmlBody,
    MessageStream: "outbound",
  };

  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Postmark send failed (${res.status}): ${body}`);
  }
}

async function getOrCreateUserByEmail(email: string): Promise<StoredUser> {
  const existing = (await kv.get<StoredUser>(userByEmailKey(email))).value;
  if (existing) return existing;

  const user: StoredUser = {
    userId: `u_${crypto.randomUUID()}`,
    email,
    createdAt: nowMs(),
  };

  const atomic = kv.atomic();
  atomic.set(userByEmailKey(email), user);
  atomic.set(userByIdKey(user.userId), user);

  const res = await atomic.commit();
  if (!res.ok) throw new Error("Failed to create user");
  return user;
}

async function mintJwt(user: StoredUser) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  const payload = {
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    sub: user.userId,
    email: user.email,
    exp: getNumericDate(60 * 60 * 24), // 24h
    iat: getNumericDate(0),
  };

  return await create({ alg: "HS256", typ: "JWT" }, payload, key);
}

async function verifyJwt(authHeader: string | null): Promise<{ userId: string; email: string }> {
  if (!authHeader?.startsWith("Bearer ")) throw new Error("Missing bearer token");
  const token = authHeader.slice("Bearer ".length);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const payload = await verify(token, key);
  const userId = String(payload.sub ?? "");
  const email = String((payload as any).email ?? "");
  if (!userId || !email) throw new Error("Invalid token");
  return { userId, email };
}

// ---- Base44 helpers ----
function base44BaseUrl() {
  return `https://app.base44.com/api/apps/${BASE44_APP_ID}/entities`;
}

async function base44Fetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base44BaseUrl()}${path}`, {
    ...init,
    headers: {
      "api_key": BASE44_API_KEY,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Base44 API error ${res.status}: ${text}`);
  return text ? safeJsonParse(text) : null;
}

async function base44FindOne(entity: string, query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  const rows = await base44Fetch(`/${encodeURIComponent(entity)}?${qs}`, { method: "GET" });

  if (Array.isArray(rows) && rows.length > 0) return rows[0];
  if (rows && Array.isArray((rows as any).data) && (rows as any).data.length > 0) return (rows as any).data[0];
  return null;
}

async function base44List(entity: string, query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  const rows = await base44Fetch(`/${encodeURIComponent(entity)}?${qs}`, { method: "GET" });

  if (Array.isArray(rows)) return rows;
  if (rows && Array.isArray((rows as any).data)) return (rows as any).data;
  return [];
}

async function base44Create(entity: string, body: unknown) {
  return await base44Fetch(`/${encodeURIComponent(entity)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function base44Update(entity: string, id: string, body: unknown) {
  return await base44Fetch(`/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// Resolve client by auth user email (Client.user_email)
async function getClientForUserEmail(userEmail: string) {
  const email = normalizeEmail(userEmail);
  const client = await base44FindOne(BASE44_CLIENT_ENTITY, { user_email: email });
  if (!client?.id) {
    throw new Error(`No Client found for user_email=${email}. Create/link the Client record first.`);
  }
  return client;
}

// ONE per day upsert: ProgressLog by (client_id, log_date)
async function upsertProgressLog(client: any, input: ProgressLogInput) {
  assertYYYYMMDD(input.log_date);

  const existing = await base44FindOne(BASE44_PROGRESS_ENTITY, {
    client_id: client.id,
    log_date: input.log_date,
  });

  const payload = {
    client_id: client.id,
    client_name: client.name ?? client.client_name ?? "",
    log_date: input.log_date,
    weight: input.weight ?? null,
    body_fat_percentage: input.body_fat_percentage ?? null,
    measurements: input.measurements ?? null,
    photo_url: input.photo_url ?? null,
    notes: input.notes ?? null,
  };

  if (existing?.id) return await base44Update(BASE44_PROGRESS_ENTITY, existing.id, payload);
  return await base44Create(BASE44_PROGRESS_ENTITY, payload);
}

// ONE per day upsert: DailyCheckIn by (client_id, log_date)
async function upsertDailyCheckIn(client: any, userEmail: string, input: DailyCheckInInput) {
  assertYYYYMMDD(input.log_date);

  const existing = await base44FindOne(BASE44_DAILY_ENTITY, {
    client_id: client.id,
    log_date: input.log_date,
  });

  const payload = {
    client_id: client.id,
    client_name: client.name ?? "",
    user_email: normalizeEmail(userEmail),

    log_date: input.log_date,
    mood: input.mood ?? null,
    sleep_hours: input.sleep_hours ?? null,
    stress: input.stress ?? null,
    soreness: input.soreness ?? null,
    energy: input.energy ?? null,
    notes: input.notes ?? null,

    idempotency_key: input.idempotency_key ?? null,
    device_id: input.device_id ?? null,
    source: input.source ?? null,
    updated_at: input.updated_at ?? new Date().toISOString(),
  };

  if (existing?.id) return await base44Update(BASE44_DAILY_ENTITY, existing.id, payload);
  return await base44Create(BASE44_DAILY_ENTITY, payload);
}

async function upsertSession(client: any, input: SessionInput) {
  const payload = normalizeSessionPayload(input, client);
  const sessionId = asNullableString(input.id);

  if (sessionId) {
    return await base44Update(BASE44_SESSION_ENTITY, sessionId, payload);
  }
  return await base44Create(BASE44_SESSION_ENTITY, payload);
}

async function syncSessionsForClient(client: any, items: SessionInput[]) {
  const results: any[] = [];
  const programCache = new Map<string, any>();

  for (const item of items) {
    const input = { ...item };
    const programName = asString(input.program_name);
    const scheduledDate = asString(input.scheduled_date);
    if (programName && scheduledDate) {
      const resolved = await resolveProgramDayLogs(client.id, programName, scheduledDate, programCache);
      if (resolved) {
        input.exercise_logs = resolved.exercise_logs;
        input.cardio_logs = resolved.cardio_logs;
      }
    }

    const r = await upsertSession(client, input);
    results.push({ ok: true, result: r });
  }

  return results;
}

async function buildDashboard(client: any, userEmail: string, days: number) {
  const today = isoDateOnly(new Date());

  const [dailyRows, progressRows] = await Promise.all([
    base44List(BASE44_DAILY_ENTITY, { client_id: client.id }),
    base44List(BASE44_PROGRESS_ENTITY, { client_id: client.id }),
  ]);

  const dailyRecent = lastNDaysByDateField(dailyRows, "log_date", days);
  const progressRecent = lastNDaysByDateField(progressRows, "log_date", days);

  // One per day, so find is OK
  const dailyToday = dailyRows.find((r: any) => r?.log_date === today) ?? null;
  const progressToday = progressRows.find((r: any) => r?.log_date === today) ?? null;

  return {
    ok: true,
    days,
    today,
    email: normalizeEmail(userEmail),
    client: {
      id: client.id,
      name: client.name ?? null,
      user_email: client.user_email ?? null,
    },
    today_data: {
      daily_checkin: dailyToday,
      progress_log: progressToday,
    },
    last_n_days: {
      daily_checkins: dailyRecent,
      progress_logs: progressRecent,
    },
  };
}

// ---- OpenAPI (Hono) ----
const ErrorSchema = z.object({
  error: z.string(),
});

const HealthResponseSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
});

const StartAuthBodySchema = z.object({
  email: z.string().email(),
});

const VerifyAuthBodySchema = z.object({
  token: z.string().min(1),
});

const VerifyAuthResponseSchema = z.object({
  access_token: z.string(),
  user: z.object({
    user_id: z.string(),
    email: z.string(),
  }),
});

const SessionSyncItemSchema = z.object({
  id: z.string().optional(),
  client_id: z.string().optional(),
  client_name: z.string().optional(),
  trainer_email: z.string().optional().nullable(),
  program_id: z.string().optional(),
  program_name: z.string().optional(),
  scheduled_date: z.string(),
  status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]).optional(),
  duration_minutes: z.number().optional().nullable(),
  session_notes: z.string().optional().nullable(),
  exercise_logs: z.array(z.any()).optional(),
  cardio_logs: z.array(z.any()).optional(),
}).passthrough();

const SessionSyncBodySchema = z.object({
  items: z.array(SessionSyncItemSchema),
});

const SessionSyncResponseSchema = z.object({
  ok: z.literal(true),
  sync_results: z.array(z.any()),
});

function buildOpenApiApp() {
  const app = new OpenAPIHono();

  app.use("*", cors({
    origin: "*",
    allowHeaders: ["content-type", "authorization", "x-dev-token-secret"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }));

  app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: {
      title: "FitFlow Backend API",
      version: "1.0.0",
    },
  });

  app.get("/docs", swaggerUI({ url: "/openapi.json" }));

  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("Missing bearer token") ||
      message.includes("Invalid token") ||
      message.includes("The token") ||
      message.toLowerCase().includes("jwt")
    ) {
      return c.json({ error: message }, 401);
    }
    return c.json({ error: message }, 500);
  });

  const healthRoute = createRoute({
    method: "get",
    path: "/health",
    summary: "Health check",
    responses: {
      200: {
        description: "Service health",
        content: {
          "application/json": { schema: HealthResponseSchema },
        },
      },
    },
  });

  app.openapi(healthRoute, (c) => {
    return c.json({ ok: true, ts: new Date().toISOString() }, 200);
  });

  const authStartRoute = createRoute({
    method: "post",
    path: "/auth/start",
    summary: "Send magic link",
    request: {
      body: {
        required: true,
        content: {
          "application/json": { schema: StartAuthBodySchema },
        },
      },
    },
    responses: {
      200: {
        description: "Magic link sent",
        content: {
          "application/json": { schema: z.object({ ok: z.literal(true) }) },
        },
      },
      400: {
        description: "Invalid request",
        content: {
          "application/json": { schema: ErrorSchema },
        },
      },
    },
  });

  app.openapi(authStartRoute, async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      ?? c.req.header("cf-connecting-ip")
      ?? "unknown";
    const ua = c.req.header("user-agent") ?? "unknown";
    await rateLimitOrThrow(ip, "auth_start", 5, 60_000);

    const body = c.req.valid("json");
    const email = normalizeEmail(body.email);
    if (!email || !isValidEmail(email)) return c.json({ error: "Valid email is required" }, 400);

    const token = `ml_${crypto.randomUUID()}`;
    const record: StoredMagicToken = {
      token,
      email,
      createdAt: nowMs(),
      expiresAt: minutesFromNowMs(15),
      ip,
      ua,
    };

    await kv.set(magicTokenKey(token), record, { expireIn: 15 * 60_000 });
    await sendMagicLinkEmail(email, token);
    return c.json({ ok: true }, 200);
  });

  const authVerifyRoute = createRoute({
    method: "post",
    path: "/auth/verify",
    summary: "Exchange magic token for JWT",
    request: {
      body: {
        required: true,
        content: {
          "application/json": { schema: VerifyAuthBodySchema },
        },
      },
    },
    responses: {
      200: {
        description: "JWT response",
        content: {
          "application/json": { schema: VerifyAuthResponseSchema },
        },
      },
      400: {
        description: "Invalid request",
        content: {
          "application/json": { schema: ErrorSchema },
        },
      },
    },
  });

  app.openapi(authVerifyRoute, async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimitOrThrow(ip, "auth_verify", 20, 60_000);

    const body = c.req.valid("json");
    const token = body.token;
    if (!token.startsWith("ml_")) return c.json({ error: "Invalid token" }, 400);

    const stored = (await kv.get<StoredMagicToken>(magicTokenKey(token))).value;
    if (!stored) return c.json({ error: "Token not found or expired" }, 400);
    if (stored.usedAt) return c.json({ error: "Token already used" }, 400);
    if (stored.expiresAt < nowMs()) return c.json({ error: "Token expired" }, 400);

    stored.usedAt = nowMs();
    await kv.set(magicTokenKey(token), stored, { expireIn: 5 * 60_000 });

    const user = await getOrCreateUserByEmail(stored.email);
    const access_token = await mintJwt(user);

    return c.json({
      access_token,
      user: {
        user_id: user.userId,
        email: user.email,
      },
    }, 200);
  });

  const sessionSyncRoute = createRoute({
    method: "post",
    path: "/session/sync",
    summary: "Batch sync sessions",
    request: {
      body: {
        required: true,
        content: {
          "application/json": { schema: SessionSyncBodySchema },
        },
      },
    },
    responses: {
      200: {
        description: "Sync results",
        content: {
          "application/json": { schema: SessionSyncResponseSchema },
        },
      },
      401: {
        description: "Unauthorized",
        content: {
          "application/json": { schema: ErrorSchema },
        },
      },
      400: {
        description: "Invalid request",
        content: {
          "application/json": { schema: ErrorSchema },
        },
      },
    },
  });

  app.openapi(sessionSyncRoute, async (c) => {
    const { email } = await verifyJwt(c.req.header("authorization") ?? null);
    const client = await getClientForUserEmail(email);
    const body = c.req.valid("json");
    const results = await syncSessionsForClient(client, body.items as SessionInput[]);
    return c.json({ ok: true as const, sync_results: results }, 200);
  });

  app.get("/auth/callback", (c) => {
    const token = c.req.query("token") ?? "";
    const deepLink = `${MAGIC_LINK_SCHEME}://auth?token=${encodeURIComponent(token)}`;

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_NAME} Login</title>
  </head>
  <body style="font-family: system-ui; padding: 24px;">
    <h2>${APP_NAME} Login</h2>
    <p>Tap below to open the app and finish signing in.</p>
    <p>
      <a href="${deepLink}" style="display:inline-block;padding:12px 16px;border:1px solid #ccc;border-radius:10px;text-decoration:none;">
        Open ${APP_NAME}
      </a>
    </p>
    <p style="color:#666;margin-top:24px;">If you’re on a device without the app installed, install it and request a new link.</p>
  </body>
</html>`;

    return c.html(html, 200);
  });

  app.post("/dev/token", async (c) => {
    const devSecret = Deno.env.get("DEV_TOKEN_SECRET");
    if (!devSecret) return c.json({ error: "Not found" }, 404);

    const headerSecret = c.req.header("x-dev-token-secret") ?? "";
    if (headerSecret !== devSecret) return c.json({ error: "Invalid dev secret" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const email = normalizeEmail(String((body as any).email ?? ""));
    if (!email || !isValidEmail(email)) return c.json({ error: "Valid email is required" }, 400);

    await getClientForUserEmail(email);
    const user = await getOrCreateUserByEmail(email);
    const access_token = await mintJwt(user);
    return c.json({
      access_token,
      user: { user_id: user.userId, email: user.email },
    }, 200);
  });

  app.get("/dashboard", async (c) => {
    const { email } = await verifyJwt(c.req.header("authorization") ?? null);
    const client = await getClientForUserEmail(email);
    const days = Math.min(Math.max(parseInt(c.req.query("days") ?? "14", 10) || 14, 1), 60);
    return c.json(await buildDashboard(client, email, days), 200);
  });

  app.get("/daily-checkin/recent", async (c) => {
    const { email } = await verifyJwt(c.req.header("authorization") ?? null);
    const client = await getClientForUserEmail(email);
    const days = Math.min(Math.max(parseInt(c.req.query("days") ?? "14", 10) || 14, 1), 60);
    const rows = await base44List(BASE44_DAILY_ENTITY, { client_id: client.id });
    const items = lastNDaysByDateField(rows, "log_date", days);
    return c.json({ ok: true, days, client_id: client.id, items }, 200);
  });

  app.get("/progress-log/recent", async (c) => {
    const { email } = await verifyJwt(c.req.header("authorization") ?? null);
    const client = await getClientForUserEmail(email);
    const days = Math.min(Math.max(parseInt(c.req.query("days") ?? "14", 10) || 14, 1), 60);
    const rows = await base44List(BASE44_PROGRESS_ENTITY, { client_id: client.id });
    const items = lastNDaysByDateField(rows, "log_date", days);
    return c.json({ ok: true, days, client_id: client.id, items }, 200);
  });

  app.get("/session/recent", async (c) => {
    const { email } = await verifyJwt(c.req.header("authorization") ?? null);
    const client = await getClientForUserEmail(email);
    const days = Math.min(Math.max(parseInt(c.req.query("days") ?? "14", 10) || 14, 1), 60);
    const rows = await base44List(BASE44_SESSION_ENTITY, { client_id: client.id });
    const items = lastNDaysByDateTimeField(rows, "scheduled_date", days);
    return c.json({ ok: true, days, client_id: client.id, items }, 200);
  });

  app.get("/sessions", async (c) => {
    const { email } = await verifyJwt(c.req.header("authorization") ?? null);
    const client = await getClientForUserEmail(email);
    const days = Math.min(Math.max(parseInt(c.req.query("days") ?? "7", 10) || 7, 1), 60);
    const rows = await base44List(BASE44_SESSION_ENTITY, { client_id: client.id });
    const items = nextNDaysByDateTimeField(rows, "scheduled_date", days);
    return c.json({ ok: true, days, client_id: client.id, items }, 200);
  });

  app.post("/sessions", async (c) => {
    const { email } = await verifyJwt(c.req.header("authorization") ?? null);
    const client = await getClientForUserEmail(email);
    const body = await c.req.json().catch(() => ({}));
    const days = Math.min(Math.max(parseInt(String((body as any).days ?? "7"), 10) || 7, 1), 60);
    const rows = await base44List(BASE44_SESSION_ENTITY, { client_id: client.id });
    const items = nextNDaysByDateTimeField(rows, "scheduled_date", days);
    return c.json({ ok: true, days, client_id: client.id, items }, 200);
  });

  app.post("/daily-checkin", async (c) => {
    const { email } = await verifyJwt(c.req.header("authorization") ?? null);
    const client = await getClientForUserEmail(email);
    const payload = (await c.req.json().catch(() => ({}))) as DailyCheckInInput;
    await upsertDailyCheckIn(client, email, payload);
    return c.json(await buildDashboard(client, email, 14), 200);
  });

  app.post("/daily-checkin/sync", async (c) => {
    const { email } = await verifyJwt(c.req.header("authorization") ?? null);
    const client = await getClientForUserEmail(email);
    const body = await c.req.json().catch(() => ({}));
    const items = Array.isArray((body as any).items) ? (body as any).items : [];
    const results: any[] = [];
    for (const item of items) {
      const r = await upsertDailyCheckIn(client, email, item as DailyCheckInInput);
      results.push({ ok: true, result: r });
    }
    const dash = await buildDashboard(client, email, 14);
    return c.json({ ...dash, sync_results: results }, 200);
  });

  app.post("/progress-log", async (c) => {
    const { email } = await verifyJwt(c.req.header("authorization") ?? null);
    const client = await getClientForUserEmail(email);
    const payload = (await c.req.json().catch(() => ({}))) as ProgressLogInput;
    await upsertProgressLog(client, payload);
    return c.json(await buildDashboard(client, email, 14), 200);
  });

  app.post("/progress-log/sync", async (c) => {
    const { email } = await verifyJwt(c.req.header("authorization") ?? null);
    const client = await getClientForUserEmail(email);
    const body = await c.req.json().catch(() => ({}));
    const items = Array.isArray((body as any).items) ? (body as any).items : [];
    const results: any[] = [];
    for (const item of items) {
      const r = await upsertProgressLog(client, item as ProgressLogInput);
      results.push({ ok: true, result: r });
    }
    const dash = await buildDashboard(client, email, 14);
    return c.json({ ...dash, sync_results: results }, 200);
  });

  app.post("/session", async (c) => {
    const { email } = await verifyJwt(c.req.header("authorization") ?? null);
    const client = await getClientForUserEmail(email);
    const payload = (await c.req.json().catch(() => ({}))) as SessionInput;
    const result = await upsertSession(client, payload);
    return c.json({ ok: true, result }, 200);
  });

  app.get("/me", async (c) => {
    const { email } = await verifyJwt(c.req.header("authorization") ?? null);
    const client = await getClientForUserEmail(email);
    return c.json({
      ok: true,
      email: normalizeEmail(email),
      client: {
        id: client.id,
        name: client.name ?? null,
        user_email: client.user_email ?? null,
      },
    }, 200);
  });

  return app;
}

const openApiApp = buildOpenApiApp();

// ---- Server ----
Deno.serve({ port: PORT }, (req) => openApiApp.fetch(req));
