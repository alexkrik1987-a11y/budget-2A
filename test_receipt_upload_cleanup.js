"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const app = fs.readFileSync("app.js", "utf8");
const storageSql = fs.readFileSync("class-receipts-storage.sql", "utf8");

const saveExpenseStart = app.indexOf("async function saveExpense(event)");
const saveExpenseEnd = app.indexOf("async function handleExpenseAction(event)", saveExpenseStart);
const deleteHandlerEnd = app.indexOf("function clearExpenseFilters()", saveExpenseEnd);
const undoStart = app.indexOf("async function createUndoPoint()");
const undoEnd = app.indexOf("function renderBackupList()", undoStart);

assert(saveExpenseStart >= 0 && saveExpenseEnd > saveExpenseStart, "не найден saveExpense()");
assert(deleteHandlerEnd > saveExpenseEnd, "не найден handleExpenseAction()");
assert(undoStart >= 0 && undoEnd > undoStart, "не найден Undo-блок");

const saveExpenseSource = app.slice(saveExpenseStart, saveExpenseEnd);
const deleteHandlerSource = app.slice(saveExpenseEnd, deleteHandlerEnd);
const undoSource = app.slice(undoStart, undoEnd);
const cleanupStart = saveExpenseSource.indexOf("if (error) {");
const successStart = saveExpenseSource.indexOf("const localExpense", cleanupStart);
const cleanupSource = saveExpenseSource.slice(cleanupStart, successStart);

for (const marker of [
  "const saveErrorMessage = `Не удалось сохранить: ${friendlyError(error)}`",
  "let cleanupError = null",
  "if (uploadedPath)",
  "const { error: removeError }",
  '.from("class-receipts").remove([uploadedPath])',
  "cleanupError = removeError",
  "catch (unexpectedCleanupError)",
  "он мог остаться в хранилище",
  "Ошибка очистки: ${friendlyError(cleanupError)}",
  "`${saveErrorMessage}${cleanupWarning}`"
]) {
  assert(cleanupSource.includes(marker), `cleanup не содержит обязательную логику: ${marker}`);
}

assert(!cleanupSource.includes("expenseReceiptPath"), "cleanup не должен доверять hidden input");
assert(!cleanupSource.includes("receipt_path"), "cleanup не должен удалять произвольный старый receipt_path");
assert.equal((saveExpenseSource.match(/\.remove\(/g) || []).length, 1, "saveExpense должен иметь ровно одну компенсационную очистку");
assert(!deleteHandlerSource.includes(".remove("), "удаление расхода этой задачей не должно удалять Storage-файл");
assert(deleteHandlerSource.includes('db.from("expenses").delete().eq("id", expense.id)'), "прежний DELETE расхода должен сохраниться");
assert(undoSource.includes('db.rpc("create_budget_backup", { p_backup_type: "undo" })'), "создание Undo backup не должно меняться");
assert(undoSource.includes('db.rpc("restore_budget_backup", { p_backup_id: backupId })'), "восстановление Undo backup не должно меняться");

for (const policyName of [
  "Class members read receipts",
  "Admins upload receipts",
  "Admins update receipts",
  "Admins delete receipts"
]) {
  assert(storageSql.includes(`create policy "${policyName}"`), `Storage SQL потерял policy ${policyName}`);
}
assert(!storageSql.includes("test_receipt_upload_cleanup"), "Storage SQL не должен зависеть от frontend-теста");

function createHarness({ id = "expense-1", uploadError = null, saveError = null, cleanupError = null, cleanupThrows = false, withFile = true } = {}) {
  const calls = {
    cleanupPaths: [],
    errors: [],
    saveOperations: [],
    undoCreated: 0,
    undoShown: 0,
    refreshed: 0
  };
  const oldPath = "2026-08-20/old-receipt.pdf";
  const uploadedPath = "2026-08-23/new-upload.pdf";
  const file = withFile ? { name: "new-upload.pdf", type: "application/pdf", size: 1024 } : null;
  const state = {
    isAdmin: true,
    advancedFeaturesReady: true,
    expenses: id ? [{ id, receipt_path: oldPath, description: "Старый расход" }] : []
  };
  const dom = {
    expenseReceiptUrl: { value: "" },
    expenseDate: { value: "2026-08-23" },
    expenseDescription: { value: "Новый расход" },
    expenseCategory: { value: "MAIN" },
    expenseFund: { value: "MAIN" },
    expenseAmount: { value: "100" },
    expenseReceiptPath: { value: oldPath },
    expenseCampaign: { value: "" },
    expenseReceiptFile: { files: file ? [file] : [] },
    expenseFormError: {},
    saveExpenseButton: {},
    expenseId: { value: id },
    expenseModal: { close() {} }
  };

  const saveResult = Promise.resolve({ error: saveError });
  const db = {
    from(table) {
      assert.equal(table, "expenses");
      return {
        update(payload) {
          calls.saveOperations.push({ type: "update", payload });
          return { eq() { return saveResult; } };
        },
        insert(payload) {
          calls.saveOperations.push({ type: "insert", payload });
          return saveResult;
        }
      };
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "class-receipts");
        return {
          async remove(paths) {
            calls.cleanupPaths.push([...paths]);
            if (cleanupThrows) throw new Error("cleanup threw");
            return { data: cleanupError ? null : [], error: cleanupError };
          }
        };
      }
    }
  };
  const context = {
    state,
    dom,
    db,
    safeHttpsUrl: (value) => value,
    showElementError(_element, message) {
      calls.errors.push(message);
      return message;
    },
    toNumber: Number,
    validateReceiptFile: () => null,
    setButtonLoading() {},
    async createUndoPoint() {
      calls.undoCreated += 1;
      return "undo-id";
    },
    async uploadReceipt() {
      return { path: uploadError ? null : uploadedPath, error: uploadError };
    },
    friendlyError: (error) => error?.message || String(error),
    refreshAfterMutation() {
      calls.refreshed += 1;
    },
    showUndoNotice() {
      calls.undoShown += 1;
    },
    Date,
    console
  };
  vm.runInNewContext(`${saveExpenseSource}\nthis.saveExpense = saveExpense;`, context);
  return { ...context, calls, oldPath, uploadedPath, file };
}

async function submit(harness) {
  await harness.saveExpense({ preventDefault() {} });
}

(async () => {
  for (const id of ["expense-1", ""]) {
    const operation = id ? "UPDATE" : "INSERT";
    const harness = createHarness({ id, saveError: new Error(`${operation} failed`) });
    await submit(harness);
    assert.deepEqual(harness.calls.cleanupPaths, [[harness.uploadedPath]], `${operation}: удаляться должен только новый uploadedPath`);
    assert(!harness.calls.cleanupPaths.flat().includes(harness.oldPath), `${operation}: старый receipt_path нельзя удалять`);
    assert.equal(harness.calls.errors.length, 1);
    assert(harness.calls.errors[0].includes(`${operation} failed`), `${operation}: основная ошибка должна отображаться`);
    assert(!harness.calls.errors[0].includes("мог остаться"), `${operation}: при успешной очистке предупреждение не нужно`);
  }

  {
    const harness = createHarness({ saveError: new Error("UPDATE failed"), cleanupError: new Error("remove failed") });
    await submit(harness);
    assert.deepEqual(harness.calls.cleanupPaths, [[harness.uploadedPath]]);
    assert(harness.calls.errors[0].includes("UPDATE failed"), "cleanup-ошибка не должна маскировать основную ошибку");
    assert(harness.calls.errors[0].includes("мог остаться в хранилище"), "нужно предупредить об оставшемся файле");
    assert(harness.calls.errors[0].includes("remove failed"), "нужно показать понятную причину ошибки очистки");
  }

  {
    const harness = createHarness({ saveError: new Error("UPDATE failed"), cleanupThrows: true });
    await submit(harness);
    assert(harness.calls.errors[0].includes("UPDATE failed"));
    assert(harness.calls.errors[0].includes("cleanup threw"), "неожиданный throw cleanup не должен скрывать основную ошибку");
  }

  {
    const harness = createHarness({ uploadError: new Error("upload failed") });
    await submit(harness);
    assert.deepEqual(harness.calls.cleanupPaths, [], "cleanup нельзя выполнять после неуспешного upload");
    assert.equal(harness.calls.saveOperations.length, 0, "после ошибки upload запись не должна сохраняться");
  }

  {
    const harness = createHarness({ withFile: false, saveError: new Error("UPDATE failed") });
    await submit(harness);
    assert.deepEqual(harness.calls.cleanupPaths, [], "без нового upload cleanup не выполняется");
  }

  {
    const harness = createHarness({ saveError: null });
    await submit(harness);
    assert.deepEqual(harness.calls.cleanupPaths, [], "после успешного сохранения новый файл нельзя удалять");
    assert.equal(harness.calls.errors.length, 0);
    assert.equal(harness.calls.undoShown, 1, "успешное сохранение должно сохранять прежний Undo UX");
  }

  console.log("receipt upload cleanup checks: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
