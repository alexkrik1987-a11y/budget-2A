"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const appSource = fs.readFileSync("app.js", "utf8");
const sqlSource = fs.readFileSync("archive-features.sql", "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = appSource.indexOf(marker);
  assert.notEqual(start, -1, `В app.js не найдена функция ${name}`);
  const bodyStart = appSource.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < appSource.length; index += 1) {
    if (appSource[index] === "{") depth += 1;
    if (appSource[index] === "}") depth -= 1;
    if (depth === 0) return appSource.slice(start, index + 1);
  }
  throw new Error(`Не найдена закрывающая скобка функции ${name}`);
}

function createRuntime(state) {
  const downloads = [];
  const notices = [];
  const dom = { exportBackupButton: { disabled: false } };
  const context = {
    state,
    Date,
    dom,
    downloadBlob(...args) {
      downloads.push(args);
    },
    todayIso() {
      return "2026-08-23";
    },
    showNotice(...args) {
      notices.push(args);
    },
    renderAll() {},
    window: {
      setTimeout() {
        return 1;
      }
    }
  };
  vm.runInNewContext([
    extractFunction("setBudgetDataReady"),
    extractFunction("resetBudgetDataState"),
    extractFunction("buildSnapshot"),
    extractFunction("exportBackupJson"),
    extractFunction("ensureBudgetDataReadyForExport"),
    extractFunction("validateSnapshot"),
    extractFunction("normalizeSnapshotForRestore"),
    extractFunction("refreshAfterMutation"),
    "this.api = { setBudgetDataReady, resetBudgetDataState, buildSnapshot, exportBackupJson, ensureBudgetDataReadyForExport, validateSnapshot, normalizeSnapshotForRestore, refreshAfterMutation };"
  ].join("\n"), context);
  context.api.downloads = downloads;
  context.api.notices = notices;
  context.api.dom = dom;
  return context.api;
}

const activeCampaign = {
  id: "10000000-0000-0000-0000-000000000001",
  name: "Активный сбор",
  archived_at: null
};
const archivedCampaign = {
  id: "10000000-0000-0000-0000-000000000002",
  name: "Архивный сбор",
  archived_at: "2026-05-31T12:00:00.000Z"
};
const student = {
  id: "20000000-0000-0000-0000-000000000001",
  full_name: "Тестовый ученик"
};
const archivedContribution = {
  id: "30000000-0000-0000-0000-000000000001",
  student_id: student.id,
  campaign_id: archivedCampaign.id,
  amount: 1500
};
const archivedExpense = {
  id: "40000000-0000-0000-0000-000000000001",
  campaign_id: archivedCampaign.id,
  description: "Расход архивного сбора",
  amount: 500
};

function makeState(overrides = {}) {
  return {
    isAdmin: true,
    budgetDataReady: false,
    classProfile: { class_name: "2 «А»", school_year: "2025/2026" },
    students: [student],
    allStudents: [student],
    campaigns: [activeCampaign],
    archivedCampaigns: [],
    contributions: [],
    expenses: [],
    backups: [],
    selectedCampaignId: activeCampaign.id,
    archiveFeaturesReady: true,
    advancedFeaturesReady: true,
    lastUndoBackupId: "50000000-0000-0000-0000-000000000001",
    undoNoticeUntil: Date.now() + 9000,
    accessRequestStatus: "APPROVED",
    enrollmentReady: true,
    enrollmentOpen: true,
    pendingEnrollmentMutation: { value: true },
    accessRequests: [{ id: "request-id" }],
    ...overrides
  };
}

{
  const state = makeState();
  const api = createRuntime(state);

  api.setBudgetDataReady(false);
  api.exportBackupJson();
  assert.equal(api.downloads.length, 0, "экспорт до первоначальной загрузки должен быть запрещён");
  assert.equal(api.dom.exportBackupButton.disabled, true);
  assert.equal(api.notices.at(-1)[0], "Данные ещё загружаются. Попробуйте через несколько секунд.");

  api.setBudgetDataReady(true);
  api.exportBackupJson();
  assert.equal(api.downloads.length, 1, "экспорт после успешной загрузки должен работать");
  assert.equal(api.dom.exportBackupButton.disabled, false);

  api.refreshAfterMutation();
  assert.equal(state.budgetDataReady, false, "refresh после изменения должен блокировать экспорт");
  api.exportBackupJson();
  assert.equal(api.downloads.length, 1, "во время refresh новый файл создаваться не должен");

  api.setBudgetDataReady(true);
  api.exportBackupJson();
  assert.equal(api.downloads.length, 2, "после успешного refresh экспорт должен снова работать");
}

{
  const state = makeState({
    archivedCampaigns: [archivedCampaign],
    contributions: [archivedContribution],
    expenses: [archivedExpense],
    backups: [{ id: "backup-id" }]
  });
  const api = createRuntime(state);
  api.setBudgetDataReady(true);
  api.resetBudgetDataState();
  for (const key of ["students", "allStudents", "campaigns", "archivedCampaigns", "contributions", "expenses", "backups"]) {
    assert.equal(Array.isArray(state[key]) && state[key].length === 0, true, `logout должен очистить state.${key}`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(state.classProfile)), { class_name: "2 «А»", school_year: "", useful_info: {}, payment_details: {} });
  assert.equal(state.selectedCampaignId, null);
  assert.equal(state.lastUndoBackupId, null);
  assert.equal(state.undoNoticeUntil, 0);
  assert.equal(state.accessRequestStatus, null);
  assert.equal(state.enrollmentReady, false);
  assert.equal(state.enrollmentOpen, false);
  assert.equal(state.pendingEnrollmentMutation, null);
  assert.equal(state.accessRequests.length, 0);
  assert.equal(state.archiveFeaturesReady, false);
  assert.equal(state.advancedFeaturesReady, false);
  assert.equal(state.budgetDataReady, false);
  assert.equal(api.dom.exportBackupButton.disabled, true);
}

{
  const api = createRuntime(makeState());
  const snapshot = api.buildSnapshot();
  assert.equal(snapshot.version, 3);
  assert.deepEqual(snapshot.campaigns.map((item) => item.id), [activeCampaign.id]);
  assert.deepEqual(snapshot.archived_campaigns, []);
}

{
  const api = createRuntime(makeState({ archivedCampaigns: [archivedCampaign] }));
  const snapshot = api.buildSnapshot();
  assert.deepEqual(snapshot.campaigns.map((item) => item.id), [activeCampaign.id]);
  assert.deepEqual(snapshot.archived_campaigns.map((item) => item.id), [archivedCampaign.id]);
}

{
  const api = createRuntime(makeState({
    archivedCampaigns: [archivedCampaign],
    contributions: [archivedContribution],
    expenses: [archivedExpense]
  }));
  const snapshot = api.buildSnapshot();
  const restored = api.normalizeSnapshotForRestore(snapshot);
  assert(restored.campaigns.some((item) => item.id === archivedContribution.campaign_id));
  assert(restored.campaigns.some((item) => item.id === archivedExpense.campaign_id));
  assert.deepEqual(restored.contributions, [archivedContribution]);
  assert.deepEqual(restored.expenses, [archivedExpense]);
}

{
  const api = createRuntime(makeState());
  const newFormat = {
    version: 3,
    students: [student],
    campaigns: [activeCampaign],
    archived_campaigns: [archivedCampaign],
    contributions: [archivedContribution],
    expenses: [archivedExpense]
  };
  api.validateSnapshot(newFormat);
  const restored = api.normalizeSnapshotForRestore(newFormat);
  assert.deepEqual(Array.from(restored.campaigns, (item) => item.id), [activeCampaign.id, archivedCampaign.id]);
}

{
  const api = createRuntime(makeState());
  const duplicateCampaign = {
    version: 3,
    students: [student],
    campaigns: [activeCampaign],
    archived_campaigns: [{ ...archivedCampaign, id: activeCampaign.id.toUpperCase() }],
    contributions: [],
    expenses: []
  };
  assert.throws(
    () => api.validateSnapshot(duplicateCampaign),
    /повторяющийся ID сбора/
  );
}

{
  const api = createRuntime(makeState());
  const oldFormat = {
    version: 2,
    students: [student],
    campaigns: [activeCampaign],
    contributions: [],
    expenses: []
  };
  api.validateSnapshot(oldFormat);
  const restored = api.normalizeSnapshotForRestore(oldFormat);
  assert.deepEqual(Array.from(restored.campaigns, (item) => item.id), [activeCampaign.id]);
}

{
  const api = createRuntime(makeState());
  const oldServerFormat = {
    version: 2,
    students: [student],
    campaigns: [activeCampaign, archivedCampaign],
    contributions: [archivedContribution],
    expenses: [archivedExpense]
  };
  api.validateSnapshot(oldServerFormat);
  const restored = api.normalizeSnapshotForRestore(oldServerFormat);
  assert.deepEqual(Array.from(restored.campaigns, (item) => item.id), [activeCampaign.id, archivedCampaign.id]);
}

{
  const originalState = makeState({
    archivedCampaigns: [archivedCampaign],
    contributions: [archivedContribution],
    expenses: [archivedExpense]
  });
  const api = createRuntime(originalState);
  const exported = JSON.parse(JSON.stringify(api.buildSnapshot()));
  api.validateSnapshot(exported);
  const restored = api.normalizeSnapshotForRestore(exported);
  assert.deepEqual(restored.students, originalState.allStudents);
  assert.deepEqual(Array.from(restored.campaigns), [activeCampaign, archivedCampaign]);
  assert.deepEqual(restored.contributions, originalState.contributions);
  assert.deepEqual(restored.expenses, originalState.expenses);
}

{
  const restoreFunctionStart = sqlSource.indexOf("create or replace function public.restore_budget_snapshot");
  assert.notEqual(restoreFunctionStart, -1, "SQL-функция restore_budget_snapshot не найдена");
  const restoreSql = sqlSource.slice(restoreFunctionStart);
  const campaignsInsert = restoreSql.indexOf("insert into public.campaigns");
  const contributionsInsert = restoreSql.indexOf("insert into public.contributions");
  const expensesInsert = restoreSql.indexOf("insert into public.expenses");
  assert(campaignsInsert >= 0 && campaignsInsert < contributionsInsert);
  assert(contributionsInsert < expensesInsert);
}

{
  const restoreHandler = extractFunction("restoreBackupFromFile");
  assert(
    restoreHandler.indexOf("normalizeSnapshotForRestore(snapshot)") < restoreHandler.indexOf('db.rpc("restore_budget_snapshot"'),
    "JSON должен быть нормализован до вызова restore_budget_snapshot"
  );
}

{
  const loadAllDataStart = appSource.indexOf("async function loadAllData");
  const loadAllDataEnd = appSource.indexOf("async function loadSupplementaryData", loadAllDataStart);
  assert(loadAllDataStart >= 0 && loadAllDataEnd > loadAllDataStart, "loadAllData не найдена");
  const loadAllData = appSource.slice(loadAllDataStart, loadAllDataEnd);
  assert(
    loadAllData.indexOf("setBudgetDataReady(false)") < loadAllData.indexOf('db.rpc("load_class_budget_snapshot")'),
    "экспорт должен блокироваться до запроса полного snapshot"
  );
  assert(
    loadAllData.indexOf("setBudgetDataReady(true)") > loadAllData.indexOf("state.archivedCampaigns ="),
    "экспорт можно разрешать только после заполнения архива"
  );

  const handleSession = extractFunction("handleSession");
  assert(handleSession.includes("resetBudgetDataState()"), "logout должен очищать состояние бюджета");
}

console.log("backup archived campaigns checks: PASS");
