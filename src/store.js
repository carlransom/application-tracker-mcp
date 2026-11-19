import admin from "firebase-admin";
import { STATUSES } from "./config.js";

// Firestore access. Reads are ALWAYS scoped to one user's subcollection:
//   users/{uid}/applications
// The uid comes from the verified OAuth access token only — callers never
// supply it. There are no write methods in this module at all.

let adminApp = null;

export function getAdmin() {
  if (adminApp) return adminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not set");
  }
  const serviceAccount = JSON.parse(raw);
  adminApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId:
      serviceAccount.project_id ||
      process.env.FIREBASE_PROJECT_ID ||
      "application-tracker-49f9e",
  });
  return adminApp;
}

const FIELDS = [
  "company",
  "role",
  "location",
  "type",
  "status",
  "applied",
  "closing",
  "pay",
  "req",
  "url",
  "notes",
];

function normalize(doc) {
  const d = doc.data() || {};
  const out = { id: doc.id };
  for (const f of FIELDS) {
    out[f] = typeof d[f] === "string" ? d[f] : (d[f] ?? "");
  }
  if (!STATUSES.includes(out.status)) out.status = "saved";
  return out;
}

function byAppliedDesc(a, b) {
  if (a.applied && b.applied) return b.applied.localeCompare(a.applied);
  if (a.applied) return -1;
  if (b.applied) return 1;
  return String(a.company).localeCompare(String(b.company));
}

function clampLimit(limit, fallback, max) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function createFirestoreStore() {
  const db = () => getAdmin().firestore();
  const appsCol = (uid) =>
    db().collection("users").doc(uid).collection("applications");

  return {
    kind: "firestore",

    async listApplications(uid, { status, limit = 50 } = {}) {
      let q = appsCol(uid);
      if (status) q = q.where("status", "==", status);
      const snap = await q.limit(clampLimit(limit, 50, 100)).get();
      return snap.docs.map(normalize).sort(byAppliedDesc);
    },

    async getApplication(uid, id) {
      const doc = await appsCol(uid).doc(String(id)).get();
      return doc.exists ? normalize(doc) : null;
    },

    async searchApplications(uid, { query, limit = 50 } = {}) {
      const needle = String(query || "").toLowerCase();
      if (!needle) return [];
      const snap = await appsCol(uid).limit(200).get();
      return snap.docs
        .map(normalize)
        .filter((a) =>
          [a.company, a.role, a.location, a.notes]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
        .sort(byAppliedDesc)
        .slice(0, clampLimit(limit, 50, 100));
    },

    async getStats(uid) {
      const snap = await appsCol(uid).limit(1000).get();
      const apps = snap.docs.map(normalize);
      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      for (const a of apps) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
      return {
        total: apps.length,
        byStatus,
        active:
          byStatus.saved +
          byStatus.applied +
          byStatus.screening +
          byStatus.interview,
        offers: byStatus.offer,
        interviews: byStatus.interview,
      };
    },
  };
}

// In-memory store with the same interface, used by the local test harness.
// seed: { uid: [application, ...] }
export function createMemoryStore(seed = {}) {
  const data = new Map(
    Object.entries(seed).map(([uid, apps]) => [
      uid,
      apps.map((a) => ({ ...a })),
    ]),
  );

  return {
    kind: "memory",

    async listApplications(uid, { status, limit = 50 } = {}) {
      let apps = (data.get(uid) || []).map((a) => ({ ...a }));
      if (status) apps = apps.filter((a) => a.status === status);
      return apps.sort(byAppliedDesc).slice(0, clampLimit(limit, 50, 100));
    },

    async getApplication(uid, id) {
      return (data.get(uid) || []).find((a) => a.id === String(id)) || null;
    },

    async searchApplications(uid, { query, limit = 50 } = {}) {
      const needle = String(query || "").toLowerCase();
      if (!needle) return [];
      return (data.get(uid) || [])
        .map((a) => ({ ...a }))
        .filter((a) =>
          [a.company, a.role, a.location, a.notes]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
        .sort(byAppliedDesc)
        .slice(0, clampLimit(limit, 50, 100));
    },

    async getStats(uid) {
      const apps = data.get(uid) || [];
      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      for (const a of apps) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
      return {
        total: apps.length,
        byStatus,
        active:
          byStatus.saved +
          byStatus.applied +
          byStatus.screening +
          byStatus.interview,
        offers: byStatus.offer,
        interviews: byStatus.interview,
      };
    },
  };
}
