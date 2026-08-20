"use strict";

/* =========================================================
   1. НАСТРОЙКА SUPABASE
   ========================================================= */
const DIRECT_SUPABASE_URL = "https://ftmnevlzremmisbajkmt.supabase.co";
const IS_LOCAL_PREVIEW = ["localhost", "127.0.0.1"].includes(window.location.hostname);
// В опубликованной версии Caddy проксирует этот путь к Supabase, поэтому
// телефон не обращается напрямую к нестабильному домену supabase.co.
const SUPABASE_URL = IS_LOCAL_PREVIEW ? DIRECT_SUPABASE_URL : `${window.location.origin}/supabase`;
const SUPABASE_ANON_KEY = "sb_publishable_jbRHoAeUQ7N96ybRzQSfHQ_DOzU-sx7";
const GOOGLE_WEB_CLIENT_ID = "572053102514-fhg5i79488bf3romhul65bktoenhg7d4.apps.googleusercontent.com";
const APP_VERSION = "v51";
const SESSION_RESTORE_HINT_KEY = "budget-2a-session-hint";
const INITIAL_AUTH_HASH = new URLSearchParams(window.location.hash.replace(/^#/, ""));
const IS_INITIAL_PASSWORD_RECOVERY = INITIAL_AUTH_HASH.get("type") === "recovery";

const isSupabaseConfigured =
  SUPABASE_URL.startsWith("https://") &&
  !SUPABASE_URL.includes("YOUR_PROJECT_ID") &&
  !SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");

const db = isSupabaseConfigured && window.supabase
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Используем штатную обработку OAuth библиотеки Supabase. Она
        // поддерживает фактический ответ провайдера и безопасно сохраняет сессию.
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
  allStudents: [],
  campaigns: [],
  archivedCampaigns: [],
  contributions: [],
  expenses: [],
  backups: [],
  chatMessages: [],
  chatReady: false,
  chatPanelOpen: false,
  chatRefreshTimer: null,
  chatExpiryTimer: null,
  chatLastReadAt: null,
  chatUnreadCount: 0,
  chatReadInitialized: false,
  chatReadUserId: null,
  classProfile: { class_name: "2 «А»", school_year: "" },
  archiveFeaturesReady: false,
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
  realtimeSubscriptionKey: null,
  realtimeRefreshTimer: null,
  noticeTimer: null,
  schoolCalendarTimer: null,
  installPrompt: null,
  authStateConfirmed: false,
  accessRequestStatus: null,
  enrollmentReady: false,
  enrollmentOpen: false,
  accessRequests: [],
  loadedSessionUserId: null,
  loadedSessionRunId: 0,
  loadRunId: 0,
  sessionRunId: 0,
  handledSessionIdentity: null
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
  renderSchoolCalendar();
  applySeasonalTheme();
  setupInstallExperience();
  activateServiceWorker();
  initGoogleIdentity();

  try {
    if (!db) {
      showConfigWarning();
      return;
    }

    // После OAuth мобильный браузер иногда восстанавливает сессию дольше обычного.
    // В этом случае продолжаем ждать ответ и не оставляем родителя на бесконечной загрузке.
    try {
      const initialSession = await getSessionWithSoftTimeout();
      if (initialSession.timedOut) {
        showAuthMessage("Проверка входа занимает больше обычного. Подождите: сайт продолжит вход автоматически.", "info");
        initialSession.pending.then(finishInitialSession).catch((error) => {
          hideLoadingScreen();
          showAuthError(`Не удалось завершить вход: ${friendlyError(error)}`);
        });
      } else {
        await finishInitialSession(initialSession.result);
      }
    } catch (error) {
      hideLoadingScreen();
      showAuthError(`Не удалось проверить авторизацию: ${friendlyError(error)}`);
    }

    db.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" && session) {
        openPasswordResetMode();
        return;
      }
      if (event === "TOKEN_REFRESHED" && session?.user?.id === state.user?.id) {
        state.session = session;
        return;
      }
      // INITIAL_SESSION особенно важен на мобильных: при медленном восстановлении
      // getSession() может первым вернуть null, а библиотека чуть позже сообщит
      // уже сохранённую сессию этим событием. Не отбрасываем его.
      // Отложенный запуск освобождает внутреннюю auth-блокировку Supabase.
      window.setTimeout(() => queueSessionHandling(session), event === "INITIAL_SESSION" ? 80 : 0);
    });
  } finally {
    // При медленном восстановлении сохранённой сессии нейтральный экран
    // остаётся до результата, а не сменяется на форму входа.
    if (!document.documentElement.classList.contains("session-restore-pending")) hideLoadingScreen();
  }
}

async function getSessionWithSoftTimeout() {
  // Используем штатное восстановление сессии Supabase. Оно уже корректно
  // обрабатывает фактический OAuth-ответ и не конфликтует со своим auth lock.
  const pending = db.auth.getSession();
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = window.setTimeout(() => resolve({ timedOut: true }), 12000);
  });
  const first = await Promise.race([pending, timeout]);
  window.clearTimeout(timeoutId);
  return first?.timedOut ? { timedOut: true, pending } : { timedOut: false, result: first };
}

async function finishInitialSession(result) {
  if (result?.error) {
    // Не оставляем OAuth-токены в адресе, но показываем конкретную ошибку.
    clearOAuthCallbackFromUrl();
    showAuthError(`Не удалось проверить авторизацию: ${friendlyError(result.error)}`);
    return;
  }
  const session = result?.data?.session ?? null;
  if (session) {
    // URL очищается только после того, как Supabase вернул уже сохранённую сессию.
    clearOAuthCallbackFromUrl();
    if (IS_INITIAL_PASSWORD_RECOVERY) {
      state.authStateConfirmed = true;
      openPasswordResetMode();
      return;
    }
  }
  state.authStateConfirmed = true;
  await queueSessionHandling(session);
}

function clearOAuthCallbackFromUrl() {
  const hash = window.location.hash;
  const query = window.location.search;
  if (!/(access_token|refresh_token|code|error|error_code)=/.test(`${hash}&${query}`)) return;
  window.history.replaceState({}, document.title, window.location.pathname);
}

function cacheDom() {
  const ids = [
    "loadingScreen", "authGate", "protectedContent", "googleLoginButton", "emailPasswordForm", "emailPasswordEmailInput", "emailPasswordInput", "togglePasswordVisibility", "rememberSessionInput", "emailPasswordLoginButton", "requestPasswordSetupButton", "authRequestAccessButton", "emailPasswordStatus", "passwordResetForm", "newPasswordInput", "confirmPasswordInput", "saveNewPasswordButton", "logoutButton", "configWarning", "authError",
    "globalNotice", "userName", "userAvatar", "roleBadge", "settingsNavButton", "lastUpdated", "schoolCalendar", "schoolCalendarDay", "schoolCalendarMonth",
    "seasonDecor", "seasonBadge", "installAppButton", "installHelpModal", "installInstructions", "parentChildOnboardingModal", "parentChildOnboardingForm", "parentChildOnboardingSelect", "parentChildOnboardingError", "parentChildOnboardingSaveButton",
    "totalCollected", "totalSpent", "totalBalance", "fundCards", "contributionReminder", "currentCampaignSummary",
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
    "receiptPreviewContent", "openReceiptExternal",
    "archiveCampaigns", "studentManagementList", "openStudentModalButton",
    "studentModal", "studentForm", "studentModalTitle", "studentId", "studentFullName", "studentSortOrder",
    "studentFormError", "saveStudentButton", "startSchoolYearForm", "nextClassName", "nextSchoolYear",
    "schoolYearFormError", "startSchoolYearButton", "expenseCampaign",
    "chatToggleButton", "chatUnreadBadge", "chatBackdrop", "classChatPanel", "closeChatButton", "chatStatus", "chatPinnedAnnouncement",
    "chatMessageList", "chatForm", "chatMessageInput", "chatCharacterCount", "sendChatButton",
    "accessEnrollmentStatus", "toggleAccessEnrollmentButton", "accessEnrollmentHint", "accessRequestError", "accessRequestList"
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
  // Google Identity самостоятельно управляет кнопкой внутри googleLoginButton.
  if (dom.emailPasswordForm) dom.emailPasswordForm.addEventListener("submit", loginWithEmailPassword);
  if (dom.togglePasswordVisibility) dom.togglePasswordVisibility.addEventListener("click", togglePasswordVisibility);
  if (dom.authRequestAccessButton) dom.authRequestAccessButton.addEventListener("click", requestAccessWithGoogle);
  if (dom.requestPasswordSetupButton) dom.requestPasswordSetupButton.addEventListener("click", requestPasswordSetup);
  if (dom.passwordResetForm) dom.passwordResetForm.addEventListener("submit", savePasswordReset);
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

  if (dom.chatToggleButton) dom.chatToggleButton.addEventListener("click", openChatPanel);
  if (dom.closeChatButton) dom.closeChatButton.addEventListener("click", closeChatPanel);
  if (dom.chatBackdrop) dom.chatBackdrop.addEventListener("click", closeChatPanel);
  if (dom.chatForm) dom.chatForm.addEventListener("submit", sendChatMessage);
  if (dom.chatMessageInput) dom.chatMessageInput.addEventListener("input", updateChatCharacterCount);
  if (dom.chatMessageList) dom.chatMessageList.addEventListener("click", handleChatAction);
  if (dom.chatPinnedAnnouncement) dom.chatPinnedAnnouncement.addEventListener("click", handleChatAction);
  if (dom.toggleAccessEnrollmentButton) dom.toggleAccessEnrollmentButton.addEventListener("click", toggleAccessEnrollment);
  if (dom.accessRequestList) dom.accessRequestList.addEventListener("click", handleAccessRequestAction);
  if (dom.parentChildOnboardingForm) dom.parentChildOnboardingForm.addEventListener("submit", saveParentChildOnboarding);

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
  if (dom.openStudentModalButton) dom.openStudentModalButton.addEventListener("click", () => openStudentModal());
  if (dom.studentForm) dom.studentForm.addEventListener("submit", saveStudent);
  if (dom.studentManagementList) dom.studentManagementList.addEventListener("click", handleStudentAction);
  if (dom.archiveCampaigns) dom.archiveCampaigns.addEventListener("click", handleArchiveAction);
  if (dom.startSchoolYearForm) dom.startSchoolYearForm.addEventListener("submit", startNewSchoolYear);
  if (dom.installAppButton) dom.installAppButton.addEventListener("click", installApp);
  if (dom.contributionsTableBody) dom.contributionsTableBody.addEventListener("change", handleContributionChange);
  if (dom.expensesTableBody) dom.expensesTableBody.addEventListener("click", handleExpenseAction);
  if (dom.campaignsTableBody) dom.campaignsTableBody.addEventListener("click", handleCampaignAction);

  document.querySelectorAll("[data-close-modal]").forEach((button) => {
    button.addEventListener("click", () => closeModal(button.dataset.closeModal));
  });

  [dom.expenseModal, dom.campaignModal, dom.studentModal, dom.receiptPreviewModal, dom.installHelpModal].forEach((dialog) => {
    if (dialog) {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
    }
  });

  if (dom.parentChildOnboardingModal) {
    dom.parentChildOnboardingModal.addEventListener("cancel", (event) => event.preventDefault());
  }
}

/* =========================================================
   4. АВТОРИЗАЦИЯ И РОЛИ
   ========================================================= */
function showEmailPasswordStatus(message) {
  if (!dom.emailPasswordStatus) return;
  dom.emailPasswordStatus.textContent = message;
  dom.emailPasswordStatus.classList.remove("hidden");
}

function validEmail(value) {
  return /^\S+@\S+\.\S+$/.test(value);
}

function togglePasswordVisibility() {
  const input = dom.emailPasswordInput;
  const button = dom.togglePasswordVisibility;
  if (!input || !button) return;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  button.textContent = show ? "◌" : "◉";
  button.setAttribute("aria-pressed", String(show));
  button.setAttribute("aria-label", show ? "Скрыть пароль" : "Показать пароль");
  input.focus();
}

function requestAccessWithGoogle() {
  if (!db) return showConfigWarning();
  showAuthMessage("Для нового родителя: выберите Google-аккаунт. Если приём заявок открыт, заявка сразу поступит администратору.", "info");
  dom.googleLoginButton?.scrollIntoView({ behavior: "smooth", block: "center" });
  window.google?.accounts?.id?.prompt?.();
}

function renderSchoolCalendar() {
  if (!dom.schoolCalendarDay || !dom.schoolCalendarMonth) return;
  const now = new Date();
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Vladivostok",
    day: "numeric",
    month: "long",
    weekday: "long"
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  const day = get("day");
  const month = get("month");
  const weekday = get("weekday");
  dom.schoolCalendarDay.textContent = day;
  dom.schoolCalendarMonth.textContent = month;
  dom.schoolCalendar?.setAttribute("aria-label", `Школьный календарь: ${weekday}, ${day} ${month}, Приморский край`);

  if (!state.schoolCalendarTimer) {
    state.schoolCalendarTimer = window.setInterval(renderSchoolCalendar, 60 * 60 * 1000);
  }
}

const AUTH_REQUEST_TIMEOUT_MS = 15_000;

async function loginWithEmailPassword(event) {
  event.preventDefault();
  if (!db) return showConfigWarning();

  const email = (dom.emailPasswordEmailInput?.value || "").trim().toLowerCase();
  const password = dom.emailPasswordInput?.value || "";
  if (!validEmail(email) || !password) {
    showAuthError("Введите почту и пароль.");
    return;
  }

  hideElement(dom.authError);
  if (dom.emailPasswordLoginButton) setButtonLoading(dom.emailPasswordLoginButton, true, "Входим…");

  let data;
  let error;
  try {
    ({ data, error } = await withTimeout(
      () => db.auth.signInWithPassword({ email, password }),
      "вход по почте и паролю",
      AUTH_REQUEST_TIMEOUT_MS
    ));
  } catch (requestError) {
    showAuthError("Сервер входа не ответил за 15 секунд. Обновите страницу и попробуйте ещё раз.");
    return;
  } finally {
    if (dom.emailPasswordLoginButton) setButtonLoading(dom.emailPasswordLoginButton, false);
  }

  if (error || !data?.session) {
    showAuthError("Не удалось войти. Проверьте почту и пароль или задайте пароль по ссылке из письма.");
    return;
  }

  showEmailPasswordStatus("Вход выполнен. Открываем бюджет…");
  await queueSessionHandling(data.session);
}

async function requestPasswordSetup() {
  if (!db) return showConfigWarning();

  const email = (dom.emailPasswordEmailInput?.value || "").trim().toLowerCase();
  if (!validEmail(email)) {
    showAuthError("Сначала введите свою почту в поле входа.");
    dom.emailPasswordEmailInput?.focus();
    return;
  }

  hideElement(dom.authError);
  if (dom.requestPasswordSetupButton) setButtonLoading(dom.requestPasswordSetupButton, true, "Отправляем…");

  let error;
  try {
    ({ error } = await withTimeout(
      () => db.auth.resetPasswordForEmail(email, { redirectTo: getPasswordResetUrl() }),
      "отправка письма для пароля",
      AUTH_REQUEST_TIMEOUT_MS
    ));
  } catch (requestError) {
    showAuthError("Сервер не ответил за 15 секунд. Обновите страницу и попробуйте отправить письмо ещё раз.");
    return;
  } finally {
    if (dom.requestPasswordSetupButton) setButtonLoading(dom.requestPasswordSetupButton, false);
  }

  if (error) {
    showAuthError("Не удалось отправить письмо. Попробуйте позже или воспользуйтесь входом через Google.");
    return;
  }

  showEmailPasswordStatus("Письмо отправлено. Откройте ссылку из письма и задайте постоянный пароль.");
}

function getPasswordResetUrl() {
  const isLocalPreview = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  return isLocalPreview ? `${window.location.origin}${window.location.pathname}` : "https://rodcomitet.budget2a.kriknexus.pro/";
}

function openPasswordResetMode() {
  setProtectedAccess(false);
  dom.emailPasswordForm?.classList.add("hidden");
  dom.requestPasswordSetupButton?.classList.add("hidden");
  dom.googleLoginButton?.classList.add("hidden");
  dom.passwordResetForm?.classList.remove("hidden");
  showEmailPasswordStatus("Придумайте и сохраните постоянный пароль для входа.");
  dom.newPasswordInput?.focus();
}

async function savePasswordReset(event) {
  event.preventDefault();
  if (!db) return showConfigWarning();

  const password = dom.newPasswordInput?.value || "";
  const confirmation = dom.confirmPasswordInput?.value || "";
  if (password.length < 6) {
    showAuthError("Пароль должен содержать не менее 6 символов.");
    return;
  }
  if (password !== confirmation) {
    showAuthError("Пароли не совпадают.");
    return;
  }

  hideElement(dom.authError);
  if (dom.saveNewPasswordButton) setButtonLoading(dom.saveNewPasswordButton, true, "Сохраняем…");

  let error;
  try {
    ({ error } = await withTimeout(
      () => db.auth.updateUser({ password }),
      "сохранение пароля",
      AUTH_REQUEST_TIMEOUT_MS
    ));
  } catch (requestError) {
    showAuthError("Сервер не ответил за 15 секунд. Откройте новую ссылку из письма и попробуйте ещё раз.");
    return;
  } finally {
    if (dom.saveNewPasswordButton) setButtonLoading(dom.saveNewPasswordButton, false);
  }

  if (error) {
    showAuthError("Не удалось сохранить пароль. Откройте новую ссылку из письма и попробуйте ещё раз.");
    return;
  }

  clearOAuthCallbackFromUrl();
  showEmailPasswordStatus("Пароль сохранён. Открываем бюджет…");
  const { data } = await db.auth.getSession();
  await queueSessionHandling(data.session);
}

function initGoogleIdentity() {
  if (!GOOGLE_WEB_CLIENT_ID || IS_LOCAL_PREVIEW) return;
  const loadIdentity = () => {
    if (!window.google?.accounts?.id || !dom.googleLoginButton) return;
    window.google.accounts.id.initialize({
      client_id: GOOGLE_WEB_CLIENT_ID,
      callback: handleGoogleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
      itp_support: true,
      use_fedcm_for_prompt: true
    });
    dom.googleLoginButton.replaceChildren();
    window.google.accounts.id.renderButton(dom.googleLoginButton, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "signin_with",
      shape: "rectangular",
      logo_alignment: "left",
      width: Math.max(260, Math.floor(dom.googleLoginButton.getBoundingClientRect().width || 320)),
      locale: "ru"
    });
  };

  if (window.google?.accounts?.id) {
    loadIdentity();
    return;
  }

  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.defer = true;
  script.onload = loadIdentity;
  script.onerror = () => showAuthError("Не удалось открыть Google. Проверьте подключение и попробуйте ещё раз.");
  document.head.append(script);
}

function loginWithGoogle() {
  if (!db) return showConfigWarning();
  if (IS_LOCAL_PREVIEW) return loginWithLegacyGoogleRedirect();
  showAuthError("Используйте кнопку Google на экране входа.");
}

async function handleGoogleCredential(response) {
  if (!response?.credential || !db) {
    showAuthError("Google не передал данные входа. Попробуйте ещё раз.");
    return;
  }

  showAuthMessage("Проверяем Google-вход…", "info");
  const { data, error } = await db.auth.signInWithIdToken({
    provider: "google",
    token: response.credential
  });
  if (error || !data?.session) {
    showAuthError(`Не удалось завершить Google-вход: ${friendlyError(error)}`);
    return;
  }

  await queueSessionHandling(data.session);
}

async function loginWithLegacyGoogleRedirect() {
    showAuthMessage("Переходим в Google…", "info");
  const { error } = await db.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: "http://localhost:4173/",
      queryParams: { prompt: "select_account" }
    }
  });
  if (error) {
    showAuthError(`Ошибка входа: ${error.message}`);
  }
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

function sessionIdentity(session) {
  // Для интерфейса важен именно пользователь, а не служебные повторные
  // события той же сессии. Выход переводит ключ в «гость», поэтому новый
  // вход даже под тем же аккаунтом будет обработан заново.
  return session?.user?.id || "guest";
}

function queueSessionHandling(session) {
  const identity = sessionIdentity(session);

  // getSession(), INITIAL_SESSION и SIGNED_IN могут сообщить одну и ту же
  // авторизацию. Не запускаем заново проверку прав и полную загрузку бюджета,
  // если пользователь не изменился. Это исключает мерцание и нулевые суммы
  // при обновлении страницы и после повторного входа.
  if (identity === state.handledSessionIdentity) {
    if (session?.user) {
      state.session = session;
      state.user = session.user;
      renderUser();
    }
    return Promise.resolve();
  }

  state.handledSessionIdentity = identity;
  const runId = ++state.sessionRunId;
  return handleSession(session, runId);
}

function isCurrentSessionRun(runId, session) {
  return runId === state.sessionRunId && state.user?.id === session?.user?.id;
}

async function handleSession(session, runId) {
  if (runId !== state.sessionRunId) return;
  state.session = session;
  state.user = session?.user ?? null;

  if (!session) {
    clearSessionRestoreHint();
    hideLoadingScreen();
    state.isAdmin = false;
    state.accessRequestStatus = null;
    state.loadedSessionUserId = null;
    state.loadedSessionRunId = 0;
    state.chatMessages = [];
    state.chatReady = false;
    state.chatLastReadAt = null;
    state.chatUnreadCount = 0;
    state.chatReadInitialized = false;
    state.chatReadUserId = null;
    state.accessRequests = [];
    window.clearTimeout(state.chatExpiryTimer);
    closeChatPanel();
    if (dom.parentChildOnboardingModal?.open) dom.parentChildOnboardingModal.close();
    setProtectedAccess(false);
    renderUser();
    return;
  }

  renderUser();
  state.isAdmin = false;
  applyRoleToUi();
  setProtectedAccess(false);

  try {
    showNotice(`${APP_VERSION}: проверяем доступ к классу…`, "info", 0);
    const accessResult = await withTimeout(
      () => db.rpc("can_access_budget"),
      "проверка доступа к классу",
      CORE_DATA_TIMEOUT_MS
    );
    if (accessResult.error) throw accessResult.error;
    if (!isCurrentSessionRun(runId, session)) return;
    const canAccess = accessResult.data;

    if (canAccess !== true) {
      clearSessionRestoreHint();
      hideLoadingScreen();
      state.loadedSessionUserId = null;
      closeChatPanel();
      const requestResult = await db.rpc("request_class_access");
      if (requestResult.error) throw requestResult.error;
      if (!isCurrentSessionRun(runId, session)) return;
      const request = Array.isArray(requestResult.data) ? requestResult.data[0] : requestResult.data;
      state.accessRequestStatus = request?.request_status || "CLOSED";
      setProtectedAccess(false);
      renderAccessRequestStatus(request);
      return;
    }

    hideElement(dom.authError);
    state.accessRequestStatus = "APPROVED";
    // Официальная кнопка Google остаётся внутри своего контейнера.
    // Бюджет не открываем до готового снимка данных: так после обновления
    // страницы пользователь не увидит нули и промежуточные суммы.
    showNotice(`${APP_VERSION}: вход выполнен. Проверяем роль…`, "info", 0);

    // Роль влияет только на кнопки редактирования. Если ответ задержался,
    // не задерживаем сам бюджет: сначала открываем режим просмотра, затем
    // роль можно безопасно проверить повторно при следующем обновлении.
    try {
      const adminResult = await withTimeout(
        () => db.rpc("is_admin"),
        "проверка роли администратора",
        OPTIONAL_DATA_TIMEOUT_MS
      );
      if (adminResult.error) throw adminResult.error;
      if (!isCurrentSessionRun(runId, session)) return;
      state.isAdmin = adminResult.data === true;
    } catch (adminError) {
      if (!isCurrentSessionRun(runId, session)) return;
      console.warn("Admin role check delayed:", adminError);
      state.isAdmin = false;
      showNotice("Проверка роли администратора задержалась. Бюджет откроется в режиме просмотра.", "info", 7000);
    }
  } catch (error) {
    if (!isCurrentSessionRun(runId, session)) return;
    console.error(error);
    state.isAdmin = false;
    // Не оставляем пользователя на бесконечном мобильном загрузчике,
    // если Supabase не ответил или проверка доступа завершилась ошибкой.
    clearSessionRestoreHint();
    hideLoadingScreen();
    setProtectedAccess(false);
    showAuthError(`Не удалось проверить доступ: ${friendlyError(error)}. Обновите страницу или попробуйте позже.`);
    return;
  }

  try {
    if (!isCurrentSessionRun(runId, session)) return;
    applyRoleToUi();
    if (state.loadedSessionUserId !== session.user.id || state.loadedSessionRunId !== runId) {
      state.loadedSessionUserId = session.user.id;
      state.loadedSessionRunId = runId;
      await loadAllData();
      if (!isCurrentSessionRun(runId, session)) return;
      subscribeRealtime();
    }
    if (!isCurrentSessionRun(runId, session)) return;
    rememberSessionRestoreHint();
    setProtectedAccess(true);
    hideLoadingScreen();
  } catch (error) {
    if (!isCurrentSessionRun(runId, session)) return;
    console.error(error);
    state.loadedSessionUserId = null;
    state.loadedSessionRunId = 0;
    rememberSessionRestoreHint();
    setProtectedAccess(true);
    hideLoadingScreen();
    showNotice(`Вход выполнен, но данные пока не загрузились: ${friendlyError(error)}. Проверьте интернет и обновите страницу.`, "error", 0);
  }
}

function rememberSessionRestoreHint() {
  try {
    window.localStorage.setItem(SESSION_RESTORE_HINT_KEY, "1");
  } catch (_) {
    // Приватный режим не должен мешать обычному входу.
  }
}

function clearSessionRestoreHint() {
  try {
    window.localStorage.removeItem(SESSION_RESTORE_HINT_KEY);
  } catch (_) {
    // Приватный режим не должен мешать выходу.
  }
  document.documentElement.classList.remove("session-restore-pending");
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
const CORE_DATA_TIMEOUT_MS = 10_000;
const OPTIONAL_DATA_TIMEOUT_MS = 7_000;

async function loadAllData({ silent = false } = {}) {
  const loadRunId = ++state.loadRunId;
  if (!silent) showNotice(`${APP_VERSION}: загружаем основные данные бюджета…`, "info", 0);

  // На мобильной сети один защищённый RPC надёжнее, чем несколько параллельных
  // REST-запросов. Он возвращает те же данные после проверки членства в классе.
  const snapshotStep = await loadStep(
    "бюджет класса",
    () => db.rpc("load_class_budget_snapshot"),
    { data: null }
  );

  if (loadRunId !== state.loadRunId || !state.session) return;

  const snapshot = snapshotStep.result?.data;
  if (!snapshot || typeof snapshot !== "object") {
    if (!silent) showNotice("Бюджет пока не загрузился. Проверьте интернет и попробуйте обновить страницу.", "error", 12_000);
    return;
  }

  const allStudents = Array.isArray(snapshot.students) ? snapshot.students : [];
  const allCampaigns = Array.isArray(snapshot.campaigns) ? snapshot.campaigns : [];
  state.allStudents = allStudents;
  state.students = allStudents.filter((student) => student.is_active !== false);
  state.contributions = Array.isArray(snapshot.contributions) ? snapshot.contributions : [];
  state.expenses = Array.isArray(snapshot.expenses) ? snapshot.expenses : [];
  state.campaigns = allCampaigns.filter((item) => !item.archived_at);
  state.archivedCampaigns = allCampaigns
    .filter((item) => item.archived_at)
    .sort((a, b) => new Date(b.archived_at) - new Date(a.archived_at));
  state.classProfile = snapshot.class_profile?.class_name ? snapshot.class_profile : state.classProfile;
    state.chatMessages = Array.isArray(snapshot.chat_messages) ? snapshot.chat_messages : [];
    state.chatReady = true;
    syncChatUnreadState();
    state.archiveFeaturesReady = true;
  state.advancedFeaturesReady = true;

  if (!state.campaigns.some((item) => item.id === state.selectedCampaignId)) {
    state.selectedCampaignId = state.campaigns.find((item) => item.is_open)?.id ?? state.campaigns[0]?.id ?? null;
  }

  renderAll();
  openParentChildOnboardingIfNeeded();
  if (!silent) {
    if (snapshotStep.error) {
      showNotice("Бюджет пока не загрузился. Проверьте интернет и попробуйте обновить страницу.", "error", 12_000);
    } else {
      hideNotice();
    }
  }

  // Для родителя всё уже пришло единым запросом. У администратора отдельно
  // догружаются только служебные данные заявок и резервных копий.
  void loadSupplementaryData(loadRunId, { silent });
}

async function loadSupplementaryData(loadRunId, { silent = false } = {}) {
  if (!state.isAdmin) {
    state.enrollmentReady = false;
    state.enrollmentOpen = false;
    state.accessRequests = [];
    state.backups = [];
    subscribeRealtime();
    return;
  }

  const [accessStep, backupsStep] = await Promise.all([
    loadStep("настройки заявок", fetchAccessAdministration, {
      ready: false,
      enrollmentOpen: false,
      accessRequests: [],
      error: null
    }, OPTIONAL_DATA_TIMEOUT_MS),
    loadStep("список резервных копий", fetchBackups, { data: [], error: null }, OPTIONAL_DATA_TIMEOUT_MS)
  ]);
  if (loadRunId !== state.loadRunId || !state.session) return;

  state.enrollmentReady = accessStep.result?.ready === true;
  state.enrollmentOpen = accessStep.result?.enrollmentOpen === true;
  state.accessRequests = accessStep.result?.accessRequests ?? [];
  state.backups = backupsStep.result?.data ?? [];

  renderAll();
  subscribeRealtime();
  const warnings = [accessStep, backupsStep].filter((step) => step.error).map((step) => step.label);
  if (!silent && warnings.length) {
    showNotice(`Бюджет загружен. Пока недоступно: ${warnings.join(", ")}. Это не влияет на суммы и историю взносов.`, "error", 12_000);
  }
}

async function loadStep(label, operation, fallback, timeoutMs = CORE_DATA_TIMEOUT_MS) {
  const startedAt = performance.now();
  try {
    const result = await withTimeout(operation, label, timeoutMs);
    if (result?.error) throw result.error;
    console.info(`[Бюджет 2А] ${label}: готово за ${Math.round(performance.now() - startedAt)} мс`);
    return { label, result, error: null };
  } catch (error) {
    console.warn(`[Бюджет 2А] ${label}: ${friendlyError(error)}`);
    if (state.session) showNotice(`${APP_VERSION}: не ответил раздел «${label}». Показываем остальные данные…`, "error", 12_000);
    return { label, result: fallback, error };
  }
}

async function withTimeout(operation, label, timeoutMs) {
  let timeoutId;
  const task = Promise.resolve().then(() => typeof operation === "function" ? operation() : operation);
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(`Раздел «${label}» не ответил за ${Math.round(timeoutMs / 1000)} сек.`)), timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function fetchStudents() {
  return db.from("students")
    .select("id, full_name, sort_order, is_active, created_at, updated_at")
    .order("is_active", { ascending: false })
    .order("sort_order");
}

async function fetchArchiveAwareData() {
  const fields = "id, name, campaign_type, fund, expected_amount, is_open, sort_order, archived_at, archived_by, school_year, archived_students, created_at, updated_at";
  const campaignsResult = await db.from("campaigns").select(fields).order("sort_order");

  if (!campaignsResult.error) {
    const campaigns = campaignsResult.data ?? [];
    return {
      campaigns: campaigns.filter((item) => !item.archived_at),
      archivedCampaigns: campaigns.filter((item) => item.archived_at).sort((a, b) => new Date(b.archived_at) - new Date(a.archived_at)),
      classProfile: state.classProfile,
      ready: true,
      error: null
    };
  }

  // Совместимость со старой схемой до запуска миграции архива.
  const fallback = await db.from("campaigns")
    .select("id, name, campaign_type, fund, expected_amount, is_open, sort_order, created_at, updated_at")
    .order("sort_order");
  if (fallback.error) return { error: fallback.error };
  return {
    campaigns: fallback.data ?? [],
    archivedCampaigns: [],
    classProfile: { class_name: "2 «А»", school_year: "" },
    ready: false,
    error: null
  };
}

async function fetchClassProfile() {
  const result = await db.from("class_profile")
    .select("class_name, school_year, updated_at")
    .eq("id", true)
    .maybeSingle();
  if (result.error && /class_profile|does not exist|relation .* does not exist/i.test(result.error.message || "")) {
    return { data: state.classProfile, error: null };
  }
  return result;
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

async function fetchAccessAdministration() {
  const [settingsResult, requestsResult] = await Promise.all([
    db.from("access_enrollment_settings").select("enrollment_open, updated_at").eq("id", true).maybeSingle(),
    db.from("access_requests").select("id, user_id, email, display_name, avatar_url, request_status, requested_at, reviewed_at").order("requested_at", { ascending: false }).limit(60)
  ]);

  const error = settingsResult.error || requestsResult.error;
  if (!error) {
    return {
      ready: true,
      enrollmentOpen: settingsResult.data?.enrollment_open === true,
      accessRequests: requestsResult.data ?? [],
      error: null
    };
  }
  if (/access_enrollment_settings|access_requests|does not exist|relation .* does not exist/i.test(error.message || "")) {
    return { ready: false, enrollmentOpen: false, accessRequests: [], error: null };
  }
  return { ready: false, enrollmentOpen: false, accessRequests: [], error };
}

async function fetchChatMessages() {
  const result = await db
    .from("chat_messages")
    .select("id, author_id, author_name, body, created_at, is_pinned, pinned_at")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(120);

  if (!result.error) {
    return { data: [...(result.data ?? [])].reverse(), ready: true, error: null };
  }
  if (/chat_messages|does not exist|relation .* does not exist/i.test(result.error.message || "")) {
    return { data: [], ready: false, error: null };
  }
  return { data: [], ready: false, error: result.error };
}

async function fetchExpenses() {
  const fields = "id, expense_date, description, category, fund, amount, receipt_url, receipt_path, campaign_id, created_at, updated_at";
  const result = await db.from("expenses").select(fields).order("expense_date", { ascending: false }).order("created_at", { ascending: false });
  if (!result.error) {
    state.advancedFeaturesReady = true;
    return result;
  }
  if (!/receipt_path|campaign_id|column .* does not exist/i.test(result.error.message || "")) return result;
  state.advancedFeaturesReady = false;

  const fallback = await db.from("expenses").select("id, expense_date, description, category, fund, amount, receipt_url, created_at, updated_at").order("expense_date", { ascending: false }).order("created_at", { ascending: false });
  return { ...fallback, data: (fallback.data || []).map((expense) => ({ ...expense, receipt_path: null, campaign_id: null })) };
}

function chatReadStorageKey() {
  return state.user?.id ? `budget-2a-chat-read:${state.user.id}` : null;
}

function latestChatMessageTime() {
  return state.chatMessages
    .map((message) => new Date(message.created_at).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0] || 0;
}

function loadStoredChatReadTime() {
  const key = chatReadStorageKey();
  if (!key) return 0;
  try {
    const value = Number(window.localStorage.getItem(key) || 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (_) {
    return 0;
  }
}

function saveChatReadTime(timestamp) {
  const key = chatReadStorageKey();
  if (!key) return;
  try {
    window.localStorage.setItem(key, String(timestamp));
  } catch (_) {
    // Приватный режим не должен мешать использованию чата.
  }
}

function markChatAsRead() {
  if (!state.session || !state.chatReady) return;
  const timestamp = latestChatMessageTime() || Date.now();
  state.chatLastReadAt = timestamp;
  state.chatUnreadCount = 0;
  state.chatReadInitialized = true;
  saveChatReadTime(timestamp);
  renderChatUnreadBadge();
}

function syncChatUnreadState() {
  if (!state.session || !state.chatReady) {
    state.chatUnreadCount = 0;
    renderChatUnreadBadge();
    return;
  }

  if (state.chatReadUserId !== state.user?.id) {
    state.chatReadUserId = state.user?.id ?? null;
    state.chatLastReadAt = null;
    state.chatUnreadCount = 0;
    state.chatReadInitialized = false;
  }

  if (!state.chatReadInitialized) {
    const storedTimestamp = loadStoredChatReadTime();
    state.chatLastReadAt = storedTimestamp || latestChatMessageTime() || Date.now();
    state.chatReadInitialized = true;
    if (!storedTimestamp) saveChatReadTime(state.chatLastReadAt);
  }

  if (state.chatPanelOpen) {
    markChatAsRead();
    return;
  }

  state.chatUnreadCount = state.chatMessages.filter((message) => {
    const createdAt = new Date(message.created_at).getTime();
    return message.author_id !== state.user?.id && Number.isFinite(createdAt) && createdAt > state.chatLastReadAt;
  }).length;
  renderChatUnreadBadge();
}

function renderChatUnreadBadge() {
  const count = state.session && state.chatReady ? state.chatUnreadCount : 0;
  if (dom.chatUnreadBadge) {
    dom.chatUnreadBadge.textContent = count > 99 ? "99+" : String(count);
    dom.chatUnreadBadge.classList.toggle("hidden", count < 1);
  }
  if (dom.chatToggleButton) {
    const suffix = count ? `: ${count > 99 ? "99+" : count} новых сообщений` : "";
    dom.chatToggleButton.setAttribute("aria-label", `Чат класса${suffix}`);
  }
}

function realtimeSubscriptionKey() {
  return `${state.isAdmin ? "admin" : "parent"}:${state.enrollmentReady ? "enrollment" : "standard"}:${state.chatReady ? "chat" : "no-chat"}`;
}

function subscribeRealtime() {
  const subscriptionKey = realtimeSubscriptionKey();
  if (state.realtimeChannel && state.realtimeSubscriptionKey === subscriptionKey) return;
  unsubscribeRealtime();
  state.realtimeSubscriptionKey = subscriptionKey;

  state.realtimeChannel = db
    .channel("class-budget-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "contributions" }, scheduleRealtimeRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "expenses" }, scheduleRealtimeRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "campaigns" }, scheduleRealtimeRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "students" }, scheduleRealtimeRefresh);

  if (state.isAdmin && state.enrollmentReady) {
    state.realtimeChannel
      .on("postgres_changes", { event: "*", schema: "public", table: "access_enrollment_settings" }, scheduleRealtimeRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "access_requests" }, scheduleRealtimeRefresh);
  }

  if (state.chatReady) {
    state.realtimeChannel.on("postgres_changes", { event: "*", schema: "public", table: "chat_messages" }, scheduleChatRefresh);
  }
  state.realtimeChannel.subscribe();
}

function unsubscribeRealtime() {
  if (db && state.realtimeChannel) db.removeChannel(state.realtimeChannel);
  state.realtimeChannel = null;
  state.realtimeSubscriptionKey = null;
}

function scheduleChatRefresh() {
  window.clearTimeout(state.chatRefreshTimer);
  state.chatRefreshTimer = window.setTimeout(async () => {
    try {
      const result = await fetchChatMessages();
      if (result.error) throw result.error;
      state.chatMessages = result.data ?? [];
      state.chatReady = result.ready === true;
      syncChatUnreadState();
      renderChat();
    } catch (error) {
      console.error("Chat refresh error:", error);
    }
  }, 180);
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
  renderClassProfile();
  renderCampaignSelect();
  renderSummary();
  renderContributionReminder();
  renderContributions();
  renderExpenses();
  renderCampaignSettings();
  renderArchivedCampaigns();
  renderStudentManagement();
  renderAccessManagement();
  renderChat();
  renderBackupList();
  renderReportMonthOptions();
  renderPrintableReport();
  if (dom.lastUpdated) {
    dom.lastUpdated.textContent = `Обновлено: ${new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
  }
}

function renderClassProfile() {
  const className = state.classProfile?.class_name || "2 «А»";
  const schoolYear = state.classProfile?.school_year || "";
  // Меняем только надпись в шапке, без запуска нового учебного года в базе.
  const displayedSchoolYear = /^2025\s*[\/–-]\s*2026$/.test(schoolYear) ? "2026–2027" : schoolYear;
  document.querySelectorAll("[data-class-name]").forEach((node) => { node.textContent = className; });
  document.querySelectorAll("[data-school-year]").forEach((node) => { node.textContent = displayedSchoolYear; });
  document.title = `Бюджет ${className} класса`;
  if (dom.nextClassName && document.activeElement !== dom.nextClassName) dom.nextClassName.value = className;
  if (dom.nextSchoolYear && document.activeElement !== dom.nextSchoolYear) dom.nextSchoolYear.value = nextSchoolYearLabel(schoolYear);
}

function renderChat() {
  if (!dom.chatMessageList) {
    renderChatUnreadBadge();
    return;
  }
  const chatAvailable = Boolean(state.session && state.chatReady);

  if (dom.chatToggleButton) {
    dom.chatToggleButton.disabled = !state.session;
    dom.chatToggleButton.title = chatAvailable ? "Открыть чат класса" : "Чат будет доступен после обновления базы";
  }
  if (dom.chatStatus) {
    dom.chatStatus.textContent = chatAvailable
      ? "Сообщения видят только родители и администраторы класса."
      : "Чат станет доступен после обновления базы данных.";
  }
  if (dom.chatMessageInput) dom.chatMessageInput.disabled = !chatAvailable;
  if (dom.sendChatButton) dom.sendChatButton.disabled = !chatAvailable;
  renderPinnedChatAnnouncement();
  updateChatCharacterCount();

  dom.chatMessageList.replaceChildren();
  if (!chatAvailable) {
    dom.chatMessageList.append(createEmptyContent("💬", "Чат пока готовится", "После обновления базы можно будет общаться прямо на сайте."));
    syncChatPanelState();
    renderChatUnreadBadge();
    return;
  }
  if (!state.chatMessages.length) {
    dom.chatMessageList.append(createEmptyContent("👋", "Начните разговор", "Первое текстовое сообщение увидят все родители класса."));
  } else {
    state.chatMessages.forEach((message) => dom.chatMessageList.append(createChatMessageElement(message)));
  }
  scheduleChatDeleteExpiry();
  syncChatPanelState();
  renderChatUnreadBadge();
}

function renderPinnedChatAnnouncement() {
  if (!dom.chatPinnedAnnouncement) return;
  dom.chatPinnedAnnouncement.replaceChildren();
  const pinned = state.chatMessages.find((message) => message.is_pinned) ?? null;
  if (!pinned) {
    dom.chatPinnedAnnouncement.classList.add("hidden");
    return;
  }

  const copy = el("div", "chat-pinned-copy");
  copy.append(
    el("strong", "", "📌 Закреплённое объявление"),
    el("p", "", pinned.body),
    el("small", "", `${pinned.author_name} · ${formatDateTime(pinned.created_at)}`)
  );
  dom.chatPinnedAnnouncement.append(copy);

  if (state.isAdmin) {
    const unpin = el("button", "chat-pinned-unpin", "Снять");
    unpin.type = "button";
    unpin.dataset.chatAction = "unpin";
    unpin.dataset.id = pinned.id;
    dom.chatPinnedAnnouncement.append(unpin);
  }
  dom.chatPinnedAnnouncement.classList.remove("hidden");
}

function createChatMessageElement(message) {
  const isOwn = message.author_id === state.user?.id;
  const item = el("article", `chat-message${isOwn ? " is-own" : ""}${message.is_pinned ? " is-pinned" : ""}`);
  const header = el("div", "chat-message-header");
  const identity = el("div", "chat-message-author");
  identity.append(el("strong", "", isOwn ? "Вы" : message.author_name), el("time", "", formatDateTime(message.created_at)));
  header.append(identity);

  if (message.is_pinned) header.append(el("span", "chat-pinned-label", "📌 Закреплено"));
  if (state.isAdmin) {
    const pinButton = el("button", "chat-pin-button", message.is_pinned ? "Снять" : "Закрепить");
    pinButton.type = "button";
    pinButton.dataset.chatAction = message.is_pinned ? "unpin" : "pin";
    pinButton.dataset.id = message.id;
    header.append(pinButton);
  }

  if (canDeleteChatMessage(message)) {
    const deleteButton = el("button", "chat-delete-button", "Удалить");
    deleteButton.type = "button";
    deleteButton.dataset.chatAction = "delete";
    deleteButton.dataset.id = message.id;
    deleteButton.setAttribute("aria-label", "Удалить сообщение");
    header.append(deleteButton);
  }

  item.append(header, el("p", "chat-message-body", message.body));
  return item;
}

function scheduleChatDeleteExpiry() {
  window.clearTimeout(state.chatExpiryTimer);
  if (state.isAdmin || !state.session) return;
  const now = Date.now();
  const nextExpiry = state.chatMessages
    .filter((message) => message.author_id === state.user?.id)
    .map((message) => new Date(message.created_at).getTime() + 15 * 60 * 1000 - now)
    .filter((remaining) => Number.isFinite(remaining) && remaining > 0)
    .sort((a, b) => a - b)[0];
  if (nextExpiry) {
    state.chatExpiryTimer = window.setTimeout(renderChat, nextExpiry + 300);
  }
}

function canDeleteChatMessage(message) {
  if (state.isAdmin) return true;
  if (message.author_id !== state.user?.id) return false;
  const createdAt = new Date(message.created_at).getTime();
  return Number.isFinite(createdAt) && createdAt >= Date.now() - 15 * 60 * 1000;
}

function syncChatPanelState() {
  const isOpen = state.chatPanelOpen && Boolean(state.session);
  if (dom.classChatPanel) {
    dom.classChatPanel.classList.toggle("is-open", isOpen);
    dom.classChatPanel.setAttribute("aria-hidden", String(!isOpen));
  }
  if (dom.chatBackdrop) {
    dom.chatBackdrop.classList.toggle("hidden", !isOpen);
    dom.chatBackdrop.setAttribute("aria-hidden", String(!isOpen));
  }
  if (dom.chatToggleButton) dom.chatToggleButton.setAttribute("aria-expanded", String(isOpen));
  document.body.classList.toggle("chat-is-open", isOpen);

  if (isOpen && dom.chatMessageList) {
    window.requestAnimationFrame(() => {
      dom.chatMessageList.scrollTop = dom.chatMessageList.scrollHeight;
    });
  }
}

function openChatPanel() {
  if (!state.session) return;
  state.chatPanelOpen = true;
  markChatAsRead();
  renderChat();
  if (state.chatReady && dom.chatMessageInput) window.setTimeout(() => dom.chatMessageInput.focus(), 120);
}

function closeChatPanel() {
  state.chatPanelOpen = false;
  syncChatPanelState();
}

function updateChatCharacterCount() {
  const length = dom.chatMessageInput?.value.length ?? 0;
  if (dom.chatCharacterCount) dom.chatCharacterCount.textContent = `${length} / 1000`;
  if (dom.sendChatButton) dom.sendChatButton.disabled = !(state.session && state.chatReady && length > 0);
}

async function sendChatMessage(event) {
  event.preventDefault();
  if (!state.chatReady || !state.session || !dom.chatMessageInput) return;
  const body = dom.chatMessageInput.value.trim();
  if (!body) return;
  if (body.length > 1000) return showNotice("Сообщение должно быть не длиннее 1000 символов.", "error");

  setButtonLoading(dom.sendChatButton, true, "Отправляем…");
  const { data, error } = await db.rpc("send_class_chat_message", { p_body: body });
  setButtonLoading(dom.sendChatButton, false);
  if (error) return showNotice(`Сообщение не отправлено: ${friendlyError(error)}`, "error");

  const message = Array.isArray(data) ? data[0] : data;
  if (message?.id) {
    state.chatMessages = [...state.chatMessages.filter((item) => item.id !== message.id), message]
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    syncChatUnreadState();
  }
  dom.chatMessageInput.value = "";
  updateChatCharacterCount();
  renderChat();
}

async function refreshChatMessagesNow() {
  const result = await fetchChatMessages();
  if (result.error) throw result.error;
  state.chatMessages = result.data ?? [];
  state.chatReady = result.ready === true;
  syncChatUnreadState();
  renderChat();
}

async function handleChatAction(event) {
  const button = event.target.closest("[data-chat-action]");
  if (!button || !state.chatReady) return;
  const action = button.dataset.chatAction;
  const message = state.chatMessages.find((item) => item.id === button.dataset.id);

  if (action === "pin" || action === "unpin") {
    if (!state.isAdmin || !message) return;
    const question = action === "pin"
      ? `Закрепить сообщение ${message.author_name} сверху чата? Предыдущее закрепление будет заменено.`
      : "Снять закреплённое объявление?";
    if (!window.confirm(question)) return;

    button.disabled = true;
    const { error } = action === "pin"
      ? await db.rpc("pin_class_chat_message", { p_message_id: message.id })
      : await db.rpc("unpin_class_chat_message");
    if (error) {
      button.disabled = false;
      return showNotice(`Не удалось изменить закрепление: ${friendlyError(error)}`, "error");
    }
    try {
      await refreshChatMessagesNow();
      showNotice(action === "pin" ? "Объявление закреплено ✓" : "Закрепление снято", "info");
    } catch (error) {
      showNotice(`Закрепление изменено, но чат пока не обновился: ${friendlyError(error)}`, "error");
    }
    return;
  }

  if (action !== "delete" || !message || !canDeleteChatMessage(message)) return;
  if (!window.confirm("Удалить это сообщение? Восстановить его будет нельзя.")) return;

  button.disabled = true;
  const { error } = await db.rpc("delete_class_chat_message", { p_message_id: message.id });
  if (error) {
    button.disabled = false;
    return showNotice(`Сообщение не удалено: ${friendlyError(error)}`, "error");
  }
  state.chatMessages = state.chatMessages.filter((item) => item.id !== message.id);
  syncChatUnreadState();
  renderChat();
  showNotice("Сообщение удалено", "info");
}

function renderArchivedCampaigns() {
  if (!dom.archiveCampaigns) return;
  dom.archiveCampaigns.replaceChildren();
  if (!state.archiveFeaturesReady) {
    dom.archiveCampaigns.append(createEmptyContent("🗂️", "Архив будет готов после обновления базы", "Сначала выполните файл archive-features.sql в Supabase."));
    return;
  }
  if (!state.archivedCampaigns.length) {
    dom.archiveCampaigns.append(createEmptyContent("🗂️", "Архив пока пуст", "Завершённый сбор можно безопасно архивировать в настройках."));
    return;
  }

  state.archivedCampaigns.forEach((campaign) => {
    const contributions = getCampaignContributions(campaign.id);
    const collected = sum(contributions.map((item) => item.amount));
    const linkedExpenses = state.expenses.filter((item) => item.campaign_id === campaign.id);
    const spent = sum(linkedExpenses.map((item) => item.amount));
    const card = el("article", "archive-card");
    const header = el("div", "archive-card-header");
    const title = el("div");
    title.append(
      el("span", "sticker sticker-blue", campaign.school_year || "Учебный год не указан"),
      el("h3", "", campaign.name),
      el("p", "", `${CAMPAIGN_TYPE_LABELS[campaign.campaign_type] || "Сбор"} · ${FUND_LABELS[campaign.fund] || "Классный фонд"} · архивирован ${formatDateTime(campaign.archived_at)}`)
    );
    const restoreButton = el("button", "button button-secondary button-small admin-only", "Вернуть в активные");
    restoreButton.type = "button";
    restoreButton.dataset.action = "restore-campaign";
    restoreButton.dataset.id = campaign.id;
    if (!state.isAdmin) restoreButton.classList.add("hidden");
    header.append(title, restoreButton);

    const metrics = el("div", "archive-metrics");
    metrics.append(
      createArchiveMetric("План", formatMoney(toNumber(campaign.expected_amount) * getArchivedCampaignStudents(campaign).length)),
      createArchiveMetric("Собрано", formatMoney(collected)),
      createArchiveMetric("Расходы по сбору", linkedExpenses.length ? formatMoney(spent) : "Не привязаны")
    );

    const details = document.createElement("details");
    details.className = "archive-details";
    const summary = el("summary", "", `Полная история: ${contributions.length} взносов${linkedExpenses.length ? ` и ${linkedExpenses.length} расходов` : ""}`);
    const history = el("div", "archive-history");
    const studentRows = getArchivedCampaignStudents(campaign).map((student) => {
      const contribution = getContribution(student.id, campaign.id);
      return `${student.full_name}: ${formatMoney(contribution?.amount || 0)}`;
    });
    history.append(el("p", "archive-history-copy", studentRows.length ? studentRows.join(" · ") : "Взносов по этому сбору не было."));
    if (linkedExpenses.length) {
      const expenseList = el("ul", "archive-expense-list");
      linkedExpenses.forEach((expense) => expenseList.append(el("li", "", `${formatDate(expense.expense_date)} — ${expense.description}: ${formatMoney(expense.amount)}`)));
      history.append(el("h4", "", "Расходы, привязанные к сбору"), expenseList);
    } else {
      history.append(el("p", "form-hint", "Старые расходы до этого обновления не были связаны с отдельными сборами и остаются в общем журнале расходов."));
    }
    details.append(summary, history);
    card.append(header, metrics, details);
    dom.archiveCampaigns.append(card);
  });
}

function createArchiveMetric(label, value) {
  const metric = el("div", "archive-metric");
  metric.append(el("small", "", label), el("strong", "", value));
  return metric;
}

function getArchivedCampaignStudents(campaign) {
  if (Array.isArray(campaign.archived_students) && campaign.archived_students.length) {
    return [...campaign.archived_students].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.full_name).localeCompare(String(b.full_name), "ru"));
  }
  // Для архивов, созданных до обновления, показываем только тех, у кого есть сохранённый взнос.
  const ids = new Set(getCampaignContributions(campaign.id).map((item) => item.student_id));
  return state.allStudents.filter((student) => ids.has(student.id));
}

function renderAccessManagement() {
  if (!dom.accessRequestList || !state.isAdmin) return;
  hideElement(dom.accessRequestError);
  dom.accessRequestList.replaceChildren();

  if (!state.enrollmentReady) {
    if (dom.accessEnrollmentStatus) dom.accessEnrollmentStatus.textContent = "Раздел заявок появится после обновления базы данных.";
    if (dom.accessEnrollmentHint) dom.accessEnrollmentHint.textContent = "После запуска parent-access-requests.sql здесь можно будет открыть приём родителей.";
    if (dom.toggleAccessEnrollmentButton) dom.toggleAccessEnrollmentButton.disabled = true;
    dom.accessRequestList.append(createEmptyContent("🔐", "Приём заявок ещё не настроен", "Сначала обновите базу данных безопасным скриптом."));
    return;
  }

  if (dom.accessEnrollmentStatus) {
    dom.accessEnrollmentStatus.textContent = state.enrollmentOpen ? "Приём заявок открыт" : "Приём заявок закрыт";
    dom.accessEnrollmentStatus.className = `access-enrollment-status ${state.enrollmentOpen ? "is-open" : "is-closed"}`;
  }
  if (dom.accessEnrollmentHint) {
    dom.accessEnrollmentHint.textContent = state.enrollmentOpen
      ? "По ссылке можно оставить заявку, но бюджет и чат останутся закрыты до вашего одобрения."
      : "Новые люди не могут оставить заявку. Уже одобренные родители продолжают пользоваться сайтом.";
  }
  if (dom.toggleAccessEnrollmentButton) {
    dom.toggleAccessEnrollmentButton.disabled = false;
    dom.toggleAccessEnrollmentButton.textContent = state.enrollmentOpen ? "Закрыть приём заявок" : "Открыть приём заявок";
    dom.toggleAccessEnrollmentButton.classList.toggle("button-secondary", state.enrollmentOpen);
    dom.toggleAccessEnrollmentButton.classList.toggle("button-primary", !state.enrollmentOpen);
  }

  if (!state.accessRequests.length) {
    dom.accessRequestList.append(createEmptyContent("👪", "Заявок пока нет", "Откройте приём, затем отправьте ссылку в родительский чат."));
    return;
  }

  const order = { PENDING: 0, REJECTED: 1, APPROVED: 2 };
  [...state.accessRequests]
    .sort((a, b) => (order[a.request_status] ?? 9) - (order[b.request_status] ?? 9) || new Date(b.requested_at) - new Date(a.requested_at))
    .forEach((request) => dom.accessRequestList.append(createAccessRequestElement(request)));
}

function createAccessRequestElement(request) {
  const item = el("article", `access-request-item is-${String(request.request_status || "PENDING").toLowerCase()}`);
  const person = el("div", "access-request-person");
  const avatarUrl = safeHttpsUrl(request.avatar_url);
  if (avatarUrl) {
    const avatar = document.createElement("img");
    avatar.className = "access-request-avatar";
    avatar.src = avatarUrl;
    avatar.alt = "";
    avatar.referrerPolicy = "no-referrer";
    person.append(avatar);
  } else {
    person.append(el("span", "access-request-initial", initials(request.display_name || request.email)));
  }
  const copy = el("div", "access-request-copy");
  copy.append(
    el("strong", "", request.display_name || "Родитель"),
    el("small", "", request.email),
    el("small", "", `Заявка: ${formatDateTime(request.requested_at)}`)
  );
  person.append(copy);

  const right = el("div", "access-request-actions");
  right.append(el("span", `access-request-status status-${String(request.request_status || "PENDING").toLowerCase()}`, accessRequestStatusLabel(request.request_status)));
  if (request.request_status !== "APPROVED") {
    const approve = el("button", "button button-primary button-small", request.request_status === "REJECTED" ? "Одобрить всё же" : "Одобрить");
    approve.type = "button";
    approve.dataset.accessAction = "approve";
    approve.dataset.id = request.id;
    right.append(approve);
  }
  if (request.request_status === "PENDING") {
    const reject = el("button", "button button-danger button-small", "Отклонить");
    reject.type = "button";
    reject.dataset.accessAction = "reject";
    reject.dataset.id = request.id;
    right.append(reject);
  }
  const revoke = el("button", "button button-danger button-small", request.request_status === "APPROVED" ? "Удалить доступ" : "Удалить");
  revoke.type = "button";
  revoke.dataset.accessAction = "revoke";
  revoke.dataset.id = request.id;
  right.append(revoke);
  item.append(person, right);
  return item;
}

function accessRequestStatusLabel(status) {
  return ({ PENDING: "Ожидает решения", APPROVED: "Одобрено", REJECTED: "Отклонено" })[status] || "Ожидает решения";
}

async function refreshAccessAdministration() {
  const result = await fetchAccessAdministration();
  if (result.error) throw result.error;
  state.enrollmentReady = result.ready === true;
  state.enrollmentOpen = result.enrollmentOpen === true;
  state.accessRequests = result.accessRequests ?? [];
  renderAccessManagement();
}

async function toggleAccessEnrollment() {
  if (!state.isAdmin || !state.enrollmentReady) return;
  const next = !state.enrollmentOpen;
  const warning = next
    ? "Открыть приём заявок? Любой человек со ссылкой сможет оставить заявку, но не увидит бюджет и чат, пока вы лично его не одобрите."
    : "Закрыть приём заявок? Новые люди не смогут оставлять заявки, а уже одобренные родители продолжат пользоваться сайтом.";
  if (!window.confirm(warning)) return;

  setButtonLoading(dom.toggleAccessEnrollmentButton, true, next ? "Открываем…" : "Закрываем…");
  const { error } = await db.rpc("set_access_enrollment", { p_open: next });
  setButtonLoading(dom.toggleAccessEnrollmentButton, false);
  if (error) return showElementError(dom.accessRequestError, `Не удалось изменить приём заявок: ${friendlyError(error)}`);
  await refreshAccessAdministration();
  showNotice(next ? "Приём заявок открыт. Отправьте ссылку родителям. ✓" : "Приём заявок закрыт. ✓", "info", 5000);
}

async function handleAccessRequestAction(event) {
  if (!state.isAdmin) return;
  const button = event.target.closest("[data-access-action]");
  if (!button) return;
  const request = state.accessRequests.find((item) => item.id === button.dataset.id);
  if (!request) return;
  const action = button.dataset.accessAction;

  if (action === "revoke") {
    const question = request.request_status === "APPROVED"
      ? `Удалить доступ ${request.display_name} (${request.email}) к бюджету и чату? Google-аккаунт человека не удаляется, но войти на этот сайт он больше не сможет.`
      : `Удалить профиль-заявку ${request.display_name} (${request.email}) из списка?`;
    if (!window.confirm(question)) return;
    button.disabled = true;
    const { error } = await db.rpc("revoke_class_access", { p_request_id: request.id });
    if (error) {
      button.disabled = false;
      return showElementError(dom.accessRequestError, `Не удалось удалить доступ: ${friendlyError(error)}`);
    }
    await refreshAccessAdministration();
    showNotice(request.request_status === "APPROVED" ? "Доступ к сайту удалён" : "Профиль-заявка удалён", "info");
    return;
  }

  const isApproval = action === "approve";
  const question = isApproval
    ? `Одобрить ${request.display_name} (${request.email})? После этого родитель увидит бюджет и чат при следующем обновлении страницы.`
    : `Отклонить заявку ${request.display_name} (${request.email})? Бюджет и чат останутся закрыты.`;
  if (!window.confirm(question)) return;

  button.disabled = true;
  const rpcName = isApproval ? "approve_access_request" : "reject_access_request";
  const { error } = await db.rpc(rpcName, { p_request_id: request.id });
  if (error) {
    button.disabled = false;
    return showElementError(dom.accessRequestError, `Не удалось обработать заявку: ${friendlyError(error)}`);
  }
  await refreshAccessAdministration();
  showNotice(isApproval ? "Доступ родителя одобрен ✓" : "Заявка отклонена", "info");
}

function renderAccessRequestStatus(request) {
  const status = request?.request_status || "CLOSED";
  if (status === "PENDING") {
    showAuthMessage("Заявка отправлена администратору. После одобрения обновите страницу — бюджет и чат откроются автоматически.", "info");
  } else if (status === "REJECTED") {
    showAuthError("Эта заявка пока не одобрена. Если это ошибка, обратитесь к администратору класса.");
  } else if (status === "CLOSED") {
    showAuthError("Приём заявок сейчас закрыт. Попросите администратора временно открыть его и отправьте заявку ещё раз.");
  } else {
    showAuthMessage("Ваш доступ уже одобрен. Обновите страницу, чтобы открыть бюджет и чат.", "info");
  }
  // Официальная кнопка Google остаётся внутри своего контейнера.
}

function renderStudentManagement() {
  if (!dom.studentManagementList) return;
  dom.studentManagementList.replaceChildren();
  if (!state.allStudents.length) {
    dom.studentManagementList.append(createEmptyContent("🧑‍🎓", "Ученики не найдены", "Добавьте первого ученика в список."));
    return;
  }
  state.allStudents.forEach((student) => {
    const item = el("article", `student-management-item ${student.is_active ? "" : "is-inactive"}`);
    const copy = el("div");
    copy.append(el("strong", "", student.full_name), el("small", "", student.is_active ? `Активен · порядок ${student.sort_order}` : "Неактивен · прежние взносы сохранены"));
    const actions = el("div", "row-actions");
    const editButton = el("button", "action-button action-edit", "Изменить");
    editButton.type = "button";
    editButton.dataset.action = "edit-student";
    editButton.dataset.id = student.id;
    const statusButton = el("button", `action-button ${student.is_active ? "action-archive" : "action-reactivate"}`, student.is_active ? "Больше не учится" : "Вернуть в класс");
    statusButton.type = "button";
    statusButton.dataset.action = student.is_active ? "deactivate-student" : "reactivate-student";
    statusButton.dataset.id = student.id;
    actions.append(editButton, statusButton);
    item.append(copy, actions);
    dom.studentManagementList.append(item);
  });
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

function contributionReminderStorageKey() {
  return state.user?.id ? `budget-2a-reminder-student:${state.user.id}` : null;
}

function getReminderStudentId() {
  const key = contributionReminderStorageKey();
  if (!key) return null;
  try {
    return window.localStorage.getItem(key) || null;
  } catch (_) {
    return null;
  }
}

function setReminderStudentId(studentId) {
  const key = contributionReminderStorageKey();
  if (!key) return;
  try {
    if (studentId) window.localStorage.setItem(key, studentId);
    else window.localStorage.removeItem(key);
  } catch (_) {
    // Приватный режим не должен мешать просмотру бюджета.
  }
}

function openParentChildOnboardingIfNeeded() {
  const modal = dom.parentChildOnboardingModal;
  if (!modal || modal.open || !state.session || state.isAdmin || !state.students.length || getReminderStudentId()) return;

  if (dom.parentChildOnboardingSelect) {
    dom.parentChildOnboardingSelect.replaceChildren();
    const placeholder = el("option", "", "Выберите имя…");
    placeholder.value = "";
    dom.parentChildOnboardingSelect.append(placeholder);
    state.students.forEach((student) => {
      const option = el("option", "", student.full_name);
      option.value = student.id;
      dom.parentChildOnboardingSelect.append(option);
    });
  }
  hideElement(dom.parentChildOnboardingError);
  modal.showModal();
}

function saveParentChildOnboarding(event) {
  event.preventDefault();
  const studentId = dom.parentChildOnboardingSelect?.value || "";
  const student = state.students.find((item) => item.id === studentId);
  if (!student) return showElementError(dom.parentChildOnboardingError, "Выберите ребёнка из списка, чтобы продолжить.");

  setReminderStudentId(student.id);
  renderContributionReminder();
  dom.parentChildOnboardingModal?.close();
  showNotice(`Готово: будем показывать напоминание для «${student.full_name}».`, "info", 5000);
}

function renderContributionReminder() {
  if (!dom.contributionReminder) return;
  dom.contributionReminder.replaceChildren();
  dom.contributionReminder.classList.add("hidden");
  dom.contributionReminder.classList.remove("is-setup");

  const openCampaigns = state.campaigns
    .filter((item) => item.is_open)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const students = state.students ?? [];
  if (!state.session || !openCampaigns.length || !students.length) return;

  let studentId = getReminderStudentId();
  let student = students.find((item) => item.id === studentId) ?? null;
  if (studentId && !student) {
    setReminderStudentId(null);
    studentId = null;
  }

  const intro = el("div", "contribution-reminder-copy");
  intro.append(
    el("span", "contribution-reminder-icon", "🎯"),
    el("div", "", "")
  );
  const copy = intro.lastElementChild;

  const controls = el("div", "contribution-reminder-controls");
  const select = document.createElement("select");
  select.className = "contribution-reminder-select";
  select.setAttribute("aria-label", "Выберите ребёнка для личного напоминания");
  select.append(el("option", "", "Выберите моего ребёнка…"));
  select.options[0].value = "";
  students.forEach((item) => {
    const option = el("option", "", item.full_name);
    option.value = item.id;
    select.append(option);
  });
  select.value = studentId || "";
  select.addEventListener("change", () => {
    setReminderStudentId(select.value || null);
    renderContributionReminder();
  });

  if (!student) {
    dom.contributionReminder.classList.add("is-setup");
    copy.append(
      el("span", "contribution-reminder-step", "Шаг 1 из 1 · для Вашего удобства"),
      el("strong", "", "Выберите своего ребёнка"),
      el("small", "", "После выбора сайт покажет личный остаток по каждому открытому сбору. Этот выбор сохраняется только на Вашем устройстве.")
    );
    const picker = el("label", "contribution-reminder-picker");
    picker.append(el("span", "", "Кого показать?"), select, el("em", "", "↓ выберите имя"));
    controls.append(picker);
  } else {
    copy.append(
      el("strong", "", "Мой взнос"),
      el("small", "", `Открытых сборов: ${openCampaigns.length}. Остаток рассчитан для «${student.full_name}».`)
    );

    const change = el("button", "contribution-reminder-change", "Изменить ребёнка");
    change.type = "button";
    change.addEventListener("click", () => {
      setReminderStudentId(null);
      renderContributionReminder();
    });
    controls.append(change);
  }

  dom.contributionReminder.append(intro, controls);

  if (student) {
    const campaignList = el("div", "contribution-reminder-list");
    openCampaigns.forEach((campaign) => {
      const paid = toNumber(getContribution(student.id, campaign.id)?.amount);
      const expected = toNumber(campaign.expected_amount);
      const remaining = Math.max(0, expected - paid);
      const isPaid = remaining === 0;
      const item = el("article", `contribution-reminder-item${isPaid ? " is-paid" : ""}`);
      const itemHeading = el("div", "contribution-reminder-item-heading");
      itemHeading.append(
        el("span", "contribution-reminder-item-icon", FUND_ICONS[campaign.fund] || "🎯"),
        el("strong", "", campaign.name)
      );
      const fundLabel = el("small", "contribution-reminder-item-fund", `Фонд: ${FUND_LABELS[campaign.fund] || "Классный фонд"}`);
      const amount = el("strong", "contribution-reminder-item-amount", isPaid ? "Внесено" : `Осталось ${formatMoney(remaining)}`);
      const detail = el("small", "contribution-reminder-item-detail", `План ${formatMoney(expected)} · внесено ${formatMoney(paid)}`);
      item.append(itemHeading, fundLabel, amount, detail);
      campaignList.append(item);
    });
    dom.contributionReminder.append(campaignList);
  }

  dom.contributionReminder.classList.remove("hidden");
}

function renderCurrentCampaignSummary() {
  if (!dom.currentCampaignSummary) return;
  const openCampaigns = state.campaigns
    .filter((item) => item.is_open)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  dom.currentCampaignSummary.replaceChildren();

  if (!openCampaigns.length) {
    dom.currentCampaignSummary.className = "campaign-summary empty-state";
    dom.currentCampaignSummary.append(createEmptyContent(
      "🎯",
      "Открытых сборов пока нет",
      "Новая цель появится здесь сразу после открытия сбора."
    ));
    return;
  }

  const cards = openCampaigns.map((campaign) => {
    const contributions = getCampaignContributions(campaign.id);
    const plan = toNumber(campaign.expected_amount) * state.students.length;
    const collected = sum(contributions.map((item) => item.amount));
    const percent = plan > 0 ? Math.min(100, Math.round((collected / plan) * 100)) : 0;
    const paidCount = state.students.filter((student) => getStudentStatus(student.id, campaign).key === "paid").length;
    const remaining = Math.max(0, plan - collected);

    const card = el("article", "campaign-progress-card");
    const heading = el("div", "campaign-progress-heading");
    const identity = el("div", "campaign-progress-identity");
    identity.append(
      el("span", "campaign-progress-icon", FUND_ICONS[campaign.fund] || "🎯"),
      (() => {
        const copy = el("div");
        copy.append(
          el("strong", "", campaign.name),
          el("small", "", `Фонд: ${FUND_LABELS[campaign.fund] || "Классный сбор"}`)
        );
        return copy;
      })()
    );
    heading.append(identity, el("span", "campaign-percent", `${percent}%`));

    const track = el("div", "progress-track");
    const bar = el("div", "progress-bar");
    bar.style.width = `${percent}%`;
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", `${campaign.name}: собрано ${percent}%`);
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
    card.append(heading, track, stats);
    return card;
  });

  dom.currentCampaignSummary.className = "campaign-summary campaign-progress-list";
  dom.currentCampaignSummary.append(...cards);
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
  renderBudgetOverview(dom.fundExpenseChart);
  renderExpenseDistribution(dom.categoryExpenseChart, groupTotals(state.expenses, "fund"), FUND_LABELS);
}

function renderBudgetOverview(container) {
  if (!container) return;
  container.replaceChildren();

  const collected = sum(state.contributions.map((item) => item.amount));
  const spent = sum(state.expenses.map((item) => item.amount));
  const balance = collected - spent;
  const base = Math.max(collected, spent, 0);
  const spentPercent = base > 0 ? Math.min(100, Math.round((spent / base) * 100)) : 0;
  const balancePercent = base > 0 ? Math.max(0, Math.min(100, Math.round((Math.max(0, balance) / base) * 100))) : 0;

  const overview = el("div", "budget-overview");
  const total = el("div", "budget-overview-total");
  total.append(el("span", "", "Всего собрано"), el("strong", "", formatMoney(collected)));
  overview.append(total);

  const rows = [
    ["Потрачено", formatMoney(spent), spentPercent, "budget-bar-spent"],
    ["Осталось", formatMoney(Math.max(0, balance)), balancePercent, "budget-bar-balance"]
  ];
  rows.forEach(([label, amount, percent, barClass]) => {
    const row = el("div", "budget-overview-row");
    const heading = el("div", "budget-overview-row-heading");
    heading.append(el("span", "", label), el("strong", "", `${amount} · ${percent}%`));
    const track = el("div", "budget-bar-track");
    const bar = el("span", `budget-bar ${barClass}`);
    bar.style.width = `${percent}%`;
    track.append(bar);
    row.append(heading, track);
    overview.append(row);
  });

  const note = el("small", "budget-overview-note", "Проценты показывают долю потраченного и остатка от общей суммы бюджета, а не только распределение расходов.");
  overview.append(note);
  container.append(overview);
}

function renderExpenseDistribution(container, totals, labels) {
  if (!container) return;
  container.replaceChildren();
  const entries = Object.entries(totals).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
  const total = sum(entries.map(([, value]) => value));

  if (!entries.length) {
    container.append(createEmptyContent("🎨", "Пока нет данных", "Распределение появится после первого расхода."));
    return;
  }

  const list = el("div", "expense-distribution-list");
  entries.forEach(([key, value]) => {
    const percent = total > 0 ? Math.round((value / total) * 100) : 0;
    const row = el("div", "expense-distribution-row");
    const heading = el("div", "expense-distribution-heading");
    const label = el("span", "expense-distribution-label");
    const dot = el("i", "chart-dot");
    dot.style.background = CHART_COLORS[key] || "#78909c";
    label.append(dot, document.createTextNode(labels[key] || key));
    heading.append(label, el("strong", "", `${formatMoney(value)} · ${percent}% расходов`));
    const track = el("div", "expense-distribution-track");
    const bar = el("span", "expense-distribution-bar");
    bar.style.width = `${percent}%`;
    bar.style.background = CHART_COLORS[key] || "#78909c";
    track.append(bar);
    row.append(heading, track);
    list.append(row);
  });
  container.append(list, el("small", "expense-distribution-note", "Процент показывает распределение уже потраченных денег между фондами."));
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
  populateExpenseCampaignSelect(expense?.campaign_id || "");
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
  if (state.advancedFeaturesReady) {
    payload.receipt_path = dom.expenseReceiptPath.value || null;
    payload.campaign_id = dom.expenseCampaign?.value || null;
  }

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

function populateExpenseCampaignSelect(selectedId = "") {
  if (!dom.expenseCampaign) return;
  dom.expenseCampaign.replaceChildren();
  const noCampaign = document.createElement("option");
  noCampaign.value = "";
  noCampaign.textContent = "Не привязывать к сбору";
  dom.expenseCampaign.append(noCampaign);
  [...state.campaigns, ...state.archivedCampaigns].forEach((campaign) => {
    const option = document.createElement("option");
    option.value = campaign.id;
    option.textContent = `${campaign.archived_at ? "Архив" : "Сбор"}: ${campaign.name}`;
    option.selected = campaign.id === selectedId;
    dom.expenseCampaign.append(option);
  });
  dom.expenseCampaign.disabled = !state.archiveFeaturesReady;
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
      createCampaignActions(campaign)
    );
    dom.campaignsTableBody.append(row);
  });
}

function createCampaignActions(campaign) {
  const cell = document.createElement("td");
  const wrapper = el("div", "row-actions");
  const editButton = el("button", "action-button action-edit", "Изменить");
  editButton.type = "button";
  editButton.dataset.action = "edit-campaign";
  editButton.dataset.id = campaign.id;
  const archiveButton = el("button", "action-button action-archive", "Архивировать");
  archiveButton.type = "button";
  archiveButton.dataset.action = "archive-campaign";
  archiveButton.dataset.id = campaign.id;
  archiveButton.disabled = campaign.is_open;
  archiveButton.title = campaign.is_open ? "Сначала закройте сбор через «Изменить»" : "Переместить закрытый сбор в архив";
  const deleteButton = el("button", "action-button action-delete", "Удалить");
  deleteButton.type = "button";
  deleteButton.dataset.action = "delete-campaign";
  deleteButton.dataset.id = campaign.id;
  wrapper.append(editButton, archiveButton, deleteButton);
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
  if (button.dataset.action === "archive-campaign") {
    if (!state.archiveFeaturesReady) return showNotice("Сначала выполните файл archive-features.sql в Supabase.", "error");
    const linkedCount = getCampaignContributions(campaign.id).length;
    const warning = `Архивировать сбор «${campaign.name}»? Он станет закрытым и исчезнет из активного списка, но ${linkedCount ? `${linkedCount} взносов и вся история` : "вся история"} сохранятся в архиве.`;
    if (!window.confirm(warning)) return;
    button.disabled = true;
    const undoBackupId = await createUndoPoint();
    const { error } = await db.rpc("archive_campaign", { p_campaign_id: campaign.id });
    if (error) {
      button.disabled = false;
      return showNotice(`Не удалось архивировать: ${friendlyError(error)}`, "error");
    }
    await loadAllData({ silent: true });
    showUndoNotice("Сбор отправлен в архив ✓", undoBackupId);
  }
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

async function handleArchiveAction(event) {
  if (!state.isAdmin || !state.archiveFeaturesReady) return;
  const button = event.target.closest('[data-action="restore-campaign"]');
  if (!button) return;
  const campaign = state.archivedCampaigns.find((item) => item.id === button.dataset.id);
  if (!campaign) return;
  if (!window.confirm(`Вернуть сбор «${campaign.name}» из архива в активный список? Он останется закрытым, пока вы не откроете его вручную.`)) return;
  button.disabled = true;
  const undoBackupId = await createUndoPoint();
  const { error } = await db.rpc("restore_archived_campaign", { p_campaign_id: campaign.id });
  if (error) {
    button.disabled = false;
    return showNotice(`Не удалось вернуть сбор: ${friendlyError(error)}`, "error");
  }
  await loadAllData({ silent: true });
  showUndoNotice("Сбор возвращён в активный список ✓", undoBackupId);
}

function openStudentModal(student = null) {
  if (!state.isAdmin || !dom.studentModal) return;
  dom.studentForm.reset();
  hideElement(dom.studentFormError);
  dom.studentId.value = student?.id || "";
  dom.studentFullName.value = student?.full_name || "";
  dom.studentSortOrder.value = student?.sort_order ?? ((Math.max(0, ...state.allStudents.map((item) => Number(item.sort_order) || 0)) || 0) + 10);
  dom.studentModalTitle.textContent = student ? "Изменить данные ученика" : "Добавить ученика";
  dom.studentModal.showModal();
}

async function saveStudent(event) {
  event.preventDefault();
  if (!state.isAdmin) return;
  const fullName = dom.studentFullName.value.trim();
  const sortOrder = Math.max(0, Math.trunc(toNumber(dom.studentSortOrder.value)));
  if (fullName.length < 2) return showElementError(dom.studentFormError, "Введите имя ученика.");

  setButtonLoading(dom.saveStudentButton, true, "Сохраняем…");
  const id = dom.studentId.value;
  const undoBackupId = await createUndoPoint();
  const result = id
    ? await db.rpc("update_student", { p_student_id: id, p_full_name: fullName, p_sort_order: sortOrder })
    : await db.rpc("add_student", { p_full_name: fullName, p_sort_order: sortOrder });
  setButtonLoading(dom.saveStudentButton, false);
  if (result.error) return showElementError(dom.studentFormError, `Не удалось сохранить: ${friendlyError(result.error)}`);
  dom.studentModal.close();
  await loadAllData({ silent: true });
  showUndoNotice(id ? "Данные ученика обновлены ✓" : "Ученик добавлен ✓", undoBackupId);
}

async function handleStudentAction(event) {
  if (!state.isAdmin) return;
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const student = state.allStudents.find((item) => item.id === button.dataset.id);
  if (!student) return;

  if (button.dataset.action === "edit-student") return openStudentModal(student);
  const isDeactivate = button.dataset.action === "deactivate-student";
  const isReactivate = button.dataset.action === "reactivate-student";
  if (!isDeactivate && !isReactivate) return;
  const message = isDeactivate
    ? `Отметить «${student.full_name}» как выбывшего? Прежние взносы и история сохранятся, но ребёнок не попадёт в новые открытые сборы.`
    : `Вернуть «${student.full_name}» в активный список учеников?`;
  if (!window.confirm(message)) return;
  button.disabled = true;
  const undoBackupId = await createUndoPoint();
  const { error } = await db.rpc(isDeactivate ? "deactivate_student" : "reactivate_student", { p_student_id: student.id });
  if (error) {
    button.disabled = false;
    return showNotice(`Не удалось обновить список: ${friendlyError(error)}`, "error");
  }
  await loadAllData({ silent: true });
  showUndoNotice(isDeactivate ? "Ученик отмечен как выбывший" : "Ученик снова в активном списке ✓", undoBackupId);
}

async function startNewSchoolYear(event) {
  event.preventDefault();
  if (!state.isAdmin || !state.archiveFeaturesReady) return;
  const className = dom.nextClassName.value.trim();
  const schoolYear = dom.nextSchoolYear.value.trim();
  if (!/^20\d{2}\/20\d{2}$/.test(schoolYear)) return showElementError(dom.schoolYearFormError, "Укажите учебный год в формате 2026/2027.");
  const warning = `Подготовить ${className} к ${schoolYear} учебному году? Все текущие сборы будут закрыты и отправлены в архив. Деньги, чеки и история не удалятся. Перед операцией будет создана дополнительная копия.`;
  if (!window.confirm(warning)) return;

  hideElement(dom.schoolYearFormError);
  setButtonLoading(dom.startSchoolYearButton, true, "Готовим…");
  const { error } = await db.rpc("prepare_new_school_year", { p_class_name: className, p_school_year: schoolYear });
  setButtonLoading(dom.startSchoolYearButton, false);
  if (error) return showElementError(dom.schoolYearFormError, `Не удалось подготовить учебный год: ${friendlyError(error)}`);
  await loadAllData({ silent: true });
  showNotice("Новый учебный год подготовлен. Теперь проверьте список учеников и создайте первый сбор. ✓", "info", 7000);
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

function budgetClassTitle() {
  return `Бюджет ${state.classProfile?.class_name || "2 «А»"} класса`;
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
  heading.append(el("h1", "", budgetClassTitle()), el("p", "", `Отчёт за ${monthYearLabel(report.month)}`));
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
    [budgetClassTitle()],
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
    version: 2,
    created_at: new Date().toISOString(),
    class_profile: state.classProfile,
    students: state.allStudents,
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
  if (error) {
    // Резервный вариант не оставляет администратора без копии, даже если миграция ещё не применена.
    downloadBlob(`budget-2A-backup-${todayIso()}.json`, JSON.stringify(buildSnapshot(), null, 2), "application/json");
    return showNotice(`Копия в Supabase пока не создана: ${friendlyError(error)}. Вместо этого скачан безопасный JSON-файл.`, "error", 7000);
  }
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

function activateServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const workerUrl = new URL("./sw.js?v=34", window.location.href);
  navigator.serviceWorker.register(workerUrl.href, { updateViaCache: "none" })
    .catch((error) => console.warn("Service worker registration failed:", error));
}

function hideLoadingScreen() {
  document.documentElement.classList.remove("session-restore-pending");
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
  const hasPreviousValue = Object.hasOwn(element.dataset, "moneyValue");
  const start = toNumber(element.dataset.moneyValue ?? 0);
  element.dataset.moneyValue = String(target);

  if (element._moneyAnimationFrame) cancelAnimationFrame(element._moneyAnimationFrame);
  // При первом снимке бюджета сразу показываем точную сумму, а не анимацию
  // от нуля. Анимация остаётся для последующих настоящих обновлений.
  if (!hasPreviousValue || start === target || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
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

function nextSchoolYearLabel(currentSchoolYear) {
  const match = String(currentSchoolYear || "").match(/^(20\d{2})\/(20\d{2})$/);
  if (match) {
    const endYear = Number(match[2]);
    return `${endYear}/${endYear + 1}`;
  }
  const start = new Date().getFullYear();
  return `${start}/${start + 1}`;
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

function initials(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]).join("") || "Р").toLocaleUpperCase("ru-RU");
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

function showAuthMessage(message, type = "info") {
  if (!dom.authError) return;
  dom.authError.textContent = message;
  dom.authError.className = `notice notice-${type}`;
  dom.authError.classList.remove("hidden");
}

function showAuthError(message) {
  showAuthMessage(message, "error");
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
