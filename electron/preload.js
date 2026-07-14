// electron/preload.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("timeclock", {
  // Called once, the first time the app is opened on this device.
  login: (name, pin) => ipcRenderer.invoke("auth:login", { name, pin }),

  // Called on every app launch to check for a saved token and confirm it's
  // still valid, so the employee skips straight to the clock screen.
  restoreSession: () => ipcRenderer.invoke("auth:restore"),

  logout: () => ipcRenderer.invoke("auth:logout"),

  clockIn: (jobName, locationType) =>
    ipcRenderer.invoke("time:clock-in", { jobName, locationType }),
  breakStart: (timeEntryId) => ipcRenderer.invoke("time:break-start", { timeEntryId }),
  breakEnd: (timeEntryId) => ipcRenderer.invoke("time:break-end", { timeEntryId }),
  clockOut: (timeEntryId) => ipcRenderer.invoke("time:clock-out", { timeEntryId }),
  submitHours: () => ipcRenderer.invoke("time:submit"),
});
