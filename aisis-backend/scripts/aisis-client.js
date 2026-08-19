/**
 * Talks to AISIS directly. This is the same request logic that used to
 * live in the Cloud Function (functions/index.js: aisisFetchDepartment,
 * aisisFetchDepartmentList, getSessionCookie, getApplicablePeriod) —
 * ported to plain Node so it can run from a GitHub Actions job instead of
 * a Firebase Cloud Function. What changed:
 *   - onCall()/HttpsError() are gone (no callable-function wrapper here);
 *     functions below just throw a plain Error, which update-aisis.js
 *     catches per department so one failure doesn't stop the run.
 *   - requireAuth()/requireAdmin() are gone — there's no "caller" to
 *     authenticate. The thing standing in for that check now is that only
 *     this GitHub Actions workflow (using a secret only you control) can
 *     write to Firestore at all; see firestore-writer.js.
 * What's UNCHANGED: the POST body AISIS expects, the session-cookie priming
 * step, the applicablePeriod convention, and the department-dropdown scrape.
 */

const AISIS_BASE_URL = "https://aisis.ateneo.edu/j_aisis/classSkeds.do";

const TERM_CODE = {intersession: "0", first: "1", second: "2"};

function validateTerm(term) {
  if (!TERM_CODE[term]) {
    throw new Error(`Invalid term "${term}" — expected intersession, first, or second.`);
  }
}

function validateSchoolYearStart(schoolYearStart) {
  const y = Number(schoolYearStart);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw new Error(`Invalid academic year "${schoolYearStart}".`);
  }
  return y;
}

function validateDeptCode(deptCode, knownDeptCodes) {
  if (typeof deptCode !== "string" || !deptCode.trim() || deptCode.length > 20) {
    throw new Error(`Invalid department code "${deptCode}".`);
  }
  if (!knownDeptCodes.has(deptCode) && !/^[A-Za-z0-9 ()]+$/.test(deptCode)) {
    throw new Error(`Unrecognized department code "${deptCode}".`);
  }
  return deptCode;
}

// AISIS's applicablePeriod convention: "<starting year>-<term code>".
function getApplicablePeriod(schoolYearStart, term) {
  return `${schoolYearStart}-${TERM_CODE[term]}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

// AISIS is a classic JSP app that may tie search results to a server-side
// session. This grabs whatever session cookie a plain GET sets, so the
// follow-up POST looks like it came from a normal page visit. Deliberately
// gets a FRESH cookie every call rather than reusing/committing one — see
// the "IMPORTANT SECURITY REQUIREMENT" note in the project README about
// never hard-coding a personal AISIS session cookie.
async function getSessionCookie() {
  try {
    const res = await fetchWithTimeout(AISIS_BASE_URL, {method: "GET"}, 15000);
    const headers = res.headers;
    let cookies = [];
    if (typeof headers.getSetCookie === "function") {
      cookies = headers.getSetCookie();
    } else {
      const single = headers.get("set-cookie");
      if (single) cookies = [single];
    }
    if (!cookies.length) return null;
    return cookies.map((c) => c.split(";")[0]).join("; ");
  } catch (e) {
    console.warn("could not prime AISIS session cookie, continuing without one:", e.message);
    return null;
  }
}

/**
 * Fetches ONE department's schedule-of-classes HTML for a given term.
 * Returns { html, applicablePeriod, deptCode }. Throws on any failure —
 * callers should catch per-department so one bad department doesn't stop
 * the whole run.
 */
async function aisisFetchDepartment({schoolYearStart, term, deptCode}, knownDeptCodes) {
  validateTerm(term);
  const y = validateSchoolYearStart(schoolYearStart);
  const dept = validateDeptCode(deptCode, knownDeptCodes);
  const applicablePeriod = getApplicablePeriod(y, term);

  const cookie = await getSessionCookie();
  const body = new URLSearchParams({
    command: "displayResults",
    subjCode: "ALL",
    applicablePeriod,
    deptCode: dept,
  }).toString();

  let res;
  try {
    res = await fetchWithTimeout(AISIS_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(cookie ? {"Cookie": cookie} : {}),
      },
      body,
    }, 25000);
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("AISIS did not respond in time — try again in a moment.");
    }
    throw new Error("Could not reach AISIS: " + err.message);
  }

  if (!res.ok) {
    throw new Error(`AISIS returned HTTP ${res.status} for ${dept}.`);
  }

  let html;
  try {
    html = await res.text();
  } catch (err) {
    throw new Error("Could not read AISIS's response.");
  }

  if (!html || html.trim().length < 20) {
    throw new Error(`AISIS returned an empty response for ${dept}.`);
  }

  return {html, applicablePeriod, deptCode: dept};
}

/**
 * Best-effort scrape of AISIS's own deptCode <select> options, so "all
 * departments" can stay accurate even if AISIS adds/renames a department
 * before config/departments.json is updated. Throws on failure — callers
 * should fall back to config/departments.json.
 */
async function aisisFetchDepartmentList() {
  let html;
  try {
    const res = await fetchWithTimeout(AISIS_BASE_URL, {method: "GET"}, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    throw new Error("Could not reach AISIS: " + err.message);
  }

  const selectMatch = html.match(/<select[^>]*name=["']deptCode["'][^>]*>([\s\S]*?)<\/select>/i);
  if (!selectMatch) {
    throw new Error("Could not find the department dropdown on AISIS's page — it may have changed.");
  }

  const departments = [];
  const optionRe = /<option[^>]*value=["']([^"']*)["'][^>]*>([^<]*)<\/option>/gi;
  let m;
  while ((m = optionRe.exec(selectMatch[1])) !== null) {
    const code = m[1].trim();
    const label = m[2].replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
    if (!code || /^all$/i.test(code)) continue;
    departments.push({code, label: label || code});
  }

  if (!departments.length) {
    throw new Error("No department options were found in AISIS's dropdown.");
  }

  return departments;
}

module.exports = {
  TERM_CODE,
  validateTerm,
  validateSchoolYearStart,
  validateDeptCode,
  getApplicablePeriod,
  aisisFetchDepartment,
  aisisFetchDepartmentList,
};
