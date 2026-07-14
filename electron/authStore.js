// electron/authStore.js
//
// Persists the employee's login token on their own machine so they enter
// their PIN once, ever (per device). Uses electron-store, which writes to
// a JSON file in the OS user-data folder — fine here since the token itself
// is the only thing that needs protecting, and it's meaningless without
// your server.
//
// npm install electron-store

const Store = require("electron-store");
const store = new Store({ name: "auth" });

function saveToken(token, employee) {
  store.set("token", token);
  store.set("employee", employee);
}

function getToken() {
  return store.get("token") || null;
}

function getEmployee() {
  return store.get("employee") || null;
}

function clearToken() {
  store.delete("token");
  store.delete("employee");
}

module.exports = { saveToken, getToken, getEmployee, clearToken };
