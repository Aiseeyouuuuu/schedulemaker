#!/usr/bin/env node
/**
 * Entry point run by .github/workflows/update-aisis.yml. Orchestrates:
 *   AISIS fetch (aisis-client.js)
 *     -> parse (aisis-parser.js — the same rules as index.html's
 *        parseAisisHtml)
 *     -> group into course+section entries
 *     -> merge into Firestore, one department at a time
 *        (firestore-writer.js), so a crash partway through still leaves
 *        earlier departments' progress saved
 *
 * CONFIG SOURCE: workflow_dispatch inputs (passed in as env vars by the
 * workflow file) override config/current-term.json, which is what
 * scheduled/cron runs use since a cron trigger can't supply inputs. See
 * that file's _comment for how to move the "current" term forward.
 *
 * Each department is fully isolated: a failure fetching, parsing, or
 * writing one department is caught, recorded, and does NOT stop the rest
 * from running (per-project requirement — a bad department shouldn't
 * block everyone else's).
 */

const fs = require("fs");
const path = require("path");

const {aisisFetchDepartment, aisisFetchDepartmentList, validateTerm, validateSchoolYearStart} = require("./aisis-client");
const {parseAisisHtml, groupStagedRows} = require("./aisis-parser");
const {mergeTermCatalog, termKey} = require("./firestore-writer");

const DEPARTMENTS_FILE = path.join(__dirname, "..", "config", "departments.json");
const CURRENT_TERM_FILE = path.join(__dirname, "..", "config", "current-term.json");

function loadKnownDepartments() {
  const raw = JSON.parse(fs.readFileSync(DEPARTMENTS_FILE, "utf8"));
  return raw.departments; // [{code,label}, ...]
}

// Resolves run configuration: workflow_dispatch inputs (env vars, set by
// the workflow file) win when present and non-empty; otherwise falls back
// to config/current-term.json for scheduled runs.
function resolveConfig() {
  const fileConfig = JSON.parse(fs.readFileSync(CURRENT_TERM_FILE, "utf8"));

  const envSchoolYearStart = process.env.INPUT_SCHOOL_YEAR_START;
  const envTerm = process.env.INPUT_TERM;
  const envDepartments = process.env.INPUT_DEPARTMENTS;

  const schoolYearStart = (envSchoolYearStart && envSchoolYearStart.trim())
    ? envSchoolYearStart.trim()
    : fileConfig.schoolYearStart;
  const term = (envTerm && envTerm.trim()) ? envTerm.trim() : fileConfig.term;
  const departmentsRaw = (envDepartments && envDepartments.trim())
    ? envDepartments.trim()
    : fileConfig.departments;

  return {schoolYearStart, term, departmentsRaw};
}

// "all" -> every known department code (tries a live AISIS scrape first,
// falls back to config/departments.json). Anything else is treated as a
// comma/whitespace-separated list of explicit department codes.
async function resolveDepartmentCodes(departmentsRaw, knownDepartments) {
  const knownCodes = new Set(knownDepartments.map((d) => d.code));

  if (String(departmentsRaw).trim().toLowerCase() === "all") {
    try {
      const live = await aisisFetchDepartmentList();
      console.log(`Using ${live.length} departments scraped live from AISIS's own dropdown.`);
      return live.map((d) => d.code);
    } catch (e) {
      console.warn(`Live department scrape failed (${e.message}) — falling back to config/departments.json.`);
      return [...knownCodes];
    }
  }

  const requested = String(departmentsRaw)
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

  const unknown = requested.filter((c) => !knownCodes.has(c));
  if (unknown.length) {
    console.warn(`Warning: these department codes aren't in config/departments.json and will be attempted anyway: ${unknown.join(", ")}`);
  }
  return requested;
}

function deptLabel(code, knownDepartments) {
  const found = knownDepartments.find((d) => d.code === code);
  return found ? found.label : code;
}

async function run() {
  const {schoolYearStart, term, departmentsRaw} = resolveConfig();

  console.log(`Config: schoolYearStart=${schoolYearStart}, term=${term}, departments=${departmentsRaw}`);

  validateTerm(term);
  validateSchoolYearStart(schoolYearStart);

  const knownDepartments = loadKnownDepartments();
  const deptCodes = await resolveDepartmentCodes(departmentsRaw, knownDepartments);
  const knownCodeSet = new Set(knownDepartments.map((d) => d.code));

  const results = {succeeded: [], failed: []};
  const key = termKey(schoolYearStart, term);
  console.log(`Target term doc: sked_shared/catalog__${key} (${deptCodes.length} department(s) requested)`);

  for (const deptCode of deptCodes) {
    const label = deptLabel(deptCode, knownDepartments);
    try {
      const {html} = await aisisFetchDepartment({schoolYearStart, term, deptCode}, knownCodeSet);
      const stagedRows = parseAisisHtml(html);

      if (!stagedRows.length) {
        console.log(`${deptCode} (${label}): AISIS returned a page with no class rows — nothing to import, treating as success.`);
        results.succeeded.push({deptCode, label, added: 0, replaced: 0, sections: 0});
        continue;
      }

      const groups = groupStagedRows(stagedRows);
      const newEntries = [...groups.values()];
      const {added, replaced} = await mergeTermCatalog({schoolYearStart, term, newEntries});

      console.log(`${deptCode} (${label}): ${added} added, ${replaced} replaced (${newEntries.length} sections parsed).`);
      results.succeeded.push({deptCode, label, added, replaced, sections: newEntries.length});
    } catch (err) {
      console.error(`${deptCode} (${label}) FAILED: ${err.message}`);
      results.failed.push({deptCode, label, error: err.message});
    }
  }

  writeSummary({schoolYearStart, term, key, results});

  console.log("\n=== Summary ===");
  console.log(`Succeeded: ${results.succeeded.length} — Failed: ${results.failed.length}`);
  if (results.failed.length) {
    console.log("Failed departments:", results.failed.map((f) => f.deptCode).join(", "));
  }

  // Only hard-fail the job if EVERY department failed — a partial failure
  // is reported (see the step summary / logs) but shouldn't turn a mostly-
  // successful run red, per the "continue on partial failure" requirement.
  if (deptCodes.length > 0 && results.succeeded.length === 0) {
    console.error("Every department failed — failing the job.");
    process.exit(1);
  }
}

function writeSummary({schoolYearStart, term, key, results}) {
  const lines = [];
  lines.push(`## AISIS catalog update — SY${schoolYearStart}-${Number(schoolYearStart) + 1}, ${term}`);
  lines.push("");
  lines.push(`Firestore doc: \`sked_shared/catalog__${key}\``);
  lines.push("");
  lines.push(`**Successful (${results.succeeded.length}):**`);
  if (results.succeeded.length) {
    results.succeeded.forEach((r) => {
      lines.push(`- ${r.label} (${r.deptCode}) — ${r.added} added, ${r.replaced} replaced`);
    });
  } else {
    lines.push("- _none_");
  }
  lines.push("");
  lines.push(`**Failed (${results.failed.length}):**`);
  if (results.failed.length) {
    results.failed.forEach((r) => {
      lines.push(`- ${r.label} (${r.deptCode}) — ${r.error}`);
    });
  } else {
    lines.push("- _none_");
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, lines.join("\n") + "\n");
  } else {
    console.log("\n" + lines.join("\n"));
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
