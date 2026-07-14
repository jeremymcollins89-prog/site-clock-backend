// electron/ipcHandlers.js
//
// Wire these up in your main process (main.js) alongside your existing POS
// IPC handlers. Assumes a global API_BASE_URL pointing at your server.

const { ipcMain } = require("electron");
const { saveToken, getToken, getEmployee, clearToken } = require("./authStore");

const API_BASE_URL = process.env.API_BASE_URL || "https://your-server.example.com";

async function apiFetch(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function registerAuthHandlers() {
  ipcMain.handle("auth:login", async (_event, { name, pin }) => {
    const data = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ name, pin }),
    });
    saveToken(data.token, data.employee);
    return data.employee;
  });

  // Runs on app startup. If a token is saved and still valid, the
  // employee lands straight on the clock screen with no login prompt.
  ipcMain.handle("auth:restore", async () => {
    const token = getToken();
    if (!token) return null;
    try {
      const employee = await apiFetch("/api/auth/me");
      return employee;
    } catch {
      clearToken(); // token expired or was revoked — fall back to login
      return null;
    }
  });

  ipcMain.handle("auth:logout", async () => {
    clearToken();
    return true;
  });
}

function registerTimeHandlers() {
  ipcMain.handle("time:clock-in", async (_event, { jobName, locationType }) => {
    return apiFetch("/api/time-entries/clock-in", {
      method: "POST",
      body: JSON.stringify({ job_name: jobName, location_type: locationType }),
    });
  });

  ipcMain.handle("time:break-start", async (_event, { timeEntryId }) => {
    return apiFetch(`/api/time-entries/${timeEntryId}/break-start`, { method: "POST" });
  });

  ipcMain.handle("time:break-end", async (_event, { timeEntryId }) => {
    return apiFetch(`/api/time-entries/${timeEntryId}/break-end`, { method: "POST" });
  });

  ipcMain.handle("time:clock-out", async (_event, { timeEntryId }) => {
    return apiFetch(`/api/time-entries/${timeEntryId}/clock-out`, { method: "POST" });
  });

  ipcMain.handle("time:submit", async () => {
    return apiFetch("/api/timesheets/submit", { method: "POST" });
  });
}

module.exports = { registerAuthHandlers, registerTimeHandlers };
