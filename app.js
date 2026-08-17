"use strict";

/* =========================================================
   1. НАСТРОЙКА SUPABASE
   ========================================================= */
const SUPABASE_URL = "https://ftmnevlzremmisbajkmt.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_jbRHoAeUQ7N96ybRzQSfHQ_DOzU-sx7";

const isSupabaseConfigured =
  SUPABASE_URL.startsWith("https://") &&
  !SUPABASE_URL.includes("YOUR_PROJECT_ID") &&
  !SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");

const db = isSupabaseConfigured && window.supabase
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;

/* =========================================================
   2. СПРАВОЧНИКИ И СОСТОЯНИЕ ПРИЛОЖЕНИЯ
   ========================================================= */
const FUND_LABELS = {
  MAIN: "Основной фонд",
  HOLIDAYS: "Праздники",
  BIRTHDAYS: "Дни рождения"
};

const FUND_ICONS = {
  MAIN: "📚",
  HOLIDAYS: "🎁",
  BIRTHDAYS: "🎂"
};

const CATEGORY_LABELS = {
  MAIN: "Основной фонд",
  HOLIDAYS: "Праздники",
  BIRTHDAYS: "Дни рождения",
  HOUSEHOLD: "Хозяйственные нужды",
  EXCURSIONS: "Экскурсии"
};

const CAMPAIGN_TYPE_LABELS = {
  MONTH: "Учебный месяц",
  HOLIDAY: "Праздник",
  OTHER: "Другой сбор"
};

const CHART_COLORS = {
  MAIN: "#3b88b5",
  HOLIDAYS: "#dd7191",
  BIRTHDAYS: "#e98b45",
  HOUSEHOLD: "#3d946a",
  EXCURSIONS: "#f2c347"
};

const CAMPAIGN_TEMPLATES = {
  monthly: { icon: "📅", type: "MONTH", fund: "MAIN", name: () => `Ежемесячный сбор — ${monthYearLabel(nextMonthIso())}` },
  holiday: { icon: "🎁", type: "HOLIDAY", fund: "HOLIDAYS", name: () => "Праздничный сбор" },
  birthday: { icon: "🎂", type: "OTHER", fund: "BIRTHDAYS", name: () => "Дни рождения" },
  excursion: { icon: "🚌", type: "OTHER", fund: "MAIN", name: () => "Экскурсия" },
  household: { icon: "🎨", type: "OTHER", fund: "MAIN", name: () => "Хозяйственные нужды" }
};

const state = {
  session: null,
  user: null,
  isAdmin: false,
  students: [],
  campaigns: [],
  contributions: [],
  expenses: [],
  backups: [],
  selectedCampaignId: null,
  studentSearch: "",
  expenseSearch: "",
  expenseMonthFilter: "ALL",
  campaignSearch: "",
  expenseCategoryFilter: "ALL",
  lastUndoBackupId: null,
  undoNoticeUntil: 0,
  advancedFeaturesReady: false,
  realtimeChannel: null,
  realtimeRefreshTimer: null,
  noticeTimer: null,
  installPrompt: null,
  authStateConfirmed: false,
  loadedSessionUserId: null
};

const dom = {};

/* =========================================================
   3. ЗАПУСК ПРИЛОЖЕНИЯ
   ========================================================= */
document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheDom();
  setProtectedAccess(false);
  fillStaticSelects();
  bindEvents();
  applySeasonalTheme();
  setupInstallExperience();
  registerServiceWorker();

  const authWatchdog = window.setTimeout(() => {
    if (state.authStateConfirmed) return;
    setProtectedAccess(false);
    showAuthError("Проверка входа заняла слишком много времени. Форма оставлена доступной — попробуйте войти ещё раз.");
  }, 7000);

  try {
    if (!db) {
      showConfigWarning();
      return;
    }

    // Subscribe first: Supabase emits INITIAL_SESSION from its persisted session.
    // The page remains locked until this confirmation arrives.
    db.auth.onAuthStateChange((event, session) => {
      if (event === "TOKEN_REFRESHED" && state.authStateConfirmed && session?.user?.id === state.user?.id) {
        state.session = session;
        return;
      }
      state.authStateConfirmed = true;
      window.setTimeout(() => handleSession(session), 0);
    });

    const { data, error } = await db.auth.getSession();
    if (error) {
      showAuthError(`Не удалось проверить авторизацию: ${error.message}`);
      return;
    }

    // Fallback for environments where INITIAL_SESSION is delayed or unavailable.
    if (!state.authStateConfirmed) {
      state.authStateConfirmed = true;
      await handleSession(data.session);
    }
  } finally {
    window.clearTimeout(authWatchdog);
    hideLoadingScreen();
  }
}

function cacheDom() {
  const ids = [
    "loadingScreen", "authGate", "protectedContent", "googleLoginButton", "logoutButton", "configWarning", "authError",
    "globalNotice", "userName", "userAvatar", "roleBadge", "settingsNavButton", "lastUpdated",
    "seasonDecor", "seasonBadge", "installAppButton", "installHelpModal", "installInstructions",
    "totalCollected", "totalSpent", "totalBalance", "fundCards", "currentCampaignSummary",
    "fundExpenseChart", "categoryExpenseChart", "reportMonthSelect", "downloadCsvButton", "printReportButton", "printReport",
    "recentExpenses", "campaignSelect", "campaignTypeTag", "selectedCampaignName",
    "selectedCampaignMeta", "campaignPlanTotal", "campaignCollectedTotal", "editModeText",
    "contributionsTableBody", "contributionsPlanFooter", "contributionsPaidFooter", "studentSearchInput",
    "expenseFilters", "expensesTableBody", "expensesFooter", "openExpenseModalButton",
    "expenseSearchInput", "expenseMonthFilter", "clearExpenseFiltersButton",
    "expenseModal", "expenseForm", "expenseModalTitle", "expenseId", "expenseDate",
    "expenseAmount", "expenseDescription", "expenseCategory", "expenseFund", "expenseReceiptUrl",
    "expenseReceiptPath", "expenseReceiptFile", "expenseReceiptStatus",
    "expenseFormError", "saveExpenseButton", "openCampaignModalButton", "campaignModal",
    "campaignForm", "campaignModalTitle", "campaignId", "campaignName", "campaignType",
    "campaignFund", "campaignExpectedAmount", "campaignSortOrder", "campaignIsOpen",
    "campaignFormError", "saveCampaignButton", "campaignsTableBody", "campaignSearchInput", "campaignTemplates",
    "createBackupButton", "exportBackupButton", "restoreBackupInput", "backupList", "receiptPreviewModal",
    "receiptPreviewContent", "openReceiptExternal"
  ];

  ids.forEach((id) => { dom[id] = document.getElementById(id); });
  dom.navButtons = [...document.querySelectorAll(".nav-button")];
}

function fillStaticSelects() {
  if (dom.expenseCategory) setSelectOptions(dom.expenseCategory, CATEGORY_LABELS);
  if (dom.expenseFund) setSelectOptions(dom.expenseFund, FUND_LABELS);
  if (dom.campaignType) setSelectOptions(dom.campaignType, CAMPAIGN_TYPE_LABELS);
  if (dom.campaignFund) setSelectOptions(dom.campaignFund, FUND_LABELS);
}

function setSelectOptions(select, options) {
  select.replaceChildren(...Object.entries(options).map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
}

function bindEvents() {
  if (dom.googleLoginButton) dom.googleLoginButton.addEventListener("click", loginWithGoogle);
  if (dom.logoutButton) dom.logoutButton.addEventListener("click", logout);
  if (dom.campaignSelect) {
    dom.campaignSelect.addEventListener("change", () => {
      state.selectedCampaignId = dom.campaignSelect.value || null;
      renderContributions();
    });
  }

  dom.navButtons.forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  if (dom.expenseFilters) {
    dom.expenseFilters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-category]");
      if (!button) return;
      state.expenseCategoryFilter = button.dataset.category;
      dom.expenseFilters.querySelectorAll(".filter-chip").forEach((chip) => {
        chip.classList.toggle("active", chip === button);
      });
      renderExpenses();
    });
  }

  if (dom.studentSearchInput) dom.studentSearchInput.addEventListener("input", () => {
    state.studentSearch = dom.studentSearchInput.value;
    renderContributions();
  });
  if (dom.expenseSearchInput) dom.expenseSearchInput.addEventListener("input", () => {
    state.expenseSearch = dom.expenseSearchInput.value;
    renderExpenses();
  });
  if (dom.expenseMonthFilter) dom.expenseMonthFilter.addEventListener("change", () => {
    state.expenseMonthFilter = dom.expenseMonthFilter.value;
    renderExpenses();
  });
  if (dom.clearExpenseFiltersButton) dom.clearExpenseFiltersButton.addEventListener("click", clearExpenseFilters);
  if (dom.campaignSearchInput) dom.campaignSearchInput.addEventListener("input", () => {
    state.campaignSearch = dom.campaignSearchInput.value;
    renderCampaignSettings();
  });
  if (dom.campaignTemplates) dom.campaignTemplates.addEventListener("click", (event) => {
    const button = event.target.closest("[data-template]");
    if (button) openCampaignModal(null, button.dataset.template);
  });
  if (dom.reportMonthSelect) dom.reportMonthSelect.addEventListener("change", renderPrintableReport);
  if (dom.downloadCsvButton) dom.downloadCsvButton.addEventListener("click", downloadMonthlyCsv);
  if (dom.printReportButton) dom.printReportButton.addEventListener("click", printMonthlyReport);
  if (dom.createBackupButton) dom.createBackupButton.addEventListener("click", createManualBackup);
  if (dom.exportBackupButton) dom.exportBackupButton.addEventListener("click", exportBackupJson);
  if (dom.restoreBackupInput) dom.restoreBackupInput.addEventListener("change", restoreBackupFromFile);
  if (dom.backupList) dom.backupList.addEventListener("click", handleBackupAction);

  if (dom.openExpenseModalButton) dom.openExpenseModalButton.addEventListener("click", () => openExpenseModal());
  if (dom.openCampaignModalButton) dom.openCampaignModalButton.addEventListener("click", () => openCampaignModal());
  if (dom.expenseForm) dom.expenseForm.addEventListener("submit", saveExpense);
  if (dom.campaignForm) dom.campaignForm.addEventListener("submit", saveCampaign);
  if (dom.installAppButton) dom.installAppButton.addEventListener("click", installApp);
  if (dom.contributionsTableBody) dom.contributionsTableBody.addEventListener("change", handleContributionChange);
  if (dom.expensesTableBody) dom.expensesTableBody.addEventListener("click", handleExpenseAction);
  if (dom.campaignsTableBody) dom.campaignsTableBody.addEventListener("click", handleCampaignAction);

  document.querySelectorAll("[data-close-modal]").forEach((button) => {
    button.addEventListener("click", () => closeModal(button.dataset.closeModal));
  });

  [dom.expenseModal, dom.campaignModal, dom.receiptPreviewModal, dom.installHelpModal].forEach((dialog) => {
    if (dialog) {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
    }
  });
}

/* =========================================================
   4. АВТОРИЗАЦИЯ И РОЛИ
   ========================================================= */
async function loginWithGoogle() {
  if (!db) return showConfigWarning();

  if (dom.googleLoginButton) setButtonLoading(dom.googleLoginButton, true, "Переходим в Google…");
  const { error } = await db.auth.signInWithOAuth({
    provider: "google",
    options: {
      // Preserve the GitHub Pages path but never send stale OAuth query/hash values back.
      redirectTo: getOAuthRedirectUrl()
    }
  });

  if (error) {
    if (dom.googleLoginButton) setButtonLoading(dom.googleLoginButton, false);
    showAuthError(`Ошибка входа: ${error.message}`);
  }
}

function getOAuthRedirectUrl() {
  const redirectUrl = new URL(`${window.location.origin}${window.location.pathname}`);
  redirectUrl.search = "";
  redirectUrl.hash = "";
  return redirectUrl.toString();
}

async function logout() {
  if (!db) return;
  if (!state.session) {
    loginWithGoogle();
    return;
  }
  if (dom.logoutButton) setButtonLoading(dom.logoutButton, true, "Выходим…");
  const { error } = await db.auth.signOut();
  if (dom.logoutButton) setButtonLoading(dom.logoutButton, false);
  if (error) showNotice(`Не удалось выйти: ${error.message}`, "error");
}

async function handleSession(session) {
  state.session = session;
  state.user = session?.user ?? null;

  if (!session) {
    state.isAdmin = false;
    state.loadedSessionUserId = null;
    setProtectedAccess(false);
    renderUser();
    return;
  }

  renderUser();
  state.isAdmin = false;
  applyRoleToUi();
  setProtectedAccess(true);
  showNotice("Вход выполнен. Загружаем данные класса…", "info", 0);

  try {
    const { data: isAdminData } = await db.rpc("is_admin");
    state.isAdmin = isAdminData === true;
  } catch (error) {
    console.error(error);
    state.isAdmin = false;
  }

  try {
    applyRoleToUi();
    if (state.loadedSessionUserId !== session.user.id) {
      state.loadedSessionUserId = session.user.id;
      await loadAllData();
      subscribeRealtime();
    }
    setProtectedAccess(true);
  } catch (error) {
    console.error(error);
    state.loadedSessionUserId = null;
    setProtectedAccess(true);
    showNotice(`Вход выполнен, но данные пока не загрузились: ${friendlyError(error)}. Проверьте интернет и обновите страницу.`, "error", 0);
  }
}

function setProtectedAccess(hasSession) {
  if (dom.authGate) {
    dom.authGate.classList.toggle("hidden", hasSession);
    dom.authGate.style.setProperty("display", hasSession ? "none" : "grid", "important");
  }
  if (dom.protectedContent) {
    dom.protectedContent.classList.toggle("is-authenticated", hasSession);
    dom.protectedContent.style.setProperty("display", hasSession ? "block" : "none", "important");
  }
}

function renderUser() {
  if (!state.user) {
    if (dom.userName) dom.userName.textContent = "Гость";
    if (dom.userAvatar) dom.userAvatar.classList.add("hidden");
    if (dom.logoutButton) dom.logoutButton.textContent = "Войти";
    return;
  }

  if (dom.logoutButton) dom.logoutButton.textContent = "Выйти";
  const metadata = state.user?.user_metadata ?? {};
  if (dom.userName) dom.userName.textContent = metadata.full_name || metadata.name || state.user?.email || "Пользователь";

  const avatarUrl = safeHttpsUrl(metadata.avatar_url || metadata.picture);
  if (avatarUrl) {
    if (dom.userAvatar) {
      dom.userAvatar.src = avatarUrl;
      dom.userAvatar.classList.remove("hidden");
    }
  } else {
    if (dom.userAvatar) {
      dom.userAvatar.removeAttribute("src");
      dom.userAvatar.classList.add("hidden");
    }
  }
}

function applyRoleToUi() {
  if (dom.roleBadge) {
    if (!state.session) {
      dom.roleBadge.textContent = "Гость · просмотр";
    } else {
      dom.roleBadge.textContent = state.isAdmin ? "Администратор · редактирование" : "Родитель · просмотр";
    }
  }

  if (dom.editModeText) {
    dom.editModeText.textContent = state.isAdmin
      ? "Режим администратора: суммы можно изменять"
      : "Режим просмотра: редактирование недоступно";
  }

  document.querySelectorAll(".admin-only").forEach((element) => {
    element.classList.toggle("hidden", !state.isAdmin);
  });

  const settingsView = document.getElementById("view-settings");
  if (!state.isAdmin && settingsView && settingsView.classList.contains("active")) {
    switchView("summary");
  }
}

/* =========================================================
   5. ЗАГРУЗКА И REALTIME-ОБНОВЛЕНИЯ
   ========================================================= */
async function loadAllData({ silent = false } = {}) {
  if (!silent) showNotice("Загружаем свежие данные…", "info", 0);

  const [studentsResult, campaignsResult, contributionsResult, expensesResult] = await Promise.all([
    db.from("students").select("id, full_name, sort_order, is_active, created_at, updated_at").eq("is_active", true).order("sort_order"),
    db.from("campaigns").select("id, name, campaign_type, fund, expected_amount, is_open, sort_order, created_at, updated_at").order("sort_order"),
    db.from("contributions").select("id, student_id, campaign_id, amount, created_at, updated_at"),
    fetchExpenses()
  ]);

  const failed = [studentsResult, campaignsResult, contributionsResult, expensesResult].find((result) => result.error);
  if (failed) throw failed.error;

  state.students = studentsResult.data ?? [];
  state.campaigns = campaignsResult.data ?? [];
  state.contributions = contributionsResult.data ?? [];
  state.expenses = expensesResult.data ?? [];

  if (state.isAdmin) {
    const { data: backups, error: backupsError } = await fetchBackups();
    if (backupsError) throw backupsError;
    state.backups = backups ?? [];
  } else {
    state.backups = [];
  }

  if (!state.campaigns.some((item) => item.id === state.selectedCampaignId)) {
    state.selectedCampaignId = state.campaigns.find((item) => item.is_open)?.id ?? state.campaigns[0]?.id ?? null;
  }

  renderAll();
  if (!silent) hideNotice();
}

async function fetchBackups() {
  const result = await db.from("budget_backups")
    .select("id, backup_type, record_count, created_by, created_at")
    .neq("backup_type", "undo")
    .order("created_at", { ascending: false })
    .limit(12);
  if (result.error && /budget_backups|does not exist/i.test(result.error.message || "")) return { data: [], error: null };
  return result;
}

async function fetchExpenses() {
  const fields = "id, expense_date, description, category, fund, amount, receipt_url, receipt_path, created_at, updated_at";
  const result = await db.from("expenses").select(fields).order("expense_date", { ascending: false }).order("created_at", { ascending: false });
  if (!result.error) {
    state.advancedFeaturesReady = true;
    return result;
  }
  if (!/receipt_path|column .* does not exist/i.test(result.error.message || "")) return result;
  state.advancedFeaturesReady = false;

  // До запуска upgrade-features.sql продолжаем показывать старые записи без загрузки чеков.
  const fallback = await db.from("expenses").select("id, expense_date, description, category, fund, amount, receipt_url, created_at, updated_at").order("expense_date", { ascending: false }).order("created_at", { ascending: false });
  return { ...fallback, data: (fallback.data || []).map((expense) => ({ ...expense, receipt_path: null })) };
}

function subscribeRealtime() {
  unsubscribeRealtime();

  state.realtimeChannel = db
    .channel("class-budget-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "contributions" }, scheduleRealtimeRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "expenses" }, scheduleRealtimeRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "campaigns" }, scheduleRealtimeRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "students" }, scheduleRealtimeRefresh)
    .subscribe();
}

function unsubscribeRealtime() {
  if (db && state.realtimeChannel) db.removeChannel(state.realtimeChannel);
  state.realtimeChannel = null;
}

function scheduleRealtimeRefresh() {
  window.clearTimeout(state.realtimeRefreshTimer);
  state.realtimeRefreshTimer = window.setTimeout(async () => {
    try {
      await loadAllData({ silent: true });
      if (Date.now() >= state.undoNoticeUntil) showNotice("Данные обновлены онлайн ✓", "info", 1800);
    } catch (error) {
      console.error("Realtime refresh error:", error);
    }
  }, 250);
}

/* =========================================================
   6. РЕНДЕРИНГ СВОДКИ И РАСЧЁТЫ
   ========================================================= */
function renderAll() {
  renderCampaignSelect();
  renderSummary();
  renderContributions();
  renderExpenses();
  renderCampaignSettings();
  renderBackupList();
  renderReportMonthOptions();
  renderPrintableReport();
  if (dom.lastUpdated) {
    dom.lastUpdated.textContent = `Обновлено: ${new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
  }
}

function renderSummary() {
  const collectedByFund = sumByFund(state.contributions);
  const spentByFund = sumByFund(state.expenses);
  const totalCollected = sum(state.contributions.map((item) => item.amount));
  const totalSpent = sum(state.expenses.map((item) => item.amount));
  const totalBalance = totalCollected - totalSpent;

  if (dom.totalCollected) animateMoney(dom.totalCollected, totalCollected);
  if (dom.totalSpent) animateMoney(dom.totalSpent, totalSpent);
  if (dom.totalBalance) {
    animateMoney(dom.totalBalance, totalBalance);
    dom.totalBalance.style.color = totalBalance < 0 ? "#ff9f9f" : "";
  }

  if (dom.fundCards) {
    dom.fundCards.replaceChildren(...Object.keys(FUND_LABELS).map((fund) => {
      const collected = collectedByFund[fund] ?? 0;
      const spent = spentByFund[fund] ?? 0;
      const balance = collected - spent;
      const card = el("article", "fund-card");
      card.append(
        el("p", "", `${FUND_ICONS[fund]} ${FUND_LABELS[fund]}`),
        el("strong", "", formatMoney(balance)),
        el("small", "", `Собрано ${formatMoney(collected)} · Потрачено ${formatMoney(spent)}`)
      );
      return card;
    }));
  }

  renderCurrentCampaignSummary();
  renderRecentExpenses();
  renderExpenseCharts();
}

function sumByFund(items) {
  const result = { MAIN: 0, HOLIDAYS: 0, BIRTHDAYS: 0 };
  items.forEach((item) => {
    const fund = item.fund || state.campaigns.find((campaign) => campaign.id === item.campaign_id)?.fund;
    if (fund in result) result[fund] += toNumber(item.amount);
  });
  return result;
}

function renderCurrentCampaignSummary() {
  if (!dom.currentCampaignSummary) return;
  const campaign = state.campaigns.find((item) => item.is_open) ?? null;
  dom.currentCampaignSummary.replaceChildren();

  if (!campaign) {
    dom.currentCampaignSummary.className = "campaign-summary empty-state";
    dom.currentCampaignSummary.append(createEmptyContent(
      "🎯",
      "Открытых сборов пока нет",
      "Новая цель появится здесь сразу после открытия сбора."
    ));
    return;
  }

  const contributions = getCampaignContributions(campaign.id);
  const plan = toNumber(campaign.expected_amount) * state.students.length;
  const collected = sum(contributions.map((item) => item.amount));
  const percent = plan > 0 ? Math.min(100, Math.round((collected / plan) * 100)) : 0;
  const paidCount = state.students.filter((student) => getStudentStatus(student.id, campaign).key === "paid").length;
  const remaining = Math.max(0, plan - collected);

  const heading = el("div", "campaign-progress-heading");
  const identity = el("div", "campaign-progress-identity");
  identity.append(
    el("span", "campaign-progress-icon", FUND_ICONS[campaign.fund] || "🎯"),
    (() => {
      const copy = el("div");
      copy.append(
        el("strong", "", campaign.name),
        el("small", "", FUND_LABELS[campaign.fund] || "Классный сбор")
      );
      return copy;
    })()
  );
  heading.append(identity, el("span", "campaign-percent", `${percent}%`));

  const track = el("div", "progress-track");
  const bar = el("div", "progress-bar");
  bar.style.width = `${percent}%`;
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", `Собрано ${percent}%`);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", String(percent));
  track.append(bar);

  const stats = el("div", "campaign-progress-stats");
  stats.append(
    createProgressStat("Собрано", formatMoney(collected), "💰"),
    createProgressStat("Осталось", formatMoney(remaining), "🏁"),
    createProgressStat("Сдали полностью", `${paidCount} из ${state.students.length}`, "⭐")
  );
  dom.currentCampaignSummary.className = "campaign-summary";
  dom.currentCampaignSummary.append(heading, track, stats);
}

function renderRecentExpenses() {
  if (!dom.recentExpenses) return;
  dom.recentExpenses.replaceChildren();
  const recent = state.expenses.slice(0, 4);

  if (!recent.length) {
    dom.recentExpenses.className = "compact-list empty-state";
    dom.recentExpenses.append(createEmptyContent(
      "✨",
      "Расходов пока нет",
      "Копилка в порядке — новые записи появятся здесь."
    ));
    return;
  }

  dom.recentExpenses.className = "compact-list";
  recent.forEach((expense) => {
    const item = el("div", "compact-expense");
    item.append(
      el("span", "compact-expense-icon", FUND_ICONS[expense.fund] || "🧾"),
      (() => {
        const copy = el("div");
        copy.append(el("p", "", expense.description), el("small", "", formatDate(expense.expense_date)));
        return copy;
      })(),
      el("strong", "", `−${formatMoney(expense.amount)}`)
    );
    dom.recentExpenses.append(item);
  });
}

function renderExpenseCharts() {
  renderDonutChart(dom.fundExpenseChart, groupTotals(state.expenses, "fund"), FUND_LABELS);
  renderDonutChart(dom.categoryExpenseChart, groupTotals(state.expenses, "category"), CATEGORY_LABELS);
}

function groupTotals(items, key) {
  return items.reduce((totals, item) => {
    const group = item[key];
    totals[group] = (totals[group] || 0) + toNumber(item.amount);
    return totals;
  }, {});
}

function renderDonutChart(container, totals, labels) {
  if (!container) return;
  container.replaceChildren();
  const entries = Object.entries(totals).filter(([, value]) => value > 0);
  const total = sum(entries.map(([, value]) => value));

  if (!entries.length) {
    container.append(createEmptyContent("🎨", "Пока нет данных", "Диаграмма появится после первого расхода."));
    return;
  }

  let cursor = 0;
  const slices = entries.map(([key, value]) => {
    const start = cursor;
    cursor += (value / total) * 100;
    return `${CHART_COLORS[key] || "#78909c"} ${start}% ${cursor}%`;
  });

  const donut = el("div", "donut-chart");
  donut.style.background = `conic-gradient(${slices.join(", ")})`;
  donut.setAttribute("role", "img");
  donut.setAttribute("aria-label", entries.map(([key, value]) => `${labels[key] || key}: ${formatMoney(value)}`).join(", "));
  const center = el("div", "donut-center");
  center.append(el("small", "", "Всего"), el("strong", "", formatMoney(total)));
  donut.append(center);

  const legend = el("div", "chart-legend");
  entries.sort((a, b) => b[1] - a[1]).forEach(([key, value]) => {
    const item = el("div", "chart-legend-item");
    const label = el("span", "chart-legend-label");
    const dot = el("i", "chart-dot");
    dot.style.background = CHART_COLORS[key] || "#78909c";
    label.append(dot, document.createTextNode(labels[key] || key));
    item.append(label, el("strong", "", `${Math.round((value / total) * 100)}%`), el("small", "", formatMoney(value)));
    legend.append(item);
  });
  container.append(donut, legend);
}

/* =========================================================
   7. ТАБЛИЦА ВЗНОСОВ И АВТОМАТИЧЕСКИЕ СТАТУСЫ
   ========================================================= */
function renderCampaignSelect() {
  if (!dom.campaignSelect) return;
  dom.campaignSelect.replaceChildren(...state.campaigns.map((campaign) => {
    const option = document.createElement("option");
    option.value = campaign.id;
    option.textContent = `${campaign.is_open ? "🟢" : "⚪"} ${campaign.name}`;
    option.selected = campaign.id === state.selectedCampaignId;
    return option;
  }));
  dom.campaignSelect.disabled = state.campaigns.length === 0;
}

function renderContributions() {
  if (!dom.contributionsTableBody) return;
  const campaign = getSelectedCampaign();
  dom.contributionsTableBody.replaceChildren();

  if (!campaign) {
    if (dom.selectedCampaignName) dom.selectedCampaignName.textContent = "Сборы не созданы";
    if (dom.selectedCampaignMeta) dom.selectedCampaignMeta.textContent = "Администратор может добавить первый сбор в настройках.";
    if (dom.campaignTypeTag) dom.campaignTypeTag.textContent = "Нет данных";
    setContributionTotals(0, 0);
    appendEmptyTableRow(dom.contributionsTableBody, 5, "Сборов пока нет.");
    return;
  }

  if (dom.campaignTypeTag) dom.campaignTypeTag.textContent = CAMPAIGN_TYPE_LABELS[campaign.campaign_type] ?? "Сбор";
  if (dom.selectedCampaignName) dom.selectedCampaignName.textContent = campaign.name;
  if (dom.selectedCampaignMeta) dom.selectedCampaignMeta.textContent = `${FUND_LABELS[campaign.fund]} · ${campaign.is_open ? "сбор открыт" : "сборы не открыты"}`;

  const query = normalizeSearch(state.studentSearch);
  const visibleStudents = query
    ? state.students.filter((student) => normalizeSearch(student.full_name).includes(query))
    : state.students;
  let paidTotal = 0;
  visibleStudents.forEach((student) => {
    const contribution = getContribution(student.id, campaign.id);
    const amount = toNumber(contribution?.amount);
    paidTotal += amount;
    const status = getStudentStatus(student.id, campaign);
    const row = document.createElement("tr");

    row.append(
      labeledCell("Номер", String(state.students.indexOf(student) + 1)),
      labeledCell("Ученик", student.full_name, "student-name"),
      labeledCell("План", formatMoney(campaign.expected_amount)),
      createContributionInputCell(student, campaign, amount),
      (() => {
        const cell = document.createElement("td");
        cell.dataset.label = "Статус";
        cell.append(el("span", `status status-${status.key}`, status.label));
        return cell;
      })()
    );
    dom.contributionsTableBody.append(row);
  });

  if (!visibleStudents.length) appendEmptyTableRow(dom.contributionsTableBody, 5, "Ученик не найден.");
  setContributionTotals(toNumber(campaign.expected_amount) * visibleStudents.length, paidTotal);
}

function createContributionInputCell(student, campaign, amount) {
  const cell = document.createElement("td");
  cell.dataset.label = "Внесено";
  const input = document.createElement("input");
  input.className = "money-input";
  input.type = "number";
  input.min = "0";
  input.step = "0.01";
  input.inputMode = "decimal";
  input.value = amount ? String(amount) : "0";
  input.disabled = !state.isAdmin;
  input.setAttribute("aria-label", `Взнос: ${student.full_name}`);
  input.dataset.studentId = student.id;
  input.dataset.campaignId = campaign.id;
  input.dataset.previousValue = String(amount);
  cell.append(input);
  return cell;
}

function setContributionTotals(plan, collected) {
  if (dom.campaignPlanTotal) dom.campaignPlanTotal.textContent = formatMoney(plan);
  if (dom.campaignCollectedTotal) dom.campaignCollectedTotal.textContent = formatMoney(collected);
  if (dom.contributionsPlanFooter) dom.contributionsPlanFooter.textContent = formatMoney(plan);
  if (dom.contributionsPaidFooter) dom.contributionsPaidFooter.textContent = formatMoney(collected);
}

function getStudentStatus(studentId, campaign) {
  if (!campaign.is_open) return { key: "closed", label: "⏳ Сборы не открыты" };
  const amount = toNumber(getContribution(studentId, campaign.id)?.amount);
  const expected = toNumber(campaign.expected_amount);
  if (expected === 0 || amount >= expected) return { key: "paid", label: "✓ Сдал" };
  if (amount > 0) return { key: "partial", label: "⚠ Частично" };
  return { key: "debt", label: "✗ Должник" };
}

async function handleContributionChange(event) {
  const input = event.target.closest(".money-input");
  if (!input || !state.isAdmin) return;

  const amount = Math.max(0, toNumber(input.value));
  const previousValue = input.dataset.previousValue;
  input.value = String(amount);
  input.disabled = true;

  const undoBackupId = await createUndoPoint();

  const { data, error } = await db
    .from("contributions")
    .upsert({
      student_id: input.dataset.studentId,
      campaign_id: input.dataset.campaignId,
      amount
    }, { onConflict: "student_id,campaign_id" })
    .select("id, student_id, campaign_id, amount, created_at, updated_at")
    .single();

  input.disabled = false;
  if (error) {
    input.value = previousValue;
    showNotice(`Взнос не сохранён: ${friendlyError(error)}`, "error");
    return;
  }

  const existingIndex = state.contributions.findIndex((item) =>
    item.student_id === data.student_id && item.campaign_id === data.campaign_id
  );
  if (existingIndex >= 0) state.contributions[existingIndex] = data;
  else state.contributions.push(data);

  renderSummary();
  renderContributions();
  showUndoNotice("Сумма сохранена ✓", undoBackupId);
}

function getSelectedCampaign() {
  return state.campaigns.find((item) => item.id === state.selectedCampaignId) ?? null;
}

function getCampaignContributions(campaignId) {
  return state.contributions.filter((item) => item.campaign_id === campaignId);
}

function getContribution(studentId, campaignId) {
  return state.contributions.find((item) => item.student_id === studentId && item.campaign_id === campaignId);
}

/* =========================================================
   8. РАСХОДЫ И ССЫЛКИ НА ЧЕКИ
   ========================================================= */
function renderExpenses() {
  if (!dom.expensesTableBody) return;
  dom.expensesTableBody.replaceChildren();
  const query = normalizeSearch(state.expenseSearch);
  const filtered = state.expenses.filter((expense) => {
    const categoryMatches = state.expenseCategoryFilter === "ALL" || expense.category === state.expenseCategoryFilter;
    const monthMatches = state.expenseMonthFilter === "ALL" || expense.expense_date?.startsWith(state.expenseMonthFilter);
    const searchMatches = !query || normalizeSearch(`${expense.description} ${CATEGORY_LABELS[expense.category] || ""} ${FUND_LABELS[expense.fund] || ""}`).includes(query);
    return categoryMatches && monthMatches && searchMatches;
  });

  if (!filtered.length) {
    appendEmptyTableRow(dom.expensesTableBody, state.isAdmin ? 7 : 6, "По выбранному фильтру расходов нет.");
  }

  filtered.forEach((expense) => {
    const row = document.createElement("tr");
    row.append(
      labeledCell("Дата", formatDate(expense.expense_date)),
      labeledCell("Описание", expense.description, "expense-description"),
      labeledCell("Категория", CATEGORY_LABELS[expense.category] ?? expense.category),
      labeledCell("Фонд", FUND_LABELS[expense.fund] ?? expense.fund),
      labeledCell("Сумма", formatMoney(expense.amount), "expense-amount"),
      createReceiptCell(expense.receipt_url, expense.receipt_path)
    );

    if (state.isAdmin) row.append(createExpenseActions(expense.id));
    dom.expensesTableBody.append(row);
  });

  if (dom.expensesFooter) dom.expensesFooter.textContent = formatMoney(sum(filtered.map((item) => item.amount)));
}

function createReceiptCell(url, path) {
  const cell = document.createElement("td");
  cell.dataset.label = "Чек";
  const safeUrl = safeHttpsUrl(url);
  if (!safeUrl && !path) {
    cell.textContent = "—";
    return cell;
  }

  const link = el("a", "receipt-link", "🧾 Чек / Фото");
  link.href = safeUrl || "#";
  if (safeUrl) link.dataset.receiptUrl = safeUrl;
  if (path) link.dataset.receiptPath = path;
  cell.append(link);
  return cell;
}

function createExpenseActions(id) {
  const cell = document.createElement("td");
  cell.dataset.label = "Действия";
  const wrapper = el("div", "row-actions");
  const editButton = el("button", "action-button action-edit", "Изменить");
  editButton.type = "button";
  editButton.dataset.action = "edit-expense";
  editButton.dataset.id = id;
  const deleteButton = el("button", "action-button action-delete", "Удалить");
  deleteButton.type = "button";
  deleteButton.dataset.action = "delete-expense";
  deleteButton.dataset.id = id;
  wrapper.append(editButton, deleteButton);
  cell.append(wrapper);
  return cell;
}

function openExpenseModal(expense = null) {
  if (!state.isAdmin) return;
  dom.expenseForm.reset();
  hideElement(dom.expenseFormError);
  dom.expenseId.value = expense?.id ?? "";
  dom.expenseModalTitle.textContent = expense ? "Изменить расход" : "Добавить расход";
  dom.expenseDate.value = expense?.expense_date ?? todayIso();
  dom.expenseAmount.value = expense?.amount ?? "";
  dom.expenseDescription.value = expense?.description ?? "";
  dom.expenseCategory.value = expense?.category ?? "MAIN";
  dom.expenseFund.value = expense?.fund ?? "MAIN";
  dom.expenseReceiptUrl.value = expense?.receipt_url ?? "";
  dom.expenseReceiptPath.value = expense?.receipt_path ?? "";
  dom.expenseReceiptFile.value = "";
  dom.expenseReceiptStatus.textContent = expense?.receipt_path
    ? "✓ Чек уже загружен. Выберите новый файл, чтобы заменить его."
    : "Фото JPG/PNG/WebP или PDF, не больше 10 МБ";
  dom.expenseModal.showModal();
}

async function saveExpense(event) {
  event.preventDefault();
  if (!state.isAdmin) return;

  const receiptUrl = dom.expenseReceiptUrl.value.trim();
  if (receiptUrl && !safeHttpsUrl(receiptUrl)) {
    return showElementError(dom.expenseFormError, "Ссылка на чек должна быть корректным адресом https://");
  }

  const payload = {
    expense_date: dom.expenseDate.value,
    description: dom.expenseDescription.value.trim(),
    category: dom.expenseCategory.value,
    fund: dom.expenseFund.value,
    amount: toNumber(dom.expenseAmount.value),
    receipt_url: receiptUrl || null
  };
  if (state.advancedFeaturesReady) payload.receipt_path = dom.expenseReceiptPath.value || null;

  if (!payload.description || payload.amount <= 0 || !payload.expense_date) {
    return showElementError(dom.expenseFormError, "Заполните дату, описание и положительную сумму.");
  }

  const receiptFile = dom.expenseReceiptFile.files?.[0] ?? null;
  if (receiptFile && !state.advancedFeaturesReady) {
    return showElementError(dom.expenseFormError, "Сначала выполните файл upgrade-features.sql в Supabase.");
  }
  const fileError = validateReceiptFile(receiptFile);
  if (fileError) return showElementError(dom.expenseFormError, fileError);

  setButtonLoading(dom.saveExpenseButton, true, receiptFile ? "Загружаем чек…" : "Сохраняем…");
  const id = dom.expenseId.value;
  const undoBackupId = await createUndoPoint();
  let uploadedPath = null;

  if (receiptFile) {
    const uploadResult = await uploadReceipt(receiptFile);
    if (uploadResult.error) {
      setButtonLoading(dom.saveExpenseButton, false);
      return showElementError(dom.expenseFormError, `Не удалось загрузить чек: ${friendlyError(uploadResult.error)}`);
    }
    uploadedPath = uploadResult.path;
    payload.receipt_path = uploadedPath;
  }

  const query = id
    ? db.from("expenses").update(payload).eq("id", id)
    : db.from("expenses").insert(payload);
  const { error } = await query;
  setButtonLoading(dom.saveExpenseButton, false);

  if (error) {
    if (uploadedPath) await db.storage.from("class-receipts").remove([uploadedPath]);
    return showElementError(dom.expenseFormError, `Не удалось сохранить: ${friendlyError(error)}`);
  }
  dom.expenseModal.close();
  await loadAllData({ silent: true });
  showUndoNotice("Расход сохранён ✓", undoBackupId);
}

async function handleExpenseAction(event) {
  const receiptLink = event.target.closest("[data-receipt-url], [data-receipt-path]");
  if (receiptLink) {
    event.preventDefault();
    if (receiptLink.dataset.receiptPath) {
      const { data, error } = await db.storage.from("class-receipts").createSignedUrl(receiptLink.dataset.receiptPath, 900);
      if (error || !data?.signedUrl) return showNotice(`Чек не открылся: ${friendlyError(error)}`, "error");
      openReceiptPreview(data.signedUrl);
    } else {
      openReceiptPreview(receiptLink.dataset.receiptUrl);
    }
    return;
  }

  if (!state.isAdmin) return;
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const expense = state.expenses.find((item) => item.id === button.dataset.id);
  if (!expense) return;

  if (button.dataset.action === "edit-expense") openExpenseModal(expense);
  if (button.dataset.action === "delete-expense") {
    if (!window.confirm(`Удалить расход «${expense.description}» на сумму ${formatMoney(expense.amount)}?`)) return;
    button.disabled = true;
    const undoBackupId = await createUndoPoint();
    const { error } = await db.from("expenses").delete().eq("id", expense.id);
    if (error) return showNotice(`Не удалось удалить: ${friendlyError(error)}`, "error");
    await loadAllData({ silent: true });
    showUndoNotice("Расход удалён", undoBackupId);
  }
}

function clearExpenseFilters() {
  state.expenseCategoryFilter = "ALL";
  state.expenseSearch = "";
  state.expenseMonthFilter = "ALL";
  if (dom.expenseSearchInput) dom.expenseSearchInput.value = "";
  if (dom.expenseMonthFilter) dom.expenseMonthFilter.value = "ALL";
  dom.expenseFilters?.querySelectorAll(".filter-chip").forEach((chip) => chip.classList.toggle("active", chip.dataset.category === "ALL"));
  renderExpenses();
}

function validateReceiptFile(file) {
  if (!file) return null;
  const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  if (!allowed.includes(file.type)) return "Можно загрузить JPG, PNG, WebP или PDF.";
  if (file.size > 10 * 1024 * 1024) return "Файл больше 10 МБ. Уменьшите его и попробуйте снова.";
  return null;
}

async function uploadReceipt(file) {
  const extension = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "file";
  const id = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const path = `${todayIso()}/${id}.${extension.replace(/[^a-z0-9]/g, "")}`;
  const { error } = await db.storage.from("class-receipts").upload(path, file, { contentType: file.type, upsert: false });
  return { path, error };
}

/* =========================================================
   9. АДМИНИСТРИРОВАНИЕ СБОРОВ
   ========================================================= */
function renderCampaignSettings() {
  if (!dom.campaignsTableBody) return;
  dom.campaignsTableBody.replaceChildren();
  const query = normalizeSearch(state.campaignSearch);
  const visibleCampaigns = query
    ? state.campaigns.filter((campaign) => normalizeSearch(`${campaign.name} ${CAMPAIGN_TYPE_LABELS[campaign.campaign_type] || ""} ${FUND_LABELS[campaign.fund] || ""}`).includes(query))
    : state.campaigns;
  if (!visibleCampaigns.length) appendEmptyTableRow(dom.campaignsTableBody, 6, state.campaigns.length ? "Сбор не найден." : "Сборов пока нет.");

  visibleCampaigns.forEach((campaign) => {
    const row = document.createElement("tr");
    row.append(
      el("td", "", campaign.name),
      el("td", "", CAMPAIGN_TYPE_LABELS[campaign.campaign_type] ?? campaign.campaign_type),
      el("td", "", FUND_LABELS[campaign.fund] ?? campaign.fund),
      el("td", "", formatMoney(campaign.expected_amount)),
      (() => {
        const cell = document.createElement("td");
        cell.append(el("span", `status ${campaign.is_open ? "status-paid" : "status-closed"}`, campaign.is_open ? "Открыт" : "Закрыт"));
        return cell;
      })(),
      createCampaignActions(campaign.id)
    );
    dom.campaignsTableBody.append(row);
  });
}

function createCampaignActions(id) {
  const cell = document.createElement("td");
  const wrapper = el("div", "row-actions");
  const editButton = el("button", "action-button action-edit", "Изменить");
  editButton.type = "button";
  editButton.dataset.action = "edit-campaign";
  editButton.dataset.id = id;
  const deleteButton = el("button", "action-button action-delete", "Удалить");
  deleteButton.type = "button";
  deleteButton.dataset.action = "delete-campaign";
  deleteButton.dataset.id = id;
  wrapper.append(editButton, deleteButton);
  cell.append(wrapper);
  return cell;
}

function openCampaignModal(campaign = null, templateKey = null) {
  if (!state.isAdmin) return;
  const template = CAMPAIGN_TEMPLATES[templateKey] ?? null;
  dom.campaignForm.reset();
  hideElement(dom.campaignFormError);
  dom.campaignId.value = campaign?.id ?? "";
  dom.campaignModalTitle.textContent = campaign ? "Изменить сбор" : template ? `${template.icon} Новый сбор по шаблону` : "Добавить сбор";
  dom.campaignName.value = campaign?.name ?? template?.name() ?? "";
  dom.campaignType.value = campaign?.campaign_type ?? template?.type ?? "OTHER";
  dom.campaignFund.value = campaign?.fund ?? template?.fund ?? "MAIN";
  dom.campaignExpectedAmount.value = campaign?.expected_amount ?? "0";
  dom.campaignSortOrder.value = campaign?.sort_order ?? (state.campaigns.length + 1) * 10;
  dom.campaignIsOpen.checked = campaign?.is_open ?? Boolean(template);
  dom.campaignModal.showModal();
}

async function saveCampaign(event) {
  event.preventDefault();
  if (!state.isAdmin) return;

  const payload = {
    name: dom.campaignName.value.trim(),
    campaign_type: dom.campaignType.value,
    fund: dom.campaignFund.value,
    expected_amount: Math.max(0, toNumber(dom.campaignExpectedAmount.value)),
    sort_order: Math.max(0, Math.trunc(toNumber(dom.campaignSortOrder.value))),
    is_open: dom.campaignIsOpen.checked
  };

  if (!payload.name) return showElementError(dom.campaignFormError, "Введите название сбора.");

  setButtonLoading(dom.saveCampaignButton, true, "Сохраняем…");
  const id = dom.campaignId.value;
  const undoBackupId = await createUndoPoint();
  const query = id
    ? db.from("campaigns").update(payload).eq("id", id)
    : db.from("campaigns").insert(payload);
  const { error } = await query;
  setButtonLoading(dom.saveCampaignButton, false);

  if (error) return showElementError(dom.campaignFormError, `Не удалось сохранить: ${friendlyError(error)}`);
  dom.campaignModal.close();
  await loadAllData({ silent: true });
  showUndoNotice("Сбор сохранён ✓", undoBackupId);
}

async function handleCampaignAction(event) {
  if (!state.isAdmin) return;
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const campaign = state.campaigns.find((item) => item.id === button.dataset.id);
  if (!campaign) return;

  if (button.dataset.action === "edit-campaign") openCampaignModal(campaign);
  if (button.dataset.action === "delete-campaign") {
    const linkedCount = getCampaignContributions(campaign.id).length;
    const warning = linkedCount
      ? `Удалить сбор «${campaign.name}» и ${linkedCount} связанных записей о взносах?`
      : `Удалить сбор «${campaign.name}»?`;
    if (!window.confirm(warning)) return;
    button.disabled = true;
    const undoBackupId = await createUndoPoint();
    const { error } = await db.from("campaigns").delete().eq("id", campaign.id);
    if (error) return showNotice(`Не удалось удалить: ${friendlyError(error)}`, "error");
    await loadAllData({ silent: true });
    showUndoNotice("Сбор удалён", undoBackupId);
  }
}

/* =========================================================
   10. ОТЧЁТЫ, РЕЗЕРВНЫЕ КОПИИ И ОТМЕНА
   ========================================================= */
function renderReportMonthOptions() {
  const months = [...new Set([todayIso().slice(0, 7), ...state.expenses.map((item) => item.expense_date?.slice(0, 7)).filter(Boolean)])].sort().reverse();
  if (state.expenseMonthFilter !== "ALL" && !months.includes(state.expenseMonthFilter)) state.expenseMonthFilter = "ALL";
  const currentValue = dom.reportMonthSelect?.value;
  const selected = months.includes(currentValue) ? currentValue : (months.includes(todayIso().slice(0, 7)) ? todayIso().slice(0, 7) : months[0]);

  [dom.reportMonthSelect, dom.expenseMonthFilter].forEach((select) => {
    if (!select) return;
    const previous = select === dom.expenseMonthFilter ? state.expenseMonthFilter : selected;
    select.replaceChildren();
    if (select === dom.expenseMonthFilter) {
      const all = document.createElement("option");
      all.value = "ALL";
      all.textContent = "Все месяцы";
      select.append(all);
    }
    months.forEach((month) => {
      const option = document.createElement("option");
      option.value = month;
      option.textContent = monthYearLabel(month);
      select.append(option);
    });
    select.value = previous || (select === dom.expenseMonthFilter ? "ALL" : "");
  });
}

function getReportData() {
  const month = dom.reportMonthSelect?.value || todayIso().slice(0, 7);
  const expenses = state.expenses.filter((expense) => expense.expense_date?.startsWith(month));
  return {
    month,
    expenses,
    spent: sum(expenses.map((item) => item.amount)),
    collected: sum(state.contributions.map((item) => item.amount)),
    totalSpent: sum(state.expenses.map((item) => item.amount))
  };
}

function renderPrintableReport() {
  if (!dom.printReport) return;
  const report = getReportData();
  dom.printReport.replaceChildren();

  const heading = el("header", "print-report-header");
  heading.append(el("h1", "", "Бюджет 2 «А» класса"), el("p", "", `Отчёт за ${monthYearLabel(report.month)}`));
  const summary = el("div", "print-summary");
  summary.append(
    createPrintMetric("Всего собрано", report.collected),
    createPrintMetric("Расходы за месяц", report.spent),
    createPrintMetric("Остаток в кассе", report.collected - report.totalSpent)
  );
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Дата", "Описание", "Категория", "Фонд", "Сумма"].forEach((text) => headRow.append(el("th", "", text)));
  head.append(headRow);
  const body = document.createElement("tbody");
  report.expenses.forEach((expense) => {
    const row = document.createElement("tr");
    row.append(
      el("td", "", formatDate(expense.expense_date)),
      el("td", "", expense.description),
      el("td", "", CATEGORY_LABELS[expense.category] || expense.category),
      el("td", "", FUND_LABELS[expense.fund] || expense.fund),
      el("td", "", formatMoney(expense.amount))
    );
    body.append(row);
  });
  if (!report.expenses.length) {
    const row = document.createElement("tr");
    const cell = el("td", "", "В этом месяце расходов нет.");
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
  }
  table.append(head, body);
  const footer = el("footer", "", `Сформировано ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" }).format(new Date())}`);
  dom.printReport.append(heading, summary, table, footer);
}

function createPrintMetric(label, value) {
  const item = el("div");
  item.append(el("span", "", label), el("strong", "", formatMoney(value)));
  return item;
}

function downloadMonthlyCsv() {
  const report = getReportData();
  const rows = [
    ["Бюджет 2 «А» класса"],
    [`Отчёт за ${monthYearLabel(report.month)}`],
    [],
    ["Всего собрано", report.collected],
    ["Расходы за месяц", report.spent],
    ["Текущий остаток", report.collected - report.totalSpent],
    [],
    ["Дата", "Описание", "Категория", "Фонд", "Сумма, руб."]
  ];
  report.expenses.forEach((expense) => rows.push([
    formatDate(expense.expense_date), expense.description,
    CATEGORY_LABELS[expense.category] || expense.category,
    FUND_LABELS[expense.fund] || expense.fund, toNumber(expense.amount)
  ]));
  const csv = rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
  downloadBlob(`budget-2A-${report.month}.csv`, `\ufeff${csv}`, "text/csv;charset=utf-8");
  showNotice("Отчёт скачан — его можно открыть в Excel ✓", "info");
}

function printMonthlyReport() {
  renderPrintableReport();
  window.print();
}

function buildSnapshot() {
  return {
    version: 1,
    created_at: new Date().toISOString(),
    students: state.students,
    campaigns: state.campaigns,
    contributions: state.contributions,
    expenses: state.expenses
  };
}

function exportBackupJson() {
  if (!state.isAdmin) return;
  downloadBlob(`budget-2A-backup-${todayIso()}.json`, JSON.stringify(buildSnapshot(), null, 2), "application/json");
  showNotice("Резервная копия скачана ✓", "info");
}

async function createManualBackup() {
  if (!state.isAdmin) return;
  setButtonLoading(dom.createBackupButton, true, "Создаём…");
  const { error } = await db.rpc("create_budget_backup", { p_backup_type: "manual" });
  setButtonLoading(dom.createBackupButton, false);
  if (error) return showNotice(`Копия не создана: ${friendlyError(error)}`, "error");
  await loadAllData({ silent: true });
  showNotice("Резервная копия сохранена в Supabase ✓", "info");
}

async function createUndoPoint() {
  if (!state.isAdmin) return null;
  const { data, error } = await db.rpc("create_budget_backup", { p_backup_type: "undo" });
  if (error) {
    console.warn("Undo backup failed:", error);
    return null;
  }
  state.lastUndoBackupId = data;
  return data;
}

function showUndoNotice(message, backupId) {
  if (!backupId || !dom.globalNotice) return showNotice(message, "info");
  window.clearTimeout(state.noticeTimer);
  dom.globalNotice.replaceChildren(document.createTextNode(`${message} `));
  const button = el("button", "notice-undo-button", "↩ Отменить");
  button.type = "button";
  button.addEventListener("click", () => undoLastAction(backupId));
  dom.globalNotice.append(button);
  dom.globalNotice.className = "global-notice notice-info notice-with-action";
  state.undoNoticeUntil = Date.now() + 9000;
  state.noticeTimer = window.setTimeout(hideNotice, 9000);
}

async function undoLastAction(backupId) {
  if (!state.isAdmin || !backupId) return;
  const { error } = await db.rpc("restore_budget_backup", { p_backup_id: backupId });
  if (error) return showNotice(`Не удалось отменить: ${friendlyError(error)}`, "error");
  state.lastUndoBackupId = null;
  await loadAllData({ silent: true });
  showNotice("Последнее действие отменено ✓", "info");
}

function renderBackupList() {
  if (!dom.backupList) return;
  dom.backupList.replaceChildren();
  if (!state.backups.length) {
    dom.backupList.append(createEmptyContent("🛟", "Копий пока нет", "Создайте первую ручную копию."));
    return;
  }
  state.backups.forEach((backup) => {
    const item = el("article", "backup-item");
    const copy = el("div");
    copy.append(
      el("strong", "", backupTypeLabel(backup.backup_type)),
      el("small", "", `${formatDateTime(backup.created_at)} · ${backup.record_count} записей`)
    );
    const button = el("button", "button button-secondary button-small", "Восстановить");
    button.type = "button";
    button.dataset.action = "restore-backup";
    button.dataset.id = backup.id;
    item.append(copy, button);
    dom.backupList.append(item);
  });
}

async function handleBackupAction(event) {
  const button = event.target.closest('[data-action="restore-backup"]');
  if (!button || !state.isAdmin) return;
  const backup = state.backups.find((item) => item.id === button.dataset.id);
  if (!backup || !window.confirm(`Восстановить копию от ${formatDateTime(backup.created_at)}? Текущие записи будут заменены.`)) return;
  button.disabled = true;
  const { error } = await db.rpc("restore_budget_backup", { p_backup_id: backup.id });
  if (error) {
    button.disabled = false;
    return showNotice(`Не удалось восстановить: ${friendlyError(error)}`, "error");
  }
  await loadAllData({ silent: true });
  showNotice("Данные успешно восстановлены ✓", "info");
}

async function restoreBackupFromFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || !state.isAdmin) return;
  try {
    const snapshot = JSON.parse(await file.text());
    validateSnapshot(snapshot);
    if (!window.confirm(`Восстановить данные из файла «${file.name}»? Текущие записи будут заменены.`)) return;
    showNotice("Проверяем и восстанавливаем данные…", "info", 0);
    const { error } = await db.rpc("restore_budget_snapshot", { p_snapshot: snapshot });
    if (error) throw error;
    await loadAllData({ silent: true });
    showNotice("Данные из файла восстановлены ✓", "info");
  } catch (error) {
    showNotice(`Файл не восстановлен: ${friendlyError(error)}`, "error", 0);
  }
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("неверный формат файла");
  ["students", "campaigns", "contributions", "expenses"].forEach((key) => {
    if (!Array.isArray(snapshot[key])) throw new Error(`в копии отсутствует раздел «${key}»`);
  });
}

function backupTypeLabel(type) {
  return ({ daily: "Ежедневная копия", manual: "Ручная копия", undo: "Точка отмены", pre_restore: "Перед восстановлением", import: "Импорт" })[type] || "Резервная копия";
}

/* =========================================================
   11. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
   ========================================================= */
function switchView(viewName) {
  if (viewName === "settings" && !state.isAdmin) return;
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
  dom.navButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === viewName));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openReceiptPreview(value) {
  const url = safeHttpsUrl(value);
  if (!url || !dom.receiptPreviewModal || !dom.receiptPreviewContent) return;

  dom.receiptPreviewContent.replaceChildren();
  if (dom.openReceiptExternal) dom.openReceiptExternal.href = url;

  const previewUrl = receiptPreviewUrl(url);
  const pathname = new URL(previewUrl).pathname.toLowerCase();
  const isImage = /\.(?:avif|gif|jpe?g|png|webp)$/.test(pathname);

  if (isImage) {
    const image = document.createElement("img");
    image.src = previewUrl;
    image.alt = "Фотография чека";
    image.loading = "eager";
    image.referrerPolicy = "no-referrer";
    dom.receiptPreviewContent.append(image);
  } else {
    const frame = document.createElement("iframe");
    frame.src = previewUrl;
    frame.title = "Предпросмотр чека";
    frame.loading = "eager";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    dom.receiptPreviewContent.append(frame);
  }

  dom.receiptPreviewModal.showModal();
}

function receiptPreviewUrl(value) {
  const url = new URL(value);
  if (url.hostname === "drive.google.com") {
    const fileMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
    const fileId = fileMatch?.[1] || url.searchParams.get("id");
    if (fileId) return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`;
  }
  return url.href;
}

function applySeasonalTheme() {
  const now = new Date();
  const month = now.getMonth();
  const day = now.getDate();
  let theme = { key: "school", badge: "📚 Учебный год", decor: "✏️  ⭐  🍎" };

  if ((month === 11 && day >= 15) || (month === 0 && day <= 15)) {
    theme = { key: "new-year", badge: "❄️ Новогоднее настроение", decor: "❄️  🎄  ✨" };
  } else if (month === 2 && day <= 10) {
    theme = { key: "spring", badge: "🌷 Весенний праздник", decor: "🌷  🌼  💛" };
  } else if ((month === 4 && day >= 20) || (month === 5 && day <= 10)) {
    theme = { key: "graduation", badge: "🎈 Завершаем учебный год", decor: "🎈  ⭐  🏆" };
  } else if ((month === 7 && day >= 15) || (month === 8 && day <= 10)) {
    theme = { key: "school-start", badge: "🍎 Скоро в школу!", decor: "🍎  ✏️  📚" };
  }

  document.documentElement.dataset.season = theme.key;
  if (dom.seasonBadge) dom.seasonBadge.textContent = theme.badge;
  if (dom.seasonDecor) dom.seasonDecor.textContent = theme.decor;
}

function setupInstallExperience() {
  if (!dom.installAppButton || isStandalone()) return;
  dom.installAppButton.classList.remove("hidden");

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    dom.installAppButton.classList.remove("hidden");
  });

  window.addEventListener("appinstalled", () => {
    state.installPrompt = null;
    dom.installAppButton.classList.add("hidden");
    showNotice("Приложение установлено на устройство ✓", "info");
  });
}

async function installApp() {
  if (state.installPrompt) {
    state.installPrompt.prompt();
    const { outcome } = await state.installPrompt.userChoice;
    state.installPrompt = null;
    if (outcome === "accepted") dom.installAppButton.classList.add("hidden");
    return;
  }

  if (dom.installInstructions) {
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    dom.installInstructions.innerHTML = isIos
      ? "<li>Нажмите кнопку «Поделиться» внизу Safari.</li><li>Выберите «На экран Домой».</li><li>Нажмите «Добавить».</li>"
      : "<li>Откройте меню браузера.</li><li>Выберите «Установить приложение» или «Добавить на главный экран».</li><li>Подтвердите установку.</li>";
  }
  dom.installHelpModal?.showModal();
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !/^https?:$/.test(window.location.protocol)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service worker registration failed:", error);
    });
  });
}

function hideLoadingScreen() {
  document.body.classList.remove("is-loading");
  if (!dom.loadingScreen) return;
  dom.loadingScreen.classList.add("is-leaving");
  window.setTimeout(() => dom.loadingScreen.classList.add("hidden"), 320);
}

function formatMoney(value) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: Number(value) % 1 === 0 ? 0 : 2
  }).format(toNumber(value));
}

function animateMoney(element, value) {
  const target = toNumber(value);
  const start = toNumber(element.dataset.moneyValue ?? 0);
  element.dataset.moneyValue = String(target);

  if (element._moneyAnimationFrame) cancelAnimationFrame(element._moneyAnimationFrame);
  if (start === target || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    element.textContent = formatMoney(target);
    return;
  }

  const startedAt = performance.now();
  const duration = 650;
  const renderFrame = (now) => {
    const progress = Math.min((now - startedAt) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = start + ((target - start) * eased);
    element.textContent = formatMoney(Number.isInteger(target) ? Math.round(current) : Math.round(current * 100) / 100);
    if (progress < 1) {
      element._moneyAnimationFrame = requestAnimationFrame(renderFrame);
    } else {
      element.textContent = formatMoney(target);
      element._moneyAnimationFrame = null;
    }
  };
  element._moneyAnimationFrame = requestAnimationFrame(renderFrame);
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T00:00:00`));
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function monthYearLabel(value) {
  const month = /^\d{4}-\d{2}$/.test(value || "") ? value : todayIso().slice(0, 7);
  const label = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(new Date(`${month}-01T00:00:00`));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function nextMonthIso() {
  const date = new Date();
  date.setMonth(date.getMonth() + 1, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function todayIso() {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function toNumber(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + toNumber(value), 0);
}

function safeHttpsUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeSearch(value) {
  return String(value || "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").trim();
}

function csvCell(value) {
  const text = String(value ?? "").replace(/"/g, '""');
  return `"${text}"`;
}

function downloadBlob(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function el(tagName, className = "", text = "") {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== "") element.textContent = text;
  return element;
}

function labeledCell(label, text, className = "") {
  const cell = el("td", className, text);
  cell.dataset.label = label;
  return cell;
}

function createProgressStat(label, value, icon) {
  const item = el("div", "campaign-progress-stat");
  item.append(
    el("span", "campaign-progress-stat-icon", icon),
    (() => {
      const copy = el("div");
      copy.append(el("small", "", label), el("strong", "", value));
      return copy;
    })()
  );
  return item;
}

function createEmptyContent(icon, title, copy) {
  const content = el("div", "empty-content");
  content.append(
    el("span", "empty-illustration", icon),
    el("strong", "", title),
    el("small", "", copy)
  );
  return content;
}

function appendEmptyTableRow(tbody, colspan, message) {
  const row = document.createElement("tr");
  row.className = "empty-row";
  const cell = el("td", "empty-state");
  cell.colSpan = colspan;
  cell.append(createEmptyContent("📝", message, "Здесь появятся новые записи."));
  row.append(cell);
  tbody.append(row);
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal?.open) modal.close();
}

function showNotice(text, type = "info", autoHideMs = 2500) {
  if (!dom.globalNotice) return;
  state.undoNoticeUntil = 0;
  window.clearTimeout(state.noticeTimer);
  dom.globalNotice.textContent = text;
  dom.globalNotice.className = `global-notice notice-${type}`;
  dom.globalNotice.classList.remove("hidden");
  if (autoHideMs > 0) {
    state.noticeTimer = window.setTimeout(() => hideNotice(), autoHideMs);
  }
}

function hideNotice() {
  if (dom.globalNotice) dom.globalNotice.classList.add("hidden");
}

function showAuthError(message) {
  if (dom.authError) {
    dom.authError.textContent = message;
    dom.authError.classList.remove("hidden");
  }
}

function showConfigWarning() {
  if (dom.configWarning) dom.configWarning.classList.remove("hidden");
}

function showElementError(element, text) {
  if (element) {
    element.textContent = text;
    element.classList.remove("hidden");
  }
}

function hideElement(element) {
  if (element) element.classList.add("hidden");
}

function setButtonLoading(button, isLoading, text = "") {
  if (!button) return;
  if (isLoading && !button.dataset.defaultText) button.dataset.defaultText = button.textContent;
  button.disabled = isLoading;
  if (isLoading && text) button.textContent = text;
  if (!isLoading && button.dataset.defaultText) {
    button.textContent = button.dataset.defaultText;
    delete button.dataset.defaultText;
  }
}

function friendlyError(error) {
  if (!error) return "Неизвестная ошибка";
  return error.message || String(error);
}
