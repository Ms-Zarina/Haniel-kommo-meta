const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 3000;
const PROJECT_NAME = process.env.PROJECT_NAME || "haniel-kommo-meta";
const META_GRAPH_VERSION = "v20.0";

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// ============================================================
// helpers
// ============================================================

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || "").trim().toLowerCase())
    .digest("hex");
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d]/g, "");
  return digits || null;
}

function normalizeEmail(raw) {
  if (!raw) return null;
  const value = String(raw).trim().toLowerCase();
  return value || null;
}

function softNormalize(str) {
  return String(str || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// ============================================================
// MAPPING: pipeline_id + status_id -> Meta event_name
// ============================================================
//
// Composite key:  "<pipeline_id>_<status_id>"
// Все ID берутся из ENV — захардкоженных значений нет.
// Если ID статуса не задан в ENV, маппинг для него просто не создастся.
//
// При неизвестных ID можно сначала открыть GET /kommo/statuses-target,
// взять оттуда pipeline_id + status_id и положить их в Render env vars.
// ============================================================

function buildPipelineMapping() {
  const mapping = {};

  // ============================================================
  // === PIPELINE 1: Квалификация ===
  // статусы:
  // - записалась           -> Lead
  // - успешно реализован   -> Purchase
  // ============================================================
  const P1 = process.env.QUALIFICATION_PIPELINE_ID;
  if (P1) {
    if (process.env.QUALIFICATION_BOOKED_STATUS_ID) {
      mapping[`${P1}_${process.env.QUALIFICATION_BOOKED_STATUS_ID}`] = {
        pipeline_name: "01 Квалификация",
        status_name: "записалась",
        event_name: "Lead"
      };
    }
    if (process.env.QUALIFICATION_SUCCESS_STATUS_ID) {
      mapping[`${P1}_${process.env.QUALIFICATION_SUCCESS_STATUS_ID}`] = {
        pipeline_name: "01 Квалификация",
        status_name: "успешно реализован",
        event_name: "Purchase"
      };
    }
  }
  // === END PIPELINE 1 ===

  // ############################################################
  // ############################################################
  // === PIPELINE 2: Запись 01 ===
  // Если воронка "Запись 01" не нужна — закомментировать только этот блок.
  // статусы:
  // - записана                       -> Schedule
  // - пришла на пробную процедуру    -> QualifiedLead
  // - купила абонемент               -> Purchase
  // - привела подругу                -> Lead
  // - купила второй раз              -> Purchase
  // - обслужить сегодня              -> QualifiedLead
  // ############################################################
  // ############################################################
  const P2 = process.env.BOOKING_PIPELINE_ID;
  if (P2) {
    if (process.env.BOOKING_BOOKED_STATUS_ID) {
      mapping[`${P2}_${process.env.BOOKING_BOOKED_STATUS_ID}`] = {
        pipeline_name: "Запись 01",
        status_name: "записана",
        event_name: "Schedule"
      };
    }
    if (process.env.BOOKING_TRIAL_VISIT_STATUS_ID) {
      mapping[`${P2}_${process.env.BOOKING_TRIAL_VISIT_STATUS_ID}`] = {
        pipeline_name: "Запись 01",
        status_name: "пришла на пробную процедуру",
        event_name: "QualifiedLead"
      };
    }
    if (process.env.BOOKING_SUBSCRIPTION_PURCHASE_STATUS_ID) {
      mapping[`${P2}_${process.env.BOOKING_SUBSCRIPTION_PURCHASE_STATUS_ID}`] = {
        pipeline_name: "Запись 01",
        status_name: "купила абонемент",
        event_name: "Purchase"
      };
    }
    if (process.env.BOOKING_FRIEND_REFERRAL_STATUS_ID) {
      mapping[`${P2}_${process.env.BOOKING_FRIEND_REFERRAL_STATUS_ID}`] = {
        pipeline_name: "Запись 01",
        status_name: "привела подругу",
        event_name: "Lead"
      };
    }
    if (process.env.BOOKING_SECOND_PURCHASE_STATUS_ID) {
      mapping[`${P2}_${process.env.BOOKING_SECOND_PURCHASE_STATUS_ID}`] = {
        pipeline_name: "Запись 01",
        status_name: "купила второй раз",
        event_name: "Purchase"
      };
    }
    if (process.env.BOOKING_SERVE_TODAY_STATUS_ID) {
      mapping[`${P2}_${process.env.BOOKING_SERVE_TODAY_STATUS_ID}`] = {
        pipeline_name: "Запись 01",
        status_name: "обслужить сегодня",
        event_name: "QualifiedLead"
      };
    }
  }
  // === END PIPELINE 2 ===

  return mapping;
}

// Legacy fallback (без учёта pipeline_id) — остаётся для обратной совместимости
// со старыми ENV THINKING_STATUS_ID / BOOKING_STATUS_ID / SUCCESSFULLY_STATUS_ID.
function getMetaEventNameByStatusLegacy(statusId) {
  const map = {
    [String(process.env.THINKING_STATUS_ID)]: "Lead",
    [String(process.env.BOOKING_STATUS_ID)]: "QualifiedLead",
    [String(process.env.SUCCESSFULLY_STATUS_ID)]: "Purchase"
  };
  return map[String(statusId)] || null;
}

function resolveEventName({ pipelineId, statusId }) {
  const compositeKey = `${pipelineId}_${statusId}`;
  const mapping = buildPipelineMapping();
  const hit = mapping[compositeKey];
  if (hit) {
    return {
      compositeKey,
      eventName: hit.event_name,
      pipeline_name: hit.pipeline_name,
      status_name: hit.status_name,
      source: "pipeline_mapping"
    };
  }
  const legacy = getMetaEventNameByStatusLegacy(statusId);
  if (legacy) {
    return {
      compositeKey,
      eventName: legacy,
      pipeline_name: null,
      status_name: null,
      source: "legacy_status_mapping"
    };
  }
  return { compositeKey, eventName: null, source: "not_mapped" };
}

// ============================================================
// Meta CAPI
// ============================================================

async function sendMetaEvent({ eventName, email, phone, leadId, statusId, pipelineId, source }) {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

  if (!pixelId || !accessToken) {
    throw new Error("META_PIXEL_ID or META_ACCESS_TOKEN is not set");
  }

  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${pixelId}/events`;

  const normEmail = normalizeEmail(email);
  const normPhone = normalizePhone(phone);

  const user_data = {};
  if (normEmail) user_data.em = [sha256(normEmail)];
  if (normPhone) user_data.ph = [sha256(normPhone)];

  const eventPayload = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    action_source: "system_generated",
    user_data,
    custom_data: {
      currency: "CZK",
      value: 1,
      lead_id: leadId ? String(leadId) : "unknown",
      status_id: statusId ? String(statusId) : "unknown",
      pipeline_id: pipelineId ? String(pipelineId) : "unknown",
      source: source || "kommo_webhook"
    }
  };

  const payload = {
    data: [eventPayload],
    access_token: accessToken
  };

  if (process.env.META_TEST_EVENT_CODE && process.env.META_TEST_EVENT_CODE.trim() !== "") {
    payload.test_event_code = process.env.META_TEST_EVENT_CODE.trim();
  }

  console.log("[META] sending event", {
    event_name: eventName,
    has_email: !!normEmail,
    has_phone: !!normPhone,
    test_event_code: payload.test_event_code || null,
    pipeline_id: pipelineId,
    status_id: statusId,
    lead_id: leadId
  });

  try {
    const { data } = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000
    });
    console.log("[META] response", data);
    return data;
  } catch (err) {
    const metaErr = err.response?.data || { message: err.message };
    console.error("[META] error", metaErr);
    const e = new Error("Meta CAPI request failed");
    e.meta = metaErr;
    throw e;
  }
}

// ============================================================
// Kommo API
// ============================================================

function kommoBaseUrl() {
  const sub = process.env.KOMMO_SUBDOMAIN;
  if (!sub) throw new Error("KOMMO_SUBDOMAIN is not set");
  return `https://${sub}.kommo.com/api/v4`;
}

function kommoHeaders() {
  const token = process.env.KOMMO_ACCESS_TOKEN;
  if (!token) throw new Error("KOMMO_ACCESS_TOKEN is not set");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json"
  };
}

async function getLeadWithContacts(leadId) {
  const url = `${kommoBaseUrl()}/leads/${leadId}?with=contacts`;
  const { data } = await axios.get(url, { headers: kommoHeaders(), timeout: 15000 });
  return data;
}

async function getContactById(contactId) {
  const url = `${kommoBaseUrl()}/contacts/${contactId}`;
  const { data } = await axios.get(url, { headers: kommoHeaders(), timeout: 15000 });
  return data;
}

async function getPipelinesFromKommo() {
  const url = `${kommoBaseUrl()}/leads/pipelines`;
  const { data } = await axios.get(url, { headers: kommoHeaders(), timeout: 15000 });

  const pipelines = (data?._embedded?.pipelines || []).map((p) => ({
    pipeline_id: p.id,
    pipeline_name: p.name,
    is_archive: !!p.is_archive,
    statuses: (p?._embedded?.statuses || []).map((s) => ({
      status_id: s.id,
      status_name: s.name,
      type: s.type,
      color: s.color
    }))
  }));

  return pipelines;
}

function extractEmailAndPhone(contact) {
  const fields = contact?.custom_fields_values || [];
  let email = null;
  let phone = null;

  for (const field of fields) {
    const code = String(field.field_code || "").toUpperCase();
    if (code === "EMAIL") {
      email = field.values?.[0]?.value || email;
    }
    if (code === "PHONE") {
      phone = field.values?.[0]?.value || phone;
    }
  }
  return { email, phone };
}

// ============================================================
// payload normalization (Kommo webhook)
// ============================================================

function pickLeadFromKommoBody(body) {
  const leadsRoot = body?.leads || {};

  const candidate =
    leadsRoot?.status?.[0] ||
    leadsRoot?.update?.[0] ||
    leadsRoot?.add?.[0] ||
    null;

  if (!candidate) return null;

  return {
    id: candidate.id || candidate.lead_id || null,
    status_id: candidate.status_id || candidate.status || null,
    pipeline_id: candidate.pipeline_id || null,
    raw: candidate
  };
}

// ============================================================
// dedupe
// ============================================================

const sentEvents = new Set();
function isDuplicate(key) {
  if (sentEvents.has(key)) return true;
  sentEvents.add(key);
  if (sentEvents.size > 5000) {
    const first = sentEvents.values().next().value;
    sentEvents.delete(first);
  }
  return false;
}

// ============================================================
// routes
// ============================================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    project: PROJECT_NAME,
    message: "Kommo -> Meta CAPI backend is running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    project: PROJECT_NAME,
    pixel_id: process.env.META_PIXEL_ID ? "exists" : "not exists",
    meta_access_token: process.env.META_ACCESS_TOKEN ? "exists" : "not exists",
    meta_test_event_code: process.env.META_TEST_EVENT_CODE ? "exists" : "not exists",
    kommo_subdomain: process.env.KOMMO_SUBDOMAIN ? "exists" : "not exists",
    kommo_access_token: process.env.KOMMO_ACCESS_TOKEN ? "exists" : "not exists",
    pipeline_mapping: {
      QUALIFICATION_PIPELINE_ID: process.env.QUALIFICATION_PIPELINE_ID ? "exists" : "not exists",
      QUALIFICATION_BOOKED_STATUS_ID: process.env.QUALIFICATION_BOOKED_STATUS_ID ? "exists" : "not exists",
      QUALIFICATION_SUCCESS_STATUS_ID: process.env.QUALIFICATION_SUCCESS_STATUS_ID ? "exists" : "not exists",
      BOOKING_PIPELINE_ID: process.env.BOOKING_PIPELINE_ID ? "exists" : "not exists",
      BOOKING_BOOKED_STATUS_ID: process.env.BOOKING_BOOKED_STATUS_ID ? "exists" : "not exists",
      BOOKING_TRIAL_VISIT_STATUS_ID: process.env.BOOKING_TRIAL_VISIT_STATUS_ID ? "exists" : "not exists",
      BOOKING_SUBSCRIPTION_PURCHASE_STATUS_ID: process.env.BOOKING_SUBSCRIPTION_PURCHASE_STATUS_ID ? "exists" : "not exists",
      BOOKING_FRIEND_REFERRAL_STATUS_ID: process.env.BOOKING_FRIEND_REFERRAL_STATUS_ID ? "exists" : "not exists",
      BOOKING_SECOND_PURCHASE_STATUS_ID: process.env.BOOKING_SECOND_PURCHASE_STATUS_ID ? "exists" : "not exists",
      BOOKING_SERVE_TODAY_STATUS_ID: process.env.BOOKING_SERVE_TODAY_STATUS_ID ? "exists" : "not exists"
    },
    legacy_status_mapping: {
      THINKING_STATUS_ID: process.env.THINKING_STATUS_ID ? "exists" : "not exists",
      BOOKING_STATUS_ID: process.env.BOOKING_STATUS_ID ? "exists" : "not exists",
      SUCCESSFULLY_STATUS_ID: process.env.SUCCESSFULLY_STATUS_ID ? "exists" : "not exists"
    }
  });
});

// ---------- Kommo discovery: все воронки и статусы ----------
app.get("/kommo/pipelines", async (req, res) => {
  try {
    const pipelines = await getPipelinesFromKommo();
    return res.json({ ok: true, count: pipelines.length, pipelines });
  } catch (err) {
    console.error("[KOMMO API] /kommo/pipelines error", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    });
    return res.status(502).json({
      ok: false,
      error: "Kommo API error",
      details: err.response?.data || err.message
    });
  }
});

// ---------- Kommo discovery: только нужные статусы из двух воронок ----------
const TARGET_PIPELINES = [
  {
    label: "01 Квалификация",
    // мягкое совпадение по подстроке (case-insensitive)
    match: (name) => softNormalize(name).includes("квалификац"),
    statuses: ["записалась", "успешно реализован"]
  },
  {
    label: "Запись 01",
    match: (name) => softNormalize(name).includes("запись"),
    statuses: [
      "записана",
      "пришла на пробную процедуру",
      "купила абонемент",
      "привела подругу",
      "купила второй раз",
      "обслужить сегодня"
    ]
  }
];

app.get("/kommo/statuses-target", async (req, res) => {
  try {
    const pipelines = await getPipelinesFromKommo();
    const result = [];

    for (const target of TARGET_PIPELINES) {
      const found = pipelines.find((p) => target.match(p.pipeline_name));
      if (!found) {
        result.push({
          pipeline_label: target.label,
          pipeline_id: null,
          pipeline_name_in_kommo: null,
          note: "Pipeline not found in Kommo",
          statuses: target.statuses.map((s) => ({
            status_name_expected: s,
            status_id: null,
            status_name_in_kommo: null,
            found: false
          }))
        });
        continue;
      }

      const statuses = target.statuses.map((expectedName) => {
        const hit = found.statuses.find(
          (s) => softNormalize(s.status_name) === softNormalize(expectedName)
        );
        return {
          status_name_expected: expectedName,
          status_id: hit ? hit.status_id : null,
          status_name_in_kommo: hit ? hit.status_name : null,
          found: !!hit
        };
      });

      result.push({
        pipeline_label: target.label,
        pipeline_id: found.pipeline_id,
        pipeline_name_in_kommo: found.pipeline_name,
        note: "OK",
        statuses
      });
    }

    return res.json({ ok: true, pipelines: result });
  } catch (err) {
    console.error("[KOMMO API] /kommo/statuses-target error", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    });
    return res.status(502).json({
      ok: false,
      error: "Kommo API error",
      details: err.response?.data || err.message
    });
  }
});

// ---------- Текущий mapping pipeline_id:status_id -> Meta event ----------
app.get("/mapping", (req, res) => {
  const mapping = buildPipelineMapping();
  const items = Object.entries(mapping).map(([compositeKey, val]) => {
    const [pipeline_id, status_id] = compositeKey.split("_");
    return {
      composite_key: compositeKey,
      pipeline_id,
      status_id,
      pipeline_name: val.pipeline_name,
      status_name: val.status_name,
      meta_event_name: val.event_name
    };
  });

  const legacy = {
    THINKING_STATUS_ID: process.env.THINKING_STATUS_ID || null,
    BOOKING_STATUS_ID: process.env.BOOKING_STATUS_ID || null,
    SUCCESSFULLY_STATUS_ID: process.env.SUCCESSFULLY_STATUS_ID || null
  };

  res.json({
    ok: true,
    pipeline_mapping_count: items.length,
    pipeline_mapping: items,
    legacy_status_only_mapping: legacy
  });
});

// ---------- Manual test → прямой Meta event ----------
app.post("/webhook/test-lead", async (req, res) => {
  try {
    const { lead_id, status_id, pipeline_id, email, phone } = req.body || {};

    console.log("[TEST] incoming", { lead_id, status_id, pipeline_id, email, phone });

    if (!email && !phone) {
      return res.status(400).json({
        ok: false,
        error: "email or phone is required"
      });
    }

    const resolved = resolveEventName({ pipelineId: pipeline_id, statusId: status_id });
    if (!resolved.eventName) {
      return res.status(400).json({
        ok: false,
        error: "Unknown pipeline_id/status_id combo (not mapped)",
        pipeline_id,
        status_id,
        composite_key: resolved.compositeKey
      });
    }

    const metaResult = await sendMetaEvent({
      eventName: resolved.eventName,
      email,
      phone,
      leadId: lead_id,
      statusId: status_id,
      pipelineId: pipeline_id,
      source: "test_endpoint"
    });

    return res.json({
      ok: true,
      sent_to_meta: true,
      event_name: resolved.eventName,
      mapping_source: resolved.source,
      composite_key: resolved.compositeKey,
      lead_id,
      status_id,
      pipeline_id,
      meta: metaResult
    });
  } catch (error) {
    console.error("[TEST] error", error.message, error.meta || "");
    return res.status(500).json({
      ok: false,
      error: error.message,
      meta_error: error.meta || null
    });
  }
});

// ---------- Реальный webhook от Kommo ----------
app.post("/webhook/kommo", async (req, res) => {
  try {
    console.log("[KOMMO] incoming webhook");
    console.log(JSON.stringify(req.body, null, 2));

    const lead = pickLeadFromKommoBody(req.body);

    if (!lead || !lead.id) {
      console.log("[KOMMO] skipped: no lead in payload");
      return res.json({
        ok: true,
        skipped: true,
        reason: "No lead data in webhook (leads.status / leads.update / leads.add not found)"
      });
    }

    const resolved = resolveEventName({
      pipelineId: lead.pipeline_id,
      statusId: lead.status_id
    });

    console.log("[KOMMO] detected lead", {
      lead_id: lead.id,
      pipeline_id: lead.pipeline_id,
      status_id: lead.status_id,
      composite_key: resolved.compositeKey,
      event_name: resolved.eventName,
      mapping_source: resolved.source
    });

    if (!resolved.eventName) {
      console.log("[KOMMO] skipped: composite key not mapped", resolved.compositeKey);
      return res.json({
        ok: true,
        skipped: true,
        reason: "pipeline_id+status_id not mapped",
        lead_id: lead.id,
        pipeline_id: lead.pipeline_id,
        status_id: lead.status_id,
        composite_key: resolved.compositeKey
      });
    }

    const eventKey = `${lead.id}_${resolved.compositeKey}_${resolved.eventName}`;
    if (isDuplicate(eventKey)) {
      console.log("[KOMMO] skipped: duplicate", eventKey);
      return res.json({
        ok: true,
        skipped: true,
        reason: "Duplicate event skipped",
        eventKey
      });
    }

    let leadData;
    try {
      leadData = await getLeadWithContacts(lead.id);
    } catch (err) {
      console.error("[KOMMO API] getLeadWithContacts error", {
        lead_id: lead.id,
        status: err.response?.status,
        data: err.response?.data,
        message: err.message
      });
      return res.status(502).json({
        ok: false,
        error: "Kommo API error on getLeadWithContacts",
        details: err.response?.data || err.message
      });
    }

    const contactId = leadData?._embedded?.contacts?.[0]?.id;
    if (!contactId) {
      console.log("[KOMMO] skipped: no contact linked", lead.id);
      return res.json({
        ok: true,
        skipped: true,
        reason: "No contact linked to lead",
        lead_id: lead.id
      });
    }

    let contactData;
    try {
      contactData = await getContactById(contactId);
    } catch (err) {
      console.error("[KOMMO API] getContactById error", {
        contact_id: contactId,
        status: err.response?.status,
        data: err.response?.data,
        message: err.message
      });
      return res.status(502).json({
        ok: false,
        error: "Kommo API error on getContactById",
        details: err.response?.data || err.message
      });
    }

    const { email, phone } = extractEmailAndPhone(contactData);

    if (!email && !phone) {
      console.log("[KOMMO] skipped: contact has no email/phone", {
        lead_id: lead.id,
        contact_id: contactId
      });
      return res.json({
        ok: true,
        skipped: true,
        reason: "No email or phone in contact",
        lead_id: lead.id,
        contact_id: contactId
      });
    }

    const metaResult = await sendMetaEvent({
      eventName: resolved.eventName,
      email,
      phone,
      leadId: lead.id,
      statusId: lead.status_id,
      pipelineId: lead.pipeline_id,
      source: "kommo_webhook"
    });

    return res.json({
      ok: true,
      sent_to_meta: true,
      lead_id: lead.id,
      pipeline_id: lead.pipeline_id,
      status_id: lead.status_id,
      composite_key: resolved.compositeKey,
      contact_id: contactId,
      event_name: resolved.eventName,
      mapping_source: resolved.source,
      meta: metaResult
    });
  } catch (error) {
    console.error("[KOMMO] unhandled error", error.message, error.meta || "");
    return res.status(500).json({
      ok: false,
      error: error.message,
      meta_error: error.meta || null
    });
  }
});

// fallback 404
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found", path: req.path });
});

// ============================================================
// Export / listen
// ============================================================
// На Vercel переменная VERCEL=1 проставляется автоматически — там app.listen()
// не нужен, Vercel сам оборачивает экспортированный handler в serverless function.
// Локально (npm start) — обычный Express-сервер.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[${PROJECT_NAME}] server running on port ${PORT}`);
  });
}

module.exports = app;
