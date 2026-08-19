/**
 * Writes parsed AISIS results to Firestore using the Admin SDK, which
 * authenticates with a service account and always bypasses firestore.rules
 * — that's why the client-side admin passcode / sked_admins system doesn't
 * need to be involved for this automated path at all.
 *
 * WHERE IT WRITES: sked_shared/catalog__<termKey>, one document per
 * (schoolYearStart, term) pair — e.g. "catalog__2026-2027-1" for First
 * Semester of SY2026-2027. This deliberately reuses the exact collection
 * (sked_shared) and document SHAPE ({value: [...], updatedAt}) that the
 * website's own sGet()/sSet() helpers already read and write for every
 * other shared key — so the frontend can load a term with a plain
 * `sGet('catalog__'+termKey, true)` and get back the same kind of course
 * array `state.catalog` already holds. See index.html's
 * catalogTermKey()/renderAutoCatalogPanel().
 *
 * The firestore.rules you already have anticipates exactly this: it
 * singles out `catalog` and any `catalog__*` doc in sked_shared for
 * admin-only CLIENT writes, while leaving reads open to everyone — no
 * rules changes were needed for this migration.
 *
 * NEVER overwrites another term's document, and never overwrites a whole
 * term wholesale on a partial run: new/updated courses are merged into
 * whatever's already in that term's `value` array by course+section (the
 * same catalogKey the frontend uses), so re-running just one department
 * only touches that department's sections.
 */

const admin = require("firebase-admin");
const {catalogKey} = require("./aisis-parser");

let _app = null;

function initFirebase() {
  if (_app) return _app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error(
        "FIREBASE_SERVICE_ACCOUNT is not set. This must be the JSON contents " +
        "of a Firebase service account key, stored as a GitHub Actions secret " +
        "— see aisis-backend/README.md for exactly how to create one.",
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT does not contain valid JSON: " + e.message);
  }

  _app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  return _app;
}

function getDb() {
  initFirebase();
  return admin.firestore();
}

// Matches TERM_CODE in aisis-client.js / index.html's TERM_CODE.
const TERM_CODE = {intersession: "0", first: "1", second: "2"};

// e.g. termKey(2026, "second") -> "2026-2027-2". Matches
// catalogTermKey(schoolYear, semesterType) in index.html, just built from
// schoolYearStart instead of the "YYYY-YYYY+1" string the frontend keeps
// in state.schoolYear.
function termKey(schoolYearStart, term) {
  const y = Number(schoolYearStart);
  return `${y}-${y + 1}-${TERM_CODE[term]}`;
}

/**
 * Merges a Map<catalogKey, entry> of newly-parsed course entries (from
 * aisis-parser.groupStagedRows) into sked_shared/catalog__<termKey>,
 * preserving every course already in that term that wasn't touched this
 * run — mirrors the confirmAdd merge logic in index.html exactly
 * (same key wins in place, keeps the existing id; new key gets appended
 * with a fresh id).
 *
 * Returns {added, replaced, total}.
 */
async function mergeTermCatalog({schoolYearStart, term, newEntries}) {
  const db = getDb();
  const key = termKey(schoolYearStart, term);
  const docRef = db.collection("sked_shared").doc(`catalog__${key}`);

  const snap = await docRef.get();
  const existing = (snap.exists && Array.isArray(snap.data().value)) ? snap.data().value : [];

  let added = 0;
  let replaced = 0;

  newEntries.forEach((entry) => {
    const k = catalogKey(entry.code, entry.section);
    const idx = existing.findIndex((c) => catalogKey(c.code, c.section) === k);
    if (idx > -1) {
      entry.id = existing[idx].id;
      existing[idx] = entry;
      replaced++;
    } else {
      entry.id = "c_" + Math.random().toString(36).slice(2, 9);
      existing.push(entry);
      added++;
    }
  });

  await docRef.set({
    value: existing,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {added, replaced, total: existing.length, key};
}

module.exports = {termKey, mergeTermCatalog};
